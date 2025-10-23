# Sprint 15: Continuous Session Persistence

**Status:** 📋 Planned
**Priority:** High
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD)
- 🔜 Sprint 11 – Local-Only Transcription (browser-based VAD + transcription)
- 🔜 Sprint 14 – Passive Mode Polish (Silero VAD)
- 🔜 Sprint 15+ – Automated Frame Capture & Diffusion Refinement

---

## Purpose

Transform AgentSession from ephemeral (per-recording) to continuous (long-lived across video session). This enables:
- Persistent context across multiple speech segments
- Accumulated visual and audio evidence over time
- Foundation for diffusion-based refinement (Sprint 15+)
- Better conversation continuity for the agent

**Key Insight:** Current architecture creates a new session per recording. For passive mode to feel like a continuous assistant, the session must persist across the entire video viewing session.

---

## Current State

### How Sessions Work Today (Sprint 10)

```
User opens video tab
    │
    ▼
Speech detected by VAD
    │
    ▼
service-worker.js: startRecording()
    │
    ├─ Create NEW session_id (UUID)
    ├─ Join Phoenix channel: "audio:#{session_id}"
    ├─ Start AgentSession GenServer
    │
    ▼
Speech ends
    │
    ▼
service-worker.js: stopRecording()
    │
    ├─ Send audio, wait for transcript
    ├─ Note created
    ├─ Leave Phoenix channel
    └─ AgentSession GenServer terminates
    │
    ▼
Next speech segment
    │
    └─ Repeat from start (NEW session_id, NEW GenServer)
```

**Problem:** Each speech segment is isolated. No shared context, no accumulated evidence, no conversation continuity.

---

## Target State

### Continuous Session Architecture

```
User opens video tab
    │
    ▼
Video detected by extension
    │
    ├─ Create ONE session_id for entire video viewing
    ├─ Join Phoenix channel: "audio:#{session_id}"
    ├─ Start AgentSession GenServer (long-lived)
    ├─ Store session_id in chrome.storage.session
    │
    ▼
Speech segment 1
    │
    ├─ Send audio to EXISTING session
    ├─ Accumulate context (audio, frames, notes)
    ├─ Note created
    │
    ▼
Speech segment 2
    │
    ├─ Send audio to SAME session
    ├─ Agent has context from segment 1
    ├─ Note created with cross-segment awareness
    │
    ▼
Speech segment N
    │
    └─ Continue accumulating context
    │
    ▼
User closes tab or navigates away
    │
    ├─ Leave Phoenix channel
    ├─ AgentSession GenServer persists state to DB
    └─ Graceful shutdown
```

**Benefit:** Single continuous conversation with the agent. Context builds over time. Foundation for diffusion refinement.

---

## Goals

### Primary Deliverables

1. **Session Lifecycle Management**
   - One session per video viewing (tab + video_id pair)
   - Session survives across multiple recordings
   - Graceful session resumption on page reload
   - Session cleanup on tab close or navigation

2. **Backend Persistent State Schema**
   - New table: `agent_session_states`
   - Store accumulated context snapshots and session health metadata
   - Checkpoint session state periodically
   - Restore state on session resumption

3. **Evidence Ledger & Storage Policy**
   - New table: `session_evidence` (immutable, append-only)
   - Record every transcript chunk, synthesized draft, frame reference, and agent decision with deterministic payload hashes
   - Persist transcript artifacts as long as the underlying video stays in the user's library
   - Persist frame blobs in object storage with TTL/eviction while retaining derived embeddings + evidence pointers in the ledger
   - Classify evidence as `critical` or `supplementary` to drive pruning rules and backpressure signals

4. **Context Retrieval & Note Reconciliation**
   - Implement proximity heuristics for neighborhood lookups (e.g., ±3 s primary window, ±10 s secondary sweep)
   - Default to updating or merging existing notes when temporal + semantic overlap crosses configured thresholds
   - Provide low-confidence escalation paths so the agent can request broader context (older transcripts, farther frames) before emitting new notes
   - Surface note merge/update decisions and lineage in the ledger for later replay

5. **Session State Transitions & Backpressure**
   - `created` → session started
   - `active` → currently accumulating context
   - `idle` → no activity but still alive
   - `checkpointed` → state saved to DB
   - `degraded` → ledger recovery incomplete; extension notified to operate read-only
   - `closed` → session ended gracefully
   - `abandoned` → session died unexpectedly (cleanup required)
   - Emit mailbox depth/backpressure telemetry to pause upstream uploads when overloaded

6. **Graceful Degradation**
   - Handle network disconnections (queue events locally)
   - Recover from backend crashes (restore from checkpoint or mark session `degraded` with read-only guardrails)
   - Fallback to ephemeral sessions if persistence fails

### Success Criteria

- [ ] One session persists across 10+ speech segments
- [ ] Session state checkpointed every 5 minutes or 10 notes
- [ ] Session resumes correctly after page reload (<5s)
- [ ] Session cleanup removes orphaned sessions (<1% abandoned)
- [ ] Context accumulation visible in agent responses (cross-segment awareness)
- [ ] Evidence ledger captures 100% of transcript chunks, notes, and frame references with stable payload hashes
- [ ] Context replay fidelity ≥95% when regenerating notes from ledger-only inputs (spot-check harness)
- [ ] Note merge/update logic triggers instead of new note creation when overlap thresholds are met (telemetry ratio)
- [ ] **Mailbox depth monitored** and emitted as telemetry every message
- [ ] **Extension receives backpressure signals** and pauses uploads when triggered
- [ ] **Transcripts never dropped** (verified in logs over 24h test)
- [ ] **Frames dropped only when buffer full** (logged as telemetry event)
- [ ] **Adaptive debounce window** ranges 2-6s based on activity patterns
- [ ] **LLM tasks spawned via Task.Supervisor** (GenServer survives LLM errors)
- [ ] **Backpressure clears** when mailbox depth drops below 25 messages
- [ ] **Degraded sessions** surface a read-only banner in the side panel within 1 s of detection

---

## Detailed Requirements

### 1. Session Lifecycle Management

**Extension Side (service-worker.js):**

```javascript
// Session registry: One session per tab + video_id
const activeSessions = new Map();
// Key: `${tabId}:${videoId}`, Value: { sessionId, channelRef, createdAt }

async function getOrCreateSession(tabId, videoId) {
  const key = `${tabId}:${videoId}`;

  // Check if session already exists
  let session = activeSessions.get(key);
  if (session && await isSessionAlive(session.sessionId)) {
    console.log('[Session] Reusing existing session:', session.sessionId);
    return session;
  }

  // Create new session
  const sessionId = crypto.randomUUID();
  console.log('[Session] Creating new session:', sessionId);

  // Join persistent channel
  const channel = await joinAudioChannel(sessionId, videoId);

  session = {
    sessionId,
    channelRef: channel,
    createdAt: Date.now(),
    videoId,
    tabId
  };

  activeSessions.set(key, session);

  // Store in chrome.storage.session for recovery
  await chrome.storage.session.set({ [`session_${key}`]: session });

  return session;
}

async function isSessionAlive(sessionId) {
  // Ping backend to check if session still exists
  try {
    const response = await fetch(`${API_URL}/api/sessions/${sessionId}/ping`);
    return response.ok;
  } catch (err) {
    return false;
  }
}

// Tab closed event
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Find all sessions for this tab
  for (const [key, session] of activeSessions.entries()) {
    if (session.tabId === tabId) {
      await closeSession(session.sessionId);
      activeSessions.delete(key);
    }
  }
});

// Navigation event
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only main frame

  // Close sessions for this tab (video changed)
  for (const [key, session] of activeSessions.entries()) {
    if (session.tabId === details.tabId) {
      await closeSession(session.sessionId);
      activeSessions.delete(key);
    }
  }
});

async function closeSession(sessionId) {
  console.log('[Session] Closing session:', sessionId);

  // Notify backend to checkpoint and close
  const channel = activeSessions.get(sessionId)?.channelRef;
  if (channel) {
    channel.push('close_session', {})
      .receive('ok', () => console.log('[Session] Closed gracefully'))
      .receive('error', (err) => console.error('[Session] Close failed:', err));

    channel.leave();
  }
}
```

**Backend Side (lib/lossy/agent/session.ex):**

```elixir
defmodule Lossy.Agent.Session do
  use GenServer

  defstruct [
    session_id: nil,
    video_id: nil,
    status: :created,      # created, active, idle, checkpointed, closed
    created_at: nil,
    last_activity_at: nil,

    # Long-term accumulated context (persisted in checkpoints)
    notes: [],            # List of note IDs created in this session
    frames: [],           # List of {frame_id, timestamp, embedding} tuples
    transcript_buffer: "", # ALL transcripts ever (for diffusion review)
    conversation_memory: %{}, # Agent's understanding of user intent

    # Short-term accumulator (2-6s batching window, cleared after LLM call)
    pending_transcripts: [],  # [{text, timestamp, source}, ...] - NEVER drop
    lossy_frame_buffer: [],   # [{embedding, timestamp, opts}] - drop oldest under load (max 20)
    llm_timer_ref: nil,       # Debounce timer reference
    llm_debounce_ms: 4_000,   # Adaptive window (2-6s based on activity)
    consecutive_messages: 0,  # Track burst activity
    last_message_time: nil,   # For adaptive window calculation

    # Backpressure monitoring
    mailbox_watermark: 50,    # Warning threshold
    mailbox_critical: 100,    # Signal extension to pause uploads
    backpressure_signaled: false,

    # Current recording state (ephemeral)
    audio_buffer: <<>>,
    audio_duration: 0,
    timestamp_seconds: 0.0
  ]

  def start_link(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    GenServer.start_link(__MODULE__, opts, name: via_tuple(session_id))
  end

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    video_id = Keyword.fetch!(opts, :video_id)

    # Try to restore from checkpoint
    state = case restore_from_checkpoint(session_id) do
      {:ok, restored_state} ->
        Logger.info("[#{session_id}] Session restored from checkpoint")
        %{restored_state | status: :active, last_activity_at: DateTime.utc_now()}

      {:error, :not_found} ->
        Logger.info("[#{session_id}] New session created")
        %__MODULE__{
          session_id: session_id,
          video_id: video_id,
          status: :created,
          created_at: DateTime.utc_now(),
          last_activity_at: DateTime.utc_now()
        }
    end

    # Schedule periodic checkpoint (every 5 minutes)
    schedule_checkpoint()

    {:ok, state}
  end

  # Accumulate note in session context
  @impl true
  def handle_cast({:note_created, note}, state) do
    new_state = %{state |
      notes: [note.id | state.notes],
      last_activity_at: DateTime.utc_now(),
      status: :active
    }

    {:noreply, new_state}
  end

  # Periodic checkpoint
  @impl true
  def handle_info(:checkpoint, state) do
    case checkpoint_to_db(state) do
      :ok ->
        Logger.info("[#{state.session_id}] Session checkpointed (#{length(state.notes)} notes)")
        new_state = %{state | status: :checkpointed}
        schedule_checkpoint()
        {:noreply, new_state}

      {:error, reason} ->
        Logger.error("[#{state.session_id}] Checkpoint failed: #{inspect(reason)}")
        schedule_checkpoint()
        {:noreply, state}
    end
  end

  # Graceful shutdown
  @impl true
  def handle_call(:close_session, _from, state) do
    Logger.info("[#{state.session_id}] Closing session gracefully")

    # Final checkpoint
    checkpoint_to_db(state)

    new_state = %{state | status: :closed}
    {:stop, :normal, :ok, new_state}
  end

  defp schedule_checkpoint do
    Process.send_after(self(), :checkpoint, 5 * 60 * 1000) # 5 minutes
  end

  defp checkpoint_to_db(state) do
    # Serialize state to agent_session_states table
    attrs = %{
      session_id: state.session_id,
      video_id: state.video_id,
      status: Atom.to_string(state.status),
      notes: state.notes,
      frames: state.frames,
      transcript_buffer: state.transcript_buffer,
      conversation_memory: state.conversation_memory,
      created_at: state.created_at,
      last_activity_at: state.last_activity_at
    }

    case Repo.insert_or_update(AgentSessionState.changeset(%AgentSessionState{}, attrs)) do
      {:ok, _record} -> :ok
      {:error, changeset} -> {:error, changeset}
    end
  end

  defp restore_from_checkpoint(session_id) do
    case Repo.get_by(AgentSessionState, session_id: session_id) do
      nil -> {:error, :not_found}
      record -> {:ok, from_db_record(record)}
    end
  end
end
```

---

### 2. Intelligent LLM Batching & Backpressure

**Problem:**
- Current implementation calls LLM immediately per transcript, missing temporal context
- No backpressure mechanism when backend becomes overloaded
- Risk of GenServer mailbox overflow under heavy load (transcripts + frames flooding in)

**Solution: Adaptive Debouncing + Upstream Throttling**

**Core Pattern - Two-Tier Accumulation:**

```elixir
# Short-term: Cleared after each LLM invocation (2-6s window)
pending_transcripts: []        # Critical - NEVER drop
lossy_frame_buffer: []         # Bounded (max 20) - can drop oldest

# Long-term: Persisted in checkpoints (session lifetime)
transcript_buffer: ""          # ALL transcripts ever (for diffusion)
frames: []                     # ALL frames ever
conversation_memory: %{}
```

**Message Type Taxonomy:**

```elixir
# Critical messages - NEVER drop, always process
@type critical_message ::
  {:transcript_ready, text :: String.t(), opts :: keyword()}
  | {:note_created, note :: map()}
  | {:checkpoint}
  | {:close_session}

# Lossy messages - can shed under extreme load
@type lossy_message ::
  {:frame_embedding, embedding :: list(float()), timestamp :: float()}
  | {:vad_event, :speech_start | :speech_end}
  | {:telemetry_ping, metrics :: map()}
```

**Adaptive Debounce Window (2-6s):**

The system dynamically adjusts the batching window based on user activity patterns:

| Activity Pattern | Window | Rationale |
|-----------------|--------|-----------|
| **Idle** (>10s since last message) | 2s | Respond quickly to single utterance |
| **Burst** (>3 messages in 5s) | 6s | Batch more for conversational context |
| **Similar topic** (shared keywords) | 6s | Extend for topical coherence |
| **Default** | 4s | Balanced responsiveness vs. context |

**Implementation:**

```elixir
def handle_cast({:transcript_ready, text, opts}, state) do
  # 1. Instrument with telemetry
  :telemetry.execute(
    [:lossy, :agent, :message, :received],
    %{type: :transcript},
    %{session_id: state.session_id}
  )

  # 2. Check mailbox health & signal backpressure if needed
  state = check_and_signal_backpressure(state)

  # 3. Capture timing before mutating state
  now = System.monotonic_time(:millisecond)
  previous_last_message_time = state.last_message_time

  # 4. Accumulate in both buffers
  updated_state = %{state |
    # Short-term (for immediate LLM batching)
    pending_transcripts: [{text, now, opts} | state.pending_transcripts],
    consecutive_messages: update_consecutive_messages(previous_last_message_time, now, state.consecutive_messages),
    last_message_time: now,

    # Long-term (for checkpoints & diffusion)
    transcript_buffer: state.transcript_buffer <> text <> "\n"
  }

  # 5. Schedule/reset adaptive debounce timer
  updated_state = schedule_adaptive_llm(updated_state, previous_last_message_time)

  {:noreply, updated_state}
end

def handle_cast({:frame_embedding, embedding, timestamp, opts}, state) do
  :telemetry.execute(
    [:lossy, :agent, :message, :received],
    %{type: :frame},
    %{session_id: state.session_id}
  )

  state = check_and_signal_backpressure(state)

  now = System.monotonic_time(:millisecond)
  previous_last_message_time = state.last_message_time

  state =
    state
    |> add_to_lossy_buffer({embedding, timestamp, opts}, max_size: 20)
    |> Map.put(:consecutive_messages, update_consecutive_messages(previous_last_message_time, now, state.consecutive_messages))
    |> Map.put(:last_message_time, now)

  state = schedule_adaptive_llm(state, previous_last_message_time)

  {:noreply, state}
end

# Timer-driven LLM invocation
def handle_info(:invoke_llm, state) do
  if should_invoke_llm?(state) do
    context = %{
      transcripts: Enum.reverse(state.pending_transcripts),
      frames: Enum.reverse(state.lossy_frame_buffer),
      video_timestamp: state.timestamp_seconds,
      recent_notes: Enum.take(state.notes, 5)
    }

    # Spawn via Task.Supervisor for fault isolation
    Task.Supervisor.async_nolink(
      Lossy.TaskSupervisor,
      fn -> process_accumulated_context(state.session_id, context) end
    )

    :telemetry.execute(
      [:lossy, :agent, :llm, :invoked],
      %{batch_size: length(context.transcripts)},
      %{session_id: state.session_id}
    )
  end

  # Clear short-term buffers (long-term stays)
  {:noreply, %{state |
    pending_transcripts: [],
    lossy_frame_buffer: [],
    llm_timer_ref: nil,
    consecutive_messages: 0
  }}
end

defp schedule_adaptive_llm(state, previous_last_message_time) do
  # Cancel existing timer (debounce pattern)
  if state.llm_timer_ref do
    Process.cancel_timer(state.llm_timer_ref)
  end

  # Calculate adaptive window
  window_ms = calculate_adaptive_window(state, previous_last_message_time)
  timer_ref = Process.send_after(self(), :invoke_llm, window_ms)

  %{state | llm_timer_ref: timer_ref, llm_debounce_ms: window_ms}
end

defp calculate_adaptive_window(state, previous_last_message_time) do
  time_since_last =
    case previous_last_message_time do
      nil -> :infinity
      last_timestamp -> System.monotonic_time(:millisecond) - last_timestamp
    end

  cond do
    time_since_last != :infinity and time_since_last > 10_000 -> 2_000  # Idle: respond quickly
    state.consecutive_messages > 3 -> 6_000  # Burst: batch more
    similar_topic?(state.pending_transcripts) -> 6_000  # Topic coherence
    true -> 4_000  # Default: balanced
  end
end

defp update_consecutive_messages(nil, _now, _count), do: 1
defp update_consecutive_messages(previous_last, now, _count) when now - previous_last > 10_000, do: 1
defp update_consecutive_messages(_previous_last, _now, count), do: count + 1

defp similar_topic?(pending_transcripts) do
  pending_transcripts
  |> Enum.take(4)
  |> Enum.map(fn {text, _ts, _opts} -> tokenize(text) end)
  |> Enum.reduce(%{}, fn tokens, acc ->
    Enum.reduce(tokens, acc, fn token, inner ->
      Map.update(inner, token, 1, &(&1 + 1))
    end)
  end)
  |> Enum.any?(fn {_token, freq} -> freq >= 3 end)
end

defp tokenize(text) do
  text
  |> String.downcase()
  |> String.replace(~r/[^a-z0-9\s]/u, "")
  |> String.split()
  |> Enum.reject(&(&1 in ["the", "and", "but", "or"]))
end

# Handle Task completion/failure without crashing the GenServer
def handle_info({:DOWN, _ref, :process, _pid, reason}, state) do
  case reason do
    :normal ->
      :ok

    _ ->
      Logger.error("[#{state.session_id}] LLM task crashed: #{inspect(reason)}")
  end

  {:noreply, state}
end
```

`update_consecutive_messages/3` resets burst counters after idle gaps, and `similar_topic?/1` uses a lightweight token frequency check (swap for embeddings later if needed). The `handle_info({:DOWN, ...})` clause keeps LLM crashes from terminating the GenServer while still logging failures for observability.

**Backpressure Strategy:**

Rather than dropping messages in the GenServer, signal the extension to pause uploads upstream:

```elixir
defp check_and_signal_backpressure(state) do
  mailbox_len = Process.info(self(), :message_queue_len) |> elem(1)

  # Emit telemetry for monitoring
  :telemetry.execute(
    [:lossy, :agent, :mailbox, :depth],
    %{depth: mailbox_len},
    %{session_id: state.session_id}
  )

  cond do
    # Critical: Signal extension to STOP uploads
    mailbox_len >= state.mailbox_critical and not state.backpressure_signaled ->
      Logger.warn("[#{state.session_id}] Mailbox critical: #{mailbox_len}")
      Phoenix.PubSub.broadcast(
        Lossy.PubSub,
        "session:#{state.session_id}",
        {:backpressure, :critical}
      )
      %{state | backpressure_signaled: true}

    # Warning threshold
    mailbox_len >= state.mailbox_watermark ->
      Logger.warn("[#{state.session_id}] Mailbox at watermark: #{mailbox_len}")
      state

    # Recovered: Resume uploads
    mailbox_len < 25 and state.backpressure_signaled ->
      Logger.info("[#{state.session_id}] Mailbox recovered: #{mailbox_len}")
      Phoenix.PubSub.broadcast(
        Lossy.PubSub,
        "session:#{state.session_id}",
        {:backpressure, :normal}
      )
      %{state | backpressure_signaled: false}

    true ->
      state
  end
end

defp add_to_lossy_buffer(state, item, opts) do
  max_size = Keyword.get(opts, :max_size, 20)
  buffer = state.lossy_frame_buffer

  new_buffer = [item | buffer] |> Enum.take(max_size)

  # Log frame drops
  if length(buffer) >= max_size do
    :telemetry.execute(
      [:lossy, :agent, :frame, :dropped],
      %{count: 1},
      %{session_id: state.session_id}
    )
  end

  %{state | lossy_frame_buffer: new_buffer}
end
```

**Extension Backpressure Handling:**

```javascript
// extension/src/background/service-worker.js

channel.on('backpressure', ({ level }) => {
  if (level === 'critical') {
    console.warn('[Session] Backend overloaded, pausing uploads');

    // Stop frame captures
    frameCaptureRules.enabled = false;

    // Queue audio locally in IndexedDB
    audioUploadQueue.pause();

    // Show UI indicator
    chrome.action.setBadgeText({ text: '⏸', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#FFA500', tabId });

  } else if (level === 'normal') {
    console.log('[Session] Backend recovered, resuming');

    frameCaptureRules.enabled = true;
    audioUploadQueue.resume();

    chrome.action.setBadgeText({ text: '', tabId });
  }
});
```

**Phoenix Channel bridge:**

```elixir
# lib/lossy_web/channels/agent_session_channel.ex

@impl true
def join("agent_session:" <> session_id, _payload, socket) do
  Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")
  {:ok, assign(socket, :session_id, session_id)}
end

@impl true
def handle_info({:backpressure, level}, socket) do
  push(socket, "backpressure", %{level: Atom.to_string(level)})
  {:noreply, socket}
end
```

**Telemetry Events:**

```elixir
# Attach telemetry handlers
:telemetry.attach_many(
  "agent-session-metrics",
  [
    [:lossy, :agent, :message, :received],   # Count by type
    [:lossy, :agent, :mailbox, :depth],      # Queue health
    [:lossy, :agent, :llm, :invoked],        # Batch sizes
    [:lossy, :agent, :frame, :dropped]       # Load shedding
  ],
  &MetricsHandler.handle_event/4,
  nil
)
```

**Load Shedding Policy:**

| Message Type | Drop Policy | Rationale |
|--------------|-------------|-----------|
| Transcripts | **NEVER** | Critical for note creation |
| Note events | **NEVER** | User-facing state |
| Checkpoints | **NEVER** | Data durability |
| Frames | Drop oldest when buffer full | Visual context is supplementary |
| VAD events | Drop duplicates | Redundant timing signals |
| Telemetry | Drop when mailbox > 50 | Non-critical observability |

**State Diagram:**

```
Message arrives (handle_cast)
    ↓
Telemetry: [:message, :received]
    ↓
Check mailbox depth
    ↓
mailbox > 100? → Broadcast backpressure signal
    ↓
Accumulate in pending_* buffer
    ↓
Schedule/reset adaptive timer (2-6s)
    ↓
Return immediately (<10ms)
    ↓
... [timer expires] ...
    ↓
:invoke_llm message fires
    ↓
Task.Supervisor.async_nolink spawns task
    ↓
LLM processes batched context
    ↓
Clear short-term buffers
    ↓
Ready for next batch
```

**Advanced: Separate Priority GenServers**

For extreme load scenarios, split into separate GenServers per priority:

```elixir
# High-priority lane (critical messages only)
defmodule Lossy.Agent.Session.HighPriority do
  use GenServer
  # Handles transcripts, note events, checkpoints
end

# Low-priority lane (lossy messages)
defmodule Lossy.Agent.Session.LowPriority do
  use GenServer
  # Handles frames, telemetry
  # Can shed load aggressively
end

# Route messages by type
def route_message(message, session_id) do
  case classify_priority(message) do
    :critical -> GenServer.cast(via_tuple(:high, session_id), message)
    :lossy    -> GenServer.cast(via_tuple(:low, session_id), message)
  end
end
```

**Feature Flag Rollout:**

```elixir
# config/runtime.exs
config :lossy, :features,
  adaptive_batching: System.get_env("ADAPTIVE_BATCHING") == "true",
  backpressure_signaling: System.get_env("BACKPRESSURE_SIGNALING") == "true"

# Enable in dev/staging first, validate telemetry before production
```

---

### 3. Backend Persistent State Schema

**Migration: `priv/repo/migrations/XXXXXX_create_agent_session_states.exs`**

```elixir
defmodule Lossy.Repo.Migrations.CreateAgentSessionStates do
  use Ecto.Migration

  def change do
    create table(:agent_session_states, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :session_id, :uuid, null: false
      add :video_id, references(:videos, on_delete: :delete_all), null: false
      add :status, :string, null: false, default: "created"

      # Lightweight snapshot metadata (everything else lives in the ledger)
      add :note_ids, {:array, :uuid}, default: []
      add :ledger_cursor, :bigint, null: false, default: 0
      add :last_context_hash, :string
      add :cost_cents, :integer, null: false, default: 0
      add :health, :jsonb, null: false, default: "{}"

      # Metadata
      add :created_at, :utc_datetime_usec, null: false
      add :last_activity_at, :utc_datetime_usec, null: false
      add :closed_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:agent_session_states, [:session_id])
    create index(:agent_session_states, [:video_id])
    create index(:agent_session_states, [:status])
    create index(:agent_session_states, [:last_activity_at])
  end
end
```

**Ledger Table: `priv/repo/migrations/XXXXXX_create_session_evidence.exs`**

```elixir
defmodule Lossy.Repo.Migrations.CreateSessionEvidence do
  use Ecto.Migration

  def change do
    create table(:session_evidence) do
      add :session_id, references(:agent_session_states, column: :session_id, type: :uuid, on_delete: :delete_all), null: false
      add :sequence, :bigint, null: false
      add :evidence_type, :string, null: false
      add :payload_hash, :binary, null: false
      add :payload, :jsonb, null: false
      add :critical, :boolean, null: false, default: false
      add :blob_pointer, :string
      add :occurred_at, :utc_datetime_usec, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:session_evidence, [:session_id, :sequence])
    create index(:session_evidence, [:session_id])
    create index(:session_evidence, [:payload_hash])
    create index(:session_evidence, [:critical])
  end
end
```

**Storage Policy Notes:**
- `sequence` is a strictly increasing cursor; `ledger_cursor` in `agent_session_states` tracks the highest applied entry.
- `payload_hash` (e.g., SHA256) lets us guarantee the “pure function” invariant—any note can be regenerated from ledger entries.
- Transcript payloads are marked `critical` and persist indefinitely alongside the video library item.
- Frame payloads store derived embeddings + metadata in the ledger (`payload`), while `blob_pointer` references object storage with TTL; eviction removes the blob but not the ledger row.
- `health` tracks heartbeat metrics (e.g., last checkpoint error, degraded flag) surfaced to the extension.

---

### 4. Context Retrieval & Note Reconciliation

**Neighborhood Heuristics**
- Primary window: collect evidence ±3 s around the target timestamp (transcripts, frames, prior notes).
- Secondary sweep: expand to ±10 s when confidence < threshold or neighboring evidence is sparse.
- Evidence prioritization: always load `critical` entries first, then layer in `supplementary` items until the token budget or confidence target is met.

**Merge vs. New Note Logic**
- Temporal overlap: if an existing note’s span overlaps the current utterance by ≥50% of the shorter duration, consider it a merge candidate.
- Semantic similarity: cosine similarity ≥0.8 between transcript chunk embedding and candidate note embedding triggers update flow.
- Update path: mutate the existing note content, attach new evidence to its ledger record, and append a `note_update` entry referencing both the old and new payload hashes.
- Merge path: create a new synthesized note, mark source notes `archived`, and log a `note_merge` ledger entry with lineage metadata.

**Low-Confidence Escalation**
- If the agent’s confidence remains <0.6 after primary + secondary sweeps, pull additional evidence (older transcripts, more distant frames) up to a configurable cap.
- When confidence still fails to clear the threshold, enqueue a `context_request` message so the extension can prompt the user or capture fresh evidence.
- Every escalation path is recorded in the ledger so audits can replay “why the agent asked for more context.”

**Query API**

```elixir
def fetch_context_window(session_id, timestamp, opts \\ []) do
  Lossy.Agent.SessionEvidence.fetch_window(session_id,
    timestamp: timestamp,
    primary_window_ms: Keyword.get(opts, :primary_window_ms, 3000),
    secondary_window_ms: Keyword.get(opts, :secondary_window_ms, 10_000),
    token_budget: Keyword.get(opts, :token_budget, 1_500)
  )
end
```

- Results stream in priority order so the agent can stop once confidence targets are met.
- Extension side receives backpressure hints when the mailboxes saturate to avoid over-supplying frames.

---

### 5. Session State Transitions & Backpressure

```
created ──► active ──► idle ──► checkpointed ──► closed
   │           │         │            │
   │           │         │            │
   │           │         │            └────────► degraded (restore failed)
   │           │         │
   │           │         └─────────────────────► degraded (ledger gaps)
   │
   └───────────────────────────────────────────► abandoned (timeout)
```

**State Definitions:**

- `created`: Session just started, no activity yet.
- `active`: Currently processing audio/frames (status: recording, transcribing, structuring).
- `idle`: No current activity, but session alive (waiting for next speech).
- `checkpointed`: State saved to DB (periodic or before shutdown).
- `degraded`: Ledger or checkpoint restore failed—session continues in read-only mode until manual recovery.
- `closed`: Session ended gracefully (user navigated away).
- `abandoned`: Session died unexpectedly (cleanup needed).

**Degraded Mode Handshake:**

```elixir
def handle_cast({:mark_degraded, reason}, state) do
  updated =
    state
    |> Map.put(:status, :degraded)
    |> Map.update!(:health, fn health ->
      Map.merge(health, %{
        degraded_reason: reason,
        degraded_at: DateTime.utc_now()
      })
    end)

  notify_extension(state.session_id, :degraded, reason)
  {:noreply, updated}
end
```

- Extension displays a read-only banner and stops enqueueing new evidence.
- Backpressure telemetry (mailbox depth, restart counters) is emitted with every state change so the extension can throttle uploads before we hit degrade.

**Cleanup Task (Oban):**
```elixir
defmodule Lossy.Workers.SessionCleanup do
  use Oban.Worker, queue: :maintenance, max_attempts: 3

  @impl Oban.Worker
  def perform(%Job{}) do
    # Find sessions with last_activity > 1 hour ago, status != closed
    abandoned_sessions =
      from(s in AgentSessionState,
        where: s.status != "closed",
        where: s.last_activity_at < ago(1, "hour")
      )
      |> Repo.all()

    Enum.each(abandoned_sessions, fn session ->
      Logger.warn("Cleaning up abandoned session: #{session.session_id}")

      # Update status to abandoned
      session
      |> Ecto.Changeset.change(status: "abandoned", closed_at: DateTime.utc_now())
      |> Repo.update()

      # Stop GenServer if still running
      case GenServer.whereis(Lossy.Agent.Session.via_tuple(session.session_id)) do
        nil -> :ok
        pid -> GenServer.stop(pid, :normal)
      end
    end)

    :ok
  end
end
```

- Sessions stuck in `degraded` for >1 hour are escalated to `abandoned` with an alert in telemetry dashboards.
- Backpressure signals resume once mailbox depth drops below configured thresholds, allowing the extension to restart uploads safely.

```elixir
# Schedule hourly
Oban.insert!(Lossy.Workers.SessionCleanup.new(%{}, schedule_in: 3600))
```

---

## Implementation Phases

### Phase 1: Session Lifecycle (Week 1-2)
- Extension: `getOrCreateSession()`, tab close handlers
- Backend: Session creation/resumption, ping endpoint
- Testing: Multi-segment sessions, tab close cleanup

### Phase 2: Persistent State (Week 2-3)
- Migration: `agent_session_states` table
- Backend: `checkpoint_to_db()`, `restore_from_checkpoint()`
- Testing: State persistence, resumption after restart

### Phase 3: Evidence Ledger & Storage Policy (Week 3-4)
- Migration: `session_evidence` table + blob storage wiring
- Backend: Append-only writer with payload hash validation, TTL policy for frame blobs
- Telemetry: Ledger coverage (% of transcripts/frames captured), payload hash audits

### Phase 4: Context Retrieval & Note Reconciliation (Week 4-5)
- Agent: Neighborhood query API, similarity/temporal heuristics, merge-vs-update flows
- Extension: Honor backpressure hints, surface merge/update UI affordances
- Testing: Context replay harness, merge ratio telemetry, low-confidence escalation paths

### Phase 5: State Transitions, Backpressure & Graceful Degradation (Week 5-6)
- State machine: `degraded` handling, health metadata, extension notification flow
- Backpressure: Mailbox depth telemetry, extension throttling hooks, recovery scenarios
- Resilience: Network disconnection handling, checkpoint restore validations, fallback to ephemeral sessions

**Total Estimated Time:** 6 weeks

---

## Deferred Items (Sprint 15+)

### Diffusion Refinement
- Multi-pass note refinement using session context
- Evidence graph (notes linked by common frames/transcripts)
- Confidence boosting via cross-segment validation

### Advanced Session Features
- Session export (download all notes + frames)
- Session replay (visual timeline of activity)
- Multi-tab sessions (track across related videos)

### Cost Governance
- Per-session cost tracking
- Budget limits and throttling
- User notifications when approaching limits

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **GenServer memory growth** | OOM crash after long session | Periodic checkpoint + trim old data, session size limits |
| **Checkpoint failures** | Lost context on crash | Retry logic, fallback to in-memory only, alerts |
| **Orphaned sessions** | Database bloat | Hourly cleanup worker, status monitoring |
| **Session ID conflicts** | Data corruption | UUID primary key, unique constraint |
| **Network partition** | Session isolation | Queue events locally, sync on reconnect |
| **Migration failures** | Downtime | Reversible migration, zero-downtime deploy |
| **Ledger replay drift** | Notes no longer reproducible | Payload hash audits, automated nightly ledger replays |
| **Blob eviction too aggressive** | Missing visual context | Tiered TTLs, fallback to embeddings, user-visible warnings before purge |

---

## Success Metrics

### Functional
- Session continuity: 95% of sessions persist across 10+ segments
- Checkpoint reliability: 99% of checkpoints succeed
- Cleanup efficiency: <1% abandoned sessions after 1 week

### Performance
- Session creation latency: <100ms
- Checkpoint latency: <500ms (non-blocking)
- Restore latency: <1s (on page reload)

### Quality
- Cross-segment awareness: Measurable in note quality (A/B test)
- Conversation continuity: User survey (does agent "remember"?)
- Context utilization: % of notes using session context

---

**Document Version:** 1.0 (Planning)
**Last Updated:** 2025-10-22
**Author:** Claude Code
