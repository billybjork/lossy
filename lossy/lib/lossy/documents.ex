defmodule Lossy.Documents do
  @moduledoc """
  The Documents context.
  """

  require Logger
  import Ecto.Query, warn: false
  alias Lossy.Repo
  alias Lossy.Assets

  alias Lossy.Documents.{Document, ProcessingJob, TextRegion}
  alias Lossy.ImageProcessing.Compositor

  ## Documents

  @doc """
  Creates a document from a capture request.
  """
  def create_capture(attrs \\ %{}) do
    Logger.info("Creating capture document",
      attrs: Map.take(attrs, ["source_url", "capture_mode"])
    )

    result =
      %Document{}
      |> Document.changeset(attrs)
      |> Repo.insert()

    case result do
      {:ok, document} ->
        Logger.info("Capture document created successfully", document_id: document.id)
        result

      {:error, changeset} ->
        Logger.error("Failed to create capture document", errors: inspect(changeset.errors))
        result
    end
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
    Logger.info("Updating document", document_id: document.id, attrs: inspect(Map.keys(attrs)))

    case document
         |> Document.changeset(attrs)
         |> Repo.update() do
      {:ok, updated_doc} = result ->
        Logger.info("Document updated successfully",
          document_id: updated_doc.id,
          status: updated_doc.status
        )

        # Broadcast update to LiveView subscribers
        broadcast_document_update(updated_doc)
        result

      {:error, changeset} = error ->
        Logger.error("Failed to update document",
          document_id: document.id,
          errors: inspect(changeset.errors)
        )

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
  Enqueue inpainting for a text region.
  Called when user edits text in a region.
  """
  def enqueue_inpainting(%TextRegion{} = region) do
    Logger.info("Enqueuing inpainting job", region_id: region.id)

    case %{region_id: region.id}
         |> Lossy.Workers.Inpainting.new()
         |> Oban.insert() do
      {:ok, _job} ->
        Logger.info("Inpainting job enqueued", region_id: region.id)
        :ok

      {:error, reason} ->
        Logger.error("Failed to enqueue inpainting",
          region_id: region.id,
          reason: inspect(reason)
        )

        {:error, reason}
    end
  end

  @doc """
  Creates text regions from extension-provided local detection results.
  """
  def create_text_regions_from_local_detection(%Document{} = document, text_regions)
      when is_list(text_regions) do
    Logger.info("Creating text regions from local detection",
      document_id: document.id,
      region_count: length(text_regions)
    )

    results =
      text_regions
      |> Enum.with_index(1)
      |> Enum.map(fn {region_data, index} ->
        # Extract recognized text from local OCR (if provided)
        original_text = region_data["original_text"] || region_data[:original_text]

        attrs = %{
          document_id: document.id,
          bbox: normalize_bbox(region_data["bbox"] || region_data[:bbox]),
          polygon: normalize_polygon(region_data["polygon"] || region_data[:polygon] || []),
          original_text: original_text,
          current_text: original_text,
          font_family: nil,
          font_weight: nil,
          font_size_px: nil,
          color_rgba: nil,
          alignment: :left,
          status: :detected,
          z_index: index,
          padding_px: 10
        }

        create_text_region(attrs)
      end)

    # Check if all succeeded
    failed =
      Enum.filter(results, fn
        {:error, _} -> true
        _ -> false
      end)

    if Enum.empty?(failed) do
      {:ok, length(results)}
    else
      Logger.error("Some text regions failed to create", failed_count: length(failed))
      {:error, :partial_failure}
    end
  end

  defp normalize_bbox(nil), do: %{x: 0, y: 0, w: 0, h: 0}

  defp normalize_bbox(bbox) when is_map(bbox) do
    %{
      x: bbox["x"] || bbox[:x] || 0,
      y: bbox["y"] || bbox[:y] || 0,
      w: bbox["w"] || bbox[:w] || 0,
      h: bbox["h"] || bbox[:h] || 0
    }
  end

  defp normalize_polygon(nil), do: []

  defp normalize_polygon(polygon) when is_list(polygon) do
    Enum.map(polygon, fn point ->
      %{
        x: point["x"] || point[:x] || 0,
        y: point["y"] || point[:y] || 0
      }
    end)
  end

  ## Export

  @doc """
  Generate the final exportable image by compositing all rendered regions.

  Returns {:ok, export_path} where the final image is saved.
  """
  def generate_export(%Document{} = document) do
    Logger.info("Generating export", document_id: document.id)

    # Reload document with all associations
    document = get_document(document.id)

    # Get the original image path
    case document.original_asset do
      nil ->
        {:error, :no_original_image}

      original_asset ->
        original_path = Assets.asset_path(original_asset)
        export_path = generate_export_path(document.id)

        # Create a working copy
        with {:ok, working_path} <- Compositor.create_working_copy(original_path, export_path),
             :ok <- composite_all_regions(working_path, document.text_regions) do
          Logger.info("Export generated", document_id: document.id, path: export_path)

          # Update document status
          update_document(document, %{status: :export_ready})

          {:ok, export_path}
        end
    end
  end

  defp composite_all_regions(working_path, regions) do
    # Sort regions by z_index to composite in correct order
    sorted_regions =
      regions
      |> Enum.filter(fn r -> r.status == :rendered && r.inpainted_asset_id != nil end)
      |> Enum.sort_by(& &1.z_index)

    Enum.reduce_while(sorted_regions, :ok, fn region, :ok ->
      case composite_region(working_path, region) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp composite_region(working_path, region) do
    case Repo.preload(region, :inpainted_asset).inpainted_asset do
      nil ->
        :ok

      asset ->
        patch_path = Assets.asset_path(asset)
        bbox = normalize_bbox(region.bbox)

        case Compositor.composite_patch(working_path, patch_path, bbox) do
          {:ok, _} -> :ok
          {:error, reason} -> {:error, reason}
        end
    end
  end

  defp generate_export_path(document_id) do
    dir = Path.join(["priv/static/uploads", document_id])
    File.mkdir_p!(dir)
    Path.join(dir, "export_#{System.system_time(:millisecond)}.png")
  end

  @doc """
  Check if a document is ready for export.

  Returns true if all text regions have been rendered.
  """
  def export_ready?(%Document{} = document) do
    document = get_document(document.id)

    case document.text_regions do
      [] ->
        # No regions means original image can be exported as-is
        document.original_asset != nil

      regions ->
        # All regions must be in rendered status
        Enum.all?(regions, fn r -> r.status == :rendered end)
    end
  end
end
