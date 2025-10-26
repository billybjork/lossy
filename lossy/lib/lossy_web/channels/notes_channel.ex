defmodule LossyWeb.NotesChannel do
  @moduledoc """
  Phoenix Channel for real-time note subscriptions.

  This channel allows the extension sidepanel to subscribe directly to notes
  for a specific video or user, eliminating the need for service worker relay.

  ## Topics

  - `notes:video:\#{video_id}` - Subscribe to notes for a specific video
  - `notes:user:\#{user_id}` - Subscribe to all notes for a user (future: library view)

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
  alias LossyWeb.ChannelAuth

  @impl true
  def join("notes:video:" <> video_id, params, socket) do
    with {:ok, authed_socket, auth_payload} <- ChannelAuth.authorize_join(socket, params),
         :ok <- authorize_video_access(video_id, authed_socket.assigns.user_id) do
      Logger.info("Client joined notes channel for video: #{video_id}")

      Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")

      response = Map.put(auth_payload, :scope, %{"type" => "video", "id" => video_id})

      {:ok, response, authed_socket}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def join("notes:user:" <> user_id, params, socket) do
    with {:ok, authed_socket, auth_payload} <- ChannelAuth.authorize_join(socket, params),
         :ok <- ensure_same_user(user_id, authed_socket.assigns.user_id) do
      Logger.info("Client joined notes channel for user: #{user_id}")

      Phoenix.PubSub.subscribe(Lossy.PubSub, "user:#{user_id}")

      response = Map.put(auth_payload, :scope, %{"type" => "user", "id" => user_id})

      {:ok, response, authed_socket}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def join(_topic, _params, _socket) do
    {:error, %{reason: "invalid_topic"}}
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    with :ok <- authorize_video_access(video_id, socket.assigns.user_id) do
      notes = Videos.list_notes(%{video_id: video_id})

      Logger.info("Sending #{length(notes)} existing notes for video: #{video_id}")

      {:reply, {:ok, %{notes: serialize_notes(notes)}}, socket}
    else
      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
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

  defp ensure_same_user(requested_user_id, actual_user_id) when requested_user_id == actual_user_id,
    do: :ok

  defp ensure_same_user(_requested_user_id, _actual_user_id), do: {:error, :forbidden}

  defp authorize_video_access(nil, _user_id), do: :ok

  defp authorize_video_access(video_id, user_id) do
    case Videos.get_video(video_id) do
      nil ->
        {:error, :video_not_found}

      %{user_id: ^user_id} ->
        :ok

      %{user_id: nil} ->
        :ok

      _ ->
        {:error, :forbidden}
    end
  end
end
