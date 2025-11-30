defmodule Lossy.ML.Inpainting do
  @moduledoc """
  High-level inpainting interface using LaMa model on Replicate.

  Handles the full inpainting workflow:
  1. Generate mask from bbox
  2. Upload image and mask to accessible URLs
  3. Call LaMa model via Replicate
  4. Download and save inpainted result
  """

  require Logger
  alias Lossy.ML.{Config, ReplicateClient}
  alias Lossy.ImageProcessing.Mask

  @doc """
  Inpaint a region in an image.

  Takes the original image path and a bbox, generates a mask,
  and returns the path to the inpainted image.

  Options:
  - :padding_px - Padding around the bbox for the mask (default: 10)
  - :output_path - Where to save the result (default: auto-generated)
  """
  def inpaint_region(image_path, bbox, opts \\ []) do
    padding = Keyword.get(opts, :padding_px, 10)
    output_path = Keyword.get(opts, :output_path, generate_output_path(image_path))

    with {:ok, mask_path} <- Mask.generate_mask(image_path, bbox, padding_px: padding),
         {:ok, image_url} <- upload_for_replicate(image_path),
         {:ok, mask_url} <- upload_for_replicate(mask_path),
         {:ok, result_url} <- run_lama_inpainting(image_url, mask_url),
         {:ok, _} <- download_result(result_url, output_path) do
      # Cleanup temporary mask
      File.rm(mask_path)
      {:ok, output_path}
    else
      {:error, reason} = error ->
        Logger.error("Inpainting failed: #{inspect(reason)}")
        error
    end
  end

  @doc """
  Inpaint multiple regions in a single pass.

  More efficient than calling inpaint_region multiple times
  as it combines all regions into a single mask.
  """
  def inpaint_regions(image_path, bboxes, opts \\ []) when is_list(bboxes) do
    padding = Keyword.get(opts, :padding_px, 10)
    output_path = Keyword.get(opts, :output_path, generate_output_path(image_path))

    with {:ok, mask_path} <- Mask.generate_combined_mask(image_path, bboxes, padding_px: padding),
         {:ok, image_url} <- upload_for_replicate(image_path),
         {:ok, mask_url} <- upload_for_replicate(mask_path),
         {:ok, result_url} <- run_lama_inpainting(image_url, mask_url),
         {:ok, _} <- download_result(result_url, output_path) do
      File.rm(mask_path)
      {:ok, output_path}
    else
      {:error, reason} = error ->
        Logger.error("Batch inpainting failed: #{inspect(reason)}")
        error
    end
  end

  # For local development, we need to make images accessible to Replicate
  # Options:
  # 1. Use data URLs (base64) - works but limited to ~256KB
  # 2. Expose via local server URL (requires public access)
  # 3. Upload to a file hosting service
  #
  # For MVP, we'll use data URLs for smaller files and expect
  # production to use proper CDN/S3 URLs
  defp upload_for_replicate(file_path) do
    case File.read(file_path) do
      {:ok, data} ->
        # Check size BEFORE encoding - Replicate recommends URLs for files > 256KB
        size_kb = div(byte_size(data), 1024)
        max_size_kb = 256

        if size_kb > max_size_kb do
          Logger.error(
            "File too large for data URL: #{size_kb}KB exceeds #{max_size_kb}KB limit"
          )

          {:error,
           {:file_too_large,
            "File size #{size_kb}KB exceeds Replicate's #{max_size_kb}KB limit for data URLs"}}
        else
          mime_type = mime_type_for(file_path)
          data_url = "data:#{mime_type};base64,#{Base.encode64(data)}"
          {:ok, data_url}
        end

      {:error, reason} ->
        {:error, {:file_read_failed, reason}}
    end
  end

  defp mime_type_for(path) do
    case Path.extname(path) |> String.downcase() do
      ".png" -> "image/png"
      ".jpg" -> "image/jpeg"
      ".jpeg" -> "image/jpeg"
      ".webp" -> "image/webp"
      _ -> "application/octet-stream"
    end
  end

  defp run_lama_inpainting(image_url, mask_url) do
    model_version = Config.lama_model_version()

    input = %{
      "image" => image_url,
      "mask" => mask_url
    }

    case ReplicateClient.run(model_version, input, max_attempts: 120, poll_interval_ms: 500) do
      {:ok, output_url} when is_binary(output_url) ->
        {:ok, output_url}

      {:ok, [output_url | _]} when is_binary(output_url) ->
        {:ok, output_url}

      {:ok, other} ->
        Logger.error("Unexpected LaMa output format: #{inspect(other)}")
        {:error, :unexpected_output_format}

      {:error, :api_key_not_configured} = error ->
        Logger.error("Replicate API key not configured")
        error

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp download_result(url, output_path) do
    case Req.get(url, receive_timeout: 60_000) do
      {:ok, %{status: 200, body: body}} ->
        case File.write(output_path, body) do
          :ok -> {:ok, output_path}
          {:error, reason} -> {:error, {:file_write_failed, reason}}
        end

      {:ok, %{status: status}} ->
        {:error, {:download_failed, status}}

      {:error, reason} ->
        {:error, {:download_failed, reason}}
    end
  end

  defp generate_output_path(image_path) do
    dir = Path.dirname(image_path)
    basename = Path.basename(image_path, Path.extname(image_path))
    timestamp = System.system_time(:millisecond)
    Path.join(dir, "#{basename}_inpainted_#{timestamp}.png")
  end
end
