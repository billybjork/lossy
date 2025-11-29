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

    # Create document and save image if provided
    with {:ok, document} <- Documents.create_capture(params),
         {:ok, document} <- maybe_save_image(document, params),
         :ok <- handle_text_detection(document, params) do
      Logger.info("Capture created successfully",
        document_id: document.id,
        status: document.status
      )

      conn
      |> put_status(:created)
      |> json(%{id: document.id, status: document.status})
    else
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
