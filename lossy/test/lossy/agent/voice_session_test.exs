defmodule Lossy.Agent.VoiceSessionTest do
  use Lossy.DataCase

  alias Lossy.Agent.VoiceSession

  describe "voice session lifecycle" do
    setup do
      session_id = Ecto.UUID.generate()
      user_id = Ecto.UUID.generate()
      video_id = Ecto.UUID.generate()

      {:ok, pid} =
        VoiceSession.start_link(
          session_id: session_id,
          user_id: user_id,
          video_id: video_id
        )

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
      end)

      %{session_id: session_id, user_id: user_id, video_id: video_id}
    end

    test "initializes in idle state", %{session_id: session_id} do
      state = VoiceSession.get_state(session_id)

      assert state.status == :idle
      assert state.telemetry.speech_detections == 0
    end

    test "transitions to observing on first speech_start", %{session_id: session_id} do
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      # Give GenServer time to process
      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      assert state.status == :recording
      assert state.telemetry.speech_detections == 1
    end

    test "transitions from recording to cooldown on speech_end", %{session_id: session_id} do
      # Start speech
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      Process.sleep(10)

      # End speech
      VoiceSession.handle_voice_event(session_id, :speech_end, %{
        duration_ms: 2000,
        confidence: 0.95
      })

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      assert state.status == :cooldown
    end

    test "ignores speech_start during cooldown", %{session_id: session_id} do
      # Start and end speech
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      Process.sleep(10)

      VoiceSession.handle_voice_event(session_id, :speech_end, %{
        duration_ms: 2000,
        confidence: 0.95
      })

      Process.sleep(10)

      initial_detections = VoiceSession.get_state(session_id).telemetry.speech_detections

      # Try to start speech again during cooldown
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 15.0
      })

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      assert state.status == :cooldown
      assert state.telemetry.ignored_cooldown == 1
      assert state.telemetry.speech_detections == initial_detections
    end

    test "returns to observing after cooldown completes", %{session_id: session_id} do
      # Configure shorter cooldown for testing
      via = {:via, Registry, {Lossy.Agent.SessionRegistry, {:voice, session_id}}}
      GenServer.stop(via)

      {:ok, _pid} =
        VoiceSession.start_link(
          session_id: session_id,
          user_id: Ecto.UUID.generate(),
          video_id: Ecto.UUID.generate(),
          config: %{cooldown_ms: 50}
        )

      # Start and end speech
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      Process.sleep(10)

      VoiceSession.handle_voice_event(session_id, :speech_end, %{
        duration_ms: 2000,
        confidence: 0.95
      })

      Process.sleep(10)

      assert VoiceSession.get_state(session_id).status == :cooldown

      # Wait for cooldown to complete
      Process.sleep(100)

      assert VoiceSession.get_state(session_id).status == :observing
    end

    test "updates heartbeat timestamp on metrics event", %{session_id: session_id} do
      VoiceSession.handle_voice_event(session_id, :metrics, %{
        state: "observing",
        confidence: 0.8,
        latency_ms: 15.5
      })

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      assert state.telemetry.last_heartbeat_at != nil
    end

    test "ignores speech when no video context", %{session_id: session_id, user_id: user_id} do
      # Stop existing session and start new one without video_id
      via = {:via, Registry, {Lossy.Agent.SessionRegistry, {:voice, session_id}}}
      GenServer.stop(via)

      {:ok, _pid} =
        VoiceSession.start_link(
          session_id: session_id,
          user_id: user_id,
          video_id: nil
        )

      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      # Should remain in idle or observing, not recording
      assert state.status in [:idle, :observing]
      assert state.telemetry.ignored_no_context == 1
    end
  end

  describe "reconnection protocol" do
    setup do
      session_id = Ecto.UUID.generate()
      user_id = Ecto.UUID.generate()
      video_id = Ecto.UUID.generate()

      {:ok, pid} =
        VoiceSession.start_link(
          session_id: session_id,
          user_id: user_id,
          video_id: video_id
        )

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
      end)

      %{session_id: session_id}
    end

    test "reconciles with perfect sync", %{session_id: session_id} do
      assert {:ok, %{gap: 0}} = VoiceSession.reconcile_events(session_id, 0)
    end

    test "reconciles with small gap", %{session_id: session_id} do
      # Send some events to advance sequence
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 1)
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 2)
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 3)

      Process.sleep(10)

      # Client reconnects with last known sequence 1
      assert {:ok, %{gap: 2}} = VoiceSession.reconcile_events(session_id, 1)
    end

    test "requires reset with large gap", %{session_id: session_id} do
      # Send many events to create large gap
      for seq <- 1..150 do
        VoiceSession.handle_voice_event(session_id, :metrics, %{}, seq)
      end

      Process.sleep(50)

      # Client reconnects with last known sequence 1 (gap of ~150)
      assert {:error, :reset_required} = VoiceSession.reconcile_events(session_id, 1)
    end

    test "validates sequence numbers", %{session_id: session_id} do
      # Send events with sequence numbers
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 1)
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 2)

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)
      assert state.sequence_number == 2

      # Send out-of-order event (should be accepted but logged)
      VoiceSession.handle_voice_event(session_id, :metrics, %{}, 5)

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)
      assert state.sequence_number == 5
    end
  end

  describe "error handling" do
    setup do
      session_id = Ecto.UUID.generate()
      user_id = Ecto.UUID.generate()
      video_id = Ecto.UUID.generate()

      {:ok, pid} =
        VoiceSession.start_link(
          session_id: session_id,
          user_id: user_id,
          video_id: video_id
        )

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
      end)

      %{session_id: session_id}
    end

    test "transitions to error state on error event", %{session_id: session_id} do
      VoiceSession.handle_voice_event(session_id, :error, %{
        message: "VAD initialization failed"
      })

      Process.sleep(10)

      state = VoiceSession.get_state(session_id)

      assert state.status == :error
    end

    test "stops session gracefully", %{session_id: session_id} do
      # Start speech
      VoiceSession.handle_voice_event(session_id, :speech_start, %{
        confidence: 0.95,
        timestamp: 10.5
      })

      Process.sleep(10)

      assert VoiceSession.get_state(session_id).status == :recording

      # Stop session
      VoiceSession.stop_session(session_id)

      Process.sleep(10)

      assert VoiceSession.get_state(session_id).status == :idle
    end
  end
end
