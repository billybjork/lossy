# Design: Context as a Mailbox

**Status:** 📋 Conceptual Design
**Author:** Architecture Team
**Created:** 2025-10-23

---

## Purpose

Formalize the **mailbox metaphor** as the universal pattern for how the agent handles all incoming context—from tool call responses to client-provided data (transcripts, frames, audio) to system events. This design draws on Erlang/OTP mailbox patterns, queue theory, and flow control mechanisms to create a predictable, scalable context handling system.

**Key Insight:** The agent doesn't "pull" context arbitrarily—context **arrives** and **queues** like mail. The agent processes its mailbox on a schedule, with natural backpressure built in.

---

## The Mailbox Metaphor

### Core Concept

Every source of incoming context—whether a tool response, a transcript fragment, an image frame, or a system event—is a **message** deposited into the agent's **mailbox**. The agent:

1. **Receives** messages asynchronously (never blocking senders)
2. **Queues** messages in order of arrival (with optional priority)
3. **Processes** messages one at a time (or in configurable batches)
4. **Applies backpressure** when the queue grows too large (slowing or rejecting new messages)

This mirrors how humans handle email, mail, or notifications: items arrive asynchronously, accumulate in an inbox, and are processed when we attend to the mailbox.

### Why a Mailbox?

**Alternative patterns and their limitations:**

| Pattern | Problem |
|---------|---------|
| **Direct function calls** | Caller blocks waiting for response; no queuing |
| **Polling** | Wasteful (check when nothing is there); delayed (miss urgent items) |
| **Push without queue** | Lost messages during busy periods; no ordering guarantees |
| **Event bus with no mailbox** | No per-agent isolation; no backpressure |

**Mailbox advantages:**

- ✅ **Asynchronous by default** – Senders never block
- ✅ **Ordered processing** – FIFO or priority-based
- ✅ **Backpressure** – Queue depth provides natural flow control signal
- ✅ **Isolation** – Each agent has its own mailbox (no crosstalk)
- ✅ **Supervision-friendly** – Process can crash; mailbox survives (if durable)

---

## Erlang/OTP Mailbox Foundations

### GenServer as Mailbox

The **AgentSession GenServer** (`lib/lossy/agent/session.ex`) already implements a mailbox:

```elixir
# Cast (async, non-blocking)
GenServer.cast(session_pid, {:audio_chunk, data})
# → Message queued in process mailbox
# → Sender continues immediately
# → GenServer processes via handle_cast/2 when ready

# Call (sync, blocking caller)
GenServer.call(session_pid, {:set_timestamp, timestamp})
# → Message queued + caller blocks
# → GenServer processes via handle_call/3
# → Caller receives response

# Info (system messages)
send(session_pid, :checkpoint)
# → Message queued
# → GenServer processes via handle_info/2
```

**Message processing order:**
- Erlang VM guarantees **FIFO per sender**
- No global ordering across senders (intentional—avoids bottlenecks)
- Messages processed **one at a time** (sequential processing in process loop)

### Mailbox Properties

```elixir
# Mailbox depth (queue length)
Process.info(self(), :message_queue_len)
# → {message_queue_len, 42}

# Memory usage of mailbox
Process.info(self(), :messages)
# → {messages, [...list of pending messages...]}

# High watermark for backpressure
if Process.info(self(), :message_queue_len) > 100 do
  Logger.warn("Mailbox overload! Applying backpressure.")
  # Option 1: Reject new messages
  # Option 2: Drop oldest low-priority messages
  # Option 3: Notify sender to slow down
end
```

**Key OTP references:**
- [GenServer behavior](https://hexdocs.pm/elixir/GenServer.html)
- [Process mailboxes](https://www.erlang.org/doc/reference_manual/processes.html#process-mailboxes)
- [Selective receive](https://www.erlang.org/doc/efficiency_guide/processes.html#selective-receive)

---

## Universal Message Types

All incoming context fits into these categories:

### 1. Tool Call Responses

**Source:** Backend tools (transcription, LLM, posting automation)
**Delivery:** `handle_cast({:transcript_ready, text, opts}, state)`
**Characteristics:**
- High priority (blocks further processing until received)
- Large payloads (transcripts can be 10KB+)
- Latency-sensitive (user waiting)

**Example flow:**
```elixir
# Extension transcribes audio locally (WASM Whisper)
# → Sends transcript to backend via AudioChannel
# → AudioChannel casts to AgentSession
GenServer.cast(session_pid, {:transcript_ready, "User said...", source: :local})

# AgentSession mailbox:
# [ {:transcript_ready, "...", [source: :local]}, ... ]

# Processed via handle_cast:
def handle_cast({:transcript_ready, text, opts}, state) do
  # Structure note, broadcast result
  {:noreply, new_state}
end
```

### 2. Client-Provided Data

**Source:** Browser extension (audio chunks, frame embeddings, timestamps)
**Delivery:** Multiple cast types
**Characteristics:**
- High frequency (audio chunks every 100ms, frames every 1-5s)
- Small payloads (audio chunk ~2KB, frame embedding ~512 floats)
- Bursty (user speaks → 20 chunks arrive → silence)

**Example flow:**
```elixir
# Audio chunk stream (passive mode, Sprint 10+)
GenServer.cast(session_pid, {:audio_chunk, <<binary>>})
# → Accumulates in state.audio_buffer until VAD detects silence

# Frame embedding (visual intelligence, Sprint 08)
GenServer.cast(session_pid, {:frame_embedding, [0.1, 0.2, ...], timestamp, opts})
# → Stored in state.pending_visual_context for note enrichment

# Timestamp update (playback position tracking)
GenServer.call(session_pid, {:set_timestamp, 123.45})
# → Updates state.timestamp_seconds
```

### 3. System Events

**Source:** Phoenix PubSub, Oban jobs, internal timers
**Delivery:** `handle_info` or PubSub subscriptions
**Characteristics:**
- Low frequency (periodic checkpoints, lifecycle events)
- Priority-based (checkpoints can wait, shutdown is urgent)
- Fire-and-forget (no response expected)

**Example flow:**
```elixir
# Periodic checkpoint (every 5 minutes)
Process.send_after(self(), :checkpoint, 5 * 60 * 1000)

# Handled via handle_info:
def handle_info(:checkpoint, state) do
  checkpoint_to_db(state)
  schedule_checkpoint()
  {:noreply, state}
end

# PubSub event (note posted)
Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")
# → {:new_note, note} arrives in mailbox
def handle_info({:new_note, note}, state) do
  # Update local cache, broadcast to clients
  {:noreply, state}
end
```

### 4. Video Context Changes

**Source:** Tab navigation, video switching
**Delivery:** `handle_cast({:update_video_context, video_id}, state)`
**Characteristics:**
- Rare but critical (session must switch context immediately)
- Idempotent (re-sending same video_id is safe)
- May invalidate pending work (discard audio buffer for old video)

**Example flow:**
```elixir
# User switches tabs to new video
GenServer.cast(session_pid, {:update_video_context, new_video_id})

def handle_cast({:update_video_context, video_id}, state) do
  # Clear old context, reset timestamp
  new_state = %{state |
    video_id: video_id,
    timestamp_seconds: 0.0,
    audio_buffer: <<>>,  # Discard audio from old video
    pending_visual_context: nil
  }
  {:noreply, new_state}
end
```

---

## Scheduling: When Does the Agent Read Its Mailbox?

### Pattern 1: Event-Driven (Current Implementation)

**How it works:**
- Erlang VM **continuously polls** the GenServer's mailbox
- When a message arrives, the VM **immediately** invokes the appropriate callback
- Processing is **sequential** (one message at a time)

**Advantages:**
- Zero latency (no artificial delay)
- Simple implementation (VM handles scheduling)
- Natural backpressure (slow processing → queue builds up)

**Disadvantages:**
- No batching (each message processed individually)
- No explicit priority (FIFO within process, but no global ordering)
- No configurable windowing (can't say "process 10 messages every 5 seconds")

**Example:**
```elixir
# Messages arrive continuously:
# t=0ms:   {:audio_chunk, <<...>>}
# t=100ms: {:audio_chunk, <<...>>}
# t=200ms: {:audio_chunk, <<...>>}

# Processed immediately (no batching):
def handle_cast({:audio_chunk, data}, state) do
  # Append to buffer, check limits
  new_buffer = state.audio_buffer <> data
  # ... process ...
  {:noreply, %{state | audio_buffer: new_buffer}}
end
```

### Pattern 2: Periodic Polling (Alternative)

**How it works:**
- Messages accumulate in a custom queue (not GenServer mailbox)
- Timer fires every N milliseconds: `Process.send_after(self(), :process_batch, N)`
- Handler drains queue in batches

**Advantages:**
- **Batching** (process 10 audio chunks at once → reduce overhead)
- **Rate limiting** (never process more than once per N ms)
- **Windowing** (sliding window over recent messages)

**Disadvantages:**
- Artificial latency (messages wait for next timer tick)
- More complex implementation (custom queue management)
- Potential message loss (if queue overflows before next tick)

**Example:**
```elixir
defmodule Lossy.Agent.SessionWithPolling do
  use GenServer

  def init(opts) do
    schedule_batch_processing()
    {:ok, %{pending_messages: :queue.new(), ...}}
  end

  # Messages enqueued (not processed immediately)
  def handle_cast({:audio_chunk, data}, state) do
    new_queue = :queue.in({:audio_chunk, data}, state.pending_messages)
    {:noreply, %{state | pending_messages: new_queue}}
  end

  # Periodic batch processing
  def handle_info(:process_batch, state) do
    # Drain queue (up to 50 messages per batch)
    {messages, new_queue} = drain_queue(state.pending_messages, 50)

    # Process batch
    new_state = Enum.reduce(messages, state, fn msg, acc ->
      process_message(msg, acc)
    end)

    schedule_batch_processing()
    {:noreply, %{new_state | pending_messages: new_queue}}
  end

  defp schedule_batch_processing do
    Process.send_after(self(), :process_batch, 500) # 500ms window
  end
end
```

### Pattern 3: Sliding Window (Hybrid)

**How it works:**
- Process messages **immediately** (low latency)
- But **aggregate context** over a sliding time window (last N seconds)
- Use windowed context for higher-level decisions

**Advantages:**
- Best of both worlds: immediate response + temporal context
- Natural fit for audio/video (sliding window mirrors human perception)
- Backpressure via window size (old messages fall out automatically)

**Example:**
```elixir
defmodule Lossy.Agent.SessionWithWindow do
  use GenServer

  # Sliding window: Keep last 10 seconds of audio chunks
  @window_duration_ms 10_000

  def handle_cast({:audio_chunk, data}, state) do
    timestamp = System.monotonic_time(:millisecond)

    # Add to window with timestamp
    new_window = [{timestamp, data} | state.audio_window]

    # Trim old messages (outside window)
    cutoff = timestamp - @window_duration_ms
    trimmed_window = Enum.filter(new_window, fn {ts, _} -> ts > cutoff end)

    # Use windowed context for VAD (voice activity detection)
    speech_detected? = detect_speech_in_window(trimmed_window)

    {:noreply, %{state | audio_window: trimmed_window}}
  end
end
```

**Recommended approach:**
- **Event-driven** for most messages (low latency, simple)
- **Sliding window** for temporal context (audio/video frames)
- **Periodic batching** only when batching provides efficiency gains (e.g., bulk database writes)

---

## Backpressure Mechanisms

### Principle: Never Silently Drop Messages

When the mailbox overflows, the system must **apply backpressure** to slow down senders. Options:

### 1. Reject New Messages (Fail Fast)

**When:** Mailbox depth exceeds hard limit
**How:** Return error to sender
**Example:**
```elixir
def handle_cast({:audio_chunk, data}, state) do
  if :queue.len(state.audio_buffer) > 1000 do
    Logger.error("Mailbox overflow! Rejecting audio chunk.")
    # Option A: Just log (message still lost)
    # Option B: Notify sender via PubSub
    Phoenix.PubSub.broadcast(Lossy.PubSub, "session:#{state.session_id}",
      {:backpressure, :mailbox_full})
    {:noreply, state} # Don't add to buffer
  else
    {:noreply, %{state | audio_buffer: state.audio_buffer <> data}}
  end
end
```

### 2. Drop Oldest Low-Priority Messages (Shed Load)

**When:** Mailbox depth exceeds soft limit
**How:** Remove oldest non-critical messages
**Example:**
```elixir
def handle_cast({:audio_chunk, data}, state) do
  if byte_size(state.audio_buffer) > 5_000_000 do
    Logger.warning("Max buffer size reached, forcing transcription")
    # Force processing (clears buffer)
    {:noreply, transition_to(state, :transcribing)}
  else
    {:noreply, %{state | audio_buffer: state.audio_buffer <> data}}
  end
end
```

**Current implementation** (`lib/lossy/agent/session.ex:90-105`):
- Max 5MB audio buffer → force transcription
- Max 60s duration → force transcription
- Backpressure via **processing, not dropping**

### 3. Rate Limiting (Throttle Sender)

**When:** Sender produces messages faster than agent can process
**How:** Notify sender to slow down; sender pauses or batches
**Example:**
```elixir
# Backend detects high message rate
if message_rate > 100 per_second do
  # Send backpressure signal to extension
  channel.push("backpressure", %{
    current_rate: message_rate,
    target_rate: 50
  })
end

# Extension throttles audio chunks
audioContext.suspend() # Pause audio processing
setTimeout(() => audioContext.resume(), 2000) # Resume after 2s
```

### 4. Priority Queues (Process Critical First)

**When:** Multiple message types with different urgency
**How:** Separate queues or priority tagging
**Example (using Erlang's priority send):**
```elixir
# High priority (shutdown, errors)
send(pid, {:system, :shutdown}, [:priority])

# Normal priority (transcripts, notes)
GenServer.cast(pid, {:transcript_ready, text})

# Low priority (checkpoints, stats)
GenServer.cast(pid, {:background_checkpoint})
```

**Better approach: Multiple GenServers**
- **AgentSession** (high priority): Handles audio, transcripts, notes
- **SessionCheckpoint** (low priority): Handles periodic state persistence
- **SessionAnalytics** (lowest priority): Handles metrics, telemetry

Each has its own mailbox → natural priority separation.

---

## Queue Theory Foundations

### Little's Law

**Formula:** `L = λ × W`

Where:
- **L** = Average number of items in system (mailbox depth)
- **λ** (lambda) = Arrival rate (messages per second)
- **W** = Average time in system (processing latency)

**Example:**
- Audio chunks arrive at λ = 10/sec
- Processing takes W = 50ms (0.05s)
- Expected mailbox depth: L = 10 × 0.05 = 0.5 messages

**If processing slows down:**
- W increases to 200ms (0.2s)
- L = 10 × 0.2 = 2 messages (queue builds up)

**Implication:** Mailbox depth is an **observable signal** of processing health. Monitor it!

### Queuing Models

**M/M/1 Queue** (Markovian arrival/service, 1 server):
- **Arrival rate:** λ messages/sec
- **Service rate:** μ messages/sec (processing capacity)
- **Utilization:** ρ = λ/μ
  - ρ < 1: Stable (queue drains)
  - ρ ≥ 1: Unstable (queue grows indefinitely)

**Example:**
- Audio chunks: λ = 10/sec
- Processing: μ = 20/sec (50ms each)
- Utilization: ρ = 10/20 = 0.5 (50% busy, stable)

**If arrival rate spikes:**
- λ = 25/sec (user speaks rapidly)
- ρ = 25/20 = 1.25 (overloaded!)
- Queue grows until backpressure applied

**Erlang references:**
- [OTP design principles](https://www.erlang.org/doc/design_principles/des_princ.html)
- [Overload protection](https://www.erlang.org/doc/design_principles/spec_proc.html#overload-protection)

---

## Flow Control: Server-Driven Queries

### Pull-Based Flow (Alternative to Push)

Instead of the extension **pushing** audio chunks continuously, the backend could **pull** when ready:

**Push model (current):**
```javascript
// Extension (sender controls rate)
setInterval(() => {
  const chunk = captureAudio();
  channel.push("audio_chunk", { data: chunk });
}, 100); // 10 chunks/sec
```

**Pull model (alternative):**
```javascript
// Extension (backend controls rate)
channel.on("request_audio", () => {
  const chunk = captureAudio();
  channel.push("audio_chunk", { data: chunk });
  // Wait for next request (natural backpressure)
});

// Backend
def handle_info(:request_next_chunk, state) do
  Phoenix.PubSub.broadcast("session:#{session_id}", :request_audio)
  {:noreply, state}
end
```

**Advantages:**
- Backend never overloaded (only requests when ready)
- Natural flow control (no buffering needed)
- Client can't flood server

**Disadvantages:**
- Higher latency (round-trip per chunk)
- More complex coordination
- Network jitter affects timing

**When to use pull:**
- Low-frequency updates (video context changes)
- Resource-constrained backend (pull prevents overload)
- Expensive processing (don't waste cycles on unnecessary data)

**When to use push (current approach):**
- High-frequency streams (audio, video frames)
- Client already buffering (extension's VAD already batches audio)
- Low latency requirements (avoid round-trip delay)

---

## Mailbox Monitoring & Observability

### Metrics to Track

```elixir
# Telemetry events
:telemetry.execute(
  [:lossy, :agent, :mailbox],
  %{
    queue_depth: Process.info(self(), :message_queue_len),
    oldest_message_age_ms: calculate_oldest_message_age(),
    message_processing_time_ms: processing_duration
  },
  %{session_id: state.session_id}
)

# Alerts
if mailbox_depth > 100 do
  Logger.error("[#{session_id}] Mailbox overflow: #{mailbox_depth} messages")
  # Send to monitoring system (Honeybadger, Sentry, etc.)
end
```

### Dashboard Metrics

- **Mailbox depth** (gauge): Current number of queued messages
- **Message processing rate** (counter): Messages processed per second
- **Processing latency** (histogram): Time from message arrival to completion
- **Backpressure events** (counter): How often limits are hit

### Debugging Tools

```elixir
# Inspect mailbox contents (development only!)
Process.info(pid, :messages)
# → {messages, [{:audio_chunk, <<...>>}, {:transcript_ready, "..."}, ...]}

# Count messages by type
defp mailbox_stats(pid) do
  {:messages, messages} = Process.info(pid, :messages)
  Enum.frequencies_by(messages, fn
    {:cast, {type, _}} -> type
    {:info, type} -> type
    _ -> :other
  end)
end
# → %{audio_chunk: 42, transcript_ready: 1, checkpoint: 1}
```

---

## Concrete Recommendations

### 1. Formalize Message Types

Create explicit structs for all message types (improves type safety, documentation):

```elixir
defmodule Lossy.Agent.Message do
  defmodule AudioChunk do
    @enforce_keys [:data, :timestamp]
    defstruct [:data, :timestamp, :source]
  end

  defmodule TranscriptReady do
    @enforce_keys [:text]
    defstruct [:text, :source, :confidence]
  end

  defmodule FrameEmbedding do
    @enforce_keys [:embedding, :timestamp]
    defstruct [:embedding, :timestamp, :device, :source]
  end
end

# Usage
def handle_cast(%Message.AudioChunk{} = msg, state) do
  # Type-safe message handling
end
```

### 2. Add Mailbox Depth Monitoring

```elixir
def handle_cast(message, state) do
  # Monitor mailbox depth before processing
  {:message_queue_len, depth} = Process.info(self(), :message_queue_len)

  if depth > 50 do
    Logger.warning("[#{state.session_id}] Mailbox depth: #{depth}")
  end

  # Process message...
end
```

### 3. Implement Priority Separation

Split AgentSession into multiple processes:

```elixir
# High priority: Real-time audio/transcript processing
AgentSession.Core (GenServer)
  ↓ handles: audio_chunk, transcript_ready, frame_embedding

# Medium priority: Note structuring, database writes
AgentSession.Persistence (GenServer)
  ↓ handles: note_created, update_video_context

# Low priority: Analytics, checkpointing
AgentSession.Background (GenServer)
  ↓ handles: checkpoint, cleanup, telemetry
```

Each with its own mailbox → natural priority isolation.

### 4. Add Backpressure Signaling

```elixir
def handle_cast({:audio_chunk, data}, state) do
  depth = Process.info(self(), :message_queue_len) |> elem(1)

  if depth > 100 do
    # Signal backpressure to extension
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "session:#{state.session_id}",
      {:backpressure, :slow_down}
    )
  end

  # Continue processing...
end
```

Extension responds:
```javascript
channel.on("backpressure", ({ level }) => {
  if (level === "slow_down") {
    // Reduce audio chunk rate
    audioChunkInterval = 200; // Was 100ms, now 200ms
  }
});
```

---

## Future Considerations

### Persistent Mailboxes (Durable Queues)

Currently, if AgentSession crashes, **all queued messages are lost**. For critical messages, consider:

**Option 1: RabbitMQ/Redis Queue**
- Messages persist outside process
- Survive crashes, restarts
- Overhead: Network round-trip, serialization

**Option 2: Database-Backed Queue (Oban)**
- Already used for automation jobs
- Could extend to agent messages
- Overhead: Database writes

**When needed:**
- Long-running sessions (Sprint 14)
- High-value messages (user-initiated requests)
- Regulatory compliance (audit trail)

### Multi-Agent Coordination

If multiple agents process same video (future: collaborative note-taking):
- **Shared mailbox** (single queue, multiple consumers)
- **Work stealing** (agents pull from shared pool)
- **Partitioning** (each agent handles subset of message types)

Erlang reference: [pg module](https://www.erlang.org/doc/man/pg.html) for process groups.

---

## Summary

The **mailbox metaphor** provides a powerful mental model for context handling:

1. **All context is messages** – Responses, data, events
2. **Messages queue in order** – FIFO (or priority-based)
3. **Agent processes sequentially** – One message at a time
4. **Backpressure is built-in** – Queue depth signals overload
5. **Scheduling is flexible** – Event-driven, periodic, or windowed

**Current state:** AgentSession already implements a mailbox via GenServer.
**Next steps:** Formalize message types, add monitoring, implement backpressure signaling.

**Key references:**
- [GenServer documentation](https://hexdocs.pm/elixir/GenServer.html)
- [Erlang process mailboxes](https://www.erlang.org/doc/reference_manual/processes.html)
- [OTP design principles](https://www.erlang.org/doc/design_principles/des_princ.html)
- [Little's Law (queue theory)](https://en.wikipedia.org/wiki/Little%27s_law)
- Fred Hebert's [*Learn You Some Erlang*](https://learnyousomeerlang.com/what-is-otp) (OTP chapters)

---

**Document Version:** 1.0
**Last Updated:** 2025-10-23
**Author:** Architecture Team
