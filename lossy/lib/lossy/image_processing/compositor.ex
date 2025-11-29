defmodule Lossy.ImageProcessing.Compositor do
  @moduledoc """
  Composite inpainted patches back into the working image.

  Uses ImageMagick for image composition operations.
  """

  require Logger

  @doc """
  Composite an inpainted patch back into the working image.

  The patch is placed at the specified position (top-left corner of bbox).
  """
  def composite_patch(working_image_path, patch_path, bbox) do
    x = trunc(bbox.x)
    y = trunc(bbox.y)

    # Use ImageMagick composite to overlay the patch
    args = [
      working_image_path,
      patch_path,
      "-geometry",
      "+#{x}+#{y}",
      "-composite",
      working_image_path
    ]

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {_, 0} ->
        Logger.info("Patch composited",
          working_image: working_image_path,
          patch: patch_path,
          position: {x, y}
        )

        {:ok, working_image_path}

      {output, _} ->
        Logger.error("Failed to composite patch", output: output)
        {:error, :composite_failed}
    end
  end

  @doc """
  Create a working copy of the original image.

  This is the image that gets modified during editing.
  """
  def create_working_copy(original_path, working_path) do
    case File.copy(original_path, working_path) do
      {:ok, _} ->
        {:ok, working_path}

      {:error, reason} ->
        {:error, {:copy_failed, reason}}
    end
  end

  @doc """
  Extract a region from an image.

  Useful for extracting patches for re-inpainting or analysis.
  """
  def extract_region(image_path, bbox, output_path) do
    x = trunc(bbox.x)
    y = trunc(bbox.y)
    w = trunc(bbox.w)
    h = trunc(bbox.h)

    args = [
      image_path,
      "-crop",
      "#{w}x#{h}+#{x}+#{y}",
      "+repage",
      output_path
    ]

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {_, 0} ->
        {:ok, output_path}

      {output, _} ->
        Logger.error("Failed to extract region", output: output)
        {:error, :extract_failed}
    end
  end
end
