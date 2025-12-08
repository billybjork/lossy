defmodule LossyWeb.EditLive do
  @moduledoc """
  LiveView for the image editor.

  Simplified state machine:
    :loading → :ready
  """
  use LossyWeb, :live_view

  alias Lossy.Assets
  alias Lossy.Documents

  @impl true
  def mount(%{"id" => id} = params, _session, socket) do
    case Documents.get_document(id) do
      nil ->
        {:ok,
         socket
         |> put_flash(:error, "Document not found")
         |> redirect(to: "/")}

      document ->
        # Subscribe to document updates for real-time changes
        if connected?(socket) do
          Phoenix.PubSub.subscribe(Lossy.PubSub, "document:#{document.id}")
        end

        # Check for fresh arrival (from capture flow)
        fresh_arrival = Map.has_key?(params, "fresh")

        masks = regions_to_masks(document)

        socket =
          socket
          |> assign(document: document, page_title: document.name || "Edit")
          |> assign(selected_region_ids: MapSet.new())

          |> assign(export_path: nil, export_filename: nil, exporting: false)
          |> assign(masks: masks)
          |> assign(fresh_arrival: fresh_arrival)
          |> assign(smart_select_mode: false)
          |> maybe_push_masks(masks, connected?(socket))

        {:ok, socket}
    end
  end

  @impl true
  def handle_info({:document_updated, document}, socket) do
    masks = regions_to_masks(document)

    {:noreply,
     socket
     |> assign(document: document, masks: masks)
     |> push_event("masks_updated", %{masks: masks})}
  end



  @impl true
  def handle_event("clear_fresh_arrival", _params, socket) do
    {:noreply, assign(socket, fresh_arrival: false)}
  end

  @impl true
  def handle_event("select_region", %{"id" => region_id, "shift" => shift}, socket) do
    selected = socket.assigns.selected_region_ids

    new_selected =
      if shift do
        # Multi-select: toggle region
        if MapSet.member?(selected, region_id) do
          MapSet.delete(selected, region_id)
        else
          MapSet.put(selected, region_id)
        end
      else
        # Single select: replace selection
        MapSet.new([region_id])
      end

    {:noreply, assign(socket, selected_region_ids: new_selected)}
  end

  @impl true
  def handle_event("select_regions", %{"ids" => region_ids, "shift" => shift}, socket) do
    selected = socket.assigns.selected_region_ids
    new_ids = MapSet.new(region_ids)

    new_selected =
      if shift do
        MapSet.union(selected, new_ids)
      else
        new_ids
      end

    {:noreply, assign(socket, selected_region_ids: new_selected)}
  end

  @impl true
  def handle_event("deselect_all", _params, socket) do
    {:noreply, assign(socket, selected_region_ids: MapSet.new())}
  end

  @impl true
  def handle_event("delete_selected", _params, socket) do
    selected = socket.assigns.selected_region_ids

    if MapSet.size(selected) > 0 do
      region_ids = MapSet.to_list(selected)
      {:ok, _count} = Documents.delete_detected_regions(socket.assigns.document, region_ids)

      # Clear selection (document update will be broadcast via PubSub)
      {:noreply, assign(socket, selected_region_ids: MapSet.new())}
    else
      {:noreply, socket}
    end
  end



  @impl true
  def handle_event("undo", _params, socket) do
    case Documents.undo(socket.assigns.document) do
      {:ok, _document} ->
        # Document update will be broadcast via PubSub
        {:noreply, socket}

      {:error, :cannot_undo} ->
        {:noreply, socket}

      {:error, reason} ->
        {:noreply, put_flash(socket, :error, "Undo failed: #{inspect(reason)}")}
    end
  end

  # Client-side text detection handler (from local ML inference)
  @impl true
  def handle_event("detected_text_regions", %{"regions" => regions}, socket) do
    document = socket.assigns.document
    # Function always succeeds, document update is broadcast via PubSub
    {:ok, _regions} = Documents.create_detected_regions_from_text_detection(document, regions)
    {:noreply, socket}
  end

  # Smart Select handlers
  @impl true
  def handle_event("enter_smart_select", _params, socket) do
    {:noreply, assign(socket, smart_select_mode: true)}
  end

  @impl true
  def handle_event("exit_smart_select", _params, socket) do
    {:noreply, assign(socket, smart_select_mode: false)}
  end

  @impl true
  def handle_event("confirm_segment", %{"mask_png" => mask_png, "bbox" => bbox}, socket) do
    # Save the mask from click-to-segment as a new region
    document = socket.assigns.document

    case Documents.add_manual_region(document, mask_png, bbox) do
      {:ok, _updated_document} ->
        # Document update will be broadcast via PubSub
        {:noreply, assign(socket, smart_select_mode: false)}

      {:error, reason} ->
        {:noreply,
         socket
         |> assign(smart_select_mode: false)
         |> put_flash(:error, "Failed to save segment: #{inspect(reason)}")}
    end
  end

  # Auto-segmentation batch handler - receives masks progressively as they're computed
  @impl true
  def handle_event("auto_segment_batch", %{"masks" => masks} = _params, socket) do
    document = socket.assigns.document

    # Store each high-confidence auto-segment
    {:ok, _regions} = Documents.create_detected_regions_from_auto_segments(document, masks)

    # Document update will be broadcast via PubSub
    {:noreply, socket}
  end

  # Auto-segmentation complete notification
  @impl true
  def handle_event(
        "auto_segment_complete",
        %{"total_masks" => total, "inference_time_ms" => time},
        socket
      ) do
    require Logger

    Logger.info(
      "[EditLive] Auto-segmentation complete: #{total} masks in #{Float.round(time / 1000, 1)}s"
    )

    {:noreply, socket}
  end

  @impl true
  def handle_event("export", _params, socket) do
    socket = assign(socket, exporting: true)

    case Documents.generate_export(socket.assigns.document) do
      {:ok, export_path, document_name} ->
        # Convert file path to public URL
        public_path = export_path_to_url(export_path)
        # Use document name for download filename, with fallback
        download_filename = "#{document_name || "lossy-export"}.png"

        {:noreply,
         socket
         |> assign(export_path: public_path, export_filename: download_filename, exporting: false)
         |> put_flash(:info, "Export generated! Click Download to save.")}

      {:error, reason} ->
        {:noreply,
         socket
         |> assign(exporting: false)
         |> put_flash(:error, "Export failed: #{inspect(reason)}")}
    end
  end

  defp export_path_to_url(path) do
    # Convert file path to web-accessible URL
    # e.g., "priv/static/uploads/abc/export.png" -> "/uploads/abc/export.png"
    case String.split(path, "/uploads/", parts: 2) do
      [_prefix, rest] -> "/uploads/#{rest}"
      _ -> path
    end
  end

  defp maybe_push_masks(socket, masks, true = _connected),
    do: push_event(socket, "masks_updated", %{masks: masks})

  defp maybe_push_masks(socket, _masks, false = _connected), do: socket

  # Convert DetectedRegion records to format expected by MaskOverlay hook
  defp regions_to_masks(document) do
    (document.detected_regions || [])
    |> Enum.map(fn region ->
      %{
        id: region.id,
        # "text", "object", or "manual"
        type: Atom.to_string(region.type),
        bbox: region.bbox,
        z_index: region.z_index,
        mask_url: mask_path_to_url(region.mask_path)
      }
    end)
  end

  defp mask_path_to_url(nil), do: nil

  defp mask_path_to_url(path) do
    case String.split(path, "/uploads/", parts: 2) do
      [_prefix, rest] -> "/uploads/#{rest}"
      _ -> nil
    end
  end
end
