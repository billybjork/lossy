defmodule LossyWeb.VideoChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Videos

  @impl true
  def join("video:meta", _payload, socket) do
    Logger.info("[VideoChannel] Joined video metadata channel")
    {:ok, socket}
  end

  @impl true
  def handle_in("video_detected", %{"platform" => platform, "videoId" => video_id} = payload, socket) do
    Logger.info("[VideoChannel] Video detected: #{platform}/#{video_id}")

    url = Map.get(payload, "url")
    title = Map.get(payload, "title")

    case Videos.find_or_create_video(%{
      platform: platform,
      external_id: video_id,
      url: url,
      title: title
    }) do
      {:ok, video} ->
        Logger.info("[VideoChannel] Video record created/found: #{video.id}")
        {:reply, {:ok, %{video_id: video.id}}, socket}

      {:error, changeset} ->
        Logger.error("[VideoChannel] Failed to create video: #{inspect(changeset)}")
        {:reply, {:error, %{message: "Failed to create video"}}, socket}
    end
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    Logger.info("[VideoChannel] Fetching notes for video: #{video_id}")

    notes = Videos.list_notes_by_video(video_id)

    {:reply, {:ok, %{notes: notes}}, socket}
  end

  @impl true
  def handle_in("delete_note", %{"note_id" => note_id}, socket) do
    Logger.info("[VideoChannel] Deleting note: #{note_id}")

    case Videos.delete_note(note_id) do
      {:ok, _note} ->
        Logger.info("[VideoChannel] Note deleted successfully: #{note_id}")
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        Logger.error("[VideoChannel] Failed to delete note: #{inspect(reason)}")
        {:reply, {:error, %{message: "Failed to delete note"}}, socket}
    end
  end
end
