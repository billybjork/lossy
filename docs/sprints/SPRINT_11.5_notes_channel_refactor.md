# Sprint 11.5: Notes Channel Refactor

**Status:** 🟢 In Progress
**Goal:** Replace service worker note relay with direct Phoenix Channel subscription in sidepanel
**Duration:** 2-3 hours
**Started:** 2025-10-22

---

## 🎯 Objective

Simplify the notes data flow by having the sidepanel subscribe directly to a Phoenix Channel for notes, eliminating the service worker as a middleman relay.

### Current Architecture (Complex)

```
Phoenix Backend
  ↓ PubSub broadcast
AudioChannel (in service worker)
  ↓ channel.on('note_created')
Service Worker
  ↓ messageRouter.routeToSidePanel()
  ↓ chrome.runtime.onMessage
Sidepanel JS
  ↓ appendNote()
DOM
```

**Problems:**
- Service worker acts as unnecessary middleman for notes
- 200+ lines of relay logic in service worker
- Notes go through 3 hops instead of direct subscription
- Service worker has to track which sidepanel wants which notes
- Mixing concerns: audio streaming + note relay

### New Architecture (Simple)

```
Phoenix Backend (AudioChannel)          Phoenix Backend (NotesChannel)
  ↓ Audio streaming only                  ↓ PubSub broadcast
Service Worker                           NotesChannel (in sidepanel)
  ↓ Chrome APIs only                       ↓ channel.on('note_created')
(Recording, VAD, MediaRecorder)          Sidepanel JS
                                           ↓ appendNote()
                                         DOM
```

**Benefits:**
- Service worker focuses on audio streaming only (single responsibility)
- Sidepanel owns its data subscription
- Direct real-time updates (no relay)
- ~200 lines removed from service worker
- Cleaner separation: Chrome APIs vs Phoenix Channels

---

## 📋 Deliverables

- [ ] `lib/lossy_web/channels/notes_channel.ex` - New channel for notes subscription
- [ ] Phoenix socket handler updated with notes channel route
- [ ] Sidepanel connects directly to NotesChannel via WebSocket
- [ ] Service worker relay logic removed (~200 lines)
- [ ] Real-time notes working in sidepanel
- [ ] Documentation updated to reflect architecture change

---

## 🔧 Technical Tasks

### Task 1: Create NotesChannel (Backend)

**File:** `lib/lossy_web/channels/notes_channel.ex` (new)

```elixir
defmodule LossyWeb.NotesChannel do
  use LossyWeb, :channel
  require Logger

  @impl true
  def join("notes:video:" <> video_id, _params, socket) do
    Logger.info("Client joined notes channel for video: #{video_id}")

    # Subscribe to this video's PubSub topic
    Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")

    {:ok, socket}
  end

  @impl true
  def join("notes:user:" <> user_id, _params, socket) do
    # For future: cross-video note feed (library view)
    Logger.info("Client joined notes channel for user: #{user_id}")
    {:ok, socket}
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    notes = Lossy.Videos.list_notes(%{video_id: video_id})

    Logger.info("Sending #{length(notes)} existing notes for video: #{video_id}")

    {:reply, {:ok, %{notes: serialize_notes(notes)}}, socket}
  end

  # Receive PubSub broadcasts from AgentSession
  @impl true
  def handle_info({:new_note, note}, socket) do
    Logger.debug("Broadcasting new note: #{note.id}")

    push(socket, "note_created", serialize_note(note))

    {:noreply, socket}
  end

  @impl true
  def handle_info(_msg, socket), do: {:noreply, socket}

  # Serialize note for client
  defp serialize_note(note) do
    %{
      id: note.id,
      text: note.text,
      category: note.category,
      confidence: note.confidence,
      timestamp_seconds: note.timestamp_seconds,
      raw_transcript: note.raw_transcript,
      video_id: note.video_id,
      timestamp: note.inserted_at
    }
  end

  defp serialize_notes(notes), do: Enum.map(notes, &serialize_note/1)
end
```

**File:** `lib/lossy_web/channels/user_socket.ex` (update)

```elixir
# Add to channel routes
channel "notes:*", LossyWeb.NotesChannel
```

---

### Task 2: Install Phoenix Client in Extension

**Command:**

```bash
cd extension
npm install phoenix
```

**Webpack config:** Already configured to bundle node_modules

---

### Task 3: Add Phoenix Socket to Sidepanel

**File:** `extension/src/sidepanel/sidepanel.js` (add at top)

```javascript
import { Socket } from 'phoenix';

// Phoenix connection for notes (separate from service worker's audio channel)
let notesSocket = null;
let notesChannel = null;

// Initialize Phoenix connection for notes
function initNotesSocket() {
  notesSocket = new Socket('ws://localhost:4000/socket', {
    params: {} // TODO: Add auth token when auth is implemented
  });

  notesSocket.connect();

  notesSocket.onOpen(() => {
    console.log('[Notes] Connected to Phoenix');
  });

  notesSocket.onError((error) => {
    console.error('[Notes] Socket error:', error);
  });

  notesSocket.onClose(() => {
    console.log('[Notes] Socket closed');
  });
}

// Subscribe to a video's notes channel
function subscribeToVideoNotes(videoDbId) {
  if (!videoDbId) {
    console.log('[Notes] No video ID, skipping subscription');
    return;
  }

  // Leave old channel if exists
  if (notesChannel) {
    console.log('[Notes] Leaving old channel');
    notesChannel.leave();
    notesChannel = null;
  }

  // Join new video's channel
  notesChannel = notesSocket.channel(`notes:video:${videoDbId}`, {});

  // Listen for real-time notes
  notesChannel.on('note_created', (note) => {
    console.log('[Notes] Received real-time note:', note);

    // Only append if we're still viewing this video
    if (displayedVideoDbId === note.video_id) {
      appendNote({
        action: 'transcript',
        data: note
      });
    }
  });

  // Join channel and load existing notes
  notesChannel.join()
    .receive('ok', () => {
      console.log(`[Notes] Joined channel for video: ${videoDbId}`);

      // Load existing notes
      notesChannel.push('get_notes', { video_id: videoDbId })
        .receive('ok', ({ notes }) => {
          console.log(`[Notes] Loaded ${notes.length} existing notes`);

          // Clear and render notes
          if (notes.length > 0) {
            // Update cache
            notesCache.set(videoDbId, notes);

            // Render
            renderNotesFromCache(videoDbId);
          }
        })
        .receive('error', (err) => {
          console.error('[Notes] Failed to get notes:', err);
        });
    })
    .receive('error', (err) => {
      console.error('[Notes] Failed to join channel:', err);
    });
}

// Initialize on load
initNotesSocket();
```

**File:** `extension/src/sidepanel/sidepanel.js` (update existing tab change handler)

Find the existing tab change handler and add:

```javascript
// Existing code that updates displayedVideoDbId...
displayedVideoDbId = newVideoDbId;

// NEW: Subscribe to notes channel for this video
subscribeToVideoNotes(newVideoDbId);
```

---

### Task 4: Remove Service Worker Relay Logic

**File:** `extension/src/background/service-worker.js`

Remove or simplify:

1. **Lines 896-926**: `audioChannel.on('note_created')` relay
2. **Lines 1238-1268**: Passive mode `note_created` relay
3. **Lines 1507-1571**: `loadNotesForSidePanel()` and `sendNotesToSidePanel()`
4. **Lines 1475-1505**: Note loading in `loadNotesForContentScript()` (keep for timeline markers)

**Changes:**

```javascript
// REMOVE: Don't listen for note_created in service worker
// audioChannel.on('note_created', (payload) => { ... });

// KEEP: Service worker only handles audio streaming
// audioChannel.on('transcription_progress', ...) // If you have this
// audioChannel.on('audio_ack', ...) // If you have this
```

**Content script timeline markers:** Keep the existing logic in `loadNotesForContentScript()` that sends notes to content script for timeline markers. Just remove the sidepanel relay.

---

### Task 5: Update AgentSession Broadcasting

**File:** `lib/lossy/agent/session.ex` (verify)

Ensure AgentSession broadcasts to both:
1. `"session:#{session_id}"` topic (for AudioChannel)
2. `"video:#{video_id}"` topic (for NotesChannel)

Current code (lines 287-290) already does this:

```elixir
Phoenix.PubSub.broadcast(
  Lossy.PubSub,
  "video:#{state.video_id}",
  {:new_note, note}
)
```

✅ No changes needed - already broadcasting correctly

---

## 🧪 Testing Checklist

### Manual Testing

- [ ] Start Phoenix backend: `mix phx.server`
- [ ] Build extension: `npm run build`
- [ ] Reload extension in Chrome
- [ ] Open sidepanel on a video page
- [ ] Check browser console: `[Notes] Connected to Phoenix`
- [ ] Check browser console: `[Notes] Joined channel for video: X`
- [ ] Start recording and speak
- [ ] Verify note appears in sidepanel in real-time
- [ ] Switch to different video tab
- [ ] Verify sidepanel loads that video's notes
- [ ] Create new note on second video
- [ ] Verify it appears immediately
- [ ] Check service worker has no note relay logs

### Backend Testing

```elixir
# In IEx
iex> Phoenix.PubSub.broadcast(Lossy.PubSub, "video:test_123", {:new_note, %{id: 1, text: "Test", category: "general", confidence: 0.95, timestamp_seconds: 10.5, raw_transcript: "test", video_id: "test_123"}})
```

Should see note appear in sidepanel if connected to `notes:video:test_123`

---

## 📊 Metrics

### Lines of Code

- **Before:** ~1800 lines in service-worker.js
- **After:** ~1600 lines (-200 relay logic)
- **Added:** ~100 lines in notes_channel.ex + 80 lines in sidepanel.js
- **Net:** -20 lines, better separation of concerns

### Architecture Wins

- ✅ Service worker: Audio streaming only
- ✅ Sidepanel: Owns note subscription
- ✅ Direct WebSocket connection (no middleman)
- ✅ Real-time by default (Phoenix Channels)
- ✅ Easy to add filters/search server-side later

---

## 📚 Documentation Updates

### Files to Update

1. **docs/01_OVERVIEW.md**
   - Line 40-41: Change "Phoenix LiveView" → "Vanilla JS + Phoenix Channels"
   - Line 263: Change "LiveView for extension UI" → "Phoenix Channels for real-time data"
   - Line 73: Keep "Phoenix Channels" for audio (already correct)

2. **docs/04_LIVEVIEW_PATTERNS.md**
   - Move to `docs/archive/04_LIVEVIEW_PATTERNS.md`
   - Add note at top: "This pattern was researched but not adopted. Project uses vanilla JS + Phoenix Channels for simpler extension integration."

3. **docs/03_ARCHITECTURE.md** (if it exists)
   - Update data flow diagrams
   - Document NotesChannel vs AudioChannel separation

4. **docs/sprints/README.md**
   - Add Sprint 11.5 to completed sprints

---

## 🎓 Key Learnings

### What Worked

- **Channels > LiveView for extensions**: LiveView adds unnecessary complexity (JS Hooks, token auth, CSP config) when you already have Chrome APIs
- **Direct subscription**: Sidepanel subscribing directly to notes channel is cleaner than service worker relay
- **Separation of concerns**: Audio streaming vs data subscription are different responsibilities
- **Phoenix Channels are lightweight**: Just WebSocket + PubSub, no LiveView overhead

### What to Avoid

- ❌ Using service worker as message relay when direct connection is possible
- ❌ Mixing audio streaming channel with data subscription
- ❌ Assuming LiveView is always the answer for real-time UI

### Future Considerations

- When auth is added, pass token in socket params: `new Socket('...', { params: { token } })`
- Video library view can use `notes:user:#{id}` channel for cross-video feed
- Search/filters can happen server-side by sending filter params to channel

---

## 🔗 Related Sprints

- **Sprint 01**: Audio Streaming - Created AudioChannel (still used)
- **Sprint 02**: Transcription - Created note_created events (still used)
- **Sprint 04**: Tab Management - Created MessageRouter (partially replaced)
- **Sprint 09**: Video Library - Can benefit from user-level notes channel

---

## ✅ Definition of Done

- [ ] NotesChannel implemented and tested
- [ ] Sidepanel connects to NotesChannel on load
- [ ] Real-time notes appear in sidepanel without service worker relay
- [ ] Tab switching subscribes to new video's channel
- [ ] Service worker relay logic removed
- [ ] No regressions in audio streaming or recording
- [ ] Timeline markers still work in content script
- [ ] Documentation updated
- [ ] Sprint archived with learnings

---

**Next Steps After Completion:**

Consider adding:
- Server-side note filtering (by category, confidence, etc.)
- Note search via channel
- Pagination for large note lists
- User-level notes feed for library view
