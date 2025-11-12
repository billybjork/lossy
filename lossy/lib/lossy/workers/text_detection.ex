defmodule Lossy.Workers.TextDetection do
  @moduledoc """
  Oban worker for processing text detection on documents.
  """

  use Oban.Worker, queue: :ml, max_attempts: 3

  require Logger
  alias Lossy.Documents

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"document_id" => document_id}}) do
    Logger.info("Starting text detection", document_id: document_id)

    document = Documents.get_document(document_id)

    if is_nil(document) do
      Logger.error("Document not found", document_id: document_id)
      {:error, :document_not_found}
    else
      try do
        # Update document status to detecting
        {:ok, document} = Documents.update_document(document, %{status: :detecting})

        # Simulate processing delay (MVP stubbed detection)
        Process.sleep(1000)

        # Create stubbed text regions for testing
        Documents.create_stubbed_text_regions(document)

        # Update document status to awaiting_edits
        {:ok, _document} = Documents.update_document(document, %{status: :awaiting_edits})

        Logger.info("Text detection completed", document_id: document_id)
        :ok
      rescue
        error ->
          Logger.error("Text detection failed",
            document_id: document_id,
            error: Exception.message(error),
            stacktrace: Exception.format_stacktrace(__STACKTRACE__)
          )

          # Update document status to error so it doesn't get stuck
          Documents.update_document(document, %{status: :error})

          # Re-raise so Oban can retry or mark as failed
          reraise error, __STACKTRACE__
      end
    end
  end
end
