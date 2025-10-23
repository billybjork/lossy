defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Agent.SessionSupervisor

  @impl true
  def join("audio:" <> session_id, payload, socket) do
    Logger.info("Audio channel joined: #{session_id}")

    video_id = Map.get(payload, "video_id")
    timestamp = Map.get(payload, "timestamp")

    # Subscribe to agent session events
    Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")

    # Start AgentSession with video context
    case SessionSupervisor.start_session(
           session_id,
           video_id: video_id,
           timestamp: timestamp
         ) do
      {:ok, _pid} ->
        Logger.info(
          "Started new AgentSession: #{session_id} (video: #{video_id}, ts: #{timestamp})"
        )

      {:error, {:already_started, _pid}} ->
        Logger.info("AgentSession already running: #{session_id}")

      {:error, reason} ->
        Logger.error("Failed to start AgentSession: #{inspect(reason)}")
    end

    {:ok, assign(socket, :session_id, session_id)}
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

  # Sprint 10: Handle timestamp update for passive mode
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

  # Sprint 12: Handle video context update for passive mode (tab switching)
  @impl true
  def handle_in("update_video_context", %{"video_id" => video_id}, socket) do
    session_id = socket.assigns.session_id

    Logger.info("[#{session_id}] Updating video context to #{video_id}")

    # Update the AgentSession's video_id
    Lossy.Agent.Session.update_video_context(session_id, video_id)

    {:reply, :ok, socket}
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
end
