# Phoenix LiveView in Browser Extensions

**Last Updated:** 2025-10-14

---

## Overview

This document provides patterns and best practices for using Phoenix LiveView in browser extensions (MV3). **Key insight:** LiveView DOES work in extensions with proper setup!

---

## Why LiveView for Extensions?

### ✅ Perfect Use Cases

1. **Side Panel** - Persistent UI, streaming note list
2. **Popup** - Agent status, quick controls
3. **Options Page** - Settings, account management

### ❌ Where NOT to Use LiveView

- **Content Scripts** - Use Shadow DOM + vanilla JS (injected into arbitrary pages)
- **Service Worker** - No DOM access

---

## The Pattern

```
Extension Page (Local HTML)
    ↓
Bundles phoenix.js locally (webpack)
    ↓
Connects to Phoenix LiveView via WebSocket
    ↓
LiveView manages state + streaming updates
    ↓
Browser renders updates (zero flicker with stream_insert/3)
```

**Key:** Local HTML loads → JS connects → LiveView takes over state management

---

## Setup Requirements

### 1. Extension manifest.json

```json
{
  "manifest_version": 3,

  "permissions": ["storage"],

  "host_permissions": [
    "https://your-phoenix-app.com/*",
    "wss://your-phoenix-app.com/*"
  ],

  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' https://your-phoenix-app.com wss://your-phoenix-app.com"
  },

  "side_panel": {
    "default_path": "sidepanel.html"
  }
}
```

**Critical CSP settings:**
- ✅ `script-src 'self'` - Only local scripts
- ✅ `connect-src` includes your Phoenix WebSocket URL
- ❌ NO `'unsafe-eval'` - Not needed for LiveView!

### 2. Phoenix Endpoint Configuration

```elixir
# config/config.exs
config :your_app, YourAppWeb.Endpoint,
  check_origin: [
    "https://your-phoenix-app.com",
    "chrome-extension://YOUR_EXTENSION_ID",  # Get from chrome://extensions
    "moz-extension://YOUR_EXTENSION_ID"      # For Firefox
  ]

# lib/your_app_web/endpoint.ex
socket "/live", Phoenix.LiveView.Socket,
  websocket: [
    connect_info: [:peer_data, :x_headers, :uri]
  ]
```

**Getting Extension ID:**
1. Load extension in Chrome (Developer mode)
2. Go to `chrome://extensions`
3. Copy the ID (e.g., `abcdefghijklmnopqrstuvwxyz123456`)
4. Add to `check_origin` list

**For development:** Use wildcard pattern
```elixir
check_origin: ["chrome-extension://*"]
```

### 3. Authentication via Token (NOT Cookies)

**Why not cookies?**
- Extensions have origin `chrome-extension://ID`
- Cross-origin cookies blocked by most browsers
- Third-party cookie restrictions

**Use Phoenix.Token instead:**

```elixir
# On login (REST endpoint)
def login(conn, %{"email" => email, "password" => password}) do
  case authenticate(email, password) do
    {:ok, user} ->
      token = Phoenix.Token.sign(
        YourAppWeb.Endpoint,
        "user socket",
        user.id,
        max_age: 30 * 24 * 60 * 60  # 30 days
      )

      json(conn, %{token: token, user: user})
  end
end

# On LiveView mount
def mount(_params, session, socket) do
  case verify_token(session["auth_token"]) do
    {:ok, user_id} ->
      {:ok, assign(socket, :user_id, user_id)}
    {:error, _} ->
      {:ok, redirect(socket, to: "/login")}
  end
end

defp verify_token(token) do
  Phoenix.Token.verify(
    YourAppWeb.Endpoint,
    "user socket",
    token,
    max_age: 30 * 24 * 60 * 60
  )
end
```

**Extension storage:**
```javascript
// Store token
await chrome.storage.local.set({ authToken: token });

// Load for LiveSocket
const {authToken} = await chrome.storage.local.get('authToken');
```

---

## Complete Side Panel Implementation

### Extension: sidepanel.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="script-src 'self'; connect-src 'self' wss://your-phoenix-app.com">
  <title>Voice Notes</title>
</head>
<body>
  <!-- LiveView mounts here -->
  <div id="live-root" data-phx-main="true"></div>

  <!-- Bundled locally via webpack -->
  <script src="sidepanel.js"></script>
</body>
</html>
```

### Extension: sidepanel.js

```javascript
import {Socket} from "phoenix";
import {LiveSocket} from "phoenix_live_view";

async function initSidePanel() {
  // Get stored auth token
  const storage = await chrome.storage.local.get(['authToken', 'sessionId']);

  if (!storage.authToken) {
    showLoginPrompt();
    return;
  }

  // Get current video context
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractVideoId(tab?.url);

  // Define JS hooks (for client-side actions)
  const Hooks = {
    NoteCard: {
      mounted() {
        // Seek video when clicking note timestamp
        this.handleEvent("seek_video", ({timestamp}) => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'seek_to',
            timestamp: timestamp
          });
        });
      }
    },

    MicControl: {
      mounted() {
        // Mic button communicates with service worker
        this.el.addEventListener('click', () => {
          chrome.runtime.sendMessage({ cmd: 'toggle_mic' }, (response) => {
            console.log('Mic toggled:', response);
          });
        });
      }
    }
  };

  // Connect to LiveView
  const liveSocket = new LiveSocket("wss://your-phoenix-app.com/live", Socket, {
    params: () => ({
      auth_token: storage.authToken,
      session_id: storage.sessionId || generateSessionId(),
      video_id: videoId  // Current video context
    }),
    hooks: Hooks
  });

  liveSocket.connect();
  window.liveSocket = liveSocket;  // For debugging

  // Listen for tab changes
  chrome.tabs.onActivated.addListener(handleTabChange);
  chrome.tabs.onUpdated.addListener(handleTabUpdate);
}

async function handleTabChange(activeInfo) {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  const videoId = extractVideoId(tab.url);

  if (window.liveSocket) {
    // Push video context change to LiveView
    window.liveSocket.pushEvent("video_changed", { video_id: videoId });
  }
}

function handleTabUpdate(tabId, changeInfo, tab) {
  if (changeInfo.url) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) {
        const videoId = extractVideoId(changeInfo.url);
        window.liveSocket?.pushEvent("video_changed", { video_id: videoId });
      }
    });
  }
}

function extractVideoId(url) {
  if (!url) return null;

  // YouTube
  const ytMatch = url.match(/[?&]v=([^&]+)/);
  if (ytMatch) return ytMatch[1];

  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return vimeoMatch[1];

  // Air
  const airMatch = url.match(/air\.inc\/.*\/([^\/]+)$/);
  if (airMatch) return airMatch[1];

  return null;
}

function generateSessionId() {
  const sessionId = crypto.randomUUID();
  chrome.storage.local.set({ sessionId });
  return sessionId;
}

function showLoginPrompt() {
  document.getElementById('live-root').innerHTML = `
    <div style="padding: 20px; text-align: center;">
      <h2>Please log in</h2>
      <button onclick="chrome.runtime.openOptionsPage()">
        Open Login
      </button>
    </div>
  `;
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidePanel);
} else {
  initSidePanel();
}
```

### Phoenix: SidePanelLive

```elixir
defmodule YourAppWeb.SidePanelLive do
  use YourAppWeb, :live_view
  require Logger

  @impl true
  def mount(_params, session, socket) do
    case authenticate(session) do
      {:ok, user_id, session_id, video_id} ->
        # Subscribe to real-time events
        Phoenix.PubSub.subscribe(YourApp.PubSub, "session:#{session_id}")

        if video_id do
          Phoenix.PubSub.subscribe(YourApp.PubSub, "video:#{video_id}")
        end

        # Load notes for current video
        notes = if video_id do
          YourApp.Videos.list_notes(video_id)
        else
          YourApp.Videos.list_recent_notes(user_id, limit: 50)
        end

        {:ok,
         socket
         |> assign(:user_id, user_id)
         |> assign(:session_id, session_id)
         |> assign(:current_video_id, video_id)
         |> assign(:filter, :all)
         |> assign(:recording, false)
         |> stream(:notes, notes)}

      {:error, reason} ->
        {:ok, assign(socket, :error, reason)}
    end
  end

  # Real-time: New note created
  @impl true
  def handle_info({:new_note, note}, socket) do
    {:noreply, stream_insert(socket, :notes, note, at: 0)}
  end

  # Real-time: Note updated (posted, status change)
  @impl true
  def handle_info({:note_updated, note}, socket) do
    {:noreply, stream_insert(socket, :notes, note)}
  end

  # Real-time: Agent event (transcript, ghost comment, etc.)
  @impl true
  def handle_info({:agent_event, event}, socket) do
    # Could stream events to a timeline
    {:noreply, socket}
  end

  # User changes video (tab switch)
  @impl true
  def handle_event("video_changed", %{"video_id" => new_video_id}, socket) do
    old_video_id = socket.assigns.current_video_id

    # Unsubscribe from old
    if old_video_id do
      Phoenix.PubSub.unsubscribe(YourApp.PubSub, "video:#{old_video_id}")
    end

    # Subscribe to new
    if new_video_id do
      Phoenix.PubSub.subscribe(YourApp.PubSub, "video:#{new_video_id}")
    end

    # Reload notes
    notes = if new_video_id do
      YourApp.Videos.list_notes(new_video_id)
    else
      []
    end

    {:noreply,
     socket
     |> assign(:current_video_id, new_video_id)
     |> stream(:notes, notes, reset: true)}
  end

  # User clicks filter
  @impl true
  def handle_event("filter_notes", %{"filter" => filter}, socket) do
    notes = case filter do
      "current" ->
        YourApp.Videos.list_notes(socket.assigns.current_video_id)
      "ghost" ->
        YourApp.Videos.list_ghost_notes(socket.assigns.user_id)
      "firmed" ->
        YourApp.Videos.list_firmed_notes(socket.assigns.user_id)
      "all" ->
        YourApp.Videos.list_recent_notes(socket.assigns.user_id)
    end

    {:noreply,
     socket
     |> assign(:filter, String.to_existing_atom(filter))
     |> stream(:notes, notes, reset: true)}
  end

  # User clicks note to seek video
  @impl true
  def handle_event("seek_to_note", %{"note_id" => note_id}, socket) do
    note = YourApp.Videos.get_note!(note_id)

    # Push to JS hook (which will message content script)
    {:noreply, push_event(socket, "seek_video", %{timestamp: note.timestamp_seconds})}
  end

  # Mic toggle (actual work in service worker, just update UI)
  @impl true
  def handle_event("toggle_mic", _params, socket) do
    {:noreply, update(socket, :recording, &(!&1))}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="side-panel">
      <header class="panel-header">
        <h1>📹 Video Notes</h1>

        <button
          phx-click="toggle_mic"
          phx-hook="MicControl"
          id="mic-control"
          class={["btn-mic", @recording && "recording"]}
        >
          <%= if @recording, do: "⏹️ Stop", else: "🎤 Record" %>
        </button>
      </header>

      <nav class="filter-tabs">
        <button
          phx-click="filter_notes"
          phx-value-filter="all"
          class={["tab", @filter == :all && "active"]}
        >
          All
        </button>
        <button
          phx-click="filter_notes"
          phx-value-filter="current"
          class={["tab", @filter == :current && "active"]}
        >
          Current Video
        </button>
        <button
          phx-click="filter_notes"
          phx-value-filter="ghost"
          class={["tab", @filter == :ghost && "active"]}
        >
          Ghost
        </button>
        <button
          phx-click="filter_notes"
          phx-value-filter="firmed"
          class={["tab", @filter == :firmed && "active"]}
        >
          Firmed
        </button>
      </nav>

      <main class="notes-list">
        <div id="notes-stream" phx-update="stream">
          <div
            :for={{dom_id, note} <- @streams.notes}
            id={dom_id}
            class={["note-card", "status-#{note.status}"]}
            phx-hook="NoteCard"
          >
            <.note_card note={note} />
          </div>
        </div>

        <div :if={Enum.empty?(@streams.notes)} class="empty-state">
          <p>No notes yet</p>
          <p class="hint">Navigate to a video and click Record</p>
        </div>
      </main>
    </div>
    """
  end

  # Components

  defp note_card(assigns) do
    ~H"""
    <div class="note-header">
      <span class="note-time"><%= format_timestamp(@note.timestamp_seconds) %></span>
      <span class={"note-status #{@note.status}"}><%= @note.status %></span>
    </div>

    <p class="note-text"><%= @note.text %></p>

    <div class="note-meta">
      <span class="category"><%= @note.category %></span>
      <span :if={@note.confidence} class="confidence">
        <%= round(@note.confidence * 100) %>%
      </span>
    </div>

    <div class="note-actions">
      <button
        phx-click="seek_to_note"
        phx-value-note-id={@note.id}
        class="btn-icon"
        title="Jump to timestamp"
      >
        ▶️
      </button>
    </div>
    """
  end

  # Helpers

  defp authenticate(session) do
    with {:ok, token} <- Map.fetch(session, "auth_token"),
         {:ok, session_id} <- Map.fetch(session, "session_id"),
         {:ok, user_id} <- verify_token(token) do
      video_id = Map.get(session, "video_id")
      {:ok, user_id, session_id, video_id}
    else
      _ -> {:error, "Invalid credentials"}
    end
  end

  defp verify_token(token) do
    Phoenix.Token.verify(
      YourAppWeb.Endpoint,
      "user socket",
      token,
      max_age: 30 * 24 * 60 * 60
    )
  end

  defp format_timestamp(seconds) do
    minutes = div(trunc(seconds), 60)
    secs = rem(trunc(seconds), 60)
    "#{String.pad_leading(to_string(minutes), 2, "0")}:#{String.pad_leading(to_string(secs), 2, "0")}"
  end
end
```

---

## Streaming Updates with stream_insert/3

**Why streams?** Zero-flicker updates, efficient DOM patching.

```elixir
# Initial mount - load many notes
notes = Videos.list_notes(video_id)
stream(socket, :notes, notes)

# Later - add one new note at top
def handle_info({:new_note, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note, at: 0)}
end

# Update existing note (e.g., status change)
def handle_info({:note_updated, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note)}
end

# Reset entire stream (e.g., filter change)
def handle_event("filter_notes", %{"filter" => filter}, socket) do
  new_notes = Videos.filter_notes(filter)
  {:noreply, stream(socket, :notes, new_notes, reset: true)}
end
```

**Template:**
```heex
<div id="notes-stream" phx-update="stream">
  <div :for={{dom_id, note} <- @streams.notes} id={dom_id}>
    <.note_card note={note} />
  </div>
</div>
```

**Key:** `phx-update="stream"` tells LiveView to use efficient diffing.

---

## Common Patterns

### Pattern 1: Context-Aware Side Panel

Side panel updates based on current video:

```javascript
// Extension: detect video change
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  const videoId = extractVideoId(tab.url);

  window.liveSocket.pushEvent("video_changed", { video_id: videoId });
});
```

```elixir
# Phoenix: reload notes for new video
def handle_event("video_changed", %{"video_id" => new_id}, socket) do
  notes = Videos.list_notes(new_id)
  {:noreply, stream(socket, :notes, notes, reset: true)}
end
```

### Pattern 2: Bidirectional Actions

Click note in side panel → seek video on page:

```elixir
# Phoenix: push event to JS hook
def handle_event("seek_to_note", %{"note_id" => note_id}, socket) do
  note = Videos.get_note!(note_id)
  {:noreply, push_event(socket, "seek_video", %{timestamp: note.timestamp_seconds})}
end
```

```javascript
// Extension: JS hook receives event
const Hooks = {
  NoteCard: {
    mounted() {
      this.handleEvent("seek_video", async ({timestamp}) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // Message content script
        chrome.tabs.sendMessage(tab.id, {
          action: 'seek_to',
          timestamp: timestamp
        });
      });
    }
  }
};
```

```javascript
// Content script: seek video
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'seek_to') {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = msg.timestamp;
      video.play();
    }
  }
});
```

### Pattern 3: Service Worker Coordination

Mic button in LiveView → triggers service worker:

```elixir
# LiveView: just update UI state
def handle_event("toggle_mic", _params, socket) do
  {:noreply, update(socket, :recording, &(!&1))}
end
```

```javascript
// Extension: JS hook does actual work
const Hooks = {
  MicControl: {
    mounted() {
      this.el.addEventListener('click', () => {
        chrome.runtime.sendMessage({ cmd: 'toggle_mic' });
      });
    }
  }
};
```

---

## Offline Handling & Reconnection

### Pattern 4: Connection State Management

LiveView can disconnect due to network issues, extension updates, or user closing side panel. Handle gracefully:

**Phoenix: Track connection state**
```elixir
defmodule YourAppWeb.SidePanelLive do
  # ... existing code ...

  @impl true
  def mount(_params, session, socket) do
    # Subscribe to presence for connection tracking
    if connected?(socket) do
      Phoenix.PubSub.subscribe(YourApp.PubSub, "session:#{session_id}")

      {:ok,
       socket
       |> assign(:connected, true)
       |> assign(:connection_state, :online)
       |> stream(:notes, notes)}
    else
      # Initial render (disconnected)
      {:ok,
       socket
       |> assign(:connected, false)
       |> assign(:connection_state, :connecting)
       |> stream(:notes, [])}
    end
  end

  # Handle LiveView disconnect
  @impl true
  def terminate(reason, socket) do
    Logger.info("LiveView terminating: #{inspect(reason)}")
    # Cleanup subscriptions (automatic, but good to be explicit)
    :ok
  end
end
```

**Extension: Detect and handle disconnection**
```javascript
// src/sidepanel/sidepanel.js
const liveSocket = new LiveSocket("wss://your-phoenix-app.com/live", Socket, {
  params: () => ({
    auth_token: authToken,
    session_id: sessionId,
    video_id: videoId
  }),
  hooks: Hooks,

  // Reconnection configuration
  reconnectAfterMs: (tries) => {
    // Exponential backoff: 100ms, 500ms, 2.5s, 12.5s, max 30s
    return Math.min(100 * Math.pow(5, tries), 30000);
  },

  // Show connection status to user
  onOpen: () => {
    console.log('LiveView connected');
    updateConnectionStatus('online');
  },

  onClose: () => {
    console.log('LiveView disconnected');
    updateConnectionStatus('offline');
  },

  onError: (error) => {
    console.error('LiveView error:', error);
    updateConnectionStatus('error');
  }
});

function updateConnectionStatus(status) {
  const indicator = document.getElementById('connection-indicator');
  if (indicator) {
    indicator.className = `connection-status ${status}`;
    indicator.textContent = {
      'online': '🟢 Connected',
      'offline': '🔴 Offline',
      'error': '🟡 Connection error'
    }[status];
  }
}

liveSocket.connect();
```

**Template: Show connection status**
```heex
<div class="side-panel">
  <header class="panel-header">
    <h1>📹 Video Notes</h1>

    <!-- Connection indicator -->
    <div
      id="connection-indicator"
      class={"connection-status #{@connection_state}"}
    >
      <%= case @connection_state do %>
        <% :online -> %>🟢 Connected
        <% :offline -> %>🔴 Offline
        <% :connecting -> %>🟡 Connecting...
        <% :error -> %>🟡 Connection error
      <% end %>
    </div>
  </header>

  <!-- Show offline banner -->
  <div :if={@connection_state != :online} class="offline-banner">
    <p>You're offline. Changes will sync when reconnected.</p>
    <button phx-click="retry_connection">Retry Now</button>
  </div>

  <!-- ... rest of content ... -->
</div>
```

### Pattern 5: Side Panel Lifecycle

User can close side panel while recording is active. Handle state persistence:

**Extension: Persist session state**
```javascript
// src/background/service-worker.js
let activeSession = {
  sessionId: null,
  recording: false,
  audioBufferSize: 0,
  startedAt: null
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'toggle_mic') {
    toggleMic().then((result) => {
      // Update session state
      activeSession.recording = result.recording;
      activeSession.startedAt = result.recording ? Date.now() : null;

      // Persist to storage (survives side panel close)
      chrome.storage.session.set({ activeSession });

      sendResponse(result);
    });
    return true;
  }
});

// Restore session when side panel reopens
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    chrome.storage.session.get('activeSession', (data) => {
      if (data.activeSession?.recording) {
        port.postMessage({
          type: 'session_restored',
          session: data.activeSession
        });
      }
    });
  }
});
```

**Extension: Reconnect in side panel**
```javascript
// src/sidepanel/sidepanel.js
async function initSidePanel() {
  // Check if there's an active recording session
  const {activeSession} = await chrome.storage.session.get('activeSession');

  if (activeSession?.recording) {
    console.log('Restoring active recording session:', activeSession);

    // Reconnect to LiveView with existing session
    const liveSocket = new LiveSocket("wss://...", Socket, {
      params: () => ({
        auth_token: authToken,
        session_id: activeSession.sessionId,
        reconnecting: true
      }),
      hooks: Hooks
    });

    liveSocket.connect();

    // Update UI to show recording state
    document.getElementById('mic-control').classList.add('recording');
  }
}
```

**Phoenix: Handle reconnection**
```elixir
def mount(_params, session, socket) do
  reconnecting = session["reconnecting"] == true

  if reconnecting do
    # Restore previous session state
    session_id = session["session_id"]

    case AgentSessionRegistry.lookup(session_id) do
      {:ok, pid} ->
        state = GenServer.call(pid, :get_state)

        {:ok,
         socket
         |> assign(:session_id, session_id)
         |> assign(:recording, state.status == :listening)
         |> assign(:connection_state, :online)
         |> put_flash(:info, "Session restored")
         |> stream(:notes, load_notes_for_session(session_id))}

      {:error, _} ->
        # Session expired, start fresh
        {:ok,
         socket
         |> assign(:recording, false)
         |> put_flash(:warning, "Previous session expired")
         |> stream(:notes, [])}
    end
  else
    # Normal mount
    # ... existing code ...
  end
end
```

### Pattern 6: Queue Actions During Offline

Buffer user actions when offline, replay on reconnect:

```javascript
// src/sidepanel/sidepanel.js
class OfflineQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  add(action, params) {
    this.queue.push({ action, params, timestamp: Date.now() });
    this.save();
  }

  async process(liveSocket) {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();

      try {
        await liveSocket.push(item.action, item.params);
        console.log(`Replayed action: ${item.action}`);
      } catch (error) {
        console.error(`Failed to replay action: ${item.action}`, error);
        // Re-queue if failed
        this.queue.unshift(item);
        break;
      }

      this.save();
    }

    this.processing = false;
  }

  save() {
    chrome.storage.session.set({ offlineQueue: this.queue });
  }

  async load() {
    const {offlineQueue} = await chrome.storage.session.get('offlineQueue');
    this.queue = offlineQueue || [];
  }
}

const offlineQueue = new OfflineQueue();
await offlineQueue.load();

// Use offline queue
liveSocket.onOpen(() => {
  offlineQueue.process(liveSocket);
});

// Intercept LiveView events when offline
Hooks.NoteActions = {
  mounted() {
    this.el.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      const noteId = e.target.dataset.noteId;

      if (!liveSocket.isConnected()) {
        // Queue for later
        offlineQueue.add('note_action', { action, note_id: noteId });
        showToast('Action queued - will sync when online');
        e.preventDefault();
      }
    });
  }
};
```

---

## Debugging Tips

### 1. LiveView Connection Issues

**Check WebSocket in DevTools:**
```
Network tab → WS → Look for connection to /live
```

**Common issues:**
- ❌ `check_origin` doesn't include extension ID
- ❌ CSP blocks WebSocket connection
- ❌ Token expired/invalid

**Debug in IEx:**
```elixir
Phoenix.Token.verify(YourAppWeb.Endpoint, "user socket", "YOUR_TOKEN", max_age: 86400)
```

### 2. Events Not Updating

**Check PubSub subscriptions:**
```elixir
def mount(...) do
  Logger.debug("Subscribing to session:#{session_id}")
  Phoenix.PubSub.subscribe(YourApp.PubSub, "session:#{session_id}")
  ...
end
```

**Verify broadcasts:**
```elixir
# In your GenServer/Worker
Phoenix.PubSub.broadcast(YourApp.PubSub, "session:#{sid}", {:new_note, note})
```

**Check handler:**
```elixir
def handle_info({:new_note, note}, socket) do
  Logger.debug("Received new note: #{inspect note}")
  {:noreply, stream_insert(socket, :notes, note, at: 0)}
end
```

### 3. Extension ID Changes

**In development**, extension ID changes every time you reload unpacked extension.

**Solutions:**
1. Use wildcard: `check_origin: ["chrome-extension://*"]`
2. Pin extension ID: Use `--load-extension` flag with stable path
3. Use Firefox: ID is stable based on manifest ID

---

## Production Checklist

- [ ] Use specific extension ID in `check_origin` (not wildcard)
- [ ] Set reasonable `max_age` for tokens (7-30 days)
- [ ] Implement token refresh before expiry
- [ ] Handle LiveView disconnect gracefully (show offline state)
- [ ] Rate limit WebSocket connections
- [ ] Monitor PubSub topic sizes
- [ ] Add Telemetry for LiveView metrics
- [ ] Test with slow/unstable network
- [ ] Test popup closing during operations
- [ ] Test side panel with multiple tabs open

---

## Summary

**LiveView works great in extensions!** Key points:

✅ **Side Panel** - Best use case, persistent UI
✅ **Popup** - Good for quick actions, ephemeral
✅ **Token auth** - Via `params`, not cookies
✅ **Bundled locally** - Webpack bundles phoenix.js
✅ **check_origin** - Must include extension ID
✅ **Streaming** - `stream_insert/3` for efficient updates
✅ **Context-aware** - Updates based on current video

For complete examples, see the implementation in `03_IMPLEMENTATION_PHASES.md`.
