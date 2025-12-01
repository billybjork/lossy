defmodule LossyWeb.CaptureLive do
  @moduledoc """
  LiveView for the image editor.

  Simplified state machine:
    :loading → :ready → :inpainting → :ready

  No more text-specific states. Focus on mask selection and inpainting.
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
          |> assign(document: document, page_title: "Edit Capture")
          |> assign(selected_region_ids: MapSet.new())
          |> assign(inpainting: false)
          |> assign(export_path: nil, exporting: false)
          |> assign(masks: masks)
          |> assign(fresh_arrival: fresh_arrival)
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
  def handle_info({:masks_detected, masks}, socket) do
    # Push masks to client for rendering
    {:noreply,
     socket
     |> assign(masks: masks)
     |> push_event("masks_updated", %{masks: masks})}
  end

  @impl true
  def handle_info({:inpainting_complete, _result}, socket) do
    {:noreply,
     socket
     |> assign(inpainting: false, selected_region_ids: MapSet.new())
     |> push_event("clear_selection", %{})}
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
  def handle_event("deselect_all", _params, socket) do
    {:noreply, assign(socket, selected_region_ids: MapSet.new())}
  end

  @impl true
  def handle_event("inpaint_selected", _params, socket) do
    selected = socket.assigns.selected_region_ids

    if MapSet.size(selected) > 0 do
      region_ids = MapSet.to_list(selected)

      case Documents.enqueue_mask_inpainting(socket.assigns.document, region_ids) do
        :ok ->
          {:noreply, assign(socket, inpainting: true)}

        {:error, :no_masks} ->
          {:noreply, put_flash(socket, :error, "Selected regions have no masks")}

        {:error, _reason} ->
          {:noreply, put_flash(socket, :error, "Failed to start inpainting")}
      end
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

  @impl true
  def handle_event("redo", _params, socket) do
    # Redo not yet implemented - silently ignore
    # TODO: Implement by storing "after" states in history entries
    _result = Documents.redo(socket.assigns.document)
    {:noreply, socket}
  end

  @impl true
  def handle_event("export", _params, socket) do
    socket = assign(socket, exporting: true)

    case Documents.generate_export(socket.assigns.document) do
      {:ok, export_path} ->
        # Convert file path to public URL
        public_path = export_path_to_url(export_path)

        {:noreply,
         socket
         |> assign(export_path: public_path, exporting: false)
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
  # Filters out already-inpainted regions (they're baked into the image now)
  defp regions_to_masks(document) do
    (document.detected_regions || [])
    |> Enum.reject(fn region -> region.status == :inpainted end)
    |> Enum.map(fn region ->
      %{
        id: region.id,
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
