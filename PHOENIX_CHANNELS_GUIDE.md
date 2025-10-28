# Phoenix Channels Guide

**Using `lossy` codebase as a real-world example**

## Table of Contents
1. [What Are Phoenix Channels?](#what-are-phoenix-channels)
2. [Architecture in This Codebase](#architecture-in-this-codebase)
3. [Channel Implementations Review](#channel-implementations-review)
4. [Areas for Improvement](#areas-for-improvement)
5. [Best Practices & Recommendations](#best-practices--recommendations)

---

## What Are Phoenix Channels?

Phoenix Channels provide a way to do **bidirectional, real-time communication** between clients and your Phoenix server over WebSockets (with fallback to long-polling).

### Core Concepts

**1. Socket** (`lib/lossy_web/user_socket.ex:1`)
- The transport layer that manages the WebSocket connection
- Routes incoming connections to appropriate channels
- Handles authentication and connection lifecycle

**2. Channel** (e.g., `lib/lossy_web/channels/video_channel.ex:1`)
- A process that manages communication for a specific topic
- Receives messages from clients via `handle_in/3`
- Sends messages to clients via `push/3`
- Subscribes to PubSub topics for broadcasts

**3. Topic**
- A string identifier that clients subscribe to (e.g., `"video:meta"`, `"audio:session123"`)
- Can use wildcards in socket routing: `channel "audio:*", AudioChannel`

**4. PubSub**
- Phoenix's internal pub/sub system
- Allows broadcasting messages to all subscribers of a topic
- Decouples message producers from consumers

---

## Architecture in This Codebase

### Three Channels, Three Responsibilities

```
┌─────────────────┐
│  UserSocket     │  Routes connections to channels
│  /socket        │
└────────┬────────┘
         │
    ┌────┴────────────────────┐
    │                         │
┌───▼────────┐    ┌──────────▼──┐    ┌──────────────┐
│VideoChannel│    │ AudioChannel│    │ NotesChannel │
│ video:meta │    │  audio:*    │    │  notes:*     │
└────────────┘    └─────────────┘    └──────────────┘
```

### 1. **VideoChannel** (`lib/lossy_web/channels/video_channel.ex`)

**Topic:** `video:meta` (singleton topic - all clients join the same channel)

**Purpose:** Video metadata and note management

**Client → Server (handle_in):**
- `video_detected` - Create/find video in database
- `get_notes` - Fetch existing notes for a video
- `delete_note` - Remove a note
- `enrich_note` - Add visual context (embedding) to a note
- `refine_note_with_vision` - Use GPT-4o Vision to improve note text
- `list_videos` - Query video library with filters
- `update_video_status` - Change video status (queued/active/archived)
- `queue_video` - Add video to user's queue

**Server → Client (push/broadcast):**
- Broadcasts `video_updated` and `video_queued` via PubSub to `user:#{user_id}` topics

**Example from codebase:**
```elixir
# lib/lossy_web/channels/video_channel.ex:25-48
def handle_in("video_detected", %{"platform" => platform, "videoId" => video_id} = payload, socket) do
  Logger.info("[VideoChannel] Video detected: #{platform}/#{video_id}")

  url = Map.get(payload, "url")
  title = Map.get(payload, "title")

  case Videos.find_or_create_video(%{
    platform: platform,
    external_id: video_id,
    url: url,
    title: title
  }) do
    {:ok, video} ->
      {:reply, {:ok, %{video_id: video.id}}, socket}
    {:error, changeset} ->
      {:reply, {:error, %{message: "Failed to create video"}}, socket}
  end
end
```

### 2. **AudioChannel** (`lib/lossy_web/channels/audio_channel.ex`)

**Topic:** `audio:#{session_id}` (dynamic - each session gets its own channel)

**Purpose:** Real-time audio transcription and visual embeddings

**Client → Server (handle_in):**
- `transcript_partial` - Streaming partial transcripts
- `transcript_final` - Complete transcript from client-side Whisper
- `frame_embedding` - Visual context from SigLIP model
- `set_timestamp` - Update video playback position
- `update_video_context` - Switch video context (tab switching)
- `ping` - Keep-alive

**Server → Client (push via PubSub):**
- `note_created` - When AgentSession creates a new note
- `agent_event` - Various agent lifecycle events

**Key Design Pattern:**
```elixir
# lib/lossy_web/channels/audio_channel.ex:8-36
def join("audio:" <> session_id, payload, socket) do
  video_id = Map.get(payload, "video_id")
  timestamp = Map.get(payload, "timestamp")

  # Subscribe to this session's PubSub topic
  Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")

  # Start a GenServer for this session
  case SessionSupervisor.start_session(session_id,
    video_id: video_id,
    timestamp: timestamp
  ) do
    {:ok, _pid} ->
      Logger.info("Started new AgentSession: #{session_id}")
    {:error, {:already_started, _pid}} ->
      Logger.info("AgentSession already running: #{session_id}")
  end

  {:ok, assign(socket, :session_id, session_id)}
end
```

This demonstrates the **GenServer + Channel** pattern:
- Channel manages WebSocket communication
- GenServer (`AgentSession`) handles business logic
- PubSub bridges them for async communication

### 3. **NotesChannel** (`lib/lossy_web/channels/notes_channel.ex`)

**Topics:**
- `notes:video:#{video_id}` - Notes for specific video
- `notes:user:#{user_id}` - All notes for user (future)

**Purpose:** Real-time note subscriptions (sidepanel UI)

**Client → Server (handle_in):**
- `get_notes` - Fetch existing notes for initial load

**Server → Client (push):**
- `note_created` - Broadcast new notes from AgentSession

**Why a separate channel?**
The moduledoc explains this well:
```elixir
# lib/lossy_web/channels/notes_channel.ex:19-27
## Architecture
Previous: Phoenix → AudioChannel (SW) → MessageRouter → Sidepanel
Current:  Phoenix → NotesChannel → Sidepanel (direct)

Benefits:
- Service worker focuses on audio streaming only
- Sidepanel owns its data subscription
- ~200 lines removed from service worker
- Direct real-time updates via PubSub
```

### Client-Side Usage (JavaScript)

**Connecting and joining:**
```javascript
// extension/src/sidepanel/sidepanel.js:1605-1607
notesSocket = new Socket('ws://localhost:4000/socket', {
  params: {}, // TODO: Add auth token when auth is implemented
});

notesSocket.connect();

// Subscribe to a specific video's notes
notesChannel = notesSocket.channel(`notes:video:${videoDbId}`, {});

// Listen for real-time events
notesChannel.on('note_created', (note) => {
  console.log('Received real-time note:', note);
  // Update UI
});

// Join the channel
notesChannel
  .join()
  .receive('ok', () => {
    console.log('Joined channel');
    // Load initial data
    notesChannel.push('get_notes', { video_id: videoDbId })
      .receive('ok', ({ notes }) => {
        console.log(`Loaded ${notes.length} notes`);
      });
  })
  .receive('error', (err) => console.error('Join failed', err));
```

---

## Channel Implementations Review

### ✅ What's Done Well

**1. Clear Separation of Concerns**
- VideoChannel = CRUD operations
- AudioChannel = Real-time streaming
- NotesChannel = Subscribe-only (read-oriented)

**2. Proper Use of PubSub**
```elixir
# lib/lossy_web/channels/video_channel.ex:188-193
Phoenix.PubSub.broadcast(
  Lossy.PubSub,
  "user:#{video.user_id}",
  {:video_updated, serialize_video(video)}
)
```

**3. Good Documentation**
All channels have clear moduledocs explaining purpose and usage

**4. Serialization Helpers**
```elixir
# lib/lossy_web/channels/video_channel.ex:243-257
defp serialize_video(video) do
  %{
    id: video.id,
    platform: video.platform,
    # ... only expose needed fields
  }
end
```

**5. Pattern Matching in join/3**
```elixir
# lib/lossy_web/channels/audio_channel.ex:8
def join("audio:" <> session_id, payload, socket) do
  # Extract session_id from topic
end
```

---

## Areas for Improvement

### 🔴 Critical Issues

#### 1. **No Authentication** (`lib/lossy_web/user_socket.ex:10-14`)

```elixir
def connect(_params, socket, _connect_info) do
  # For now: accept all connections (no auth)
  # Later (Sprint 05): verify token from params["token"]
  {:ok, socket}
end
```

**Problem:** Anyone can connect and access all data

**Fix:**
```elixir
def connect(%{"token" => token}, socket, _connect_info) do
  case verify_token(token) do
    {:ok, user_id} ->
      {:ok, assign(socket, :user_id, user_id)}
    {:error, _reason} ->
      :error
  end
end

def connect(_params, _socket, _connect_info), do: :error
```

#### 2. **Missing Authorization in Channels**

```elixir
# lib/lossy_web/channels/video_channel.ex:162-178
def handle_in("list_videos", %{"filters" => filters}, socket) do
  # TODO: Get user_id from socket.assigns once authentication is implemented
  user_id = Map.get(socket.assigns, :user_id)
  # ...
end
```

**Problem:**
- `user_id` can be nil, exposing all videos
- No validation that user owns the video they're querying

**Fix:**
```elixir
def handle_in("list_videos", %{"filters" => filters}, socket) do
  case socket.assigns[:user_id] do
    nil ->
      {:reply, {:error, %{reason: "unauthorized"}}, socket}

    user_id ->
      videos = Videos.list_user_videos(user_id, filters)
      {:reply, {:ok, %{videos: serialize_videos(videos)}}, socket}
  end
end
```

#### 3. **Socket ID Returns nil** (`lib/lossy_web/user_socket.ex:16-18`)

```elixir
def id(_socket), do: nil
```

**Problem:** This breaks channel process reattachment after disconnects

**Why it matters:**
When `id/1` returns nil, Phoenix creates a new channel process on every reconnect, losing state. If it returns a unique ID (like `"user:#{user_id}"`), Phoenix can reattach to existing channel processes.

**Fix:**
```elixir
def id(socket) do
  case socket.assigns[:user_id] do
    nil -> nil
    user_id -> "user:#{user_id}"
  end
end
```

### 🟡 Design Issues

#### 4. **Inconsistent Error Handling**

Compare these two:
```elixir
# Good: Returns structured error (video_channel.ex:46-47)
{:error, changeset} ->
  {:reply, {:error, %{message: "Failed to create video"}}, socket}

# Bad: Loses error details (video_channel.ex:70-71)
{:error, reason} ->
  Logger.error("[VideoChannel] Failed to delete note: #{inspect(reason)}")
  {:reply, {:error, %{message: "Failed to delete note"}}, socket}
```

**Recommendation:** Create a consistent error response helper:
```elixir
defp error_reply(message, details \\ nil) do
  case details do
    nil -> %{error: message}
    %Ecto.Changeset{} = changeset ->
      %{error: message, details: format_changeset_errors(changeset)}
    other ->
      %{error: message, details: inspect(other)}
  end
end
```

#### 5. **Broadcasting Without Verification**

```elixir
# lib/lossy_web/channels/video_channel.ex:186-193
# Broadcast to all connected clients for this user
if video.user_id do
  Phoenix.PubSub.broadcast(
    Lossy.PubSub,
    "user:#{video.user_id}",
    {:video_updated, serialize_video(video)}
  )
end
```

**Problem:** What if `video.user_id` doesn't match `socket.assigns.user_id`? User could update another user's video status.

**Fix:**
```elixir
def handle_in("update_video_status", %{"video_id" => video_id, "status" => status}, socket) do
  user_id = socket.assigns[:user_id]

  with {:ok, video} <- Videos.get_user_video(video_id, user_id),
       {:ok, updated_video} <- Videos.update_video_status(video_id, status) do

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "user:#{user_id}",
      {:video_updated, serialize_video(updated_video)}
    )

    {:reply, :ok, socket}
  else
    {:error, :not_found} ->
      {:reply, {:error, %{reason: "Video not found"}}, socket}
    {:error, reason} ->
      {:reply, {:error, %{reason: "Update failed"}}, socket}
  end
end
```

#### 6. **No Rate Limiting**

Channels are vulnerable to abuse. For expensive operations like `refine_note_with_vision` (GPT-4o API call), you should add rate limiting.

**Recommendation:** Use a library like `ex_rated` or implement token bucket:
```elixir
def handle_in("refine_note_with_vision", payload, socket) do
  user_id = socket.assigns[:user_id]

  case check_rate_limit(user_id, :vision_refinement) do
    :ok ->
      # Proceed with refinement

    {:error, :rate_limited} ->
      {:reply, {:error, %{reason: "Rate limit exceeded"}}, socket}
  end
end
```

### 🟢 Minor Improvements

#### 7. **Use `@impl` Consistently**

Good:
```elixir
# lib/lossy_web/channels/video_channel.ex:18
@impl true
def join("video:meta", _payload, socket) do
```

But some functions are missing it:
```elixir
# lib/lossy_web/channels/notes_channel.ex:76-86
def handle_info({:new_note, note}, socket) do  # Missing @impl true
```

**Fix:** Add `@impl true` to all callback implementations

#### 8. **Hardcoded Values**

```elixir
# lib/lossy_web/channels/video_channel.ex:174
limit: Map.get(filters, "limit", 100)
```

**Better:**
```elixir
@default_limit 100
@max_limit 1000

defp get_limit(filters) do
  filters
  |> Map.get("limit", @default_limit)
  |> min(@max_limit)  # Prevent abuse
end
```

#### 9. **Unused Variables**

```elixir
# lib/lossy_web/channels/video_channel.ex:122
_timestamp = Map.get(payload, "timestamp")
```

**Fix:** Either use it or remove the line entirely

#### 10. **Magic Strings for PubSub Topics**

```elixir
Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")
Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")
```

**Better:** Centralize topic naming:
```elixir
# lib/lossy/pubsub_topics.ex
defmodule Lossy.PubSubTopics do
  def session(session_id), do: "session:#{session_id}"
  def video(video_id), do: "video:#{video_id}"
  def user(user_id), do: "user:#{user_id}"
end

# Usage:
Phoenix.PubSub.subscribe(Lossy.PubSub, PubSubTopics.session(session_id))
```

#### 11. **Missing Telemetry/Metrics**

Phoenix Channels generate telemetry events, but you're not capturing them.

**Add to endpoint.ex:**
```elixir
# Attach telemetry handler
:telemetry.attach_many(
  "channel-metrics",
  [
    [:phoenix, :channel_joined],
    [:phoenix, :channel_handled_in],
  ],
  &MyApp.Telemetry.handle_event/4,
  nil
)
```

---

## Best Practices & Recommendations

### 1. **Channel Naming**

✅ **Do:**
- Use plural for resource channels: `NotesChannel`, `VideosChannel`
- Use descriptive suffixes: `AudioChannel` (not `AudioHandler`)

❌ **Don't:**
- Mix naming conventions: `VideoChannel` + `NoteHandler`

### 2. **Topic Patterns**

✅ **Do:**
```elixir
# Resource-specific
"notes:video:#{video_id}"

# User-specific
"presence:user:#{user_id}"

# Scoped wildcards
"room:*"  # Matches room:lobby, room:123
```

❌ **Don't:**
```elixir
# Too broad
"notifications"  # Everyone gets all notifications

# Non-hierarchical
"user_#{user_id}_notifications"  # Hard to pattern match
```

### 3. **Reply Patterns**

✅ **Do:**
```elixir
{:reply, {:ok, %{data: result}}, socket}
{:reply, {:error, %{reason: "not_found"}}, socket}
```

❌ **Don't:**
```elixir
{:reply, :ok, socket}  # Client can't distinguish success from error
{:noreply, socket}     # Client waits forever
```

### 4. **PubSub vs Push**

**Use `push/3`** when sending to ONE specific client:
```elixir
push(socket, "note_created", note_data)
```

**Use `broadcast/3`** when sending to ALL subscribers:
```elixir
Phoenix.PubSub.broadcast(Lossy.PubSub, "video:#{video_id}", {:note_created, note})
```

**Use `broadcast_from/3`** when sending to all EXCEPT the sender:
```elixir
Phoenix.PubSub.broadcast_from(Lossy.PubSub, self(), "video:#{video_id}", {:note_created, note})
```

### 5. **Handle Disconnects**

Your client code does this well:
```javascript
// extension/src/sidepanel/sidepanel.js:1609-1627
notesSocket.onOpen(() => {
  console.log('[Notes] ✅ Connected to Phoenix');

  // Re-subscribe to current video on reconnect
  if (displayedVideoDbId && !notesChannel) {
    console.log('[Notes] Re-subscribing after reconnect');
    subscribeToVideoNotes(displayedVideoDbId);
  }
});
```

**Server-side:** Ensure `id/1` returns a stable identifier for process reattachment

### 6. **Testing Channels**

Phoenix provides `ChannelCase` for testing:
```elixir
defmodule LossyWeb.VideoChannelTest do
  use LossyWeb.ChannelCase

  test "video_detected creates video record" do
    {:ok, _, socket} =
      socket(LossyWeb.UserSocket, "user_id", %{user_id: 123})
      |> subscribe_and_join(LossyWeb.VideoChannel, "video:meta")

    ref = push(socket, "video_detected", %{
      "platform" => "youtube",
      "videoId" => "abc123"
    })

    assert_reply ref, :ok, %{video_id: _video_id}
  end

  test "broadcasts on video update" do
    # Setup
    {:ok, _, socket} = subscribe_and_join(...)

    # Subscribe to PubSub topic
    Phoenix.PubSub.subscribe(Lossy.PubSub, "user:123")

    # Trigger update
    push(socket, "update_video_status", %{...})

    # Assert broadcast
    assert_broadcast "video_updated", %{id: _id}
  end
end
```

---

## Summary

### Your codebase demonstrates:
- ✅ Good separation of concerns (3 focused channels)
- ✅ Proper PubSub usage for broadcasting
- ✅ Clear documentation
- ✅ GenServer + Channel pattern for complex logic

### Priority improvements:
1. **Security:** Add authentication/authorization (critical before production)
2. **Reliability:** Implement socket `id/1` for process reattachment
3. **Safety:** Add rate limiting on expensive operations
4. **Consistency:** Standardize error responses
5. **Maintainability:** Centralize PubSub topic naming

### Recommended reading:
- [Phoenix Channels Guide](https://hexdocs.pm/phoenix/channels.html)
- [Phoenix PubSub](https://hexdocs.pm/phoenix_pubsub/Phoenix.PubSub.html)
- [Real-Time Phoenix (Book)](https://pragprog.com/titles/sbsockets/real-time-phoenix/)

---

**Questions?** Let me know which area you'd like me to expand on or demonstrate with code examples!
