defmodule Lossy.Agent.Session do
  use GenServer
  require Logger

  alias Lossy.Inference.Cloud
  alias Lossy.Videos

  # 5MB max
  @max_audio_buffer_bytes 5_000_000
  # 60s max
  @max_audio_duration_seconds 60

  # Client API

  def start_link(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    GenServer.start_link(__MODULE__, opts, name: via_tuple(session_id))
  end

  def cast_audio(session_id, audio_chunk) do
    GenServer.cast(via_tuple(session_id), {:audio_chunk, audio_chunk})
  end

  def stop_recording(session_id) do
    GenServer.cast(via_tuple(session_id), :stop_recording)
  end

  def handle_transcript(session_id, text, opts \\ []) do
    GenServer.cast(via_tuple(session_id), {:transcript_ready, text, opts})
  end

  # Sprint 08: Handle frame embedding from visual intelligence
  def handle_frame_embedding(session_id, embedding, timestamp, opts \\ []) do
    GenServer.cast(via_tuple(session_id), {:frame_embedding, embedding, timestamp, opts})
  end

  # Sprint 10: Update timestamp for passive mode
  def set_timestamp(session_id, timestamp) when is_number(timestamp) do
    GenServer.call(via_tuple(session_id), {:set_timestamp, timestamp})
  end

  # Sprint 12: Update video context for passive mode (when user switches tabs)
  def update_video_context(session_id, video_id) do
    GenServer.cast(via_tuple(session_id), {:update_video_context, video_id})
  end

  # Server Callbacks

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.get(opts, :user_id)
    video_id = Keyword.get(opts, :video_id)
    timestamp = Keyword.get(opts, :timestamp)

    # Default timestamp to 0.0 if nil (for notes created without video context)
    timestamp_seconds = timestamp || 0.0

    state = %{
      session_id: session_id,
      user_id: user_id,
      video_id: video_id,
      timestamp_seconds: timestamp_seconds,
      status: :idle,
      audio_buffer: <<>>,
      audio_duration: 0,
      started_at: nil,
      last_transition: DateTime.utc_now()
    }

    Logger.info(
      "AgentSession started: #{session_id}, video_id: #{video_id}, timestamp: #{timestamp_seconds}"
    )

    {:ok, state}
  end

  @impl true
  def handle_cast({:audio_chunk, data}, state) do
    new_buffer = state.audio_buffer <> data
    new_duration = state.audio_duration + estimate_chunk_duration(data)

    # Broadcast partial event
    broadcast_event(state.session_id, %{
      type: :audio_chunk_received,
      buffer_size: byte_size(new_buffer),
      duration: new_duration
    })

    cond do
      byte_size(new_buffer) >= @max_audio_buffer_bytes ->
        Logger.warning("Max buffer size reached, forcing transcription")
        state = %{state | audio_buffer: new_buffer, audio_duration: new_duration}
        {:noreply, transition_to(state, :transcribing)}

      new_duration >= @max_audio_duration_seconds ->
        Logger.warning("Max duration reached, forcing transcription")
        state = %{state | audio_buffer: new_buffer, audio_duration: new_duration}
        {:noreply, transition_to(state, :transcribing)}

      true ->
        # Continue accumulating
        {:noreply,
         %{state | audio_buffer: new_buffer, audio_duration: new_duration, status: :listening}}
    end
  end

  @impl true
  def handle_cast(:stop_recording, state) do
    Logger.info("Stopping recording, transcribing #{byte_size(state.audio_buffer)} bytes")
    {:noreply, transition_to(state, :transcribing)}
  end

  # Sprint 07: Handle client-supplied transcript
  @impl true
  def handle_cast({:transcript_ready, text, opts}, state) do
    source = Keyword.get(opts, :source, :local)

    Logger.info(
      "[#{state.session_id}] Received #{source} transcript: #{String.slice(text, 0..50)}..."
    )

    # Broadcast that we received the transcript
    broadcast_event(state.session_id, %{
      type: :transcript_ready,
      text: text,
      source: source
    })

    # Move to structuring (skip transcription since we already have text)
    structure_note(state, text, source: source, opts: opts)

    # Sprint 10 FIX: Clear audio buffer after processing transcript
    # This is critical for persistent audio channel in passive mode
    {:noreply, %{state | status: :idle, audio_buffer: <<>>, audio_duration: 0}}
  end

  # Sprint 08: Handle frame embedding from visual intelligence
  @impl true
  def handle_cast({:frame_embedding, embedding, timestamp, opts}, state) do
    source = Keyword.get(opts, :source, :local)
    device = Keyword.get(opts, :device, "unknown")

    Logger.info(
      "[#{state.session_id}] Received #{source} frame embedding: #{length(embedding)} dims at #{timestamp}s (#{device})"
    )

    # Store embedding in state for potential use in note enrichment
    # For now, we just log it. In Task 6 (Clarify action), we'll use this to enrich notes.
    visual_context = %{
      embedding: embedding,
      timestamp: timestamp,
      source: source,
      device: device
    }

    {:noreply, Map.put(state, :pending_visual_context, visual_context)}
  end

  # Sprint 12: Handle video context update for passive mode (tab switching)
  @impl true
  def handle_cast({:update_video_context, video_id}, state) do
    Logger.info("[#{state.session_id}] Updating video context: #{state.video_id} → #{video_id}")
    new_state = %{state | video_id: video_id}
    {:noreply, new_state}
  end

  # Sprint 10: Handle timestamp update for passive mode
  @impl true
  def handle_call({:set_timestamp, timestamp}, _from, state) do
    Logger.info("[#{state.session_id}] Updating timestamp: #{state.timestamp_seconds} → #{timestamp}")
    new_state = %{state | timestamp_seconds: timestamp}
    {:reply, :ok, new_state}
  end

  # State Transitions

  defp transition_to(%{status: :listening} = state, :transcribing) do
    Logger.info("[#{state.session_id}] listening → transcribing")

    # Kick off async transcription
    Task.start(fn -> transcribe_audio(state) end)

    broadcast_event(state.session_id, %{
      type: :transcription_started,
      buffer_size: byte_size(state.audio_buffer)
    })

    %{state | status: :transcribing}
  end

  defp transition_to(%{status: :idle} = state, :transcribing) do
    Logger.info("[#{state.session_id}] idle → transcribing")

    # Kick off async transcription
    Task.start(fn -> transcribe_audio(state) end)

    broadcast_event(state.session_id, %{
      type: :transcription_started,
      buffer_size: byte_size(state.audio_buffer)
    })

    %{state | status: :transcribing}
  end

  defp transition_to(state, _new_status) do
    # No transition needed or invalid transition
    state
  end

  # Async Work

  defp transcribe_audio(state) do
    Logger.info(
      "[#{state.session_id}] Starting cloud transcription (#{byte_size(state.audio_buffer)} bytes)"
    )

    start_time = System.monotonic_time(:millisecond)

    case Cloud.transcribe_audio(state.audio_buffer) do
      {:ok, transcript_text} ->
        transcription_time = System.monotonic_time(:millisecond) - start_time

        Logger.info(
          "[#{state.session_id}] Cloud transcription complete in #{transcription_time}ms: #{String.slice(transcript_text, 0..50)}..."
        )

        # Broadcast transcript
        broadcast_event(state.session_id, %{
          type: :transcript_ready,
          text: transcript_text,
          source: :cloud,
          transcription_time_ms: transcription_time
        })

        # Now structure the note
        structure_note(state, transcript_text,
          source: :cloud,
          transcription_time_ms: transcription_time
        )

      {:error, reason} ->
        Logger.error("[#{state.session_id}] Transcription failed: #{inspect(reason)}")

        broadcast_event(state.session_id, %{
          type: :transcription_failed,
          error: inspect(reason)
        })
    end
  end

  defp structure_note(state, transcript_text, keyword_opts) do
    source = Keyword.get(keyword_opts, :source, :cloud)

    case Cloud.structure_note(transcript_text) do
      {:ok, structured_note} ->
        Logger.info(
          "[#{state.session_id}] Note structured (source: #{source}): #{inspect(structured_note)}"
        )

        # Sprint 10 FIX: Filter out low-confidence notes (junk/noise)
        # Confidence 0.0 means GPT-4o-mini determined the transcript is meaningless
        if structured_note.confidence < 0.3 do
          Logger.info(
            "[#{state.session_id}] Skipping low-confidence note (#{structured_note.confidence}): #{transcript_text}"
          )

          # Don't create the note, just return
          :ok
        else
          # Store in database
          {:ok, note} =
            Videos.create_note(%{
              raw_transcript: transcript_text,
              text: structured_note.text,
              category: structured_note.category,
              confidence: structured_note.confidence,
              status: "ghost",
              timestamp_seconds: state.timestamp_seconds,
              video_id: state.video_id,
              session_id: state.session_id
            })

          # Sprint 09: Update video's last_viewed_at and auto-transition status
          # (queued → in_progress when first note is created)
          if state.video_id do
            Videos.touch_video(state.video_id)
          end

          # Broadcast final result
          broadcast_event(state.session_id, %{
            type: :note_created,
            note: note,
            source: source
          })

          # Also broadcast to video topic
          if state.video_id do
            Phoenix.PubSub.broadcast(
              Lossy.PubSub,
              "video:#{state.video_id}",
              {:new_note, note}
            )
          end

          # Broadcast to notes:all for LiveView testing
          Phoenix.PubSub.broadcast(
            Lossy.PubSub,
            "notes:all",
            {:agent_event, %{type: :note_created, note: note}}
          )
        end

      {:error, reason} ->
        Logger.error("[#{state.session_id}] Note structuring failed: #{inspect(reason)}")

        broadcast_event(state.session_id, %{
          type: :structuring_failed,
          error: inspect(reason)
        })
    end
  end

  # Helpers

  defp broadcast_event(session_id, event) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "session:#{session_id}",
      {:agent_event, event}
    )
  end

  defp estimate_chunk_duration(audio_data) do
    # WebM Opus at 16kbps ≈ 2KB/sec
    byte_size(audio_data) / 2000
  end

  defp via_tuple(session_id) do
    {:via, Registry, {Lossy.Agent.SessionRegistry, session_id}}
  end
end
