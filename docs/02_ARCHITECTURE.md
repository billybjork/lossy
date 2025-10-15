# System Architecture

**Last Updated:** 2025-10-14

---

## High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser Extension (Chrome MV3)                                 │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Side Panel   │  │ Popup        │  │ Content Script     │   │
│  │ (LiveView)   │  │ (LiveView)   │  │ (Shadow DOM)       │   │
│  │              │  │              │  │                    │   │
│  │ - Note list  │  │ - Controls   │  │ - Overlays        │   │
│  │ - Filters    │  │ - Agent UI   │  │ - Anchor chip     │   │
│  │ - Timeline   │  │ - Mic toggle │  │ - Ghost comments  │   │
│  └──────┬───────┘  └──────┬───────┘  │ - Emoji chips     │   │
│         │                 │           │ - Frame capture   │   │
│         │                 │           └─────────┬──────────┘   │
│         │                 │                     │              │
│         └────────┬────────┴─────────────────────┘              │
│                  │                                              │
│  ┌───────────────▼────────────────────────────────────────┐   │
│  │ Service Worker (Background)                            │   │
│  │                                                         │   │
│  │ - Phoenix Socket connection (persistent)               │   │
│  │ - Audio capture orchestration                          │   │
│  │ - Tab lifecycle management                             │   │
│  │ - Message routing                                      │   │
│  └───────────────┬─────────────────────────────────────────┘  │
│                  │                                              │
│  ┌───────────────▼────────────────────────────────────────┐   │
│  │ Offscreen Document (Audio Processing)                  │   │
│  │                                                         │   │
│  │ - getUserMedia (microphone access)                     │   │
│  │ - VAD (Voice Activity Detection)                       │   │
│  │ - Audio encoding (PCM/Opus)                            │   │
│  │ - WASM Whisper (optional local transcription)          │   │
│  │ - ONNX CLIP (frame analysis)                           │   │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ WebSocket (wss://)
                         │ - Audio binary frames
                         │ - Control messages
                         │ - LiveView connection
                         │
┌────────────────────────▼────────────────────────────────────────┐
│  Phoenix Backend (Elixir)                                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Phoenix Endpoint                                          │  │
│  │                                                           │  │
│  │ - WebSocket /live (LiveView)                             │  │
│  │ - WebSocket /socket (Channels)                           │  │
│  │ - REST API /api/* (auth, config)                         │  │
│  │ - check_origin: ["chrome-extension://..."]              │  │
│  └──────────┬───────────────────────┬───────────────────────┘  │
│             │                       │                           │
│  ┌──────────▼──────────┐  ┌─────────▼──────────────────────┐  │
│  │ LiveView            │  │ Phoenix Channels               │  │
│  │                     │  │                                │  │
│  │ - SidePanelLive    │  │ - AudioChannel                 │  │
│  │ - AgentPopupLive   │  │   (binary audio streaming)     │  │
│  │                     │  │ - VideoChannel                 │  │
│  │ Subscribes to:      │  │   (frame data, metadata)       │  │
│  │ - PubSub topics     │  │ - UserChannel                  │  │
│  │ - stream_insert/3   │  │   (global events)              │  │
│  └──────────┬──────────┘  └─────────┬──────────────────────┘  │
│             │                       │                           │
│             └───────────┬───────────┘                           │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │ Phoenix.PubSub                                           │  │
│  │                                                           │  │
│  │ Topics:                                                   │  │
│  │ - "session:#{session_id}"  → AgentSession events        │  │
│  │ - "video:#{video_id}"      → Video-specific updates     │  │
│  │ - "user:#{user_id}"        → User-wide notifications    │  │
│  └──────────────────────┬────────────────────────────────────┘│
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │ AgentSession (GenServer)                                 │  │
│  │                                                           │  │
│  │ Supervised by DynamicSupervisor                          │  │
│  │ One per user session                                     │  │
│  │                                                           │  │
│  │ Pipeline:                                                 │  │
│  │   Audio → STT → Intent → LLM → Tools → Broadcast        │  │
│  │                                                           │  │
│  │ Events emitted:                                           │  │
│  │ - :asr_partial     (streaming transcript)                │  │
│  │ - :asr_final       (complete transcript)                 │  │
│  │ - :intent          (extracted user intent)               │  │
│  │ - :tool_start      (tool execution begins)               │  │
│  │ - :tool_result     (tool execution complete)             │  │
│  │ - :model_delta     (LLM streaming tokens)                │  │
│  └──────┬───────────────────────────┬────────────────────────┘│
│         │                           │                           │
│  ┌──────▼──────────┐  ┌─────────────▼──────────────────────┐  │
│  │ Inference       │  │ Automation                          │  │
│  │ Router          │  │                                     │  │
│  │                 │  │ - NoteApplicator                    │  │
│  │ - STT           │  │ - BrowserbaseClient                 │  │
│  │   • WASM (ext)  │  │ - PythonBridge (call existing)      │  │
│  │   • Cloud API   │  │ - StagehandClient                   │  │
│  │   • Rustler NIF │  │                                     │  │
│  │                 │  │ Queued via Oban for reliability     │  │
│  │ - Vision        │  └─────────────────────────────────────┘  │
│  │   • CLIP (ext)  │                                           │
│  │   • Cloud API   │                                           │
│  │                 │                                           │
│  │ - LLM           │                                           │
│  │   • OpenAI API  │                                           │
│  │   • Local llama │                                           │
│  └─────────────────┘                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Storage (PostgreSQL)                                      │ │
│  │                                                           │ │
│  │ - users                                                   │ │
│  │ - videos (metadata, thumbnails)                          │ │
│  │ - notes (ghost → firmed → posted)                        │ │
│  │ - audio_chunks (queue for processing)                    │ │
│  │ - video_frames (embeddings, phash)                       │ │
│  │ - review_sessions (presence, history)                    │ │
│  └───────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                         │
                         │ HTTPS API calls
                         │
┌────────────────────────▼────────────────────────────────────────┐
│  Browserbase (Computer Use)                                     │
│                                                                  │
│  - Create session with auth context                             │
│  - Connect via Playwright CDP                                   │
│  - Navigate to video platform                                   │
│  - Apply note at timestamp                                      │
│  - Return permalink                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Browser Extension Components

#### Service Worker (Background)

**Purpose:** Long-lived process managing connections and orchestration

**Responsibilities:**
- Maintain Phoenix Socket connection (keep-alive via heartbeat)
- Route messages between extension components
- Manage offscreen document lifecycle
- Handle tab activation/navigation events
- Coordinate audio capture start/stop

**Key APIs:**
- `chrome.runtime.onMessage` - Message routing
- `chrome.tabs.onActivated` - Track active video
- `chrome.offscreen.createDocument` - Audio processing

#### Offscreen Document

**Purpose:** Audio capture and WASM inference (bypasses service worker 30s timeout)

**Responsibilities:**
- Access microphone via `getUserMedia`
- Voice Activity Detection (VAD)
- Encode audio chunks (PCM/Opus)
- Optional: Local WASM Whisper transcription
- Optional: Local ONNX CLIP frame analysis

**Why separate from service worker:**
- Service workers can't access `getUserMedia`
- WASM workers need stable context (no timeout)
- Audio processing requires consistent timing

#### Content Script

**Purpose:** Inject UI overlays into video pages

**Responsibilities:**
- Find and monitor video element
- Inject Shadow DOM overlays (isolation from page CSS)
- Capture video frames via `requestVideoFrameCallback`
- Display anchor chip, ghost comments, emoji tokens
- Re-parent overlays into fullscreen element

**Does NOT:**
- ❌ Access microphone (done in offscreen)
- ❌ Maintain WebSocket (done in service worker)
- ❌ Use LiveView (uses Shadow DOM + vanilla JS)

#### Side Panel (LiveView Client)

**Purpose:** Persistent note list and controls

**Responsibilities:**
- Load local `sidepanel.html`
- Bundle and initialize `phoenix.js` + LiveView client
- Connect to Phoenix via WebSocket with token auth
- Subscribe to PubSub topics for real-time updates
- Handle user interactions (filter, seek, post)

**Pattern:**
```javascript
// Local HTML → Bundled JS → LiveView connection
const liveSocket = new LiveSocket("wss://...", Socket, {
  params: { auth_token, session_id, video_id }
});
```

#### Popup (LiveView Client)

**Purpose:** Quick controls and agent progress

**Responsibilities:**
- Same pattern as side panel
- More focused on agent status
- Mic toggle, session info
- Ephemeral (closes frequently)

---

### 2. Phoenix Backend Components

#### Phoenix Endpoint

**Configuration:**
```elixir
# Allows WebSocket from extension origin
config :lossy, LossyWeb.Endpoint,
  check_origin: [
    "https://your-app.com",
    "chrome-extension://YOUR_EXTENSION_ID"
  ]

# Two sockets
socket "/live", Phoenix.LiveView.Socket  # LiveView
socket "/socket", LossyWeb.UserSocket    # Channels
```

#### LiveView Modules

**SidePanelLive:**
- Mounts with `{auth_token, session_id, video_id}`
- Subscribes to `"session:#{session_id}"` and `"video:#{video_id}"`
- Uses `stream/3` for efficient note list rendering
- Handles filter changes, video context switches

**AgentPopupLive:**
- Similar to SidePanelLive but focused on agent events
- Timeline of `:asr_partial`, `:tool_start`, etc.
- Mic control via JS hook

#### Phoenix Channels

**AudioChannel:**
```elixir
# Binary WebSocket for efficient audio streaming
def handle_in("audio", {:binary, audio_chunk}, socket) do
  AgentSession.cast_audio(socket.assigns.session_id, audio_chunk)
  {:noreply, socket}
end
```

**VideoChannel:**
- Receives frame data, embeddings, metadata
- Stores in database for context

**UserChannel:**
- Global events not tied to specific session/video

#### AgentSession (GenServer)

**State Machine:**
```
States:
:idle         - No active recording
:listening    - Audio capture active, accumulating chunks
:paused       - Recording paused by user (can resume)
:transcribing - Sending audio to STT (local WASM or cloud)
:structuring  - LLM processing transcript into structured note
:confirming   - Waiting for user confirmation/cancellation (3s timeout)
:executing_tool - Posting note to platform (if auto-post enabled)
:cancelling   - Processing "scratch that" command
:retrying     - Previous operation failed, attempting retry
:error        - Unrecoverable error state

Transitions:
:idle → :listening (mic button pressed)
:listening → :paused (pause button)
:listening → :transcribing (silence detected via VAD, or manual stop)
:paused → :listening (resume button)
:transcribing → :structuring (transcript received)
:structuring → :confirming (note generated)
:confirming → :executing_tool (timeout or user confirms)
:confirming → :cancelling (user says "scratch that")
:confirming → :idle (note saved as ghost)
:executing_tool → :idle (post complete)
:cancelling → :idle (cancellation complete)
:retrying → :transcribing (retry transcription)
:retrying → :structuring (retry LLM)
* → :error (unrecoverable failure)
```

**Key Functions:**
```elixir
defmodule Lossy.Agent.Session do
  @max_audio_buffer_bytes 5_000_000  # 5MB max before forced transcription
  @max_audio_duration_seconds 60     # 60s max before forced transcription

  # Accumulate audio with buffer limits
  def handle_cast({:audio_chunk, data}, state) do
    new_buffer = state.audio_buffer <> data
    new_duration = state.audio_duration + chunk_duration(data)

    cond do
      byte_size(new_buffer) >= @max_audio_buffer_bytes ->
        # Force transcription
        {:noreply, state |> update_buffer(new_buffer) |> transition_to(:transcribing)}

      new_duration >= @max_audio_duration_seconds ->
        # Force transcription
        {:noreply, state |> update_buffer(new_buffer) |> transition_to(:transcribing)}

      true ->
        # Continue accumulating
        {:noreply, update_buffer(state, new_buffer, new_duration)}
    end
  end

  # Handle state transitions with validation
  defp transition_to(state, new_state) do
    if valid_transition?(state.status, new_state) do
      %{state | status: new_state, last_transition: DateTime.utc_now()}
      |> broadcast_state_change()
    else
      Logger.error("Invalid transition: #{state.status} -> #{new_state}")
      %{state | status: :error, error: "Invalid state transition"}
    end
  end

  # Process pipeline
  defp process_audio(audio_binary)
    |> transcribe()
    |> extract_intent()
    |> execute_tool()
    |> broadcast_results()
end
```

**Event Broadcasting:**
```elixir
# Emits to PubSub topic "session:#{session_id}"
defp emit_event(session_id, event) do
  Phoenix.PubSub.broadcast(
    Lossy.PubSub,
    "session:#{session_id}",
    {:agent_event, event}
  )
end
```

#### Inference Router

**Decision tree:**
```elixir
def transcribe(audio_binary) do
  case Application.get_env(:lossy, :stt_backend) do
    :wasm ->
      # Already done in extension, use transcript
      {:ok, get_transcript_from_extension()}

    :cloud ->
      # OpenAI Whisper API
      OpenAI.transcribe(audio_binary)

    :native ->
      # Rustler NIF to whisper.cpp
      WhisperNIF.transcribe(audio_binary)
  end
end
```

#### Automation Integration

**Pattern:**
```elixir
defmodule Lossy.Automation.NoteApplicator do
  def apply_note(note) do
    # Queue via Oban for reliability
    %{note_id: note.id}
    |> ApplyNoteWorker.new()
    |> Oban.insert()
  end
end

# Worker
defmodule ApplyNoteWorker do
  use Oban.Worker

  def perform(%{args: %{"note_id" => note_id}}) do
    note = Videos.get_note!(note_id)

    # Call existing Python agent via bridge
    result = PythonBridge.apply_note_playwright(
      note.video.url,
      note.timestamp_seconds,
      note.text
    )

    # Update note with result
    Videos.update_note(note, %{
      status: :posted,
      external_permalink: result.permalink
    })
  end
end
```

---

## Data Flow Examples

### Example 1: Voice Note Creation

```
1. User clicks mic in side panel
   ↓
2. Side panel JS sends message to service worker
   chrome.runtime.sendMessage({cmd: 'toggle_mic'})
   ↓
3. Service worker tells offscreen doc to start capture
   chrome.runtime.sendMessage({cmd: 'start_audio'})
   ↓
4. Offscreen doc:
   - getUserMedia() → stream
   - VAD detects speech start
   - Encodes audio chunks
   - Sends to service worker
   ↓
5. Service worker forwards to Phoenix via AudioChannel
   channel.push("audio", {binary: audioChunk})
   ↓
6. Phoenix AudioChannel routes to AgentSession
   AgentSession.cast_audio(session_id, audio_chunk)
   ↓
7. AgentSession accumulates audio, processes when threshold met
   ↓
8. STT transcribes (local WASM or cloud API)
   ↓
9. Broadcast event to PubSub
   {:agent_event, %{type: :asr_final, text: "..."}}
   ↓
10. SidePanelLive receives via PubSub subscription
    ↓
11. LiveView stream_insert adds to UI
    {:noreply, stream_insert(socket, :events, event)}
    ↓
12. Browser renders new event (zero flicker)
```

### Example 2: Video Context Change

```
1. User switches to new YouTube tab
   ↓
2. chrome.tabs.onActivated fires in service worker
   ↓
3. Service worker extracts video ID from URL
   ↓
4. Sends to side panel via postMessage
   ↓
5. Side panel's LiveView pushes event
   liveSocket.pushEvent("video_changed", {video_id: newId})
   ↓
6. Phoenix SidePanelLive receives
   def handle_event("video_changed", %{"video_id" => vid}, socket)
   ↓
7. Unsubscribe from old video topic, subscribe to new
   PubSub.unsubscribe("video:#{old_id}")
   PubSub.subscribe("video:#{new_id}")
   ↓
8. Reload notes for new video
   notes = Videos.list_notes(new_video_id)
   ↓
9. Reset stream
   {:noreply, stream(socket, :notes, notes, reset: true)}
   ↓
10. Browser re-renders note list
```

### Example 3: Automated Note Posting

```
1. AgentSession completes note structuring
   {:ok, structured_note} = LLM.structure_note(transcript)
   ↓
2. Checks confidence threshold
   if confidence > 0.7, queue for posting
   ↓
3. Creates note in database with status: :pending_post
   note = Videos.create_note(structured_note)
   ↓
4. Enqueues Oban job
   ApplyNoteWorker.new(%{note_id: note.id}) |> Oban.insert()
   ↓
5. Oban worker picks up job (within seconds)
   ↓
6. Worker calls Browserbase via Python bridge
   PythonBridge.apply_note_playwright(url, time, text)
   ↓
7. Python agent:
   - Creates Browserbase session with auth context
   - Connects via Playwright
   - Navigates to video URL
   - Seeks to timestamp
   - Uses Stagehand AI to post comment
   - Returns permalink
   ↓
8. Worker updates note in database
   Videos.update_note(note, %{status: :posted, permalink: result})
   ↓
9. Broadcasts update to PubSub
   PubSub.broadcast("video:#{video_id}", {:note_posted, note})
   ↓
10. SidePanelLive receives and updates UI
    stream_insert(socket, :notes, note)
    ↓
11. User sees "Posted ✅" status in side panel
```

---

## Security & Authentication

### Token Flow

```
1. User logs in via options page (regular Phoenix login)
   ↓
2. Phoenix generates token
   token = Phoenix.Token.sign(endpoint, "user socket", user.id)
   ↓
3. Extension stores in chrome.storage.local
   await chrome.storage.local.set({ authToken: token })
   ↓
4. All WebSocket connections include token
   params: { auth_token: token }
   ↓
5. Phoenix verifies on connect
   Phoenix.Token.verify(endpoint, "user socket", token, max_age: 30_days)
```

### No Cookies

- ✅ Token-based auth (immune to CSRF)
- ✅ Works across origins
- ✅ No third-party cookie issues
- ✅ Extension storage is encrypted at OS level

### CSP

**Extension manifest:**
```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; connect-src 'self' wss://your-app.com"
  }
}
```

**Phoenix endpoint:**
```elixir
# Allow extension origin for WebSocket
check_origin: ["https://your-app.com", "chrome-extension://EXT_ID"]
```

---

## Scalability Considerations

### AgentSession Lifecycle

- One GenServer per user session
- Supervised by DynamicSupervisor
- Auto-cleanup after N minutes of inactivity
- Session state persisted to DB for resume

### PubSub Topics

- `"session:#{session_id}"` - Private, one-to-one
- `"video:#{video_id}"` - Shared, multi-user (future)
- `"user:#{user_id}"` - User's global events

### Database

- Notes table indexed on `video_id`, `user_id`, `status`
- Vector embeddings for semantic search (future)
- Audio chunks cleaned up after processing

### Oban Queue

- `:automation` queue for Browserbase jobs
- Retry with exponential backoff
- Max 3 attempts
- Dead letter queue for manual review

---

## Monitoring & Observability

### Telemetry Events

```elixir
:telemetry.execute(
  [:lossy, :agent, :transcription, :complete],
  %{duration: duration_ms},
  %{session_id: sid, model: :whisper}
)
```

### Metrics to Track

- Transcription latency (p50, p95, p99)
- Ghost comment generation time
- Note posting success rate
- WebSocket connection stability
- WASM inference performance (client-side)

### Logging

- Structured logs with session_id, user_id tags
- Error tracking with Sentry/Honeybadger
- Audit trail for all posted notes

---

## Next Steps

See `03_IMPLEMENTATION_PHASES.md` for phased build plan.
