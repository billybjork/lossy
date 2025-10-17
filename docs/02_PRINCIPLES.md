# Development Principles

**Last Updated:** 2025-10-17

---

## Overview

This document outlines the core development principles that guide architectural decisions, implementation patterns, and technical trade-offs in Lossy. These principles are derived from established software engineering best practices and applied specifically to the challenges of building a voice-first video companion with browser extension and real-time backend components.

---

## Core Principles

### 1. Progressive Enhancement & Graceful Degradation

**Definition:** Build layered systems where core functionality works universally, with enhanced experiences activated when better capabilities are available. Systems degrade gracefully when optimal conditions aren't met.

**Theoretical Foundation:**
- **Fault Tolerance** (Distributed Systems): Design for partial failures
- **Feature Detection over Feature Assumption** (Web Standards)
- **Defense in Depth** (Security): Multiple fallback layers
- **Robustness Principle** (Postel's Law): "Be conservative in what you send, liberal in what you accept"

**Implementation in Lossy:**

| Component | Enhancement Layers | Degradation Path |
|-----------|-------------------|------------------|
| **Transcription** | WebGPU-accelerated WASM Whisper → CPU-based WASM → Cloud API | Always functional, performance varies |
| **Frame Analysis** | WebGPU SigLIP (50-150ms) → WASM SigLIP (300-600ms) → Skip emoji chips | Core note-taking unaffected |
| **Video Detection** | Platform-specific adapter → Generic heuristics → Manual fallback | Works on any site, reliability varies |
| **Network** | Real-time LiveView → Offline queue → Sync on reconnect | User never loses work |

**Code Example:**
```elixir
# lossy/lib/lossy/inference/stt_router.ex
defmodule Lossy.Inference.STTRouter do
  def transcribe(audio_binary, opts \\ []) do
    cond do
      # Best: Local WASM (already done in browser)
      opts[:wasm_transcript] ->
        {:ok, opts[:wasm_transcript]}

      # Good: Cloud API (fast, high quality)
      openai_available?() ->
        OpenAI.Whisper.transcribe(audio_binary)

      # Fallback: Native whisper.cpp (if compiled)
      native_whisper_available?() ->
        WhisperNIF.transcribe(audio_binary)

      # Last resort: Fail gracefully
      true ->
        {:error, :no_stt_backend_available}
    end
  end

  defp openai_available?() do
    !!System.get_env("OPENAI_API_KEY")
  end
end
```

**Benefits:**
- ✅ Works in more environments (low-end devices, poor networks, restrictive policies)
- ✅ Better user experience when conditions are optimal
- ✅ No hard failures from missing capabilities
- ✅ Privacy-conscious users can opt for local-only processing

**Anti-Pattern:**
```javascript
// ❌ WRONG: Assumes WebGPU is always available
const model = await loadModel('whisper-base', { device: 'webgpu' });
// Crashes on devices without WebGPU support
```

---

### 2. Progressive Disclosure

**Definition:** Reveal complexity, advanced features, and detailed information gradually as users demonstrate need and proficiency. Start simple, enable power users to go deep.

**Theoretical Foundation:**
- **Information Hiding** (Parnas, 1972): Expose only what's necessary at each level
- **Cognitive Load Theory**: Reduce working memory burden for novices
- **Fitts's Law**: Frequently used features should be most accessible
- **Progressive Enhancement** (UI/UX): Core experience first, enhancements layered

**Implementation in Lossy:**

| User Level | Exposed Features | Hidden Complexity |
|------------|------------------|-------------------|
| **First-time User** | • Mic button<br>• Simple note list<br>• Auto-posting | • Session management<br>• LLM confidence scores<br>• Audio encoding details |
| **Regular User** | • Video filters<br>• Manual posting controls<br>• Note categories | • Platform adapters<br>• Retry strategies<br>• PubSub topics |
| **Power User** | • Keyboard shortcuts<br>• Batch operations<br>• Debug mode | • AgentSession state machine<br>• WebSocket protocol details<br>• Oban job queues |

**Planned UI Examples:**

```heex
<!-- Side Panel: Simple by default -->
<div class="side-panel">
  <!-- Always visible: Core functionality -->
  <button class="mic-toggle">🎤 Record</button>
  <div class="notes-list">
    <!-- Simple note cards -->
  </div>

  <!-- Progressive: Show details on demand -->
  <details class="advanced-filters">
    <summary>Advanced Filters</summary>
    <div class="filter-options">
      <select name="status">...</select>
      <select name="confidence">...</select>
      <input type="date" name="date_range">
    </div>
  </details>

  <!-- Power user: Debug panel (hidden by default) -->
  <div :if={@debug_mode} class="debug-panel">
    <h3>Session State</h3>
    <pre><%= inspect(@session_state, pretty: true) %></pre>
  </div>
</div>
```

**Code Example:**
```elixir
# Show simple status by default, detailed info in debug mode
defmodule LossyWeb.SidePanelLive do
  def render(assigns) do
    ~H"""
    <div class="note-card">
      <!-- Always visible -->
      <p class="note-text"><%= @note.text %></p>
      <span class="status"><%= @note.status %></span>

      <!-- Progressive: Expand for details -->
      <button phx-click="toggle_details" phx-value-id={@note.id}>
        <%= if @show_details, do: "Hide Details", else: "Show Details" %>
      </button>

      <!-- Power user: Full metadata -->
      <div :if={@show_details} class="note-metadata">
        <div class="meta-item">
          <span>Confidence:</span>
          <span><%= (@note.confidence * 100) |> round %>%</span>
        </div>
        <div class="meta-item">
          <span>Model:</span>
          <span><%= @note.model_version %></span>
        </div>
        <div class="meta-item">
          <span>Session:</span>
          <span class="monospace"><%= @note.session_id %></span>
        </div>
      </div>
    </div>
    """
  end
end
```

**Benefits:**
- ✅ Lower barrier to entry (simple first impression)
- ✅ Reduced cognitive load for new users
- ✅ Power users aren't limited by simplified UI
- ✅ Features discoverable through natural progression

---

### 3. Self-Healing Systems

**Definition:** Systems that automatically detect, diagnose, and repair failures without manual intervention. Resilient to environmental changes, network issues, and platform updates.

**Theoretical Foundation:**
- **Autonomic Computing** (IBM, 2001): Self-configuring, self-healing, self-optimizing
- **Chaos Engineering**: Assume failures will happen, design for recovery
- **Circuit Breaker Pattern**: Detect failures, prevent cascading issues
- **Supervisor Trees** (Erlang/OTP): Automatic process restart on failure
- **Byzantine Fault Tolerance**: Continue operating despite partial failures

**Implementation in Lossy:**

| Component | Failure Mode | Self-Healing Behavior |
|-----------|-------------|----------------------|
| **Video Detection** | Video element replaced (SPA) | `VideoLifecycleManager` health checks every 5s, re-detects automatically |
| **Timeline Markers** | Progress bar removed by platform | DOM observer re-attaches markers when bar reappears |
| **Platform Adapters** | Adapter fails health check | Automatic fallback to `GenericAdapter`, continue operation |
| **Note Loading** | Backend temporarily unavailable | `NoteLoader` exponential backoff retry (3 attempts), graceful degradation |
| **WebSocket** | Connection drops | LiveView auto-reconnect with exponential backoff, queue offline actions |
| **AgentSession** | GenServer crash | `DynamicSupervisor` restarts, recovers state from database |

**Code Example:**
```javascript
// extension/src/content/core/video-lifecycle-manager.js
export class VideoLifecycleManager {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.state = 'idle';
    this.healthCheckInterval = null;
    this.signal = options.signal;

    // Self-healing: Periodic health checks
    this.startHealthChecks();
  }

  startHealthChecks() {
    this.healthCheckInterval = setInterval(() => {
      if (this.state === 'ready') {
        // Check if video element is still valid
        if (!this.isVideoHealthy()) {
          console.warn('[VideoLifecycle] Video unhealthy, re-detecting...');
          this.transition('detecting');
          this.detectVideo(); // Self-heal
        }

        // Check if adapter is still healthy
        if (!this.adapter.isHealthy()) {
          console.warn('[VideoLifecycle] Adapter unhealthy, falling back...');
          this.adapter = new GenericAdapter(); // Self-heal
          this.detectVideo();
        }
      }
    }, 5000); // Check every 5 seconds

    // Cleanup on abort
    this.signal?.addEventListener('abort', () => {
      clearInterval(this.healthCheckInterval);
    });
  }

  isVideoHealthy() {
    return this.videoElement &&
           this.videoElement.isConnected && // Still in DOM
           !this.videoElement.paused &&     // Not stuck
           this.videoElement.readyState >= 2; // Has data
  }
}
```

**Elixir Example:**
```elixir
# lossy/lib/lossy/agent/session_supervisor.ex
defmodule Lossy.Agent.SessionSupervisor do
  use DynamicSupervisor

  def start_link(init_arg) do
    DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  def init(_init_arg) do
    DynamicSupervisor.init(
      strategy: :one_for_one,
      max_restarts: 3,        # Allow 3 crashes
      max_seconds: 5          # Within 5 seconds
    )
    # After max_restarts, supervisor gives up (prevents infinite crash loop)
  end

  def start_session(session_id, user_id) do
    child_spec = %{
      id: session_id,
      start: {Lossy.Agent.Session, :start_link, [session_id: session_id, user_id: user_id]},
      restart: :transient  # Restart if abnormal termination
    }

    DynamicSupervisor.start_child(__MODULE__, child_spec)
  end
end

defmodule Lossy.Agent.Session do
  use GenServer, restart: :transient

  # Self-healing: Restore state after crash
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)

    # Try to restore previous state
    state = case Lossy.Repo.get_by(Lossy.AgentSessionState, session_id: session_id) do
      nil ->
        # Fresh start
        %{session_id: session_id, status: :idle, audio_buffer: <<>>}

      recovered ->
        # Self-heal: Continue from last known state
        Logger.info("[Session] Recovered state for #{session_id}")
        Map.from_struct(recovered)
    end

    {:ok, state}
  end

  # Persist state periodically (for crash recovery)
  def handle_info(:persist_state, state) do
    Lossy.Repo.insert_or_update(%Lossy.AgentSessionState{
      session_id: state.session_id,
      status: state.status,
      audio_buffer: state.audio_buffer,
      last_heartbeat: DateTime.utc_now()
    })

    # Schedule next persistence
    Process.send_after(self(), :persist_state, 10_000) # Every 10s

    {:noreply, state}
  end
end
```

**Benefits:**
- ✅ Reduced operational burden (fewer manual interventions)
- ✅ Better uptime (automatic recovery)
- ✅ Handles platform changes (YouTube redesigns, Vimeo player updates)
- ✅ Resilient to network instability

**Anti-Pattern:**
```javascript
// ❌ WRONG: Rigid detection, no recovery
const video = document.querySelector('video');
if (!video) throw new Error('No video found');
// Fails permanently if video loads late or is replaced
```

---

### 4. Flexible Heuristics over Intricate Rules

**Definition:** Prefer adaptive, pattern-matching approaches over brittle, rule-based systems. Use scoring, ranking, and probabilistic methods that handle edge cases gracefully.

**Theoretical Foundation:**
- **Fuzzy Logic**: Gradual truth values vs binary yes/no
- **Heuristic Search** (AI): Good-enough solutions vs optimal guarantees
- **Bayesian Inference**: Update beliefs with new evidence
- **Machine Learning**: Learn patterns from data vs hand-coded rules
- **Robustness over Fragility** (Antifragile systems)

**Implementation in Lossy:**

| Challenge | ❌ Intricate Rules | ✅ Flexible Heuristics |
|-----------|-------------------|----------------------|
| **Video Detection** | `if (url.includes('youtube')) return querySelector('.ytp-player')` | Score all `<video>` elements by size, viewport visibility, play state; select highest |
| **Platform Adapters** | Hardcoded selectors per platform | Platform adapter with fallback chain, health checks trigger fallback to generic |
| **Progress Bar Finding** | Check exact class `.ytp-progress-bar` | Search for elements matching: horizontal, ~100% width, near bottom, inside video container |
| **Note Categorization** | 100-line if/else chain checking keywords | LLM with structured output, confidence scores, user corrections feed training |
| **Auto-Posting Decision** | `if (confidence > 0.8 && category == 'feedback')` | Multi-factor scoring: confidence + user history + note complexity + platform reliability |

**Code Example:**
```javascript
// extension/src/content/core/video-detector.js

// ❌ WRONG: Brittle rules
function detectVideoOld() {
  if (window.location.hostname.includes('youtube')) {
    return document.querySelector('#movie_player video');
  } else if (window.location.hostname.includes('vimeo')) {
    return document.querySelector('.vp-video-wrapper video');
  }
  // Fails on unknown platforms
}

// ✅ RIGHT: Flexible heuristics
function detectVideo() {
  const videos = Array.from(document.querySelectorAll('video'));

  if (videos.length === 1) return videos[0]; // Easy case

  // Score each video by heuristics
  const scored = videos.map(video => ({
    element: video,
    score: scoreVideo(video)
  }));

  // Return highest scoring
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.element;
}

function scoreVideo(video) {
  let score = 0;

  // Heuristic 1: Size (larger = more likely main video)
  const area = video.videoWidth * video.videoHeight;
  score += Math.min(area / 100000, 50); // Cap at 50 points

  // Heuristic 2: Viewport visibility
  const rect = video.getBoundingClientRect();
  const viewportArea = window.innerWidth * window.innerHeight;
  const visibleArea = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)) *
                       Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  score += (visibleArea / viewportArea) * 30; // Up to 30 points

  // Heuristic 3: Has controls
  if (video.controls || video.hasAttribute('controls')) score += 10;

  // Heuristic 4: Is playing or ready to play
  if (video.readyState >= 3) score += 10;
  if (!video.paused) score += 5;

  // Heuristic 5: Not autoplay background video
  if (video.hasAttribute('autoplay') && video.muted) score -= 20;

  return score;
}
```

**Platform Adapter Example:**
```javascript
// Adapter pattern with flexible detection
class BasePlatformAdapter {
  async detectVideo() {
    // Try platform-specific selector
    const specific = this.platformSpecificVideo();
    if (specific && this.validateVideo(specific)) {
      return specific;
    }

    // Fallback to generic heuristics
    return this.genericVideoDetection();
  }

  validateVideo(video) {
    // Flexible validation (not pass/fail, but scoring)
    const validations = [
      video.isConnected,
      video.readyState >= 2,
      video.videoWidth > 0,
      video.videoHeight > 0
    ];

    const passRate = validations.filter(Boolean).length / validations.length;
    return passRate >= 0.75; // 75% of checks pass = good enough
  }
}
```

**Benefits:**
- ✅ Handles unknown platforms gracefully
- ✅ Adapts to platform UI changes (YouTube redesigns)
- ✅ Fewer false negatives (more likely to find video)
- ✅ Easier to maintain (add new heuristics vs rewrite rules)

**When to Use Rules:**
- ✅ Security decisions (authentication, authorization)
- ✅ Data validation (email format, required fields)
- ✅ Business logic with strict requirements (payment processing)

---

### 5. Declarative Design

**Definition:** Specify *what* the system should accomplish, not *how* to accomplish it. Define desired outcomes, constraints, and invariants; let the implementation handle execution details.

**Theoretical Foundation:**
- **Declarative Programming**: SQL, Prolog, HTML vs imperative C, JavaScript
- **Functional Programming**: Pure functions, immutability, composition
- **State Machines**: Declare valid states and transitions, not step-by-step logic
- **Domain-Specific Languages**: Express intent in domain terms
- **Datalog / Logic Programming**: Declare facts and rules, engine derives results

**Implementation in Lossy:**

| Component | Imperative Approach ❌ | Declarative Approach ✅ |
|-----------|----------------------|------------------------|
| **UI** | Manual DOM manipulation with `appendChild`, `innerHTML` | LiveView: Declare template, Phoenix handles diffing and updates |
| **State Management** | Manual state tracking with flags and callbacks | GenServer: Declare state machine, OTP handles messages and transitions |
| **Data Fetching** | Nested callbacks for error handling | Ecto queries: Declare what data you want, Ecto handles joins and transactions |
| **Background Jobs** | Cron jobs + shell scripts checking status | Oban: Declare job, schedule, retry policy; Oban handles execution |
| **Streaming** | Manual DOM insertion, scroll management | LiveView streams: Declare `stream_insert`, Phoenix handles incremental updates |

**UI Example (LiveView is Declarative):**
```heex
<!-- Declarative: Define what should be rendered based on state -->
<div class="side-panel">
  <!-- Conditional rendering: Declare when to show, not how -->
  <div :if={@connection_state != :online} class="offline-banner">
    <p>You're offline. Changes will sync when reconnected.</p>
  </div>

  <!-- Loop: Declare what to render for each item -->
  <div id="notes-stream" phx-update="stream">
    <div :for={{dom_id, note} <- @streams.notes} id={dom_id}>
      <.note_card note={note} />
    </div>
  </div>

  <!-- Empty state: Declaratively show when no notes -->
  <div :if={Enum.empty?(@streams.notes)} class="empty-state">
    <p>No notes yet</p>
  </div>
</div>
```

**State Machine Example (GenServer):**
```elixir
# Declarative: Define valid states and transitions
defmodule Lossy.Agent.Session do
  use GenServer

  # State machine definition (declarative)
  @valid_states [:idle, :listening, :transcribing, :structuring, :confirming, :error]

  @valid_transitions %{
    idle: [:listening],
    listening: [:transcribing, :idle],
    transcribing: [:structuring, :error],
    structuring: [:confirming, :error],
    confirming: [:idle, :error],
    error: [:idle]
  }

  # Declarative transition logic
  defp transition(state, new_status) do
    if new_status in @valid_transitions[state.status] do
      %{state | status: new_status, last_transition: DateTime.utc_now()}
      |> persist_state()
      |> broadcast_state_change()
    else
      Logger.error("Invalid transition: #{state.status} -> #{new_status}")
      %{state | status: :error, error: "Invalid state transition"}
    end
  end

  # Declarative event handling
  def handle_cast(:start_listening, state) do
    {:noreply, transition(state, :listening)}
  end

  def handle_cast({:audio_chunk, data}, %{status: :listening} = state) do
    new_state = %{state | audio_buffer: state.audio_buffer <> data}

    if should_transcribe?(new_state) do
      {:noreply, transition(new_state, :transcribing)}
    else
      {:noreply, new_state}
    end
  end
end
```

**Query Example (Ecto is Declarative):**
```elixir
# Declarative: What data to fetch, not how to fetch it
def list_notes(video_id, opts \\ []) do
  from(n in Note,
    where: n.video_id == ^video_id,
    where: n.status in [:firmed, :posted],
    order_by: [desc: n.inserted_at],
    limit: ^Keyword.get(opts, :limit, 50),
    preload: [:user, :video]  # Declare associations to load
  )
  |> Repo.all()
end

# Phoenix handles:
# - JOIN queries for preloads
# - Connection pooling
# - Transaction management
# - Result mapping to structs
```

**Job Queue Example (Oban is Declarative):**
```elixir
# Declarative: What job to run, when, and how to retry
defmodule Lossy.Workers.ApplyNoteWorker do
  use Oban.Worker,
    queue: :automation,        # Which queue
    max_attempts: 3,           # Retry policy
    unique: [period: 60]       # Prevent duplicates

  # What to do
  @impl Oban.Worker
  def perform(%Job{args: %{"note_id" => note_id}}) do
    note = Videos.get_note!(note_id)

    # Call automation
    case Automation.apply_note(note) do
      {:ok, result} ->
        Videos.update_note(note, %{status: :posted, permalink: result.url})
        :ok

      {:error, reason} ->
        {:error, reason}  # Oban automatically retries
    end
  end
end

# Schedule job (declarative)
%{note_id: note.id}
|> ApplyNoteWorker.new(schedule_in: 60)  # Run in 60 seconds
|> Oban.insert()

# Oban handles:
# - Job persistence to database
# - Retry with exponential backoff
# - Concurrency limiting
# - Dead letter queue
```

**Benefits:**
- ✅ Easier to reason about (focus on *what*, not *how*)
- ✅ Less boilerplate (framework handles mechanics)
- ✅ Fewer bugs (less imperative code = fewer state management bugs)
- ✅ More testable (test state transitions, not implementation)
- ✅ Better composition (combine declarative pieces)

**Anti-Pattern (Imperative UI):**
```javascript
// ❌ WRONG: Imperative DOM manipulation
function addNote(note) {
  const list = document.getElementById('notes-list');
  const card = document.createElement('div');
  card.className = 'note-card';
  card.innerHTML = `
    <p>${note.text}</p>
    <span>${note.status}</span>
  `;

  if (note.status === 'posted') {
    card.classList.add('posted');
  }

  // Manual insertion logic
  if (shouldAddToTop(note)) {
    list.insertBefore(card, list.firstChild);
  } else {
    list.appendChild(card);
  }

  // Manual scroll management
  if (isNearBottom()) {
    scrollToBottom();
  }
}

// ✅ RIGHT: Declarative with LiveView
# Phoenix broadcasts event
Phoenix.PubSub.broadcast("video:#{vid}", {:new_note, note})

# LiveView declaratively updates
def handle_info({:new_note, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note, at: 0)}
end
# Phoenix handles DOM diffing, insertion, scrolling
```

---

## Principle Interactions

These principles reinforce each other:

**Progressive Enhancement + Self-Healing:**
- Lower tier fallbacks handle failures automatically
- Example: WASM crashes → auto-fallback to cloud API

**Flexible Heuristics + Self-Healing:**
- Heuristic scoring adapts to platform changes
- Example: Video detector re-scores when DOM changes

**Declarative + Progressive Disclosure:**
- Declarative UI makes conditional rendering simple
- Example: LiveView `:if` conditionals show/hide based on state

**All Principles + Graceful Degradation:**
- Combined effect: System works in nearly any environment
- Example: Offline extension with slow CPU still captures notes (queues sync for later)

---

## Decision Framework

When making architectural decisions, ask:

1. **Progressive Enhancement:** Can this feature work at a basic level everywhere, with enhancements where possible?
2. **Progressive Disclosure:** Should this be visible to all users, or revealed based on proficiency?
3. **Self-Healing:** What happens when this fails? Can it recover automatically?
4. **Flexible Heuristics:** Am I writing rigid rules that will break on edge cases, or adaptive logic?
5. **Declarative:** Am I specifying *what* I want, or getting lost in *how* to do it?

---

## Examples from Lossy

### Video Detection (All Principles)

**Progressive Enhancement:**
- ✅ Platform-specific adapter (best)
- ✅ Generic heuristics (good)
- ✅ Manual user selection (fallback)

**Self-Healing:**
- ✅ Health checks every 5s
- ✅ Re-detect when video replaced
- ✅ Fallback to generic adapter on failure

**Flexible Heuristics:**
- ✅ Score videos by size, visibility, play state
- ✅ Validate with 75% threshold (not 100%)

**Declarative:**
- ✅ Adapter interface defines *what* to find
- ✅ Implementation handles *how*

### Note Posting (Declarative + Self-Healing)

**Declarative:**
```elixir
# Declare job, Oban handles execution
%{note_id: note.id}
|> ApplyNoteWorker.new()
|> Oban.insert()
```

**Self-Healing:**
- ✅ Oban auto-retries on failure (3 attempts)
- ✅ Exponential backoff
- ✅ Dead letter queue for manual review

### LiveView UI (Declarative + Progressive Disclosure)

**Declarative:**
```heex
<div :for={{dom_id, note} <- @streams.notes} id={dom_id}>
  <.note_card note={note} />
</div>
```

**Progressive Disclosure:**
```heex
<details :if={@show_advanced}>
  <summary>Advanced Options</summary>
  <!-- Complex features hidden by default -->
</details>
```

---

## Summary

| Principle | Key Benefit | Primary Application |
|-----------|-------------|---------------------|
| **Progressive Enhancement** | Works everywhere, better where possible | Inference (WASM/Cloud), video detection |
| **Progressive Disclosure** | Simple first, powerful later | UI complexity, debug features |
| **Self-Healing** | Automatic recovery, less maintenance | Video lifecycle, WebSocket reconnect, adapter health |
| **Flexible Heuristics** | Handles edge cases, adapts to change | Video detection, platform adapters |
| **Declarative** | Simpler code, fewer bugs | LiveView UI, state machines, Oban jobs, Ecto queries |

These principles guide every architectural decision in Lossy, from high-level system design to low-level implementation details.
