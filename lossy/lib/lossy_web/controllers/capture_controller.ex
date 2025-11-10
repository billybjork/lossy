defmodule LossyWeb.CaptureController do
  use LossyWeb, :controller

  alias Lossy.Documents
  alias Lossy.Assets

  def create(conn, params) do
    # Create document and save image if provided
    with {:ok, document} <- Documents.create_capture(params),
         {:ok, document} <- maybe_save_image(document, params),
         :ok <- Documents.enqueue_text_detection(document) do
      conn
      |> put_status(:created)
      |> json(%{id: document.id, status: document.status})
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})

      {:error, reason} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: to_string(reason)})
    end
  end

  # Save image from URL if provided
  defp maybe_save_image(document, %{"image_url" => image_url}) when is_binary(image_url) do
    with {:ok, asset} <- Assets.save_image_from_url(document.id, image_url, :original),
         {:ok, document} <-
           Documents.update_document(document, %{
             original_asset_id: asset.id,
             dimensions: %{width: asset.width, height: asset.height}
           }) do
      {:ok, document}
    end
  end

  # Save image from base64 data if provided
  defp maybe_save_image(document, %{"image_data" => image_data}) when is_binary(image_data) do
    with {:ok, asset} <- Assets.save_image_from_base64(document.id, image_data, :original),
         {:ok, document} <-
           Documents.update_document(document, %{
             original_asset_id: asset.id,
             dimensions: %{width: asset.width, height: asset.height}
           }) do
      {:ok, document}
    end
  end

  # No image provided - this is ok for now (will be updated to require one later)
  defp maybe_save_image(document, _params), do: {:ok, document}

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end
