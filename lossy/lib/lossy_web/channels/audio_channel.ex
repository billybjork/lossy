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

  # Handle audio chunks from extension
  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_list(audio_data) do
    # Convert array to binary (most common case - from JS Array)
    audio_binary = :binary.list_to_bin(audio_data)

    Logger.debug("Received audio chunk: #{byte_size(audio_binary)} bytes (from array)")

    # Send to AgentSession
    Lossy.Agent.Session.cast_audio(socket.assigns.session_id, audio_binary)

    {:noreply, socket}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_map(audio_data) do
    # Convert map with string keys to binary (JSON serialization artifact)
    # This handles the case where Phoenix.js serializes Uint8Array as object
    audio_list =
      audio_data
      |> Enum.sort_by(fn {k, _v} -> String.to_integer(k) end)
      |> Enum.map(fn {_k, v} -> v end)

    audio_binary = :binary.list_to_bin(audio_list)

    Logger.debug("Received audio chunk: #{byte_size(audio_binary)} bytes (from map)")

    # Send to AgentSession
    Lossy.Agent.Session.cast_audio(socket.assigns.session_id, audio_binary)

    {:noreply, socket}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_binary(audio_data) do
    Logger.debug("Received audio chunk: #{byte_size(audio_data)} bytes (from binary)")

    # Send to AgentSession
    Lossy.Agent.Session.cast_audio(socket.assigns.session_id, audio_data)

    {:noreply, socket}
  end

  # Handle stop recording event
  @impl true
  def handle_in("stop_recording", _payload, socket) do
    Logger.info("Stop recording event received")

    Lossy.Agent.Session.stop_recording(socket.assigns.session_id)

    {:reply, {:ok, %{}}, socket}
  end

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

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
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
