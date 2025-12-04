defmodule Lossy.Documents do
  @moduledoc """
  The Documents context.
  """

  require Logger
  import Ecto.Query, warn: false
  alias Lossy.Repo
  alias Lossy.Assets

  alias Lossy.Documents.{Document, ProcessingJob, DetectedRegion}

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
    |> Repo.preload([:detected_regions, :processing_jobs, :original_asset, :working_asset])
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
  Enqueue inpainting job for selected regions.

  Fetches the mask paths from the given region IDs and enqueues
  a batch inpainting job. For regions without mask_path (e.g., text regions),
  generates masks from their bboxes.
  """
  def enqueue_mask_inpainting(%Document{} = document, region_ids) when is_list(region_ids) do
    Logger.info("Enqueuing mask inpainting job",
      document_id: document.id,
      region_count: length(region_ids)
    )

    # Reload document with assets
    document = get_document(document.id)

    with {:ok, image_path} <- get_source_image_path(document),
         {:ok, mask_paths} <- get_mask_paths_for_regions(region_ids, image_path) do
      enqueue_inpainting_job(document, mask_paths, region_ids)
    end
  end

  defp get_source_image_path(document) do
    case document.working_asset || document.original_asset do
      nil ->
        Logger.error("No source image for inpainting", document_id: document.id)
        {:error, :no_source_image}

      asset ->
        {:ok, Assets.asset_path(asset)}
    end
  end

  defp get_mask_paths_for_regions(region_ids, image_path) do
    regions =
      DetectedRegion
      |> where([r], r.id in ^region_ids)
      |> Repo.all()

    mask_paths = ensure_region_masks(regions, image_path)

    if Enum.empty?(mask_paths) do
      Logger.error("Failed to get/generate masks for regions", region_ids: region_ids)
      {:error, :no_masks}
    else
      {:ok, mask_paths}
    end
  end

  defp enqueue_inpainting_job(document, mask_paths, region_ids) do
    case %{document_id: document.id, mask_paths: mask_paths, region_ids: region_ids}
         |> Lossy.Workers.Inpainting.new()
         |> Oban.insert() do
      {:ok, _job} ->
        update_document(document, %{status: :inpainting})
        Logger.info("Mask inpainting job enqueued", document_id: document.id)
        :ok

      {:error, reason} ->
        Logger.error("Failed to enqueue mask inpainting",
          document_id: document.id,
          reason: inspect(reason)
        )

        {:error, reason}
    end
  end

  # Ensure all regions have mask paths, generating from bbox if needed
  defp ensure_region_masks(regions, image_path) do
    regions
    |> Enum.map(&get_or_generate_mask(&1, image_path))
    |> Enum.reject(&is_nil/1)
  end

  defp get_or_generate_mask(%{mask_path: existing_path} = _region, _image_path)
       when not is_nil(existing_path) do
    existing_path
  end

  defp get_or_generate_mask(region, image_path) do
    alias Lossy.ImageProcessing.Mask

    Logger.info("Generating mask from bbox", region_id: region.id)

    case Mask.generate_mask(image_path, region.bbox) do
      {:ok, path} ->
        update_detected_region(region, %{mask_path: path})
        path

      {:error, reason} ->
        Logger.error("Failed to generate mask",
          region_id: region.id,
          reason: inspect(reason)
        )

        nil
    end
  end

  ## Detected Regions

  @doc """
  Gets all detected regions for a document.
  """
  def list_detected_regions(%Document{} = document) do
    DetectedRegion
    |> where([r], r.document_id == ^document.id)
    |> order_by([r], asc: r.z_index)
    |> Repo.all()
  end

  @doc """
  Gets a single detected region by ID.
  """
  def get_detected_region(id) do
    Repo.get(DetectedRegion, id)
  end

  @doc """
  Updates a detected region.
  """
  def update_detected_region(%DetectedRegion{} = region, attrs) do
    region
    |> DetectedRegion.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Creates detected regions from extension-provided text detection results.
  Converts text_regions format to DetectedRegion records.
  """
  def create_detected_regions_from_text_detection(%Document{} = document, text_regions)
      when is_list(text_regions) do
    Logger.info("Creating detected regions from text detection",
      document_id: document.id,
      region_count: length(text_regions)
    )

    now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

    regions_data =
      text_regions
      |> Enum.with_index(1)
      |> Enum.map(fn {region_data, index} ->
        %{
          id: Ecto.UUID.generate(),
          document_id: document.id,
          type: :text,
          bbox: normalize_bbox(region_data["bbox"] || region_data[:bbox]),
          polygon: normalize_polygon(region_data["polygon"] || region_data[:polygon] || []),
          confidence: region_data["confidence"] || region_data[:confidence] || 1.0,
          metadata: %{
            original_text: region_data["original_text"] || region_data[:original_text]
          },
          z_index: index,
          status: :detected,
          inserted_at: now,
          updated_at: now
        }
      end)

    case Repo.insert_all(DetectedRegion, regions_data, returning: true) do
      {count, regions} when count == length(text_regions) ->
        Logger.info("Created #{count} detected regions", document_id: document.id)
        broadcast_document_update(document)
        {:ok, regions}

      {count, regions} ->
        Logger.warning("Partial insert: expected #{length(text_regions)}, got #{count}",
          document_id: document.id
        )

        broadcast_document_update(document)
        {:ok, regions}
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

  ## Undo/Redo

  @doc """
  Undo the last inpainting action.

  Decrements history_index and restores the working_asset to the previous state.
  Also restores the inpainted regions' status back to :detected so they can be
  selected again.

  History model: history[i].image_path = state BEFORE action i was applied.
  So to undo to index N, we restore from history[N].image_path.
  """
  def undo(%Document{} = document) do
    document = get_document(document.id)

    if Document.can_undo?(document) do
      current_index = document.history_index
      new_index = current_index - 1
      history = document.history || []

      # Get the action we're undoing (current history entry)
      # Its metadata contains the region_ids that were inpainted
      undoing_entry = Enum.at(history, current_index - 1)
      region_ids_to_restore = get_in(undoing_entry.metadata, ["region_ids"]) || []

      # history[new_index] contains the state we want to restore to
      target_image_path = Enum.at(history, new_index).image_path

      Logger.info("Undoing to history index #{new_index}",
        document_id: document.id,
        target_path: target_image_path,
        restoring_regions: length(region_ids_to_restore)
      )

      # Restore regions' status back to :detected
      if length(region_ids_to_restore) > 0 do
        restore_regions_status(region_ids_to_restore)
      end

      # Create new working asset from the target image
      with {:ok, new_asset} <-
             Assets.save_image_from_path(document.id, target_image_path, :working),
           {:ok, updated_doc} <-
             update_document(document, %{
               working_asset_id: new_asset.id,
               history_index: new_index,
               status: :ready
             }) do
        {:ok, updated_doc}
      else
        {:error, reason} ->
          Logger.error("Failed to restore image for undo", reason: inspect(reason))
          {:error, :restore_failed}
      end
    else
      {:error, :cannot_undo}
    end
  end

  defp restore_regions_status(region_ids) when is_list(region_ids) do
    from(r in DetectedRegion, where: r.id in ^region_ids)
    |> Repo.update_all(set: [status: :detected, updated_at: NaiveDateTime.utc_now()])

    Logger.info("Restored regions to detected status", count: length(region_ids))
  end

  @doc """
  Redo is not currently supported.

  The history model stores "before" states, not "after" states.
  When you undo, the current state is overwritten and cannot be recovered.
  Future enhancement: store after_image_path in history entries to enable redo.
  """
  def redo(%Document{} = _document) do
    {:error, :redo_not_supported}
  end

  ## Export

  @doc """
  Generate the final exportable image.

  Uses working_asset if available (contains all inpainting results),
  otherwise falls back to original_asset.

  Returns {:ok, export_path} where the final image is saved.
  """
  def generate_export(%Document{} = document) do
    Logger.info("Generating export", document_id: document.id)

    # Reload document with all associations
    document = get_document(document.id)

    # Use working asset (with inpainting applied) or original
    source_asset = document.working_asset || document.original_asset

    case source_asset do
      nil ->
        {:error, :no_image}

      asset ->
        source_path = Assets.asset_path(asset)
        export_path = generate_export_path(document.id)

        # Copy the current state to export path
        case File.cp(source_path, export_path) do
          :ok ->
            Logger.info("Export generated", document_id: document.id, path: export_path)
            {:ok, export_path}

          {:error, reason} ->
            Logger.error("Failed to generate export", reason: inspect(reason))
            {:error, reason}
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

  Returns true if document has an image (original or working).
  """
  def export_ready?(%Document{} = document) do
    document.original_asset_id != nil || document.working_asset_id != nil
  end
end
