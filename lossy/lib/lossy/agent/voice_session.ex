defmodule Lossy.Agent.VoiceSession do
  @moduledoc """
  Voice session state machine for Phoenix-managed voice mode (Milestone 1).

  Orchestrates the voice session lifecycle, handling VAD events from the extension
  and managing state transitions, timers, and reconnection logic.

  ## States
  - `:idle` - No active voice session
  - `:observing` - Listening for speech (VAD active, no speech detected yet)
  - `:recording` - Speech detected, recording in progress
  - `:cooldown` - Recording completed, waiting before accepting new speech
  - `:error` - Unrecoverable error, session must be restarted
  - `:disconnected` - Extension disconnected (channel down)
  - `:reconnecting` - Attempting to reconnect after disconnection

  ## Events
  - `speech_start` - Speech detected by VAD
  - `speech_end` - Speech ended, transcription pending
  - `metrics` - Periodic VAD health metrics
  - `heartbeat` - Connection health check
  - `error` - Fatal VAD or connection error
  """

  use GenServer
  require Logger

  # Default configuration (can be overridden via opts)
  @default_config %{
    cooldown_ms: 1_500,
    first_speech_timeout_ms: 60_000,
    first_speech_guard_max_wait_ms: 300_000,
    heartbeat_timeout_ms: 10_000,
    max_reconnect_attempts: 5,
    reconnect_backoff_ms: 2_000
  }

  # Reconnection buffer limits
  @max_buffered_events 100

  # Client API

  def start_link(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    GenServer.start_link(__MODULE__, opts, name: via_tuple(session_id))
  end

  @doc """
  Handle a voice event from the extension (speech_start, speech_end, metrics, heartbeat, error).
  Includes sequence number for reconnection protocol.
  """
  def handle_voice_event(session_id, event_type, event_data \\ %{}, sequence_number \\ nil) do
    GenServer.cast(via_tuple(session_id), {:voice_event, event_type, event_data, sequence_number})
  end

  @doc """
  Reconcile buffered events after reconnection.
  Returns :ok if reconciliation succeeded, {:error, :reset_required} if state is too diverged.
  """
  def reconcile_events(session_id, last_known_sequence) do
    GenServer.call(via_tuple(session_id), {:reconcile_events, last_known_sequence})
  end

  @doc """
  Start observing for speech (transition from idle to observing).
  Called when voice mode is initiated.
  """
  def start_observing(session_id) do
    GenServer.cast(via_tuple(session_id), :start_observing)
  end

  @doc """
  Get current session state for debugging/telemetry.
  """
  def get_state(session_id) do
    GenServer.call(via_tuple(session_id), :get_state)
  end

  @doc """
  Stop the voice session gracefully.
  """
  def stop_session(session_id) do
    GenServer.cast(via_tuple(session_id), :stop_session)
  end

  # Server Callbacks

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.fetch!(opts, :user_id)
    video_id = Keyword.get(opts, :video_id)
    config = Keyword.get(opts, :config, @default_config)

    state = %{
      session_id: session_id,
      user_id: user_id,
      video_id: video_id,
      status: :idle,
      config: Map.merge(@default_config, config),

      # Telemetry
      telemetry: %{
        speech_detections: 0,
        ignored_cooldown: 0,
        ignored_no_context: 0,
        notes_created: 0,
        started_at: DateTime.utc_now(),
        last_heartbeat_at: nil
      },

      # Timers
      cooldown_timer: nil,
      first_speech_timer: nil,
      heartbeat_timer: nil,

      # Reconnection state
      sequence_number: 0,
      reconnect_attempts: 0,

      # Recording context
      recording_context: nil,
      last_event_at: DateTime.utc_now()
    }

    # Subscribe to regular session events to track note creation
    Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")

    Logger.info("[VoiceSession:#{session_id}] Initialized for user #{user_id}, video #{video_id}")

    {:ok, state}
  end

  # Voice Event Handlers

  @impl true
  def handle_cast({:voice_event, event_type, event_data, sequence_number}, state) do
    state = update_last_event(state)

    # Validate sequence number if provided
    state =
      if sequence_number do
        validate_and_update_sequence(state, sequence_number)
      else
        state
      end

    case handle_event(event_type, event_data, state) do
      {:ok, new_state} ->
        {:noreply, new_state}

      {:error, reason} ->
        Logger.error("[VoiceSession:#{state.session_id}] Event handling error: #{inspect(reason)}")
        {:noreply, transition_to_error(state, reason)}
    end
  end

  @impl true
  def handle_cast(:start_observing, state) do
    if state.status == :idle do
      Logger.info("[VoiceSession:#{state.session_id}] Starting to observe for speech")

      state = %{state | status: :observing}
      state = schedule_first_speech_guard(state)

      broadcast_status_change(state)

      {:noreply, state}
    else
      Logger.warning(
        "[VoiceSession:#{state.session_id}] Already in #{state.status} state, ignoring start_observing"
      )

      {:noreply, state}
    end
  end

  @impl true
  def handle_cast(:stop_session, state) do
    Logger.info("[VoiceSession:#{state.session_id}] Stopping session")

    state = cancel_all_timers(state)
    state = %{state | status: :idle}

    broadcast_status_change(state)

    {:noreply, state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    public_state = %{
      session_id: state.session_id,
      user_id: state.user_id,
      video_id: state.video_id,
      status: state.status,
      telemetry: state.telemetry,
      sequence_number: state.sequence_number
    }

    {:reply, public_state, state}
  end

  @impl true
  def handle_call({:reconcile_events, last_known_sequence}, _from, state) do
    Logger.info(
      "[VoiceSession:#{state.session_id}] Reconciling events (last_known: #{last_known_sequence}, current: #{state.sequence_number})"
    )

    sequence_gap = state.sequence_number - last_known_sequence

    cond do
      # Perfect sync - no gap
      sequence_gap == 0 ->
        Logger.info("[VoiceSession:#{state.session_id}] Perfect sync, no reconciliation needed")
        {:reply, {:ok, %{gap: 0, status: state.status}}, state}

      # Small gap - within buffer limit
      sequence_gap > 0 && sequence_gap <= @max_buffered_events ->
        Logger.info("[VoiceSession:#{state.session_id}] Small gap (#{sequence_gap}), client can replay")
        {:reply, {:ok, %{gap: sequence_gap, status: state.status}}, state}

      # Large gap - reset required
      sequence_gap > @max_buffered_events ->
        Logger.warning(
          "[VoiceSession:#{state.session_id}] Large gap (#{sequence_gap}), reset required"
        )

        {:reply, {:error, :reset_required}, state}

      # Negative gap - client ahead of server (shouldn't happen)
      sequence_gap < 0 ->
        Logger.error(
          "[VoiceSession:#{state.session_id}] Client ahead of server (gap: #{sequence_gap}), reset required"
        )

        {:reply, {:error, :reset_required}, state}
    end
  end

  # Timer Callbacks

  @impl true
  def handle_info(:cooldown_complete, state) do
    Logger.info("[VoiceSession:#{state.session_id}] Cooldown complete, resuming observation")

    new_state = %{state | status: :observing, cooldown_timer: nil}
    broadcast_status_change(new_state)

    {:noreply, new_state}
  end

  @impl true
  def handle_info(:first_speech_timeout, state) do
    if state.telemetry.speech_detections == 0 do
      Logger.info("[VoiceSession:#{state.session_id}] No speech detected within timeout, stopping")

      state = cancel_all_timers(state)
      state = %{state | status: :idle, first_speech_timer: nil}

      broadcast_status_change(state)
      broadcast_event(state, :auto_stop, %{reason: "no_speech_timeout"})

      {:noreply, state}
    else
      # Speech was detected, clear the timer
      {:noreply, %{state | first_speech_timer: nil}}
    end
  end

  @impl true
  def handle_info(:heartbeat_timeout, state) do
    Logger.warning("[VoiceSession:#{state.session_id}] Heartbeat timeout, transitioning to disconnected")

    new_state = transition_to_disconnected(state)

    {:noreply, new_state}
  end

  # Handle note creation events from the regular Session
  @impl true
  def handle_info({:agent_event, %{type: :note_created}}, state) do
    state = update_telemetry(state, :notes_created)

    Logger.debug("[VoiceSession:#{state.session_id}] Note created, total: #{state.telemetry.notes_created}")

    # Broadcast updated telemetry
    broadcast_status_change(state)

    {:noreply, state}
  end

  # Ignore other agent events
  @impl true
  def handle_info({:agent_event, _event}, state) do
    {:noreply, state}
  end

  # Event Handlers

  defp handle_event(:speech_start, event_data, state) do
    case state.status do
      :observing ->
        handle_speech_start(event_data, state)

      :recording ->
        # Already recording, extend recording
        Logger.debug("[VoiceSession:#{state.session_id}] Speech continues, extending recording")
        {:ok, state}

      :cooldown ->
        # Ignore during cooldown
        state = update_telemetry(state, :ignored_cooldown)
        Logger.debug("[VoiceSession:#{state.session_id}] Ignored speech_start during cooldown")
        {:ok, state}

      status when status in [:idle, :error, :disconnected, :reconnecting] ->
        Logger.warning("[VoiceSession:#{state.session_id}] Ignoring speech_start in #{status} state")
        {:ok, state}
    end
  end

  defp handle_event(:speech_end, event_data, state) do
    case state.status do
      :recording ->
        handle_speech_end(event_data, state)

      _other ->
        Logger.debug("[VoiceSession:#{state.session_id}] Ignoring speech_end in #{state.status} state")
        {:ok, state}
    end
  end

  defp handle_event(:metrics, event_data, state) do
    # Update heartbeat timestamp
    state = put_in(state, [:telemetry, :last_heartbeat_at], DateTime.utc_now())

    # Reset heartbeat timer
    state = cancel_heartbeat_timer(state)
    state = schedule_heartbeat_timeout(state)

    # Emit telemetry event for metrics
    :telemetry.execute(
      [:lossy, :voice_session, :metrics],
      %{
        confidence: Map.get(event_data, :confidence, 0.0),
        latency_ms: Map.get(event_data, :latency_ms, 0.0)
      },
      %{
        session_id: state.session_id,
        user_id: state.user_id,
        status: state.status
      }
    )

    # Broadcast metrics for telemetry
    broadcast_event(state, :metrics, event_data)

    {:ok, state}
  end

  defp handle_event(:heartbeat, _event_data, state) do
    # Update heartbeat timestamp
    state = put_in(state, [:telemetry, :last_heartbeat_at], DateTime.utc_now())

    # Reset heartbeat timer
    state = cancel_heartbeat_timer(state)
    state = schedule_heartbeat_timeout(state)

    {:ok, state}
  end

  defp handle_event(:error, event_data, state) do
    Logger.error("[VoiceSession:#{state.session_id}] VAD error: #{inspect(event_data)}")

    # Emit telemetry event for errors
    :telemetry.execute(
      [:lossy, :voice_session, :error],
      %{count: 1},
      %{
        session_id: state.session_id,
        user_id: state.user_id,
        error: inspect(event_data)
      }
    )

    state = transition_to_error(state, event_data)

    {:ok, state}
  end

  defp handle_event(unknown_type, _event_data, state) do
    Logger.warning("[VoiceSession:#{state.session_id}] Unknown event type: #{inspect(unknown_type)}")
    {:ok, state}
  end

  # Speech Event Handlers

  defp handle_speech_start(event_data, state) do
    # Validate video context
    if !state.video_id do
      Logger.warning("[VoiceSession:#{state.session_id}] No video context, ignoring speech_start")
      state = update_telemetry(state, :ignored_no_context)
      broadcast_event(state, :speech_ignored, %{reason: "no_video_context"})
      {:ok, state}
    else
      # Create recording context
      confidence = Map.get(event_data, :confidence, 0.0)
      timestamp = Map.get(event_data, :timestamp)

      recording_context = %{
        started_at: DateTime.utc_now(),
        confidence: confidence,
        timestamp: timestamp,
        video_id: state.video_id
      }

      # Transition to recording
      state = %{state | status: :recording, recording_context: recording_context}
      state = update_telemetry(state, :speech_detections)

      # Clear first speech timer on first detection
      state = cancel_first_speech_timer(state)

      Logger.info("[VoiceSession:#{state.session_id}] Speech started (confidence: #{confidence})")

      # Emit telemetry event for speech start
      :telemetry.execute(
        [:lossy, :voice_session, :speech_start],
        %{count: 1, confidence: confidence},
        %{
          session_id: state.session_id,
          user_id: state.user_id,
          video_id: state.video_id
        }
      )

      broadcast_status_change(state)
      broadcast_event(state, :speech_started, %{
        confidence: confidence,
        timestamp: timestamp,
        video_id: state.video_id
      })

      {:ok, state}
    end
  end

  defp handle_speech_end(event_data, state) do
    duration_ms = Map.get(event_data, :duration_ms, 0)
    confidence = Map.get(event_data, :confidence, state.recording_context[:confidence])

    Logger.info("[VoiceSession:#{state.session_id}] Speech ended (duration: #{duration_ms}ms)")

    # Emit telemetry event for speech end
    :telemetry.execute(
      [:lossy, :voice_session, :speech_end],
      %{duration_ms: duration_ms, confidence: confidence},
      %{
        session_id: state.session_id,
        user_id: state.user_id,
        video_id: state.video_id
      }
    )

    # Transition to cooldown
    state = %{state | status: :cooldown, recording_context: nil}
    state = schedule_cooldown(state)

    broadcast_status_change(state)
    broadcast_event(state, :speech_ended, %{
      duration_ms: duration_ms,
      confidence: confidence
    })

    {:ok, state}
  end

  # State Transitions

  defp transition_to_error(state, reason) do
    state = cancel_all_timers(state)
    state = %{state | status: :error}

    Logger.error("[VoiceSession:#{state.session_id}] Transitioned to error state: #{inspect(reason)}")

    broadcast_status_change(state)
    broadcast_event(state, :error, %{reason: inspect(reason)})

    state
  end

  defp transition_to_disconnected(state) do
    state = cancel_all_timers(state)
    state = %{state | status: :disconnected, reconnect_attempts: 0}

    Logger.warning("[VoiceSession:#{state.session_id}] Transitioned to disconnected state")

    broadcast_status_change(state)
    broadcast_event(state, :disconnected, %{})

    state
  end

  # Timer Management

  defp schedule_cooldown(state) do
    cancel_cooldown_timer(state)

    timer_ref = Process.send_after(self(), :cooldown_complete, state.config.cooldown_ms)

    %{state | cooldown_timer: timer_ref}
  end

  defp schedule_first_speech_guard(state) do
    cancel_first_speech_timer(state)

    timer_ref = Process.send_after(self(), :first_speech_timeout, state.config.first_speech_timeout_ms)

    %{state | first_speech_timer: timer_ref}
  end

  defp schedule_heartbeat_timeout(state) do
    timer_ref = Process.send_after(self(), :heartbeat_timeout, state.config.heartbeat_timeout_ms)

    %{state | heartbeat_timer: timer_ref}
  end

  defp cancel_cooldown_timer(state) do
    if state.cooldown_timer do
      Process.cancel_timer(state.cooldown_timer)
    end

    %{state | cooldown_timer: nil}
  end

  defp cancel_first_speech_timer(state) do
    if state.first_speech_timer do
      Process.cancel_timer(state.first_speech_timer)
    end

    %{state | first_speech_timer: nil}
  end

  defp cancel_heartbeat_timer(state) do
    if state.heartbeat_timer do
      Process.cancel_timer(state.heartbeat_timer)
    end

    %{state | heartbeat_timer: nil}
  end

  defp cancel_all_timers(state) do
    state
    |> cancel_cooldown_timer()
    |> cancel_first_speech_timer()
    |> cancel_heartbeat_timer()
  end

  # Telemetry & Broadcasting

  defp update_telemetry(state, :speech_detections) do
    put_in(state, [:telemetry, :speech_detections], state.telemetry.speech_detections + 1)
  end

  defp update_telemetry(state, :ignored_cooldown) do
    put_in(state, [:telemetry, :ignored_cooldown], state.telemetry.ignored_cooldown + 1)
  end

  defp update_telemetry(state, :ignored_no_context) do
    put_in(state, [:telemetry, :ignored_no_context], state.telemetry.ignored_no_context + 1)
  end

  defp update_telemetry(state, :notes_created) do
    put_in(state, [:telemetry, :notes_created], state.telemetry.notes_created + 1)
  end

  defp update_last_event(state) do
    %{state | last_event_at: DateTime.utc_now()}
  end

  defp broadcast_status_change(state) do
    # Emit telemetry event for observability
    :telemetry.execute(
      [:lossy, :voice_session, :status_change],
      %{count: 1},
      %{
        session_id: state.session_id,
        user_id: state.user_id,
        old_status: state.status,
        new_status: state.status,
        speech_detections: state.telemetry.speech_detections
      }
    )

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "voice_session:#{state.session_id}",
      {:voice_session_event, %{
        type: :status_changed,
        status: state.status,
        telemetry: state.telemetry
      }}
    )
  end

  defp broadcast_event(state, event_type, event_data) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "voice_session:#{state.session_id}",
      {:voice_session_event, %{
        type: event_type,
        data: event_data,
        status: state.status
      }}
    )
  end

  # Reconnection Protocol

  defp validate_and_update_sequence(state, incoming_sequence) do
    expected_sequence = state.sequence_number + 1

    cond do
      # Sequence matches expected - normal operation
      incoming_sequence == expected_sequence ->
        %{state | sequence_number: incoming_sequence}

      # Duplicate or old event - ignore but don't error
      incoming_sequence <= state.sequence_number ->
        Logger.debug(
          "[VoiceSession:#{state.session_id}] Ignoring old event (seq: #{incoming_sequence}, current: #{state.sequence_number})"
        )

        state

      # Gap detected - log warning but continue
      incoming_sequence > expected_sequence ->
        gap = incoming_sequence - state.sequence_number

        Logger.warning(
          "[VoiceSession:#{state.session_id}] Sequence gap detected (expected: #{expected_sequence}, got: #{incoming_sequence}, gap: #{gap})"
        )

        broadcast_event(state, :sequence_gap, %{
          expected: expected_sequence,
          received: incoming_sequence,
          gap: gap
        })

        %{state | sequence_number: incoming_sequence}
    end
  end

  # Helpers

  defp via_tuple(session_id) do
    {:via, Registry, {Lossy.Agent.SessionRegistry, {:voice, session_id}}}
  end
end
