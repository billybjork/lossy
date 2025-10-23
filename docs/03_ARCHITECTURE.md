# System Architecture

**Last Updated:** 2025-10-17

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
│  Backend (Elixir)                                               │
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
│  │ Inference       │  │ Computer Use Automation             │  │
│  │ Router          │  │                                     │  │
│  │                 │  │ - LocalAgent (GenServer)            │  │
│  │ - STT           │  │   • Playwright via CDP              │  │
│  │   • WASM (ext)  │  │   • Gemini Computer Use (fallback) │  │
│  │   Local only!   │  │   • Node.js Port communication     │  │
│  │   (Sprint 11)   │  │                                     │  │
│  │                 │  │ - ProfileSetup                      │  │
│  │ - Vision        │  │   • Manages agent Chrome profile    │  │
│  │   • CLIP (ext)  │  │   • Persistent cookies/localStorage│  │
│  │   • Cloud API   │  │                                     │  │
│  │                 │  │ - Platform Adapters (reusable)      │  │
│  │ - LLM           │  │   • Video/timeline element finders │  │
│  │   • OpenAI API  │  │   • Selector discovery helpers     │  │
│  │   • Local llama │  │                                     │  │
│  └─────────────────┘  │ Queued via Oban for reliability     │  │
│                       │                                     │  │
│                       │ Optional: BrowserbaseAgent          │  │
│                       │ (fallback for offline/batch mode)   │  │
│                       └─────────────────────────────────────┘  │
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
│  Local Browser Agent (Primary)                                  │
│                                                                  │
│  - Dedicated Chrome profile (~/.config/lossy/agent-profile)    │
│  - Playwright via CDP or Gemini Computer Use API               │
│  - Navigate to video platform                                   │
│  - Post note as comment at timestamp                           │
│  - Real-time status updates via PubSub                         │
│  - "Summon" feature for MFA/user intervention                  │
│  - Return permalink                                             │
│                                                                  │
│  Fallback: Browserbase (optional, when machine offline)        │
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

**Purpose:** Inject UI overlays into video pages with self-healing capabilities

**Responsibilities:**
- Find and monitor video element with platform-specific adapters
- Inject Shadow DOM overlays (isolation from page CSS)
- Capture video frames via `requestVideoFrameCallback`
- Display anchor chip, ghost comments, emoji tokens, timeline markers
- Re-parent overlays into fullscreen element
- Self-heal when video elements are replaced (SPA navigation, lazy loading)
- Load and sync notes from backend with retry logic

**Does NOT:**
- ❌ Access microphone (done in offscreen)
- ❌ Maintain WebSocket (done in service worker)
- ❌ Use LiveView (uses Shadow DOM + vanilla JS)

**Architecture (Sprint 05 - Reliability Improvements):**

The content script uses a modular, self-healing architecture with these core components:

**1. VideoLifecycleManager**
- State machine managing video detection lifecycle: `idle → detecting → ready → error`
- Periodic health checks (video validity, adapter health) every 5 seconds
- Persistent detection with retry logic (up to 20 attempts)
- Automatic recovery when video elements are replaced by platforms
- State change callbacks for event notification
- Integrated with AbortController for cleanup

**2. MessageRouter** (Per-Tab Message Routing)
- Prevents race conditions and message crosstalk between tabs
- Tab-aware message routing (only processes messages for own tabId)
- Prevents stale notes from appearing on wrong videos
- Clean separation of concerns for multi-tab scenarios

**3. NoteLoader** (Consolidated Retry Logic)
- Centralized note loading with exponential backoff retry
- Prevents duplicate notes during rapid reloads
- Graceful degradation on persistent failures
- Clear logging for debugging note loading issues
- Integrated with video context lifecycle

**4. Platform Adapters** (Extensible Detection)
- **VimeoAdapter**: Vimeo-specific video detection and progress bar handling
- **YouTubeAdapter**: YouTube-specific selectors and player integration
- **UniversalAdapter**: Fallback for generic video platforms
- Each adapter provides: `detectVideo()`, `getProgressBar()`, `isHealthy()`
- Adapters selected based on URL pattern matching

**5. TimelineMarkers** (Resilient UI Overlay)
- Shadow DOM for style isolation
- Monitors video metadata loading (duration availability)
- Queues markers until video is ready (prevents race conditions)
- Reflows markers on progress bar resize
- Reattaches after DOM manipulation (fullscreen, SPA navigation)
- Click handlers for seeking to note timestamps

**6. AbortController Cleanup Pattern**
- Single `abort()` call cascades cleanup through all components
- Prevents memory leaks during SPA navigation and reinitialization
- Clean event listener removal via AbortSignal
- Consistent pattern across VideoLifecycleManager, VideoDetector, TimelineMarkers

**State Management:**
```javascript
// Initialization with cleanup signal
const abortController = new AbortController();
const signal = abortController.signal;

// Components receive signal and self-cleanup on abort
lifecycleManager = new VideoLifecycleManager(adapter, { signal });
timelineMarkers = new TimelineMarkers(videoElement, progressBar, { signal });

// Cleanup cascades through all components
abortController.abort(); // Triggers destroy() on all components
```

**Self-Healing Behaviors:**
- Video element replacement detection (Vimeo swaps `<video>` elements during lazy loading)
- Progress bar DOM monitoring (reattach timeline markers if removed)
- Adapter health validation (fallback to universal adapter if platform-specific fails)
- Persistent note loading with retry (handles backend unavailability)
- Graceful degradation with clear console logging (reduced noise, no false alerts)

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

### 2. Backend Components

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
    :extension ->
      # Sprint 11: All transcription happens in browser (local-only)
      # Backend receives final transcript via AudioChannel
      {:ok, get_transcript_from_extension()}

    :native ->
      # Optional: Rustler NIF to whisper.cpp (if needed in future)
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
6. Extension transcribes locally (WASM - WebGPU or CPU via ONNX Runtime)
   ↓
7. Extension sends transcript to backend via AudioChannel
   channel.push("transcript_final", {text: "...", source: "local"})
   ↓
8. AgentSession receives and processes transcript
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
3. Creates note in database with status: :ghost
   note = Videos.create_note(structured_note)
   ↓
4. Enqueues Oban job
   PostNoteWorker.new(%{note_id: note.id}) |> Oban.insert()
   ↓
5. Oban worker picks up job (within seconds)
   ↓
6. Worker calls LocalAgent via GenServer
   LocalAgent.post_note(note_id, platform, url, timestamp, text)
   ↓
7. LocalAgent:
   - Sends request to Node.js Playwright agent via Port
   - Broadcasts status: "🚀 Launching browser"
   ↓
8. Node.js agent:
   - Launches Chrome with persistent profile (~/.config/lossy/agent-profile)
   - Checks if logged in via platform adapter selectors
   - Broadcasts status: "✓ Logged in"
   - Navigates to video URL at timestamp
   - Broadcasts status: "📤 Posting comment"
   - Posts comment using platform-specific selectors
   - Returns permalink
   ↓
9. LocalAgent broadcasts final status
   PubSub.broadcast("note:#{note_id}", {:agent_status, "✅ Posted"})
   ↓
10. Worker updates note in database
    Videos.update_note(note, %{status: :posted, permalink: result})
    ↓
11. NotesLive receives status updates in real-time
    handle_info({:agent_status, status}) -> updates note card
    ↓
12. User sees live progress: "🔒" → "📤" → "✅ Posted"
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

---

## Architectural Boundaries & Integration Rules

### Core Principle: Strict Separation

**Extension Responsibilities:**
- ✅ UI rendering and user interaction
- ✅ Video element detection
- ✅ Audio capture
- ✅ WebSocket client (Phoenix Channels)
- ✅ Local WASM inference (optional)

**Extension NEVER:**
- ❌ Direct database access
- ❌ Business logic
- ❌ External API calls (OpenAI, platform APIs)
- ❌ Platform integrations

**Backend Responsibilities:**
- ✅ All database operations (PostgreSQL via Ecto)
- ✅ Business logic and note structuring
- ✅ External integrations (OpenAI, Browserbase)
- ✅ Platform API calls
- ✅ Authentication and authorization
- ✅ Job orchestration (Oban)

**Backend NEVER:**
- ❌ DOM manipulation
- ❌ Video element access
- ❌ Browser APIs (getUserMedia, etc.)

### Database Access Pattern

**Rule: Extension has ZERO database access**

All data flows through WebSocket channels:

```
Extension → channel.push('create_note', data)
          → VideoChannel.handle_in("create_note")
          → Videos.create_note() [Ecto]
          → PostgreSQL
          → PubSub.broadcast(:note_created)
          → Extension receives event
```

**Extension code example:**
```javascript
// ✅ CORRECT
videoChannel.push('create_note', {
  text: noteText,
  timestamp_seconds: timestamp
}).receive('ok', ({ note }) => renderNote(note));

// ❌ NEVER do this
// import pg from 'pg';
// await client.query('INSERT INTO notes...');
```

### Integration Decision Tree

**Where should processing happen?**

```
Does it need database access?
  YES → Backend only

Does it involve external APIs?
  YES → Backend only

Does it need browser APIs (video, audio, DOM)?
  YES → Extension only

Is it computationally expensive (>100ms)?
  YES → Consider extension (WASM/WebGPU for speed + privacy)
  NO  → Backend (simpler, more maintainable)

Does it need to work across sessions/devices?
  YES → Backend
  NO  → Extension (if appropriate)
```

**Examples:**
- Audio capture → Extension (needs getUserMedia)
- Transcription → Extension only (local WASM, WebGPU or CPU - Sprint 11)
- Note categorization → Backend (business logic)
- Video frame capture → Extension (needs video element access)
- Frame analysis → Extension (WASM CLIP for privacy)
- Note posting → Backend (platform APIs, authentication)

### Common Anti-Patterns

**❌ Anti-Pattern: Business logic in extension**
```javascript
// WRONG: Complex categorization in extension
function categorizeNote(transcript) {
  // 50 lines of rules...
}
```

**✅ Correct: Backend handles business logic**
```javascript
// Extension just sends data
channel.push('categorize_note', { transcript });
channel.on('note_categorized', renderCategory);
```

**❌ Anti-Pattern: API keys in extension**
```javascript
// NEVER: Exposed in extension code
const response = await fetch('https://api.openai.com/...', {
  headers: { 'Authorization': `Bearer ${apiKey}` }
});
```

**✅ Correct: Backend handles API calls**
```javascript
channel.push('generate_summary', { transcript });
```

**❌ Anti-Pattern: Storing database credentials**
```javascript
// NEVER EVER
const db = new PostgreSQLClient({
  password: 'secret123' // Exposed!
});
```

### Current State Verification

As of 2025-10-17:

✅ **Extension has zero database access**
- No database drivers (`pg`, `postgres`, `postgrex`, etc.)
- No SQL queries in extension code
- All data flows through Phoenix Channels

✅ **All DB operations in Elixir backend**
- `Lossy.Videos` context handles all database operations
- Ecto schemas and changesets for data validation
- PostgreSQL connection only from backend

✅ **Clean WebSocket communication**
- `video:meta` channel for note operations
- `audio:SESSION_ID` channel for audio streaming
- PubSub for real-time broadcasts

---

## Next Steps

See `sprints/` directory for phased implementation plan.
