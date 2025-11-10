defmodule LossyWeb.CaptureController do
  use LossyWeb, :controller

  alias Lossy.Documents

  def create(conn, params) do
    # For MVP stub: accept source_url and capture_mode, create a basic document
    with {:ok, document} <- Documents.create_capture(params),
         :ok <- Documents.enqueue_text_detection(document) do
      conn
      |> put_status(:created)
      |> json(%{id: document.id, status: document.status})
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end
