defmodule Lossy.Documents do
  @moduledoc """
  The Documents context.
  """

  import Ecto.Query, warn: false
  alias Lossy.Repo

  alias Lossy.Documents.{Document, TextRegion, ProcessingJob, Asset}

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
    document
    |> Document.changeset(attrs)
    |> Repo.update()
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
  """
  def enqueue_text_detection(%Document{} = _document) do
    # Stubbed: In full implementation, this would:
    # 1. Create a ProcessingJob record
    # 2. Spawn async task via Task.Supervisor
    # 3. Call ML service
    # 4. Update document status
    :ok
  end
end
