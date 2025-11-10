defmodule Lossy.Assets do
  @moduledoc """
  The Assets context for managing binary assets (images, masks, etc).
  """

  import Ecto.Query, warn: false
  alias Lossy.Repo
  alias Lossy.Documents.Asset

  @upload_dir "priv/static/uploads"

  @doc """
  Creates an asset.
  """
  def create_asset(attrs \\ %{}) do
    %Asset{}
    |> Asset.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Gets a single asset.
  """
  def get_asset(id) do
    Repo.get(Asset, id)
  end

  @doc """
  Saves a base64-encoded image to disk and creates an Asset record.
  Returns {:ok, asset} on success, {:error, reason} on failure.
  """
  def save_image_from_base64(document_id, base64_data, kind \\ :original) do
    with {:ok, binary_data, content_type} <- decode_base64_image(base64_data),
         {:ok, dimensions} <- get_image_dimensions(binary_data),
         {:ok, file_path} <- write_image_file(document_id, kind, binary_data),
         sha256 <- compute_sha256(binary_data) do
      create_asset(%{
        document_id: document_id,
        kind: kind,
        storage_uri: file_path,
        width: dimensions.width,
        height: dimensions.height,
        sha256: sha256,
        metadata: %{content_type: content_type}
      })
    end
  end

  @doc """
  Downloads an image from a URL and creates an Asset record.
  Returns {:ok, asset} on success, {:error, reason} on failure.
  """
  def save_image_from_url(document_id, image_url, kind \\ :original) do
    with {:ok, binary_data, content_type} <- download_image(image_url),
         {:ok, dimensions} <- get_image_dimensions(binary_data),
         {:ok, file_path} <- write_image_file(document_id, kind, binary_data),
         sha256 <- compute_sha256(binary_data) do
      create_asset(%{
        document_id: document_id,
        kind: kind,
        storage_uri: file_path,
        width: dimensions.width,
        height: dimensions.height,
        sha256: sha256,
        metadata: %{content_type: content_type, source_url: image_url}
      })
    end
  end

  @doc """
  Returns the local file system path for an asset.
  For MVP, assumes storage_uri is a local path.
  """
  def local_path(%Asset{storage_uri: "file://" <> path}), do: path
  def local_path(%Asset{storage_uri: path}), do: path

  @doc """
  Returns the public URL path for serving an asset.
  """
  def public_url(%Asset{storage_uri: storage_uri}) do
    # Convert file path to web-accessible URL
    # e.g., "priv/static/uploads/abc/original.png" -> "/uploads/abc/original.png"
    case String.split(storage_uri, "/uploads/", parts: 2) do
      [_prefix, path] -> "/uploads/#{path}"
      _ -> storage_uri
    end
  end

  # Private functions

  defp download_image(url) do
    # Use Req to download the image
    case Req.get(url) do
      {:ok, %Req.Response{status: 200, body: body, headers: headers}} ->
        # Extract content type from headers
        content_type =
          headers
          |> Map.get("content-type", ["image/png"])
          |> List.first()
          |> String.split(";")
          |> List.first()

        {:ok, body, content_type}

      {:ok, %Req.Response{status: status}} ->
        {:error, "HTTP #{status}"}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp decode_base64_image(base64_data) do
    # Handle data URLs: "data:image/png;base64,..."
    case String.split(base64_data, ",", parts: 2) do
      [header, data] ->
        content_type = extract_content_type(header)
        case Base.decode64(data) do
          {:ok, binary} -> {:ok, binary, content_type}
          :error -> {:error, :invalid_base64}
        end

      _ ->
        {:error, :invalid_data_url}
    end
  end

  defp extract_content_type(header) do
    # Extract "image/png" from "data:image/png;base64"
    case Regex.run(~r/data:([^;]+)/, header) do
      [_, content_type] -> content_type
      _ -> "image/png"
    end
  end

  defp get_image_dimensions(binary_data) do
    # For MVP, we'll use ImageMagick via Mogrify to get dimensions
    # Write to temp file, identify, then delete
    temp_path = Path.join(System.tmp_dir!(), "temp_#{:rand.uniform(999999)}.png")

    try do
      File.write!(temp_path, binary_data)

      case System.cmd("identify", ["-format", "%w %h", temp_path]) do
        {output, 0} ->
          case String.split(String.trim(output), " ") do
            [width, height] ->
              {:ok, %{width: String.to_integer(width), height: String.to_integer(height)}}

            _ ->
              {:error, :invalid_image_format}
          end

        _ ->
          {:error, :identify_failed}
      end
    after
      File.rm(temp_path)
    end
  end

  defp write_image_file(document_id, kind, binary_data) do
    # Create directory: priv/static/uploads/{document_id}/
    dir = Path.join([@upload_dir, document_id])
    File.mkdir_p!(dir)

    # Save as: priv/static/uploads/{document_id}/{kind}.png
    file_path = Path.join(dir, "#{kind}.png")
    File.write!(file_path, binary_data)

    {:ok, file_path}
  end

  defp compute_sha256(binary_data) do
    :crypto.hash(:sha256, binary_data)
    |> Base.encode16(case: :lower)
  end
end
