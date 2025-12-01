defmodule Lossy.ML.SAM do
  @moduledoc """
  High-level interface for Meta's SAM 2 (Segment Anything Model 2) on Replicate.

  Supports three modes:
  1. segment_everything/2 - Automatic mask generation for all objects
  2. segment_point/3 - Segment object at a specific point
  3. segment_box/3 - Segment object within a bounding box

  Each function returns a list of detected regions with masks.
  """

  require Logger
  alias Lossy.ML.{Config, ReplicateClient}
  alias Lossy.Documents.DetectedRegion

  # Default parameters for automatic mask generation
  @default_points_per_side 32
  @default_pred_iou_thresh 0.88
  @default_stability_score_thresh 0.95

  @doc """
  Segment all objects in an image automatically.

  Returns {:ok, masks} where masks is a list of mask image URLs,
  or {:error, reason} on failure.

  Options:
  - :points_per_side - Grid density for auto-segmentation (default: 32)
  - :pred_iou_thresh - IOU threshold for filtering (default: 0.88)
  - :stability_score_thresh - Stability threshold (default: 0.95)
  """
  def segment_everything(image_path, opts \\ []) do
    points_per_side = Keyword.get(opts, :points_per_side, @default_points_per_side)
    pred_iou_thresh = Keyword.get(opts, :pred_iou_thresh, @default_pred_iou_thresh)
    stability_score_thresh = Keyword.get(opts, :stability_score_thresh, @default_stability_score_thresh)

    with {:ok, image_url} <- upload_for_replicate(image_path) do
      input = %{
        "image" => image_url,
        "points_per_side" => points_per_side,
        "pred_iou_thresh" => pred_iou_thresh,
        "stability_score_thresh" => stability_score_thresh,
        "use_m2m" => true
      }

      run_sam2(input)
    end
  end

  @doc """
  Segment the object at a specific point in the image.

  Returns {:ok, masks} for the object at the given coordinates.
  """
  def segment_point(image_path, %{x: x, y: y}, opts \\ []) do
    with {:ok, image_url} <- upload_for_replicate(image_path) do
      input = %{
        "image" => image_url,
        "point_coords" => [[x, y]],
        "point_labels" => [1]  # 1 = foreground point
      }

      input =
        if Keyword.get(opts, :include_background, false) do
          Map.put(input, "multimask_output", true)
        else
          input
        end

      run_sam2(input)
    end
  end

  @doc """
  Segment the object within a bounding box.

  Returns {:ok, masks} for the object in the given bbox.
  """
  def segment_box(image_path, %{x: x, y: y, w: w, h: h}, _opts \\ []) do
    with {:ok, image_url} <- upload_for_replicate(image_path) do
      # SAM expects bbox as [x1, y1, x2, y2]
      input = %{
        "image" => image_url,
        "box" => [x, y, x + w, y + h]
      }

      run_sam2(input)
    end
  end

  @doc """
  Download masks and create DetectedRegion structs.

  Takes the raw SAM output and:
  1. Downloads each mask image
  2. Extracts bounding boxes from masks
  3. Creates DetectedRegion structs

  Returns {:ok, regions} or {:error, reason}.
  """
  def download_and_create_regions(document_id, sam_output, output_dir) do
    # SAM 2 returns:
    # - combined_mask: single visualization
    # - individual_masks: array of mask URLs

    individual_masks = Map.get(sam_output, "individual_masks", [])

    if Enum.empty?(individual_masks) do
      Logger.info("SAM 2 returned no masks")
      {:ok, []}
    else
      Logger.info("SAM 2 returned #{length(individual_masks)} masks")

      regions =
        individual_masks
        |> Enum.with_index()
        |> Enum.map(fn {mask_url, index} ->
          download_mask_and_create_region(document_id, mask_url, output_dir, index)
        end)
        |> Enum.filter(&match?({:ok, _}, &1))
        |> Enum.map(fn {:ok, region} -> region end)

      {:ok, regions}
    end
  end

  defp download_mask_and_create_region(document_id, mask_url, output_dir, index) do
    mask_filename = "mask_#{index}_#{System.system_time(:millisecond)}.png"
    mask_path = Path.join(output_dir, mask_filename)

    case download_file(mask_url, mask_path) do
      {:ok, _} ->
        # Extract bbox from mask using ImageMagick
        case extract_bbox_from_mask(mask_path) do
          {:ok, bbox} ->
            region = DetectedRegion.from_sam_mask(
              document_id,
              mask_path,
              bbox,
              confidence: 1.0,
              z_index: index
            )
            {:ok, region}

          {:error, reason} ->
            Logger.warning("Failed to extract bbox from mask: #{inspect(reason)}")
            {:error, reason}
        end

      {:error, reason} ->
        Logger.warning("Failed to download mask: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp extract_bbox_from_mask(mask_path) do
    # Use ImageMagick to find the bounding box of non-transparent pixels
    # -format '%@' gives us the trim box: WxH+X+Y
    args = [mask_path, "-format", "%@", "info:"]

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {output, 0} ->
        case parse_trim_box(String.trim(output)) do
          {:ok, bbox} -> {:ok, bbox}
          :error -> {:error, :parse_failed}
        end

      {output, _} ->
        Logger.error("Failed to extract bbox: #{output}")
        {:error, :imagemagick_failed}
    end
  end

  defp parse_trim_box(trim_string) do
    # Format: "WxH+X+Y" e.g., "100x50+25+30"
    case Regex.run(~r/(\d+)x(\d+)\+(\d+)\+(\d+)/, trim_string) do
      [_, w, h, x, y] ->
        {:ok, %{
          x: String.to_integer(x),
          y: String.to_integer(y),
          w: String.to_integer(w),
          h: String.to_integer(h)
        }}

      _ ->
        :error
    end
  end

  defp run_sam2(input) do
    model_version = Config.sam2_model_version()

    # SAM 2 takes longer than inpainting, allow more time
    case ReplicateClient.run(model_version, input, max_attempts: 180, poll_interval_ms: 1000) do
      {:ok, output} when is_map(output) ->
        {:ok, output}

      {:ok, output_url} when is_binary(output_url) ->
        # Sometimes returns just a URL
        {:ok, %{"combined_mask" => output_url}}

      {:ok, other} ->
        Logger.warning("Unexpected SAM 2 output format: #{inspect(other)}")
        {:ok, %{"individual_masks" => []}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Upload image to accessible URL for Replicate
  # - Small files (<256KB): use data URLs (base64) - faster, no extra API call
  # - Large files (>=256KB): upload to Replicate's file hosting
  defp upload_for_replicate(file_path) do
    case File.stat(file_path) do
      {:ok, %{size: size}} ->
        size_kb = div(size, 1024)
        max_data_url_kb = 256

        if size_kb >= max_data_url_kb do
          Logger.info("File #{size_kb}KB, using Replicate file upload")
          ReplicateClient.upload_file(file_path)
        else
          create_data_url(file_path)
        end

      {:error, reason} ->
        {:error, {:file_stat_failed, reason}}
    end
  end

  defp create_data_url(file_path) do
    case File.read(file_path) do
      {:ok, data} ->
        mime_type = mime_type_for(file_path)
        data_url = "data:#{mime_type};base64,#{Base.encode64(data)}"
        {:ok, data_url}

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

  defp download_file(url, output_path) do
    case Req.get(url, receive_timeout: 60_000) do
      {:ok, %{status: 200, body: body}} ->
        File.mkdir_p!(Path.dirname(output_path))
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
end
