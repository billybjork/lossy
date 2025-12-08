defmodule Lossy.Documents do
  @moduledoc """
  The Documents context.
  """

  require Logger
  import Ecto.Query, warn: false
  alias Lossy.Assets
  alias Lossy.Repo

  alias Lossy.Documents.{DetectedRegion, Document, Naming}


  ## Documents

  @doc """
  Creates a document from a capture request.
  """
  def create_capture(attrs \\ %{}) do
    Logger.info("Creating capture document",
      attrs: Map.take(attrs, ["source_url", "capture_mode", :source_url, :capture_mode])
    )

    # Generate human-readable name and extract domain
    # Handle both string and atom keys from attrs
    source_url = attrs["source_url"] || attrs[:source_url]
    name = Naming.generate_name()
    source_domain = Naming.extract_domain(source_url)

    # Detect key type and add name/domain with matching key type
    attrs =
      if Map.has_key?(attrs, :source_url) do
        # Atom keys
        attrs
        |> Map.put(:name, name)
        |> Map.put(:source_domain, source_domain)
      else
        # String keys
        attrs
        |> Map.put("name", name)
        |> Map.put("source_domain", source_domain)
      end

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
    |> Repo.preload([:detected_regions, :original_asset, :working_asset])
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
    # Preload associations on existing document (avoids 4-query refetch)
    document =
      Repo.preload(document, [:detected_regions, :original_asset, :working_asset], force: true)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end













  ## Detected Regions

  @doc """
  Updates a detected region.
  """
  def update_detected_region(%DetectedRegion{} = region, attrs) do
    region
    |> DetectedRegion.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Deletes detected regions by their IDs and broadcasts document update.
  Returns {:ok, count} where count is the number of deleted regions.
  """
  def delete_detected_regions(%Document{} = document, region_ids) when is_list(region_ids) do
    Logger.info("Deleting detected regions",
      document_id: document.id,
      region_ids: region_ids
    )

    {count, _} =
      DetectedRegion
      |> where([r], r.id in ^region_ids and r.document_id == ^document.id)
      |> Repo.delete_all()

    Logger.info("Deleted #{count} detected regions", document_id: document.id)

    # Broadcast update to refresh LiveView
    document = get_document(document.id)
    broadcast_document_update(document)

    {:ok, count}
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
            source: "text_detection",
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

  @doc """
  Creates detected regions from extension-provided segment (object) detection results.
  Saves mask PNGs to files and creates DetectedRegion records with type :object.
  """
  def create_detected_regions_from_segments(%Document{} = document, segment_regions)
      when is_list(segment_regions) do
    Logger.info("Creating detected regions from segments",
      document_id: document.id,
      segment_count: length(segment_regions)
    )

    base_path = mask_base_path(document)
    File.mkdir_p!(base_path)

    now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

    regions_data =
      segment_regions
      |> Enum.with_index(1)
      |> Enum.map(&build_segment_region(&1, document.id, base_path, now))
      |> Enum.filter(& &1.mask_path)

    insert_segment_regions(regions_data, document)
  end

  defp mask_base_path(document) do
    dir_name = document.name || document.id
    Path.join(["priv/static/uploads", dir_name, "masks"])
  end

  # Start z_index after text regions (offset by 1000 to not conflict)
  @segment_z_index_offset 1000

  defp build_segment_region({region_data, index}, document_id, base_path, now) do
    mask_png = get_field(region_data, :mask_png)
    mask_path = save_mask_png(mask_png, base_path, index)

    %{
      id: Ecto.UUID.generate(),
      document_id: document_id,
      type: :object,
      bbox: normalize_bbox(get_field(region_data, :bbox)),
      mask_path: mask_path,
      polygon: [],
      confidence: get_field(region_data, :score) || 1.0,
      metadata: %{
        source: "extension_segmentation",
        area: get_field(region_data, :area) || 0,
        stability_score: get_field(region_data, :stabilityScore)
      },
      z_index: @segment_z_index_offset + index,
      status: :detected,
      inserted_at: now,
      updated_at: now
    }
  end

  defp insert_segment_regions([], document) do
    Logger.warning("No segment masks were saved successfully", document_id: document.id)
    {:ok, []}
  end

  defp insert_segment_regions(regions_data, document) do
    {count, regions} = Repo.insert_all(DetectedRegion, regions_data, returning: true)
    Logger.info("Created #{count} segment regions", document_id: document.id)
    broadcast_document_update(document)
    {:ok, regions}
  end

  # Get a field from a map that may have string or atom keys
  defp get_field(map, key) when is_atom(key) do
    Map.get(map, Atom.to_string(key)) || Map.get(map, key)
  end

  # Save a base64 PNG mask to a file, returns the file path or nil on failure
  defp save_mask_png(nil, _base_path, _index), do: nil

  defp save_mask_png(mask_png, base_path, index) when is_binary(mask_png) do
    # Strip data URL prefix if present
    data =
      case mask_png do
        "data:image/png;base64," <> base64_data -> base64_data
        base64_data -> base64_data
      end

    case Base.decode64(data) do
      {:ok, binary} ->
        # Support both integer and string indices
        filename = if is_integer(index), do: "segment_#{index}.png", else: "#{index}.png"
        path = Path.join(base_path, filename)

        case File.write(path, binary) do
          :ok ->
            Logger.debug("Saved segment mask", path: path)
            path

          {:error, reason} ->
            Logger.warning("Failed to save segment mask", path: path, reason: reason)
            nil
        end

      :error ->
        Logger.warning("Failed to decode base64 mask data", index: index)
        nil
    end
  end

  @doc """
  Creates detected regions from auto-segmentation results.
  Similar to create_detected_regions_from_segments but with source: "auto_segmentation".
  """
  def create_detected_regions_from_auto_segments(%Document{} = document, auto_segments)
      when is_list(auto_segments) do
    Logger.info("Creating detected regions from auto-segmentation",
      document_id: document.id,
      segment_count: length(auto_segments)
    )

    base_path = mask_base_path(document)
    File.mkdir_p!(base_path)

    now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

    # Get existing region count for z_index offset
    existing_count =
      DetectedRegion
      |> where([r], r.document_id == ^document.id)
      |> Repo.aggregate(:count)

    regions_data =
      auto_segments
      |> Enum.with_index(existing_count + 1)
      |> Enum.map(&build_auto_segment_region(&1, document.id, base_path, now))
      |> Enum.filter(& &1.mask_path)

    insert_segment_regions(regions_data, document)
  end

  # Auto-segment z_index offset (between text and manual regions)
  @auto_segment_z_index_offset 1500

  defp build_auto_segment_region({region_data, index}, document_id, base_path, now) do
    mask_png = get_field(region_data, :mask_png)
    # Use unique timestamp to avoid collisions
    unique_index = "auto_#{System.system_time(:microsecond)}_#{index}"
    mask_path = save_mask_png(mask_png, base_path, unique_index)

    %{
      id: Ecto.UUID.generate(),
      document_id: document_id,
      type: :object,
      bbox: normalize_bbox(get_field(region_data, :bbox)),
      mask_path: mask_path,
      polygon: [],
      confidence: get_field(region_data, :score) || 1.0,
      metadata: %{
        source: "auto_segmentation",
        area: get_field(region_data, :area) || 0,
        stability_score: get_field(region_data, :stability_score),
        centroid: get_field(region_data, :centroid)
      },
      z_index: @auto_segment_z_index_offset + index,
      status: :detected,
      inserted_at: now,
      updated_at: now
    }
  end

  @doc """
  Add a manual region from click-to-segment.
  Takes a base64-encoded mask PNG and bbox, creates a new region with type :manual.
  """
  def add_manual_region(%Document{} = document, mask_png, bbox) when is_binary(mask_png) do
    Logger.info("Adding manual region from click-to-segment", document_id: document.id)

    # Get a base path for saving masks
    # Use document name if available, fall back to UUID for legacy documents
    dir_name = document.name || document.id

    base_path =
      Path.join([
        "priv/static/uploads",
        dir_name,
        "masks"
      ])

    # Ensure directory exists
    File.mkdir_p!(base_path)

    # Generate a unique index for the mask filename
    timestamp = System.system_time(:millisecond)
    mask_path = save_mask_png(mask_png, base_path, "manual_#{timestamp}")

    if is_nil(mask_path) do
      {:error, :mask_save_failed}
    else
      now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

      # Count existing regions to set z_index
      existing_count =
        DetectedRegion
        |> where([r], r.document_id == ^document.id)
        |> Repo.aggregate(:count)

      # Use z_index after existing regions (offset by 2000 for manual regions)
      z_index = 2000 + existing_count

      region_data = %{
        id: Ecto.UUID.generate(),
        document_id: document.id,
        type: :manual,
        bbox: normalize_bbox(bbox),
        mask_path: mask_path,
        polygon: [],
        confidence: 1.0,
        metadata: %{source: "click_to_segment"},
        z_index: z_index,
        status: :detected,
        inserted_at: now,
        updated_at: now
      }

      case Repo.insert_all(DetectedRegion, [region_data], returning: true) do
        {1, [region]} ->
          Logger.info("Created manual region", region_id: region.id, document_id: document.id)
          document = get_document(document.id)
          broadcast_document_update(document)
          {:ok, document}

        _ ->
          Logger.error("Failed to create manual region", document_id: document.id)
          {:error, :insert_failed}
      end
    end
  end

  ## Undo/Redo

  @doc """
  Undo the last action.

  Decrements history_index and restores the working_asset to the previous state.

  History model: history[i].image_path = state BEFORE action i was applied.
  So to undo to index N, we restore from history[N].image_path.
  """
  def undo(%Document{} = document) do
    document = get_document(document.id)

    if Document.can_undo?(document) do
      current_index = document.history_index
      new_index = current_index - 1
      history = document.history || []

      # history[new_index] contains the state we want to restore to
      target_image_path = Enum.at(history, new_index).image_path

      Logger.info("Undoing to history index #{new_index}",
        document_id: document.id,
        target_path: target_image_path
      )

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

  Uses working_asset if available,
  otherwise falls back to original_asset.

  Returns {:ok, export_path} where the final image is saved.
  """
  def generate_export(%Document{} = document) do
    alias Lossy.ImageProcessing.XMP

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
        export_path = generate_export_path(document)

        # Embed XMP metadata with source URL, fallback to simple copy on failure
        result =
          case XMP.embed_source_url(source_path, document.source_url, export_path) do
            {:ok, _} ->
              :ok

            {:error, _reason} ->
              # Fallback: copy without metadata
              Logger.warning("XMP embedding failed, copying without metadata",
                document_id: document.id
              )

              File.cp(source_path, export_path)
          end

        case result do
          :ok ->
            Logger.info("Export generated",
              document_id: document.id,
              name: document.name,
              path: export_path
            )

            {:ok, export_path, document.name}

          {:error, reason} ->
            Logger.error("Failed to generate export", reason: inspect(reason))
            {:error, reason}
        end
    end
  end

  defp generate_export_path(%Document{} = document) do
    # Use document name if available, fall back to UUID for legacy documents
    dir_name = document.name || document.id
    dir = Path.join(["priv/static/uploads", dir_name])
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
