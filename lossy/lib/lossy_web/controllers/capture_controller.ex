defmodule LossyWeb.CaptureController do
  use LossyWeb, :controller

  require Logger
  alias Lossy.Assets
  alias Lossy.Documents

  def create(conn, params) do
    Logger.info("Capture request received",
      capture_mode: params["capture_mode"],
      has_image_url: Map.has_key?(params, "image_url"),
      has_image_data: Map.has_key?(params, "image_data"),
      image_width: params["image_width"],
      image_height: params["image_height"]
    )

    # Create document with :loading status and initial dimensions from extension
    # Map image_width/image_height to width/height for the schema
    attrs =
      params
      |> Map.put("status", "loading")
      |> maybe_add_dimensions()

    case Documents.create_capture(attrs) do
      {:ok, document} ->
        # Spawn async task for image download and text region creation
        # This allows us to return immediately and open the editor tab faster
        Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
          process_capture_async(document.id, params)
        end)

        Logger.info("Capture created, processing async",
          document_id: document.id,
          status: :loading
        )

        conn
        |> put_status(:created)
        |> json(%{id: document.id, status: :loading})

      {:error, %Ecto.Changeset{} = changeset} ->
        Logger.error("Capture creation failed with validation errors",
          errors: inspect(changeset.errors)
        )

        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})

      {:error, reason} ->
        Logger.error("Capture creation failed", reason: inspect(reason))

        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: to_string(reason)})
    end
  end

  # Async processing of capture - downloads image and saves text/segment regions
  defp process_capture_async(document_id, params) do
    Logger.info("Starting async capture processing", document_id: document_id)

    document = Documents.get_document(document_id)

    with {:ok, document} <- maybe_save_image(document, params),
         :ok <- maybe_save_text_regions(document, params),
         :ok <- maybe_save_segment_regions(document, params) do
      # Image and regions saved, mark document as ready
      Documents.update_document(document, %{status: :ready})
      Logger.info("Capture processing completed", document_id: document_id)
    else
      {:error, reason} ->
        Logger.error("Capture processing failed",
          document_id: document_id,
          reason: inspect(reason)
        )

        Documents.update_document(document, %{status: :error})
    end
  rescue
    e ->
      Logger.error("Async capture processing crashed",
        document_id: document_id,
        error: Exception.message(e),
        stacktrace: Exception.format_stacktrace(__STACKTRACE__)
      )

      # Try to update document status to error
      if document = Documents.get_document(document_id) do
        Documents.update_document(document, %{status: :error})
      end
  end

  # Map image_width/image_height from extension payload to width/height for schema
  defp maybe_add_dimensions(params) do
    width = params["image_width"]
    height = params["image_height"]

    params
    |> maybe_put("width", width)
    |> maybe_put("height", height)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  # Save image from URL if provided
  # Only updates dimensions if not already set (extension may have provided them)
  defp maybe_save_image(document, %{"image_url" => image_url}) when is_binary(image_url) do
    opts = [document_name: document.name]

    with {:ok, asset} <- Assets.save_image_from_url(document.id, image_url, :original, opts) do
      attrs = %{original_asset_id: asset.id}
      # Only set dimensions if not already provided by extension
      attrs = if document.width, do: attrs, else: Map.put(attrs, :width, asset.width)
      attrs = if document.height, do: attrs, else: Map.put(attrs, :height, asset.height)
      Documents.update_document(document, attrs)
    end
  end

  # Save image from base64 data if provided
  # Only updates dimensions if not already set (extension may have provided them)
  defp maybe_save_image(document, %{"image_data" => image_data}) when is_binary(image_data) do
    opts = [document_name: document.name]

    with {:ok, asset} <- Assets.save_image_from_base64(document.id, image_data, :original, opts) do
      attrs = %{original_asset_id: asset.id}
      # Only set dimensions if not already provided by extension
      attrs = if document.width, do: attrs, else: Map.put(attrs, :width, asset.width)
      attrs = if document.height, do: attrs, else: Map.put(attrs, :height, asset.height)
      Documents.update_document(document, attrs)
    end
  end

  # No image provided - this is ok for now (will be updated to require one later)
  defp maybe_save_image(document, _params), do: {:ok, document}

  # Save text regions as DetectedRegion records if provided
  defp maybe_save_text_regions(document, %{"text_regions" => text_regions})
       when is_list(text_regions) and length(text_regions) > 0 do
    Logger.info("Saving text regions",
      document_id: document.id,
      region_count: length(text_regions)
    )

    {:ok, _regions} =
      Documents.create_detected_regions_from_text_detection(document, text_regions)

    :ok
  end

  # No text regions provided - this is fine
  defp maybe_save_text_regions(_document, _params), do: :ok

  # Save segment (object) regions as DetectedRegion records if provided
  defp maybe_save_segment_regions(document, %{"segment_regions" => segment_regions})
       when is_list(segment_regions) and length(segment_regions) > 0 do
    Logger.info("Saving segment regions",
      document_id: document.id,
      segment_count: length(segment_regions)
    )

    {:ok, _regions} =
      Documents.create_detected_regions_from_segments(document, segment_regions)

    :ok
  end

  # No segment regions provided - this is fine
  defp maybe_save_segment_regions(_document, _params), do: :ok

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end
