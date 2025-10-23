defmodule LossyWeb.NotesChannel do
  @moduledoc """
  Phoenix Channel for real-time note subscriptions.

  This channel allows the extension sidepanel to subscribe directly to notes
  for a specific video or user, eliminating the need for service worker relay.

  ## Topics

  - `notes:video:#{video_id}` - Subscribe to notes for a specific video
  - `notes:user:#{user_id}` - Subscribe to all notes for a user (future: library view)

  ## Events

  - `note_created` (push) - New note broadcast from AgentSession
  - `get_notes` (handle_in) - Request existing notes for a video

  ## Architecture

  Previous: Phoenix → AudioChannel (SW) → MessageRouter → Sidepanel
  Current:  Phoenix → NotesChannel → Sidepanel (direct)

  Benefits:
  - Service worker focuses on audio streaming only
  - Sidepanel owns its data subscription
  - ~200 lines removed from service worker
  - Direct real-time updates via PubSub
  """

  use LossyWeb, :channel
  require Logger

  alias Lossy.Videos

  @impl true
  def join("notes:video:" <> video_id, _params, socket) do
    Logger.info("Client joined notes channel for video: #{video_id}")

    # Subscribe to this video's PubSub topic
    # AgentSession broadcasts to "video:#{video_id}" when notes are created
    Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")

    {:ok, socket}
  end

  @impl true
  def join("notes:user:" <> user_id, _params, socket) do
    # For future: cross-video note feed (library view)
    # Could subscribe to "user:#{user_id}" for all user's notes
    Logger.info("Client joined notes channel for user: #{user_id}")

    {:ok, socket}
  end

  @impl true
  def join(_topic, _params, _socket) do
    {:error, %{reason: "invalid_topic"}}
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    notes = Videos.list_notes(%{video_id: video_id})

    Logger.info("Sending #{length(notes)} existing notes for video: #{video_id}")

    {:reply, {:ok, %{notes: serialize_notes(notes)}}, socket}
  end

  @impl true
  def handle_in(_event, _params, socket) do
    {:reply, {:error, %{reason: "unknown_event"}}, socket}
  end

  # Receive PubSub broadcasts from AgentSession
  # AgentSession broadcasts: Phoenix.PubSub.broadcast(Lossy.PubSub, "video:#{video_id}", {:new_note, note})
  @impl true
  def handle_info({:new_note, note}, socket) do
    Logger.debug("Broadcasting new note to client: #{note.id}")

    push(socket, "note_created", serialize_note(note))

    {:noreply, socket}
  end

  @impl true
  def handle_info(_msg, socket), do: {:noreply, socket}

  # Serialize note for client
  defp serialize_note(note) do
    %{
      id: note.id,
      text: note.text,
      category: note.category,
      confidence: note.confidence,
      timestamp_seconds: note.timestamp_seconds,
      raw_transcript: note.raw_transcript,
      video_id: note.video_id,
      timestamp: note.inserted_at
    }
  end

  defp serialize_notes(notes), do: Enum.map(notes, &serialize_note/1)
end
