defmodule Lossy.ImageProcessing.XMP do
  @moduledoc """
  Embeds XMP Dublin Core metadata into PNG images using ImageMagick.

  XMP (Extensible Metadata Platform) is the industry standard for
  embedding provenance and source information in images. The Dublin Core
  schema is widely used for source attribution.
  """

  require Logger

  @doc """
  Embeds source URL as XMP Dublin Core `dc:source` field.

  Uses ImageMagick to read the image and write it with an XMP profile embedded.

  ## Arguments
    - `source_path` - Path to the input image
    - `source_url` - The URL to embed as the source
    - `output_path` - Path where the output image will be written

  ## Returns
    - `{:ok, output_path}` on success
    - `{:error, reason}` on failure

  ## Examples

      iex> XMP.embed_source_url("input.png", "https://example.com/page", "output.png")
      {:ok, "output.png"}

  """
  def embed_source_url(source_path, source_url, output_path) do
    # Generate XMP file content
    xmp_content = generate_xmp(source_url)
    xmp_file = Path.join(System.tmp_dir!(), "xmp_#{System.system_time(:millisecond)}.xmp")

    try do
      File.write!(xmp_file, xmp_content)

      # Use ImageMagick to embed XMP profile
      # The -profile option embeds the XMP data into the image
      args = [
        source_path,
        "-profile",
        xmp_file,
        output_path
      ]

      case System.cmd("convert", args, stderr_to_stdout: true) do
        {_, 0} ->
          Logger.info("XMP metadata embedded", source_url: source_url, output: output_path)
          {:ok, output_path}

        {error, exit_code} ->
          Logger.error("Failed to embed XMP",
            error: error,
            exit_code: exit_code,
            source: source_path
          )

          {:error, :xmp_embed_failed}
      end
    after
      File.rm(xmp_file)
    end
  end

  @doc """
  Generates XMP metadata XML with Dublin Core source field.
  """
  def generate_xmp(source_url) do
    """
    <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about=""
          xmlns:dc="http://purl.org/dc/elements/1.1/"
          xmlns:xmp="http://ns.adobe.com/xap/1.0/">
          <dc:source>#{escape_xml(source_url)}</dc:source>
          <xmp:CreatorTool>Lossy</xmp:CreatorTool>
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """
  end

  defp escape_xml(nil), do: ""

  defp escape_xml(str) do
    str
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
    |> String.replace("'", "&apos;")
  end
end
