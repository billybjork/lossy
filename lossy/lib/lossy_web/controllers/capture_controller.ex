defmodule LossyWeb.CaptureController do
  use LossyWeb, :controller

  require Logger
  alias Lossy.Assets
  alias Lossy.Documents

  def create(conn, params) do
    Logger.info("Capture request received",
      capture_mode: params["capture_mode"],
      has_image_url: Map.has_key?(params, "image_url"),
      has_image_data: Map.has_key?(params, "image_data")
    )

    # Create document and save image if provided
    with {:ok, document} <- Documents.create_capture(params),
         {:ok, document} <- maybe_save_image(document, params),
         :ok <- Documents.enqueue_text_detection(document) do
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

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end
