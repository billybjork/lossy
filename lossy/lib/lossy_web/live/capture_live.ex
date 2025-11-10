defmodule LossyWeb.CaptureLive do
  use LossyWeb, :live_view

  alias Lossy.Documents
  alias Lossy.Assets

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
  def handle_event("update_region_text", %{"region-id" => region_id, "text" => new_text}, socket) do
    region = Enum.find(socket.assigns.document.text_regions, &(&1.id == region_id))

    if region do
      case Documents.update_text_region(region, %{current_text: new_text}) do
        {:ok, _updated_region} ->
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
  def render(assigns) do
    ~H"""
    <div class="min-h-screen bg-gray-100 py-8">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="mb-6 flex justify-between items-center">
          <h1 class="text-3xl font-bold text-gray-900">Edit Capture</h1>
          <div class="text-sm text-gray-600">
            Status:
            <span class={[
              "ml-2 px-2.5 py-0.5 rounded-full text-xs font-medium",
              status_color(@document.status)
            ]}>
              <%= format_status(@document.status) %>
            </span>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- Main editor area -->
          <div class="lg:col-span-2">
            <div class="bg-white rounded-lg shadow-lg overflow-hidden">
              <%= if @document.original_asset do %>
                <div class="relative inline-block">
                  <!-- Display the captured image -->
                  <img
                    src={Assets.public_url(@document.original_asset)}
                    alt="Captured image"
                    class="max-w-full h-auto"
                    id="capture-image"
                  />
                  <!-- Overlay text regions as bounding boxes -->
                  <%= for region <- @document.text_regions do %>
                    <div
                      class={[
                        "absolute border-2 cursor-pointer transition-all",
                        if(@selected_region_id == region.id, do: "border-blue-500 bg-blue-500/10", else: "border-red-500 bg-red-500/5 hover:bg-red-500/10")
                      ]}
                      style={"left: #{region.bbox["x"]}px; top: #{region.bbox["y"]}px; width: #{region.bbox["w"]}px; height: #{region.bbox["h"]}px;"}
                      phx-click="select_region"
                      phx-value-region-id={region.id}
                      title={region.current_text || region.original_text}
                    >
                      <%= if @editing_region_id == region.id do %>
                        <form phx-submit="update_region_text" phx-value-region-id={region.id} class="w-full h-full">
                          <input
                            type="text"
                            name="text"
                            class="w-full h-full px-2 text-sm border-0 focus:ring-2 focus:ring-blue-500"
                            value={region.current_text}
                            id={"region-input-#{region.id}"}
                            style={"font-size: #{max(region.font_size_px, 12)}px; font-weight: #{region.font_weight};"}
                            autofocus
                          />
                        </form>
                      <% end %>
                    </div>
                  <% end %>
                </div>
              <% else %>
                <div class="p-12 text-center text-gray-500">
                  <%= if @document.status == :detecting do %>
                    <div class="animate-pulse">
                      <div class="text-lg font-medium mb-2">Detecting text regions...</div>
                      <div class="text-sm">This may take a few seconds</div>
                    </div>
                  <% else %>
                    <div>No image available for this capture.</div>
                  <% end %>
                </div>
              <% end %>
            </div>
          </div>

          <!-- Sidebar with region list -->
          <div class="lg:col-span-1">
            <div class="bg-white rounded-lg shadow-lg p-6">
              <h2 class="text-lg font-bold mb-4">Text Regions</h2>

              <%= if @document.text_regions == [] do %>
                <%= if @document.status == :detecting do %>
                  <p class="text-gray-500 text-sm italic">Detecting text regions...</p>
                <% else %>
                  <p class="text-gray-500 text-sm italic">No text regions detected.</p>
                <% end %>
              <% else %>
                <div class="space-y-3">
                  <%= for region <- @document.text_regions do %>
                    <div class={[
                      "border rounded-lg p-3 cursor-pointer transition-all",
                      if(@selected_region_id == region.id, do: "border-blue-500 bg-blue-50", else: "border-gray-200 hover:border-gray-300")
                    ]}
                    phx-click="select_region"
                    phx-value-region-id={region.id}
                    >
                      <div class="flex justify-between items-start mb-2">
                        <span class="text-xs font-medium text-gray-500">Region #{region.z_index}</span>
                        <button
                          class="text-xs text-blue-600 hover:text-blue-800"
                          phx-click="edit_region"
                          phx-value-region-id={region.id}
                        >
                          Edit
                        </button>
                      </div>
                      <p class="text-sm text-gray-900 font-medium break-words">
                        <%= region.current_text || region.original_text || "(no text)" %>
                      </p>
                      <div class="mt-2 text-xs text-gray-500">
                        <%= region.font_family %>, <%= region.font_size_px %>px
                      </div>
                    </div>
                  <% end %>
                </div>
              <% end %>

              <%= if @document.source_url do %>
                <div class="mt-6 pt-6 border-t border-gray-200">
                  <h3 class="text-xs font-medium text-gray-500 mb-2">Source</h3>
                  <a
                    href={@document.source_url}
                    target="_blank"
                    class="text-xs text-blue-600 hover:text-blue-800 break-all"
                  >
                    <%= @document.source_url %>
                  </a>
                </div>
              <% end %>
            </div>
          </div>
        </div>
      </div>
    </div>
    """
  end

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
end
