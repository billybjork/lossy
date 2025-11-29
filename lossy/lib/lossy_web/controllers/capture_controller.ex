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
      has_text_regions: Map.has_key?(params, "text_regions"),
      text_regions_count: length(params["text_regions"] || []),
      detection_backend: params["detection_backend"],
      detection_time_ms: params["detection_time_ms"]
    )

    # Create document with :processing status (async processing will happen in background)
    case Documents.create_capture(Map.put(params, "status", "processing")) do
      {:ok, document} ->
        # Spawn async task for image download and text region creation
        # This allows us to return immediately and open the editor tab faster
        Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
          process_capture_async(document.id, params)
        end)

        Logger.info("Capture created, processing async",
          document_id: document.id,
          status: :processing
        )

        conn
        |> put_status(:created)
        |> json(%{id: document.id, status: :processing})

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

  # Async processing of capture - downloads image and creates text regions
  defp process_capture_async(document_id, params) do
    Logger.info("Starting async capture processing", document_id: document_id)

    document = Documents.get_document(document_id)

    # Step 1: Download and save image
    case maybe_save_image(document, params) do
      {:ok, document} ->
        Logger.info("Image saved, processing text detection", document_id: document_id)

        # Step 2: Create text regions
        case handle_text_detection(document, params) do
          :ok ->
            Logger.info("Capture processing completed", document_id: document_id)

          {:error, reason} ->
            Logger.error("Text detection failed",
              document_id: document_id,
              reason: inspect(reason)
            )

            Documents.update_document(document, %{status: :error})
        end

      {:error, reason} ->
        Logger.error("Image save failed in async processing",
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

  # Save image from URL if provided
  defp maybe_save_image(document, %{"image_url" => image_url}) when is_binary(image_url) do
    with {:ok, asset} <- Assets.save_image_from_url(document.id, image_url, :original) do
      Documents.update_document(document, %{
        original_asset_id: asset.id,
        width: asset.width,
        height: asset.height
      })
    end
  end

  # Save image from base64 data if provided
  defp maybe_save_image(document, %{"image_data" => image_data}) when is_binary(image_data) do
    with {:ok, asset} <- Assets.save_image_from_base64(document.id, image_data, :original) do
      Documents.update_document(document, %{
        original_asset_id: asset.id,
        width: asset.width,
        height: asset.height
      })
    end
  end

  # No image provided - this is ok for now (will be updated to require one later)
  defp maybe_save_image(document, _params), do: {:ok, document}

  # Handle text detection: use local results if provided, otherwise enqueue cloud detection
  defp handle_text_detection(document, %{"text_regions" => text_regions})
       when is_list(text_regions) and length(text_regions) > 0 do
    Logger.info("Using local text detection results",
      document_id: document.id,
      region_count: length(text_regions)
    )

    # Create text regions from local detection and update document status
    with {:ok, _count} <-
           Documents.create_text_regions_from_local_detection(document, text_regions),
         {:ok, _document} <- Documents.update_document(document, %{status: :awaiting_edits}) do
      :ok
    end
  end

  defp handle_text_detection(document, _params) do
    # No local detection results - update status to awaiting_edits with no regions
    # The user can still use the image but won't have text regions to edit
    Logger.info("No local detection results provided",
      document_id: document.id
    )

    {:ok, _document} = Documents.update_document(document, %{status: :awaiting_edits})
    :ok
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end
