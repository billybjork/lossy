defmodule LossyWeb.NotesLive do
  use LossyWeb, :live_view

  alias Lossy.Videos

  @impl true
  def mount(_params, _session, socket) do
    # Subscribe to all note creation events for testing
    # In production, this would be scoped to specific videos
    if connected?(socket) do
      Phoenix.PubSub.subscribe(Lossy.PubSub, "notes:all")
    end

    notes = Videos.list_notes(%{})

    {:ok, assign(socket, notes: notes)}
  end

  @impl true
  def handle_info({:agent_event, %{type: :note_created, note: note}}, socket) do
    {:noreply, update(socket, :notes, fn notes -> [note | notes] end)}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def render(assigns) do
    ~H"""
    <div class="p-8">
      <h1 class="text-3xl font-bold mb-6">Voice Notes (Sprint 02 Test)</h1>

      <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p class="text-sm text-blue-800">
          <strong>Testing Instructions:</strong>
          1. Load the extension
          2. Click "Start Recording" in the side panel
          3. Speak a test phrase like "The pacing is too slow here"
          4. Click "Stop Recording"
          5. Wait 3-7 seconds for transcription + structuring
          6. Note should appear below in real-time
        </p>
      </div>

      <div class="space-y-4">
        <%= if Enum.empty?(@notes) do %>
          <div class="text-gray-500 text-center py-8">
            No notes yet. Start recording to create your first note!
          </div>
        <% else %>
          <%= for note <- @notes do %>
            <div class="bg-white shadow rounded-lg p-4 border border-gray-200">
              <div class="flex items-start justify-between">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-2">
                    <span class={"px-2 py-1 text-xs font-semibold rounded #{category_color(note.category)}"}>
                      <%= note.category %>
                    </span>
                    <span class="text-xs text-gray-500">
                      Confidence: <%= Float.round(note.confidence * 100, 1) %>%
                    </span>
                    <span class={"px-2 py-1 text-xs rounded #{status_color(note.status)}"}>
                      <%= note.status %>
                    </span>
                  </div>
                  <p class="text-gray-900 font-medium mb-1"><%= note.text %></p>
                  <p class="text-sm text-gray-600 italic">"<%= note.raw_transcript %>"</p>
                </div>
                <div class="text-xs text-gray-400">
                  <%= Calendar.strftime(note.inserted_at, "%H:%M:%S") %>
                </div>
              </div>
            </div>
          <% end %>
        <% end %>
      </div>
    </div>
    """
  end

  defp category_color("pacing"), do: "bg-purple-100 text-purple-800"
  defp category_color("audio"), do: "bg-blue-100 text-blue-800"
  defp category_color("visual"), do: "bg-green-100 text-green-800"
  defp category_color("editing"), do: "bg-yellow-100 text-yellow-800"
  defp category_color(_), do: "bg-gray-100 text-gray-800"

  defp status_color("ghost"), do: "bg-gray-100 text-gray-600"
  defp status_color("firmed"), do: "bg-green-100 text-green-600"
  defp status_color(_), do: "bg-gray-100 text-gray-600"
end
