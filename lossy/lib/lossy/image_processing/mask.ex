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
  - :padding_px - Extra padding around the bbox (default: adaptive based on bbox height)
  - :blur_radius - Gaussian blur radius for feathering (default: 10)
  """
  def generate_mask(image_path, bbox, opts \\ []) do
    # Normalize bbox to use atom keys (handles both string and atom keys)
    bbox = normalize_bbox(bbox)

    # Use adaptive padding if not explicitly provided
    padding =
      case Keyword.get(opts, :padding_px) do
        nil -> calculate_adaptive_padding(bbox)
        explicit_padding -> explicit_padding
      end

    blur_radius = Keyword.get(opts, :blur_radius, 10)

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
      case create_mask_file(width, height, x, y, w, h, mask_path, blur_radius) do
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
    # Normalize all bboxes to use atom keys
    bboxes = Enum.map(bboxes, &normalize_bbox/1)

    # Use adaptive padding if not explicitly provided (use average bbox height)
    padding =
      case Keyword.get(opts, :padding_px) do
        nil -> calculate_adaptive_padding_for_multiple(bboxes)
        explicit_padding -> explicit_padding
      end

    blur_radius = Keyword.get(opts, :blur_radius, 10)

    with {:ok, {width, height}} <- get_image_dimensions(image_path) do
      mask_path = generate_mask_path(image_path)

      # Build draw commands for all regions
      draw_commands =
        Enum.map_join(bboxes, " ", fn bbox ->
          x = max(0, trunc(bbox.x - padding))
          y = max(0, trunc(bbox.y - padding))
          w = min(width - x, trunc(bbox.w + 2 * padding))
          h = min(height - y, trunc(bbox.h + 2 * padding))

          "rectangle #{x},#{y} #{x + w},#{y + h}"
        end)

      # Create mask with all regions and feathering
      args = [
        "-size",
        "#{width}x#{height}",
        "xc:black",
        "-fill",
        "white",
        "-draw",
        draw_commands,
        "-blur",
        "0x#{blur_radius}",
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

  defp create_mask_file(width, height, x, y, w, h, mask_path, blur_radius) do
    # Use ImageMagick convert to create a black image with a white rectangle
    # Apply Gaussian blur for feathered edges (better blending)
    args = [
      "-size",
      "#{width}x#{height}",
      "xc:black",
      "-fill",
      "white",
      "-draw",
      "rectangle #{x},#{y} #{x + w},#{y + h}",
      "-blur",
      "0x#{blur_radius}",
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

  defp calculate_adaptive_padding(bbox) do
    # Calculate padding as 20% of bbox height, clamped between 10-50px
    # This ensures larger text gets more padding (captures shadows/antialiasing)
    # while smaller text doesn't waste processing time
    bbox.h
    |> Kernel.*(0.2)
    |> trunc()
    |> max(10)
    |> min(50)
  end

  defp calculate_adaptive_padding_for_multiple(bboxes) do
    # For multiple regions, use the average height
    avg_height =
      bboxes
      |> Enum.map(& &1.h)
      |> Enum.sum()
      |> Kernel./(length(bboxes))

    # Calculate padding based on average height
    avg_height
    |> Kernel.*(0.2)
    |> trunc()
    |> max(10)
    |> min(50)
  end

  defp generate_mask_path(image_path) do
    dir = Path.dirname(image_path)
    basename = Path.basename(image_path, Path.extname(image_path))
    timestamp = System.system_time(:millisecond)
    Path.join(dir, "#{basename}_mask_#{timestamp}.png")
  end

  defp normalize_bbox(bbox) when is_map(bbox) do
    %{
      x: get_bbox_value(bbox, :x),
      y: get_bbox_value(bbox, :y),
      w: get_bbox_value(bbox, :w),
      h: get_bbox_value(bbox, :h)
    }
  end

  defp get_bbox_value(bbox, key) do
    Map.get(bbox, key) || Map.get(bbox, to_string(key)) || 0
  end

  @doc """
  Combine multiple mask PNGs into a single mask using OR operation.

  All white pixels from any input mask will be white in the output.
  Useful for batch inpainting multiple selected regions.

  Returns {:ok, output_path} or {:error, reason}.
  """
  def combine_masks(mask_paths, output_path)
      when is_list(mask_paths) and length(mask_paths) > 0 do
    if length(mask_paths) == 1 do
      # Single mask, just copy it
      case File.cp(hd(mask_paths), output_path) do
        :ok -> {:ok, output_path}
        {:error, reason} -> {:error, {:file_copy_failed, reason}}
      end
    else
      # Use ImageMagick to combine masks with max (OR) operation
      # -evaluate-sequence Max takes the maximum pixel value at each position
      args = mask_paths ++ ["-evaluate-sequence", "Max", output_path]

      case System.cmd("convert", args, stderr_to_stdout: true) do
        {_, 0} ->
          Logger.info("Combined #{length(mask_paths)} masks", output: output_path)
          {:ok, output_path}

        {output, _} ->
          Logger.error("Failed to combine masks", output: output)
          {:error, :mask_combine_failed}
      end
    end
  end

  def combine_masks([], _output_path) do
    {:error, :no_masks_provided}
  end
end
