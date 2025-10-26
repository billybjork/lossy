defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Agent.SessionSupervisor
  alias Lossy.Agent.VoiceSession
  alias Lossy.Settings
  alias Lossy.FeatureFlags
  alias LossyWeb.ChannelAuth

  @impl true
  def join("audio:" <> session_id, payload, socket) do
    case ChannelAuth.authorize_join(socket, payload) do
      {:ok, authed_socket, auth_payload} ->
        Logger.info("Audio channel joined: #{session_id}")

        video_id = Map.get(payload, "video_id")
        timestamp = Map.get(payload, "timestamp")
        voice_mode = Map.get(payload, "voice_mode", false)

        Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")

        # Check if voice mode is requested and feature flag is enabled
        user_id = authed_socket.assigns.user_id
        feature_flags = Settings.feature_flags_for(user_id)
        voice_session_enabled = voice_mode && FeatureFlags.enabled?(feature_flags, "phoenix_voice_session")

        if voice_session_enabled do
          Logger.info("[AudioChannel:#{session_id}] Starting Phoenix voice session (feature flag enabled)")
          Phoenix.PubSub.subscribe(Lossy.PubSub, "voice_session:#{session_id}")
          start_voice_session(session_id, user_id, video_id: video_id)
        else
          start_session(session_id, user_id,
            video_id: video_id,
            timestamp: timestamp
          )
        end

        response =
          auth_payload
          |> Map.put(:session_id, session_id)
          |> Map.put(:video_id, video_id)
          |> Map.put(:voice_session_enabled, voice_session_enabled)

        socket_with_session =
          authed_socket
          |> Phoenix.Socket.assign(:session_id, session_id)
          |> Phoenix.Socket.assign(:voice_session_enabled, voice_session_enabled)

        {:ok, response, socket_with_session}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Sprint 11: Audio chunks removed - all transcription happens locally
  # Extension sends transcript_final after local transcription completes

  # Sprint 07: Handle client-supplied transcript (partial)
  @impl true
  def handle_in("transcript_partial", %{"text" => text} = payload, socket) do
    Logger.debug("Partial transcript received: #{String.slice(text, 0..50)}...")

    confidence = Map.get(payload, "confidence", 1.0)

    # Broadcast to PubSub for LiveView progress (optional)
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "session:#{socket.assigns.session_id}",
      {:agent_event, %{type: :transcript_partial, text: text, confidence: confidence}}
    )

    {:noreply, socket}
  end

  # Sprint 07: Handle client-supplied transcript (final)
  @impl true
  def handle_in("transcript_final", payload, socket) do
    text = Map.fetch!(payload, "text")
    source = Map.get(payload, "source", "local")

    Logger.info(
      "Final transcript received (#{source}): #{String.slice(text, 0..50)}... (#{byte_size(text)} bytes)"
    )

    # Pass transcript to AgentSession
    Lossy.Agent.Session.handle_transcript(
      socket.assigns.session_id,
      text,
      source: String.to_atom(source),
      chunks: Map.get(payload, "chunks", []),
      duration_seconds: Map.get(payload, "durationSeconds"),
      transcription_time_ms: Map.get(payload, "transcriptionTimeMs")
    )

    {:reply, {:ok, %{}}, socket}
  end

  # Sprint 08: Handle frame embedding from visual intelligence
  @impl true
  def handle_in("frame_embedding", payload, socket) do
    embedding = Map.fetch!(payload, "embedding")
    timestamp = Map.fetch!(payload, "timestamp")
    source = Map.get(payload, "source", "local")
    device = Map.get(payload, "device", "unknown")

    Logger.info(
      "Frame embedding received (#{source}): #{length(embedding)} dims at #{timestamp}s on #{device}"
    )

    # Pass embedding to AgentSession
    Lossy.Agent.Session.handle_frame_embedding(
      socket.assigns.session_id,
      embedding,
      timestamp,
      source: String.to_atom(source),
      device: device,
      embedding_time_ms: Map.get(payload, "embeddingTimeMs")
    )

    {:reply, {:ok, %{}}, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
  end

  # Sprint 10: Handle timestamp update for voice mode
  @impl true
  def handle_in("set_timestamp", %{"timestamp" => timestamp}, socket)
      when is_number(timestamp) do
    session_id = socket.assigns.session_id

    Logger.info("[#{session_id}] Setting timestamp to #{timestamp} seconds")

    # Update the AgentSession's timestamp
    case Lossy.Agent.Session.set_timestamp(session_id, timestamp) do
      :ok ->
        {:reply, :ok, socket}

      {:error, reason} ->
        Logger.error("[#{session_id}] Failed to set timestamp: #{inspect(reason)}")
        {:reply, {:error, %{reason: "Failed to set timestamp"}}, socket}
    end
  end

  # Sprint 12: Handle video context update for voice mode (tab switching)
  @impl true
  def handle_in("update_video_context", %{"video_id" => video_id}, socket) do
    session_id = socket.assigns.session_id

    Logger.info("[#{session_id}] Updating video context to #{video_id}")

    # Update the AgentSession's video_id
    Lossy.Agent.Session.update_video_context(session_id, video_id)

    {:reply, :ok, socket}
  end

  # Sprint 15 Milestone 1: Handle voice events from extension
  @impl true
  def handle_in("voice_event", payload, socket) do
    if socket.assigns[:voice_session_enabled] do
      session_id = socket.assigns.session_id
      event_type = String.to_atom(Map.fetch!(payload, "type"))
      event_data = Map.get(payload, "data", %{})
      sequence_number = Map.get(payload, "sequence")

      Logger.debug("[AudioChannel:#{session_id}] Voice event: #{event_type} (seq: #{sequence_number})")

      # Forward to VoiceSession GenServer
      VoiceSession.handle_voice_event(session_id, event_type, event_data, sequence_number)

      {:reply, :ok, socket}
    else
      Logger.warning("Voice event received but voice session not enabled")
      {:reply, {:error, %{reason: "voice_session_not_enabled"}}, socket}
    end
  end

  # Sprint 15 Milestone 1: Reconnection protocol
  @impl true
  def handle_in("reconcile_events", payload, socket) do
    if socket.assigns[:voice_session_enabled] do
      session_id = socket.assigns.session_id
      last_known_sequence = Map.fetch!(payload, "last_sequence")

      Logger.info("[AudioChannel:#{session_id}] Reconciliation requested (last_seq: #{last_known_sequence})")

      case VoiceSession.reconcile_events(session_id, last_known_sequence) do
        {:ok, reconcile_data} ->
          {:reply, {:ok, reconcile_data}, socket}

        {:error, :reset_required} ->
          # Push reset_session event to client
          push(socket, "reset_session", %{
            reason: "state_diverged",
            message: "Session state too diverged, please reset"
          })

          {:reply, {:error, %{reason: "reset_required"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "voice_session_not_enabled"}}, socket}
    end
  end

  # Handle agent session events from PubSub
  @impl true
  def handle_info({:agent_event, %{type: :transcript_ready, text: _text}}, socket) do
    # Don't forward raw transcript - we'll send the structured note instead
    {:noreply, socket}
  end

  @impl true
  def handle_info({:agent_event, %{type: :note_created, note: note}}, socket) do
    Logger.info("Forwarding note to client: #{note.id}")

    push(socket, "note_created", %{
      id: note.id,
      text: note.text,
      category: note.category,
      confidence: note.confidence,
      timestamp_seconds: note.timestamp_seconds,
      raw_transcript: note.raw_transcript,
      timestamp: System.system_time(:second)
    })

    {:noreply, socket}
  end

  @impl true
  def handle_info({:agent_event, event}, socket) do
    # Log other events for debugging
    Logger.debug("Agent event: #{inspect(event)}")
    {:noreply, socket}
  end

  # Sprint 15 Milestone 1: Handle voice session events from PubSub
  @impl true
  def handle_info({:voice_session_event, %{type: :status_changed} = event}, socket) do
    # Forward status changes to the extension
    push(socket, "voice_status", %{
      status: event.status,
      telemetry: event.telemetry
    })

    {:noreply, socket}
  end

  @impl true
  def handle_info({:voice_session_event, %{type: :speech_ignored} = event}, socket) do
    # Notify extension that speech was ignored
    push(socket, "voice_event_response", %{
      type: "speech_ignored",
      data: event.data
    })

    {:noreply, socket}
  end

  @impl true
  def handle_info({:voice_session_event, event}, socket) do
    # Log other voice session events for debugging
    Logger.debug("Voice session event: #{inspect(event)}")
    {:noreply, socket}
  end

  defp start_session(session_id, user_id, opts) do
    case SessionSupervisor.start_session(session_id, Keyword.merge(opts, user_id: user_id)) do
      {:ok, _pid} ->
        Logger.info(
          "Started new AgentSession: #{session_id} (video: #{opts[:video_id]}, ts: #{opts[:timestamp]}, user: #{user_id})"
        )

      {:error, {:already_started, _pid}} ->
        Logger.info("AgentSession already running: #{session_id}")

      {:error, reason} ->
        Logger.error("Failed to start AgentSession: #{inspect(reason)}")
    end
  end

  defp start_voice_session(session_id, user_id, opts) do
    child_spec = %{
      id: VoiceSession,
      start: {VoiceSession, :start_link, [[session_id: session_id, user_id: user_id] ++ opts]},
      restart: :transient
    }

    case DynamicSupervisor.start_child(SessionSupervisor, child_spec) do
      {:ok, _pid} ->
        Logger.info(
          "Started new VoiceSession: #{session_id} (video: #{opts[:video_id]}, user: #{user_id})"
        )

      {:error, {:already_started, _pid}} ->
        Logger.info("VoiceSession already running: #{session_id}")

      {:error, reason} ->
        Logger.error("Failed to start VoiceSession: #{inspect(reason)}")
    end
  end
end
