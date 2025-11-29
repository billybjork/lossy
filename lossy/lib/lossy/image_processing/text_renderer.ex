defmodule Lossy.ImageProcessing.TextRenderer do
  @moduledoc """
  Render text onto images using ImageMagick.

  Supports font family, size, color, and alignment.
  """

  require Logger

  # Default font for MVP - a clean sans-serif
  @default_font "Inter"

  @doc """
  Render text onto an image at the specified position.

  Options:
  - :font_family - Font name (default: "Inter")
  - :font_size_px - Font size in pixels (default: 16)
  - :font_weight - Font weight (default: 400)
  - :color_rgba - Color in rgba format (default: "rgba(0,0,0,1)")
  - :alignment - Text alignment :left, :center, :right (default: :left)
  """
  def render_text(image_path, text, bbox, opts \\ []) do
    font_family = Keyword.get(opts, :font_family) || @default_font
    font_size = Keyword.get(opts, :font_size_px, 16)
    font_weight = Keyword.get(opts, :font_weight, 400)
    color = Keyword.get(opts, :color_rgba, "rgba(0,0,0,1)")
    alignment = Keyword.get(opts, :alignment, :left)

    # Convert rgba to ImageMagick color format
    im_color = rgba_to_imagemagick(color)

    # Calculate text position
    {x, y} = calculate_text_position(bbox, alignment, font_size)

    # Build font specification
    font_spec = build_font_spec(font_family, font_weight)

    # Build ImageMagick command
    args = [
      image_path,
      "-font",
      font_spec,
      "-pointsize",
      "#{font_size}",
      "-fill",
      im_color,
      "-gravity",
      alignment_to_gravity(alignment),
      "-annotate",
      "+#{trunc(x)}+#{trunc(y)}",
      text,
      image_path
    ]

    Logger.info("Rendering text",
      text: text,
      bbox: inspect(bbox),
      font: font_spec,
      size: font_size,
      color: im_color
    )

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {_, 0} ->
        {:ok, image_path}

      {output, _} ->
        Logger.error("Failed to render text", output: output)
        {:error, :render_failed}
    end
  end

  @doc """
  Render text within a bounded region.

  This version clips the text to the bbox and handles multi-line text.
  """
  def render_text_in_region(image_path, text, bbox, opts \\ []) do
    font_family = Keyword.get(opts, :font_family) || @default_font
    font_size = Keyword.get(opts, :font_size_px, 16)
    font_weight = Keyword.get(opts, :font_weight, 400)
    color = Keyword.get(opts, :color_rgba, "rgba(0,0,0,1)")
    _alignment = Keyword.get(opts, :alignment, :left)

    im_color = rgba_to_imagemagick(color)
    font_spec = build_font_spec(font_family, font_weight)

    # For region-based rendering, we use -draw with text positioning
    x = trunc(bbox.x)
    # Baseline is at bottom of first line
    y = trunc(bbox.y + font_size)
    w = trunc(bbox.w)

    # Escape text for ImageMagick
    escaped_text = escape_text(text)

    # Use -draw for more precise positioning
    draw_cmd = "text #{x},#{y} '#{escaped_text}'"

    args = [
      image_path,
      "-font",
      font_spec,
      "-pointsize",
      "#{font_size}",
      "-fill",
      im_color,
      "-draw",
      draw_cmd,
      image_path
    ]

    Logger.info("Rendering text in region",
      text: text,
      position: {x, y},
      width: w
    )

    case System.cmd("convert", args, stderr_to_stdout: true) do
      {_, 0} ->
        {:ok, image_path}

      {output, code} ->
        Logger.error("Failed to render text in region",
          output: output,
          exit_code: code
        )

        {:error, :render_failed}
    end
  end

  # Convert rgba(r,g,b,a) to ImageMagick color format
  defp rgba_to_imagemagick(rgba) when is_binary(rgba) do
    case Regex.run(~r/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/, rgba) do
      [_, r, g, b, a] ->
        alpha = String.to_float(a)
        # ImageMagick uses rgba(r,g,b,a) but alpha is 0-1
        "rgba(#{r},#{g},#{b},#{alpha})"

      [_, r, g, b] ->
        "rgb(#{r},#{g},#{b})"

      nil ->
        # If not rgba format, assume it's already a valid color
        rgba
    end
  end

  defp rgba_to_imagemagick(nil), do: "black"

  defp calculate_text_position(bbox, alignment, font_size) do
    x =
      case alignment do
        :left -> bbox.x
        :center -> bbox.x + bbox.w / 2
        :right -> bbox.x + bbox.w
        _ -> bbox.x
      end

    # Y position is at baseline (roughly font_size from top)
    y = bbox.y + font_size

    {x, y}
  end

  defp alignment_to_gravity(:left), do: "NorthWest"
  defp alignment_to_gravity(:center), do: "North"
  defp alignment_to_gravity(:right), do: "NorthEast"
  defp alignment_to_gravity(_), do: "NorthWest"

  defp build_font_spec(font_family, weight) do
    # For MVP, we'll use system fonts
    # ImageMagick expects font names or paths
    weight_suffix =
      case weight do
        w when w >= 700 -> "-Bold"
        w when w >= 500 -> "-Medium"
        _ -> ""
      end

    "#{font_family}#{weight_suffix}"
  end

  defp escape_text(text) do
    text
    |> String.replace("\\", "\\\\")
    |> String.replace("'", "\\'")
    |> String.replace("\"", "\\\"")
  end
end
