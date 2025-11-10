defmodule Lossy.Documents do
  @moduledoc """
  The Documents context.
  """

  import Ecto.Query, warn: false
  alias Lossy.Repo

  alias Lossy.Documents.{Document, TextRegion, ProcessingJob}

  ## Documents

  @doc """
  Creates a document from a capture request.
  """
  def create_capture(attrs \\ %{}) do
    %Document{}
    |> Document.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Gets a single document with preloaded associations.
  """
  def get_document(id) do
    Document
    |> Repo.get(id)
    |> Repo.preload([:text_regions, :processing_jobs, :original_asset, :working_asset])
  end

  @doc """
  Updates a document.
  """
  def update_document(%Document{} = document, attrs) do
    case document
         |> Document.changeset(attrs)
         |> Repo.update() do
      {:ok, updated_doc} = result ->
        # Broadcast update to LiveView subscribers
        broadcast_document_update(updated_doc)
        result

      error ->
        error
    end
  end

  defp broadcast_document_update(%Document{} = document) do
    # Reload document with all associations
    document = get_document(document.id)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  ## Text Regions

  @doc """
  Creates a text region.
  """
  def create_text_region(attrs \\ %{}) do
    %TextRegion{}
    |> TextRegion.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Updates a text region.
  """
  def update_text_region(%TextRegion{} = region, attrs) do
    region
    |> TextRegion.changeset(attrs)
    |> Repo.update()
  end

  ## Processing Jobs

  @doc """
  Creates a processing job.
  """
  def create_processing_job(attrs \\ %{}) do
    %ProcessingJob{}
    |> ProcessingJob.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Enqueue text detection for a document (stubbed for MVP).
  Creates fake text regions for testing the editor UI.
  """
  def enqueue_text_detection(%Document{} = document) do
    # Update document status to detecting
    {:ok, document} = update_document(document, %{status: :detecting})

    # Spawn async task to simulate detection
    Task.start(fn ->
      # Simulate processing delay
      Process.sleep(1000)

      # Create stubbed text regions for testing
      create_stubbed_text_regions(document)

      # Update document status to awaiting_edits
      update_document(document, %{status: :awaiting_edits})
    end)

    :ok
  end

  @doc """
  Creates stubbed text regions for testing.
  These are fake regions with realistic bounding boxes and sample text.
  """
  def create_stubbed_text_regions(%Document{} = document) do
    # Get image dimensions, or use defaults if not available
    dimensions = document.dimensions || %{"width" => 1200, "height" => 800}
    width = dimensions["width"] || 1200
    height = dimensions["height"] || 800

    # Create a few sample text regions
    regions = [
      %{
        document_id: document.id,
        bbox: %{x: width * 0.1, y: height * 0.1, w: width * 0.3, h: 40},
        polygon: [],
        original_text: "Sample Headline",
        current_text: "Sample Headline",
        font_family: "Arial",
        font_weight: 700,
        font_size_px: 32,
        color_rgba: "rgba(0,0,0,1)",
        alignment: :left,
        status: :detected,
        z_index: 1,
        padding_px: 10
      },
      %{
        document_id: document.id,
        bbox: %{x: width * 0.1, y: height * 0.25, w: width * 0.5, h: 24},
        polygon: [],
        original_text: "This is some body text that was detected in the image.",
        current_text: "This is some body text that was detected in the image.",
        font_family: "Arial",
        font_weight: 400,
        font_size_px: 16,
        color_rgba: "rgba(0,0,0,1)",
        alignment: :left,
        status: :detected,
        z_index: 2,
        padding_px: 8
      },
      %{
        document_id: document.id,
        bbox: %{x: width * 0.6, y: height * 0.5, w: width * 0.25, h: 28},
        polygon: [],
        original_text: "Button Text",
        current_text: "Button Text",
        font_family: "Arial",
        font_weight: 600,
        font_size_px: 18,
        color_rgba: "rgba(255,255,255,1)",
        alignment: :center,
        status: :detected,
        z_index: 3,
        padding_px: 10
      }
    ]

    # Insert all regions
    Enum.each(regions, fn region_attrs ->
      create_text_region(region_attrs)
    end)
  end
end
