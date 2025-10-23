# Sprint 12: Continuous Session Persistence

**Status:** 📋 Planned
**Priority:** High
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD)
- 🔜 Sprint 11 – Passive Mode Polish (Silero VAD)
- 🔜 Sprint 13+ – Automated Frame Capture & Diffusion Refinement

---

## Purpose

Transform AgentSession from ephemeral (per-recording) to continuous (long-lived across video session). This enables:
- Persistent context across multiple speech segments
- Accumulated visual and audio evidence over time
- Foundation for diffusion-based refinement (Sprint 14+)
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
   - Store accumulated context (notes, frames, evidence)
   - Checkpoint session state periodically
   - Restore state on session resumption

3. **Context Accumulation**
   - Notes list (all notes created in this session)
   - Frame history (visual context over time)
   - Audio transcript buffer (for diffusion review)
   - Conversation memory (agent's understanding of user intent)

4. **Session State Transitions**
   - `created` → session started
   - `active` → currently accumulating context
   - `idle` → no activity but still alive
   - `checkpointed` → state saved to DB
   - `closed` → session ended gracefully
   - `abandoned` → session died unexpectedly (cleanup required)

5. **Graceful Degradation**
   - Handle network disconnections (queue events locally)
   - Recover from backend crashes (restore from checkpoint)
   - Fallback to ephemeral sessions if persistence fails

### Success Criteria

- [ ] One session persists across 10+ speech segments
- [ ] Session state checkpointed every 5 minutes or 10 notes
- [ ] Session resumes correctly after page reload (<5s)
- [ ] Session cleanup removes orphaned sessions (<1% abandoned)
- [ ] Context accumulation visible in agent responses (cross-segment awareness)

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

    # Accumulated context
    notes: [],            # List of note IDs created in this session
    frames: [],           # List of {frame_id, timestamp, embedding} tuples
    transcript_buffer: "", # Accumulated transcripts for diffusion review
    conversation_memory: %{}, # Agent's understanding of user intent

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

### 2. Backend Persistent State Schema

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

      # Accumulated context (JSONB for flexibility)
      add :notes, {:array, :uuid}, default: []
      add :frames, :jsonb, default: "[]"
      add :transcript_buffer, :text
      add :conversation_memory, :jsonb, default: "{}"

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

**Why JSONB for frames and conversation_memory:**
- Flexible schema for evolving data structures
- Efficient indexing with GIN indexes (future)
- No need for additional tables (simpler queries)

---

### 3. Context Accumulation

**Notes List:**
- All notes created in this session (array of UUIDs)
- Used for diffusion review (Sprint 14)
- Queryable: "Show me all notes from this session"

**Frame History:**
- Visual context over time
- JSONB structure: `[{frame_id, timestamp, embedding, uploaded_at}, ...]`
- Enables: "What was on screen 5 minutes ago?"

**Transcript Buffer:**
- Accumulated transcripts for the session
- Used for conversational context
- Example: "Earlier you mentioned X, related to this note"

**Conversation Memory:**
- Agent's understanding of user intent
- JSONB structure: `{topics: [...], intent: "...", context: "..."}`
- Enables: Agent remembers user's focus areas

---

### 4. Session State Transitions

```
created ──► active ──► idle ──► checkpointed ──► closed
   │           │         │            │
   │           │         │            │
   └───────────┴─────────┴────────────┴───► abandoned (timeout)
```

**State Definitions:**

- `created`: Session just started, no activity yet
- `active`: Currently processing audio/frames (status: recording, transcribing, structuring)
- `idle`: No current activity, but session alive (waiting for next speech)
- `checkpointed`: State saved to DB (periodic or before shutdown)
- `closed`: Session ended gracefully (user navigated away)
- `abandoned`: Session died unexpectedly (cleanup needed)

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

### Phase 3: Context Accumulation (Week 3-4)
- Backend: Notes list, frame history, transcript buffer
- Agent: Use accumulated context in note structuring
- Testing: Cross-segment awareness, conversation continuity

### Phase 4: State Transitions & Cleanup (Week 4-5)
- State machine implementation
- Oban cleanup worker
- Monitoring: Abandoned session alerts

### Phase 5: Graceful Degradation (Week 5-6)
- Network disconnection handling
- Checkpoint restore on backend crash
- Fallback to ephemeral sessions

**Total Estimated Time:** 6 weeks

---

## Deferred Items (Sprint 14+)

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
