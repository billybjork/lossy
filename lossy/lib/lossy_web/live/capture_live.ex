defmodule LossyWeb.CaptureLive do
  use LossyWeb, :live_view

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
        {:ok, assign(socket, document: document, page_title: "Edit Capture")}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 class="text-3xl font-bold mb-6">Edit Capture</h1>

      <div class="bg-white shadow rounded-lg p-6">
        <dl class="grid grid-cols-1 gap-4">
          <div>
            <dt class="text-sm font-medium text-gray-500">Document ID</dt>
            <dd class="mt-1 text-sm text-gray-900"><%= @document.id %></dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-gray-500">Status</dt>
            <dd class="mt-1 text-sm text-gray-900">
              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                <%= @document.status %>
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-gray-500">Source URL</dt>
            <dd class="mt-1 text-sm text-gray-900"><%= @document.source_url %></dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-gray-500">Capture Mode</dt>
            <dd class="mt-1 text-sm text-gray-900"><%= @document.capture_mode %></dd>
          </div>
        </dl>

        <div class="mt-6">
          <h2 class="text-lg font-medium mb-4">Text Regions</h2>
          <%= if @document.text_regions == [] do %>
            <p class="text-gray-500 italic">No text regions detected yet.</p>
          <% else %>
            <div class="space-y-2">
              <%= for region <- @document.text_regions do %>
                <div class="border rounded p-3">
                  <p class="text-sm"><strong>Text:</strong> <%= region.current_text || region.original_text || "(no text)" %></p>
                  <p class="text-xs text-gray-500 mt-1">Status: <%= region.status %></p>
                </div>
              <% end %>
            </div>
          <% end %>
        </div>
      </div>
    </div>
    """
  end
end
