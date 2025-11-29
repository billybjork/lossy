defmodule Lossy.ImageProcessing.Mask do
  @moduledoc """
  Generate binary masks for inpainting.

  Creates black/white PNG masks where white indicates regions to inpaint.
  Uses ImageMagick (via Mogrify) for mask generation.
  """

  require Logger

  @doc """
  Generate a binary mask PNG for inpainting a text region.

  The mask is the same size as the input image with:
  - Black (0,0,0) for areas to preserve
  - White (255,255,255) for areas to inpaint

  Options:
  - :padding_px - Extra padding around the bbox (default: 10)
  """
  def generate_mask(image_path, bbox, opts \\ []) do
    padding = Keyword.get(opts, :padding_px, 10)

    # Get image dimensions
    with {:ok, {width, height}} <- get_image_dimensions(image_path) do
      # Calculate padded bbox (clamped to image bounds)
      x = max(0, trunc(bbox.x - padding))
      y = max(0, trunc(bbox.y - padding))
      w = min(width - x, trunc(bbox.w + 2 * padding))
      h = min(height - y, trunc(bbox.h + 2 * padding))

      # Generate mask file path
      mask_path = generate_mask_path(image_path)

      # Create mask using ImageMagick
      case create_mask_file(width, height, x, y, w, h, mask_path) do
        :ok ->
          Logger.info("Mask generated",
            mask_path: mask_path,
            bbox: %{x: x, y: y, w: w, h: h}
          )

          {:ok, mask_path}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  @doc """
  Generate a mask for multiple regions combined.
  """
  def generate_combined_mask(image_path, bboxes, opts \\ []) when is_list(bboxes) do
    padding = Keyword.get(opts, :padding_px, 10)

    with {:ok, {width, height}} <- get_image_dimensions(image_path) do
      mask_path = generate_mask_path(image_path)

      # Build draw commands for all regions
      draw_commands =
        bboxes
        |> Enum.map(fn bbox ->
          x = max(0, trunc(bbox.x - padding))
          y = max(0, trunc(bbox.y - padding))
          w = min(width - x, trunc(bbox.w + 2 * padding))
          h = min(height - y, trunc(bbox.h + 2 * padding))

          "rectangle #{x},#{y} #{x + w},#{y + h}"
        end)
        |> Enum.join(" ")

      # Create mask with all regions
      args = [
        "-size",
        "#{width}x#{height}",
        "xc:black",
        "-fill",
        "white",
        "-draw",
        draw_commands,
        mask_path
      ]

      case System.cmd("convert", args, stderr_to_stdout: true) do
        {_, 0} ->
          {:ok, mask_path}

        {output, _} ->
          Logger.error("Failed to create combined mask", output: output)
          {:error, :mask_creation_failed}
      end
    end
  end

  defp get_image_dimensions(image_path) do
    case System.cmd("identify", ["-format", "%w %h", image_path], stderr_to_stdout: true) do
      {output, 0} ->
        [width_str, height_str] = String.split(String.trim(output), " ")
        {:ok, {String.to_integer(width_str), String.to_integer(height_str)}}

      {output, _} ->
        Logger.error("Failed to get image dimensions", output: output, path: image_path)
        {:error, :identify_failed}
    end
  end

  defp create_mask_file(width, height, x, y, w, h, mask_path) do
    # Use ImageMagick convert to create a black image with a white rectangle
    args = [
      "-size",
      "#{width}x#{height}",
      "xc:black",
      "-fill",
      "white",
      "-draw",
      "rectangle #{x},#{y} #{x + w},#{y + h}",
      mask_path
    ]

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {_, 0} ->
        :ok

      {output, _} ->
        Logger.error("Failed to create mask", output: output)
        {:error, :mask_creation_failed}
    end
  end

  defp generate_mask_path(image_path) do
    dir = Path.dirname(image_path)
    basename = Path.basename(image_path, Path.extname(image_path))
    timestamp = System.system_time(:millisecond)
    Path.join(dir, "#{basename}_mask_#{timestamp}.png")
  end
end
