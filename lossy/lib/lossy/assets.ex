defmodule Lossy.Assets do
  @moduledoc """
  The Assets context for managing binary assets (images, masks, etc).
  """

  require Logger
  import Ecto.Query, warn: false
  alias Lossy.Documents.Asset
  alias Lossy.Repo

  @upload_dir "priv/static/uploads"
  # 50MB
  @max_file_size 50 * 1024 * 1024
  @allowed_content_types ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]
  # 30 seconds
  @http_timeout 30_000
  @max_redirects 3

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
    Logger.info("Saving image from base64", document_id: document_id, kind: kind)

    with {:ok, binary_data, content_type} <- decode_base64_image(base64_data),
         :ok <- validate_file_size(binary_data),
         :ok <- validate_content_type(content_type),
         {:ok, dimensions} <- get_image_dimensions(binary_data),
         {:ok, file_path} <- write_image_file(document_id, kind, binary_data),
         sha256 <- compute_sha256(binary_data) do
      Logger.info("Image saved successfully from base64",
        document_id: document_id,
        kind: kind,
        width: dimensions.width,
        height: dimensions.height
      )

      create_asset(%{
        document_id: document_id,
        kind: kind,
        storage_uri: file_path,
        width: dimensions.width,
        height: dimensions.height,
        sha256: sha256,
        metadata: %{content_type: content_type}
      })
    else
      {:error, reason} = error ->
        Logger.error("Failed to save image from base64",
          document_id: document_id,
          kind: kind,
          reason: inspect(reason)
        )

        error
    end
  end

  @doc """
  Downloads an image from a URL and creates an Asset record.
  Returns {:ok, asset} on success, {:error, reason} on failure.
  """
  def save_image_from_url(document_id, image_url, kind \\ :original) do
    Logger.info("Downloading image from URL",
      document_id: document_id,
      kind: kind,
      url: image_url
    )

    with :ok <- validate_url(image_url),
         {:ok, binary_data, content_type} <- download_image(image_url),
         :ok <- validate_file_size(binary_data),
         :ok <- validate_content_type(content_type),
         {:ok, dimensions} <- get_image_dimensions(binary_data),
         {:ok, file_path} <- write_image_file(document_id, kind, binary_data),
         sha256 <- compute_sha256(binary_data) do
      Logger.info("Image downloaded and saved successfully",
        document_id: document_id,
        kind: kind,
        url: image_url,
        width: dimensions.width,
        height: dimensions.height
      )

      create_asset(%{
        document_id: document_id,
        kind: kind,
        storage_uri: file_path,
        width: dimensions.width,
        height: dimensions.height,
        sha256: sha256,
        metadata: %{content_type: content_type, source_url: image_url}
      })
    else
      {:error, reason} = error ->
        Logger.error("Failed to download image from URL",
          document_id: document_id,
          kind: kind,
          url: image_url,
          reason: inspect(reason)
        )

        # Clean up any partial files on error
        cleanup_document_files(document_id, kind)
        error
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
    # Use Req to download the image with timeout and redirect limits
    case Req.get(url, receive_timeout: @http_timeout, max_redirects: @max_redirects) do
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
    temp_path = Path.join(System.tmp_dir!(), "temp_#{:rand.uniform(999_999)}.png")

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

  # Security validation functions

  defp validate_url(url) do
    uri = URI.parse(url)

    cond do
      uri.scheme not in ["http", "https"] ->
        {:error, :invalid_url_scheme}

      is_nil(uri.host) ->
        {:error, :invalid_url}

      blocked_host?(uri.host) ->
        {:error, :blocked_host}

      private_ip?(uri.host) ->
        {:error, :private_network}

      true ->
        :ok
    end
  end

  # Block localhost and AWS metadata endpoint (SSRF protection)
  defp blocked_host?(host) do
    blocked_hosts = [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      # AWS metadata endpoint
      "169.254.169.254",
      # IPv6 localhost
      "[::1]"
    ]

    String.downcase(host) in blocked_hosts
  end

  # Check for private IP ranges (10.x, 192.168.x, 172.16-31.x)
  defp private_ip?(host) do
    cond do
      String.starts_with?(host, "192.168.") -> true
      String.starts_with?(host, "10.") -> true
      String.starts_with?(host, "172.") -> private_172_network?(host)
      true -> false
    end
  end

  # Check if IP is in 172.16.0.0 - 172.31.255.255 range
  defp private_172_network?(host) do
    case String.split(host, ".") do
      ["172", second | _] ->
        case Integer.parse(second) do
          {num, _} when num >= 16 and num <= 31 -> true
          _ -> false
        end

      _ ->
        false
    end
  end

  defp validate_file_size(binary_data) do
    size = byte_size(binary_data)

    if size > @max_file_size do
      {:error, :file_too_large}
    else
      :ok
    end
  end

  defp validate_content_type(content_type) do
    if content_type in @allowed_content_types do
      :ok
    else
      {:error, :unsupported_content_type}
    end
  end

  defp cleanup_document_files(document_id, kind) do
    # Clean up any files that may have been written before error
    file_path = Path.join([@upload_dir, document_id, "#{kind}.png"])

    if File.exists?(file_path) do
      Logger.info("Cleaning up orphaned file", file_path: file_path)
      File.rm(file_path)
    end
  end
end
