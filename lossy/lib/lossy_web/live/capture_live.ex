defmodule LossyWeb.CaptureLive do
  use LossyWeb, :live_view

  alias Lossy.Assets
  alias Lossy.Documents

  @impl true
  def mount(%{"id" => id}, _session, socket) do
    case Documents.get_document(id) do
      nil ->
        {:ok,
         socket
         |> put_flash(:error, "Document not found")
         |> redirect(to: "/")}

      document ->
        # Subscribe to document updates for real-time status changes
        if connected?(socket) do
          Phoenix.PubSub.subscribe(Lossy.PubSub, "document:#{document.id}")
        end

        socket =
          socket
          |> assign(document: document, page_title: "Edit Capture")
          |> assign(selected_region_id: nil, editing_region_id: nil)
          |> assign(export_path: nil, exporting: false)

        {:ok, socket}
    end
  end

  @impl true
  def handle_info({:document_updated, document}, socket) do
    {:noreply, assign(socket, document: document)}
  end

  @impl true
  def handle_event("select_region", %{"region-id" => region_id}, socket) do
    {:noreply, assign(socket, selected_region_id: region_id)}
  end

  @impl true
  def handle_event("edit_region", %{"region-id" => region_id}, socket) do
    {:noreply, assign(socket, editing_region_id: region_id)}
  end

  @impl true
  def handle_event("start_edit_region", %{"region-id" => region_id}, socket) do
    region = find_region(socket, region_id)

    if region do
      # Update region status to inpainting_blank (will trigger blank inpainting)
      case Documents.update_text_region(region, %{
             editing_status: :inpainting_blank,
             current_text: ""
           }) do
        {:ok, updated_region} ->
          # Enqueue inpainting job with UPDATED region (will create clean background)
          Documents.enqueue_inpainting(updated_region)

          # Reload document to get updated state
          document = Documents.get_document(socket.assigns.document.id)
          {:noreply, assign(socket, document: document, editing_region_id: region_id)}

        {:error, _changeset} ->
          {:noreply, put_flash(socket, :error, "Failed to start editing")}
      end
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event(
        "commit_text_change",
        %{"region-id" => region_id, "text" => new_text},
        socket
      ) do
    region = find_region(socket, region_id)

    if region do
      # Update text and trigger re-rendering
      case Documents.update_text_region(region, %{
             current_text: new_text,
             editing_status: :rendering_text
           }) do
        {:ok, updated_region} ->
          # Enqueue inpainting job with UPDATED region to render new text
          Documents.enqueue_inpainting(updated_region)

          # Reload document
          document = Documents.get_document(socket.assigns.document.id)
          {:noreply, assign(socket, document: document, editing_region_id: nil)}

        {:error, _changeset} ->
          {:noreply, put_flash(socket, :error, "Failed to update text")}
      end
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("update_region_text", %{"region-id" => region_id, "text" => new_text}, socket) do
    region = Enum.find(socket.assigns.document.text_regions, &(&1.id == region_id))

    if region do
      case Documents.update_text_region(region, %{current_text: new_text}) do
        {:ok, updated_region} ->
          # Enqueue inpainting job for this region
          # The job will inpaint the background and update region status
          Documents.enqueue_inpainting(updated_region)

          # Reload document to get updated regions
          document = Documents.get_document(socket.assigns.document.id)
          {:noreply, assign(socket, document: document, editing_region_id: nil)}

        {:error, _changeset} ->
          {:noreply, put_flash(socket, :error, "Failed to update text")}
      end
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("cancel_edit", _params, socket) do
    {:noreply, assign(socket, editing_region_id: nil)}
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

  defp status_color(:processing), do: "bg-blue-100 text-blue-800"
  defp status_color(:queued_detection), do: "bg-yellow-100 text-yellow-800"
  defp status_color(:detecting), do: "bg-blue-100 text-blue-800"
  defp status_color(:awaiting_edits), do: "bg-green-100 text-green-800"
  defp status_color(:rendering), do: "bg-purple-100 text-purple-800"
  defp status_color(:export_ready), do: "bg-emerald-100 text-emerald-800"
  defp status_color(:error), do: "bg-red-100 text-red-800"
  defp status_color(_), do: "bg-gray-100 text-gray-800"

  defp format_status(status) do
    status
    |> Atom.to_string()
    |> String.replace("_", " ")
    |> String.capitalize()
  end

  defp region_style(bbox, img_width, img_height)
       when is_number(img_width) and img_width > 0 and is_number(img_height) and img_height > 0 do
    left = bbox["x"] / img_width * 100
    top = bbox["y"] / img_height * 100
    width = bbox["w"] / img_width * 100
    height = bbox["h"] / img_height * 100

    "left: #{left}%; top: #{top}%; width: #{width}%; height: #{height}%;"
  end

  defp region_style(_bbox, _width, _height), do: "display: none;"

  defp find_region(socket, region_id) do
    Enum.find(socket.assigns.document.text_regions, &(&1.id == region_id))
  end
end
