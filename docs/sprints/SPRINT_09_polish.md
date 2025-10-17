# Sprint 06: Polish & UX Refinements

**Status:** ⏳ Future
**Estimated Duration:** 3-4 days

---

## Goal

Polish the user experience with animations, error states, loading indicators, and visual refinements using LiveView patterns. Make the product feel production-ready with smooth real-time updates and graceful degradation.

---

## Prerequisites

- ✅ All core features working (Sprints 01-05)
- ✅ End-to-end flow tested
- ✅ LiveView side panel and popup functional

---

## Deliverables

- [ ] Loading states for all async operations (LiveView + JS hooks)
- [ ] Error messages with recovery actions (LiveView flash + PubSub)
- [ ] Smooth animations for UI transitions (CSS + LiveView morphing)
- [ ] "Scratch that" voice command (intent detection)
- [ ] Confirmation UI for low-confidence notes (conditional rendering)
- [ ] Keyboard shortcuts (JS hooks)
- [ ] Dark mode support (CSS custom properties)
- [ ] Onboarding tutorial (LiveView modal)
- [ ] Connection state indicators (offline handling)
- [ ] Optimistic UI updates (stream_insert with temporary IDs)

---

## Technical Tasks

### Task 1: Error Handling (LiveView Patterns)

**1.1 Network Failures & Channel Disconnection**

**File:** `lib/lossy_web/live/side_panel_live.ex` (add connection tracking)

```elixir
@impl true
def mount(_params, session, socket) do
  # Check if connected (vs initial server render)
  if connected?(socket) do
    # Real WebSocket connection
    {:ok,
     socket
     |> assign(:connection_state, :online)
     |> assign(:retry_count, 0)
     # ... rest of mount
    }
  else
    # Initial HTTP render
    {:ok,
     socket
     |> assign(:connection_state, :connecting)
     |> assign(:retry_count, 0)}
  end
end

# Handle LiveView disconnect
@impl true
def terminate(reason, socket) do
  Logger.info("LiveView disconnected: #{inspect(reason)}")
  # Cleanup handled automatically, but log for monitoring
  :ok
end
```

**Extension:** Handle reconnection in client

**File:** `extension/src/sidepanel/sidepanel.js` (update)

```javascript
const liveSocket = new LiveSocket("wss://...", Socket, {
  params: () => ({
    auth_token: authToken,
    session_id: sessionId,
    video_id: videoId
  }),

  // Exponential backoff
  reconnectAfterMs: (tries) => {
    return Math.min(100 * Math.pow(5, tries), 30000);
  },

  // Connection lifecycle
  onOpen: () => {
    console.log('LiveView connected');
    updateConnectionIndicator('online');
  },

  onClose: () => {
    console.log('LiveView disconnected');
    updateConnectionIndicator('offline');
  },

  onError: (error) => {
    console.error('LiveView error:', error);
    updateConnectionIndicator('error');
  }
});

function updateConnectionIndicator(status) {
  // Update UI to show connection state
  document.getElementById('connection-status').textContent = {
    'online': '🟢 Connected',
    'offline': '🔴 Offline',
    'error': '🟡 Reconnecting...'
  }[status];
}
```

**Template:** Show connection state

```heex
<div class="connection-indicator">
  <%= case @connection_state do %>
    <% :online -> %>
      <span class="status-online">🟢 Connected</span>
    <% :offline -> %>
      <span class="status-offline">🔴 Offline</span>
      <button phx-click="retry_connection">Retry</button>
    <% :connecting -> %>
      <span class="status-connecting">🟡 Connecting...</span>
  <% end %>
</div>
```

**1.2 API Rate Limits & Errors**

**File:** `lib/lossy/inference/cloud.ex` (add retry logic)

```elixir
def transcribe_audio(audio_binary, opts \\ []) do
  max_retries = Keyword.get(opts, :max_retries, 3)
  retry_with_backoff(max_retries, fn attempt ->
    case HTTPoison.post(@whisper_url, build_body(audio_binary), headers(), timeout: 30_000) do
      {:ok, %{status_code: 200, body: body}} ->
        {:ok, parse_response(body)}

      {:ok, %{status_code: 429}} ->
        # Rate limited, retry with backoff
        {:retry, "Rate limited, retrying..."}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("Whisper API error: #{status} - #{error_body}")
        {:error, "API error: #{status}"}

      {:error, %HTTPoison.Error{reason: :timeout}} ->
        # Timeout, retry
        {:retry, "Request timeout, retrying..."}

      {:error, %HTTPoison.Error{reason: reason}} ->
        {:error, "Request failed: #{inspect(reason)}"}
    end
  end)
end

defp retry_with_backoff(0, _func), do: {:error, "Max retries exceeded"}

defp retry_with_backoff(retries_left, func) do
  attempt = 3 - retries_left + 1

  case func.(attempt) do
    {:ok, result} ->
      {:ok, result}

    {:retry, reason} ->
      backoff_ms = trunc(1000 * :math.pow(2, attempt))
      Logger.warn("#{reason} (attempt #{attempt}, waiting #{backoff_ms}ms)")
      Process.sleep(backoff_ms)
      retry_with_backoff(retries_left - 1, func)

    {:error, reason} ->
      {:error, reason}
  end
end
```

**Broadcast errors to LiveView:**

```elixir
# In AgentSession
defp transcribe_audio(state) do
  case Cloud.transcribe_audio(state.audio_buffer) do
    {:ok, transcript} ->
      # Success path

    {:error, reason} ->
      # Broadcast error to user
      Phoenix.PubSub.broadcast(
        Lossy.PubSub,
        "session:#{state.session_id}",
        {:agent_error, %{
          type: :transcription_failed,
          error: reason,
          recoverable: true
        }}
      )
  end
end
```

**Handle in LiveView:**

```elixir
@impl true
def handle_info({:agent_error, %{type: type, error: error, recoverable: recoverable}}, socket) do
  message = case type do
    :transcription_failed -> "Transcription failed: #{error}"
    :structuring_failed -> "Could not structure note: #{error}"
    :posting_failed -> "Failed to post note: #{error}"
  end

  socket =
    if recoverable do
      put_flash(socket, :warning, "#{message}. Retrying...")
    else
      put_flash(socket, :error, message)
    end

  {:noreply, socket}
end
```

**1.3 Microphone Permission Denied**

**Extension:** `extension/src/offscreen/offscreen.js` (update)

```javascript
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Success, proceed with recording
    // ... existing code ...

  } catch (error) {
    let userMessage = 'Failed to access microphone';

    if (error.name === 'NotAllowedError') {
      userMessage = 'Microphone permission denied. Please allow microphone access in your browser settings.';
    } else if (error.name === 'NotFoundError') {
      userMessage = 'No microphone found. Please connect a microphone and try again.';
    } else if (error.name === 'NotReadableError') {
      userMessage = 'Microphone is already in use by another application.';
    }

    // Send error to service worker → LiveView
    chrome.runtime.sendMessage({
      action: 'recording_error',
      error: {
        name: error.name,
        message: userMessage
      }
    });

    throw error;
  }
}
```

---

### Task 2: Animations (LiveView + CSS)

**2.1 LiveView Stream Animations**

**File:** `extension/src/sidepanel/sidepanel.css` (new)

```css
/* Stream insert animations */
[phx-update="stream"] > * {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Ghost comment fade-in */
.note-card.status-ghost {
  animation: ghostFadeIn 0.8s ease-out;
}

@keyframes ghostFadeIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 0.7;
    transform: scale(1);
  }
}

/* Confidence indicator */
.confidence-bar {
  width: 0;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.confidence-bar.loaded {
  width: var(--confidence-width);
}

/* Recording pulse */
.mic-button.recording {
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7);
  }
  50% {
    box-shadow: 0 0 0 12px rgba(220, 38, 38, 0);
  }
}

/* Toast notifications */
.flash-message {
  animation: toastSlide 0.3s ease-out;
}

@keyframes toastSlide {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}
```

**2.2 LiveView Morphing for Smooth Updates**

**Template:** Use `phx-update="stream"` for efficient DOM diffing

```heex
<!-- Notes list with stream updates (zero flicker) -->
<div id="notes-stream" phx-update="stream" class="notes-container">
  <div
    :for={{dom_id, note} <- @streams.notes}
    id={dom_id}
    class={["note-card", "status-#{note.status}", note.confidence < 0.7 && "low-confidence"]}
  >
    <.note_card note={note} />
  </div>
</div>
```

**2.3 Confidence Score Animation**

```heex
<div class="confidence-indicator">
  <div
    class="confidence-bar loaded"
    style={"--confidence-width: #{round(@note.confidence * 100)}%"}
    phx-hook="ConfidenceBar"
  >
    <%= round(@note.confidence * 100) %>%
  </div>
</div>
```

**JS Hook:**

```javascript
Hooks.ConfidenceBar = {
  mounted() {
    // Animate bar width on mount
    setTimeout(() => {
      this.el.classList.add('loaded');
    }, 100);
  }
};
```

---

### Task 3: Accessibility (ARIA + Keyboard)

**3.1 Keyboard Shortcuts**

**File:** `extension/src/sidepanel/sidepanel.js` (add hook)

```javascript
Hooks.KeyboardShortcuts = {
  mounted() {
    this.handleKeyPress = (e) => {
      // Cmd/Ctrl + K: Toggle mic
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('mic-button').click();
      }

      // Escape: Cancel current note
      if (e.key === 'Escape') {
        this.pushEvent('cancel_note', {});
      }

      // Cmd/Ctrl + Enter: Post all notes
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.pushEvent('post_all_notes', {});
      }
    };

    document.addEventListener('keydown', this.handleKeyPress);
  },

  destroyed() {
    document.removeEventListener('keydown', this.handleKeyPress);
  }
};
```

**3.2 Screen Reader Support**

```heex
<div class="side-panel" role="main" aria-label="Video notes panel">
  <header class="panel-header">
    <h1>Video Notes</h1>

    <button
      id="mic-button"
      phx-click="toggle_mic"
      class={["btn-mic", @recording && "recording"]}
      aria-label={if @recording, do: "Stop recording", else: "Start recording"}
      aria-pressed={to_string(@recording)}
    >
      <%= if @recording, do: "⏹️ Stop", else: "🎤 Record" %>
    </button>
  </header>

  <main class="notes-list" aria-live="polite" aria-atomic="false">
    <div id="notes-stream" phx-update="stream">
      <article
        :for={{dom_id, note} <- @streams.notes}
        id={dom_id}
        class="note-card"
        role="article"
        aria-label={"Note at #{format_timestamp(note.timestamp_seconds)}"}
      >
        <.note_card note={note} />
      </article>
    </div>
  </main>
</div>
```

**3.3 Focus Management**

```elixir
# After creating note, focus on it
def handle_info({:new_note, note}, socket) do
  {:noreply,
   socket
   |> stream_insert(:notes, note, at: 0)
   |> push_event("focus_note", %{note_id: note.id})}
end
```

```javascript
Hooks.FocusManager = {
  mounted() {
    this.handleEvent('focus_note', ({note_id}) => {
      const element = document.getElementById(`note-${note_id}`);
      if (element) {
        element.focus();
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
};
```

---

### Task 4: Performance (LiveView Optimizations)

**4.1 Efficient List Rendering with Streams**

See `03_LIVEVIEW_PATTERNS.md` for complete stream patterns.

```elixir
# Use stream/3 for efficient updates (no full re-render)
def mount(_params, session, socket) do
  notes = Videos.list_recent_notes(user_id, limit: 100)

  {:ok,
   socket
   |> stream(:notes, notes)  # Efficient initial load
   |> assign(:page, 1)}
end

# Add one note (only inserts DOM for new note)
def handle_info({:new_note, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note, at: 0)}
end

# Update one note (only patches changed note)
def handle_info({:note_updated, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note)}
end

# Delete one note (only removes DOM node)
def handle_event("delete_note", %{"id" => id}, socket) do
  Videos.delete_note(id)
  {:noreply, stream_delete(socket, :notes, note)}
end
```

**4.2 Lazy Loading (Infinite Scroll)**

```elixir
@impl true
def handle_event("load_more", _params, socket) do
  page = socket.assigns.page + 1
  notes = Videos.list_recent_notes(socket.assigns.user_id, page: page, limit: 50)

  {:noreply,
   socket
   |> stream(:notes, notes)  # Appends to existing stream
   |> assign(:page, page)}
end
```

```javascript
Hooks.InfiniteScroll = {
  mounted() {
    this.observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        this.pushEvent('load_more', {});
      }
    }, { threshold: 0.1 });

    this.observer.observe(this.el);
  },

  destroyed() {
    this.observer.disconnect();
  }
};
```

**Template:**

```heex
<div id="notes-stream" phx-update="stream">
  <!-- Notes rendered here -->
</div>

<!-- Sentinel element for infinite scroll -->
<div phx-hook="InfiniteScroll" id="scroll-sentinel"></div>
```

**4.3 Debounced Search**

```javascript
Hooks.SearchInput = {
  mounted() {
    this.timeout = null;

    this.el.addEventListener('input', (e) => {
      clearTimeout(this.timeout);

      this.timeout = setTimeout(() => {
        this.pushEvent('search_notes', { query: e.target.value });
      }, 300);  // 300ms debounce
    });
  },

  destroyed() {
    clearTimeout(this.timeout);
  }
};
```

---

### Task 5: "Scratch That" Voice Command

**File:** `lib/lossy/agent/session.ex` (add intent detection)

```elixir
defp structure_note(state, transcript_text) do
  # Check for cancel intent
  if cancel_intent?(transcript_text) do
    Logger.info("[#{state.session_id}] Cancel intent detected: #{transcript_text}")

    broadcast_event(state.session_id, %{
      type: :note_cancelled,
      transcript: transcript_text
    })

    %{state | status: :idle, audio_buffer: <<>>}
  else
    # Normal note structuring
    case Cloud.structure_note(transcript_text) do
      # ... existing code ...
    end
  end
end

defp cancel_intent?(text) do
  text = String.downcase(text)

  Enum.any?([
    "scratch that",
    "cancel that",
    "never mind",
    "forget that",
    "delete that",
    "undo"
  ], fn phrase -> String.contains?(text, phrase) end)
end
```

**Handle in LiveView:**

```elixir
@impl true
def handle_info({:agent_event, %{type: :note_cancelled}}, socket) do
  {:noreply,
   socket
   |> put_flash(:info, "Note cancelled")
   |> push_event("play_sound", %{sound: "cancel"})}
end
```

---

### Task 6: Confirmation UI for Low-Confidence Notes

```heex
<div
  :for={{dom_id, note} <- @streams.notes}
  id={dom_id}
  class={["note-card", note.confidence < 0.7 && "needs-confirmation"]}
>
  <%= if note.confidence < 0.7 and note.status == "ghost" do %>
    <div class="confirmation-banner">
      <p>⚠️ Low confidence. Please review:</p>
      <div class="actions">
        <button phx-click="firm_note" phx-value-id={note.id}>
          ✓ Looks Good
        </button>
        <button phx-click="edit_note" phx-value-id={note.id}>
          ✏️ Edit
        </button>
        <button phx-click="delete_note" phx-value-id={note.id}>
          🗑️ Delete
        </button>
      </div>
    </div>
  <% end %>

  <.note_card note={note} />
</div>
```

---

### Task 7: Dark Mode Support

**CSS Custom Properties:**

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f3f4f6;
  --text-primary: #111827;
  --text-secondary: #6b7280;
  --border-color: #e5e7eb;
  --accent: #3b82f6;
}

[data-theme="dark"] {
  --bg-primary: #1f2937;
  --bg-secondary: #111827;
  --text-primary: #f9fafb;
  --text-secondary: #9ca3af;
  --border-color: #374151;
  --accent: #60a5fa;
}

body {
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

.note-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}
```

**LiveView Toggle:**

```elixir
def handle_event("toggle_theme", _params, socket) do
  new_theme = if socket.assigns.theme == :light, do: :dark, else: :light

  {:noreply,
   socket
   |> assign(:theme, new_theme)
   |> push_event("set_theme", %{theme: new_theme})}
end
```

```javascript
Hooks.ThemeManager = {
  mounted() {
    this.handleEvent('set_theme', ({theme}) => {
      document.documentElement.setAttribute('data-theme', theme);
      chrome.storage.local.set({ theme });
    });

    // Load saved theme
    chrome.storage.local.get('theme', (data) => {
      if (data.theme) {
        document.documentElement.setAttribute('data-theme', data.theme);
      }
    });
  }
};
```

---

### Task 8: Onboarding Tutorial (LiveView Modal)

```elixir
def mount(_params, session, socket) do
  # Check if user has seen onboarding
  show_onboarding = not seen_onboarding?(session["user_id"])

  {:ok,
   socket
   |> assign(:show_onboarding, show_onboarding)
   # ... rest of mount
  }
end
```

```heex
<%= if @show_onboarding do %>
  <div class="modal-overlay" phx-click="dismiss_onboarding">
    <div class="modal-content" phx-click-away="dismiss_onboarding">
      <h2>Welcome to Voice Video Companion!</h2>

      <div class="tutorial-steps">
        <div class="step">
          <span class="step-icon">🎤</span>
          <h3>1. Record Feedback</h3>
          <p>Navigate to a video and click the mic button (Cmd+K)</p>
        </div>

        <div class="step">
          <span class="step-icon">💬</span>
          <h3>2. Speak Naturally</h3>
          <p>Say things like "The pacing is too slow here"</p>
        </div>

        <div class="step">
          <span class="step-icon">✨</span>
          <h3>3. Review & Post</h3>
          <p>Notes appear as ghost comments. Confirm to post automatically.</p>
        </div>
      </div>

      <button phx-click="dismiss_onboarding" class="btn-primary">
        Got it!
      </button>
    </div>
  </div>
<% end %>
```

---

## Testing Checklist

### LiveView Tests

- [ ] Connection state indicator updates correctly
- [ ] Offline mode queues actions, replays on reconnect
- [ ] Stream updates render without flicker
- [ ] Error flash messages display and auto-dismiss
- [ ] Keyboard shortcuts work (Cmd+K, Escape, etc.)
- [ ] Dark mode persists across sessions
- [ ] Infinite scroll loads more notes

### Animation Tests

- [ ] Ghost comments fade in smoothly
- [ ] Confidence bar animates on mount
- [ ] Recording pulse effect visible
- [ ] Toast notifications slide in from right
- [ ] Stream inserts animate correctly

### Accessibility Tests

- [ ] Screen reader announces new notes
- [ ] All interactive elements keyboard accessible
- [ ] Focus management works (auto-focus on new notes)
- [ ] Color contrast meets WCAG AA standards
- [ ] ARIA labels present on all controls

### Performance Tests

- [ ] 100+ notes render without lag
- [ ] Stream updates don't cause full re-render
- [ ] Infinite scroll loads smoothly
- [ ] Memory usage stable over time
- [ ] No memory leaks in JS hooks

---

## Reference Documentation

- **03_LIVEVIEW_PATTERNS.md** - Offline handling, connection state, stream patterns
- **Phoenix LiveView Docs** - https://hexdocs.pm/phoenix_live_view
- **Stream Documentation** - https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html#stream/4

---

## Post-MVP

After this sprint, you'll have a production-ready MVP. Future enhancements:
- **Phase 6**: WASM Whisper (local transcription)
- **Phase 7**: CLIP emoji tokens (visual context with local inference)
- Multi-note merging
- Platform-specific optimizations
- Collaborative review sessions (multi-user PubSub)
