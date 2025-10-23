# Agentic Principles & Architecture

**Status:** Design Document - Guiding Vision

---

## Overview

This document outlines the agentic principles that guide Lossy's evolution from a manual recording tool into an intelligent, always-on video companion. These principles complement the core development principles in `02_PRINCIPLES.md` by focusing specifically on AI agent behavior, autonomy, and intelligence patterns.

---

## Core Vision

**From Manual Tools → Intelligent Companions**

Lossy is transitioning from discrete, user-triggered actions (manual record, manual refine) to a continuous, context-aware agent that:
- Observes passively until needed
- Acts proactively when appropriate
- Refines understanding iteratively
- Maintains global coherence across the entire video session

---

## Agentic Principles

### 1. Context-Aware Passive Observation

**Definition:** The agent maintains continuous awareness of the video context without requiring explicit activation, similar to a human assistant observing a review session.

**Core Behaviors:**
- **Always-on listening**: Monitors audio for speech when side panel is open (not recording everything, but ready to capture). The agent can fall back to manual controls via the debug drawer when VAD is unavailable or disabled.
- **Visual sampling**: Captures frames at strategic moments (VAD events, user interactions, periodic intervals) to build spatial understanding
- **State tracking**: Maintains awareness of video position, playback state, and accumulated notes without user prompting

**Implementation Patterns:**
```
Traditional Workflow:
1. User clicks "Record" → System wakes up
2. User speaks → System captures
3. User clicks "Stop" → System processes
4. Repeat manually for each note

Agentic Workflow:
1. Side panel opens → Agent activates context monitoring
2. User speaks naturally → VAD detects speech automatically
3. Speech ends → Agent processes and creates note
4. Agent continues observing → Ready for next insight
```

**Why This Matters:**
- Reduces cognitive load (no button clicking during flow state)
- Enables natural, conversational feedback generation
- Allows agent to build holistic understanding of the entire video
- Mirrors human assistant behavior ("I'm here when you need me")

---

### 2. Progressive Evidence Accumulation

**Definition:** The agent builds understanding incrementally through multiple modalities (speech, vision, user actions) rather than making one-shot judgments.

**Evidence Sources:**
1. **Transcription fragments** - User's spoken feedback in real-time
2. **Video frames** - Visual context at key moments (pauses, scrubs, VAD events)
3. **User interactions** - Pause events, seeks, replays (implicit feedback signals)
4. **OCR/visual text** - On-screen text that provides additional context
5. **Temporal patterns** - How long user lingers on sections, rewatch behavior

**Accumulation Strategy:**
```
Initial Note (from transcript):
"The pacing is slow here"

+ Frame capture (automatic):
Visual context: Product demo screen showing repetitive UI walkthrough

+ User action (replayed section twice):
Implicit signal: This section particularly problematic

+ Sibling notes (earlier feedback):
Related note 30s earlier: "Great introduction, clear setup"

= Refined Understanding:
"The pacing becomes slow after the strong introduction, specifically during
the product demo UI walkthrough (00:45-01:15). Consider cutting repetitive
clicks and jumping directly to the key feature."
```

- Maintain a sliding window of compressed frames in IndexedDB (count/byte capped) purely for in-session retries
- Upload frames to the backend/LLM immediately after capture
- Associate frames with timestamps + note IDs when the agent ingests them
- Store user interaction events (seeks, pauses, playback speed changes)
- Reference sibling notes when structuring new notes

---

### 3. Diffusion-Style Iterative Refinement

**Definition:** Treat the entire review session as a structured object (set of notes + relations) that iteratively improves as evidence accumulates, rather than generating notes autoregressively one-by-one.

**Mental Model:**
Think of note generation as **denoising a latent review state** rather than writing notes sequentially.

**Traditional Autoregressive Approach:**
```
Time 0:00 → Note 1: "Audio is too quiet"
Time 0:30 → Note 2: "Pacing is slow"
Time 1:00 → Note 3: "Audio levels inconsistent"  ← Redundant with Note 1!
```
Problems:
- Later notes don't fix earlier misunderstandings
- Accumulates redundancy (multiple notes about same issue)
- No cross-referencing or synthesis
- Terminology inconsistency across session

**Diffusion-Style Approach:**
```
Review Session State S = {notes, relations, evidence}

Iteration 0 (coarse anchors):
- "Audio issues noted at 0:00, 1:00"
- "Pacing concerns at 0:30"
[Low confidence, broad topics]

Iteration 1 (draft notes + evidence):
- Note 1: "Audio levels inconsistent" [confidence: 0.6]
  Evidence: transcript span 0:00-0:05, timestamp, user pause event
- Note 2: "Pacing is slow" [confidence: 0.5]
  Evidence: transcript span 0:30-0:35

Iteration 2 (merge redundant, add specificity):
- Merge Notes 1 & 3 → "Audio levels inconsistent - mix starts quiet,
  peaks at 1:00" [confidence: 0.8]
- Refine Note 2 with visual context → "Pacing is slow during product demo
  - cut repetitive clicks" [confidence: 0.85]

Iteration 3 (global coherence):
- Consistent terminology: "audio levels" vs "sound quality"
- Non-redundant: Ensure no overlapping notes
- Coverage: Identify gaps (sections with no feedback)
- Actionable: Ensure specificity ("cut repetitive clicks" vs "improve pacing")
```

**Why Diffusion > Autoregression:**
- **Global coherence**: Later iterations fix earlier mistakes
- **Non-redundancy**: Merge duplicate/overlapping notes
- **Evidence grounding**: Each note links to transcript + frames + user actions
- **Specificity**: Iteratively add detail as visual context arrives
- **Consistency**: Enforce uniform terminology and structure

**Key Operations:**
```elixir
# Coarse → Fine Denoising Schedule
1. Anchor Pass (cheap, immediate)
   - Create fuzzy anchors from VAD events + transcript bursts
   - Attach coarse topics (keywords/sentiment)
   - Don't render to user yet

2. Draft Pass (light text model)
   - Generate short draft notes around anchors
   - De-duplicate obvious overlaps (time proximity + keyword similarity)
   - Show drafts to user with low confidence opacity

3. Visual Confirmation (selective, triggered by rules)
   - For high-uncertainty or high-value sections (graphics, text, compliance)
   - Capture frame, send to GPT-4o Vision for description
   - Run OCR if text detected
   - Retime note bounds, add visual specificity

4. Global Tidy (periodic or end-of-session)
   - Merge semantically duplicate notes
   - Unify labels and terminology
   - Create summaries ("3 notes about pacing")
   - Fill gaps (sections with no feedback)

5. Commit/Export
   - Stabilize IDs (prevent UI flicker)
   - Finalize copy
   - Generate OTIO/EDL/Frame.io markers
```

**Agent Policy - "Which Operation Next?"**
Use a lightweight bandit or heuristic policy to prioritize:
- **Cheap, frequent**: `AddDraft`, `Relabel`, `LocalMerge`
- **Occasional**: `VisualConfirm`, `OCR`
- **Rare**: `GlobalMerge`, `TopicRebalance`, `SessionSummary`

Optimize for: **reducing energy per unit cost/latency**

**Energy Function (to minimize):**
```
Total_Energy =
  Redundancy_Penalty       (overlapping notes with similar claims)
  + Coverage_Reward        (hot regions get feedback)
  + Specificity_Reward     (concrete verbs, timecodes, suggestions)
  + Consistency_Penalty    (inconsistent terminology)
  + Grounding_Reward       (notes linked to evidence)
```

---

### 4. Frame Capture Rules & Adaptive Bandwidth

**Definition:** Systematically capture video frames based on configurable rules that adapt to client capabilities (network bandwidth, GPU availability, storage).

**Frame Capture Triggers (Target for Sprint 13+):**
```javascript
// Configurable rules (default values)
const frameCaptureRules = {
  // Capture when VAD detects speech start/stop
  onVadEvent: true,

  // Capture when video pauses/plays
  onVideoStateChange: true,

  // Capture when user scrubs timeline (debounced)
  onScrub: {
    enabled: true,
    debounceMs: 500  // Wait 500ms after last scrub before capturing
  },

  // Minimum interval if no other trigger fired
  minimumInterval: {
    enabled: true,
    intervalMs: 10000  // Capture at least every 10 seconds
  }
};
```

**Adaptive Bandwidth Strategy (Deferred):**
```javascript
// Adjust capture frequency based on client capabilities
function getAdaptiveRules(clientCapabilities) {
  const { bandwidthMbps, storageAvailableMB, gpuAvailable } = clientCapabilities;

  return {
    onVadEvent: true,  // Always capture on speech

    // Scale frame quality/frequency with bandwidth
    frameQuality: bandwidthMbps > 10 ? 'high' : 'medium',
    minimumInterval: bandwidthMbps > 5 ? 10000 : 30000,

    // Throttle if storage constrained
    maxLocalFrames: Math.min(storageAvailableMB / 2, 100)
  };
}
```

**Frame Storage & Lifecycle (Current → Future):**
```
Sprint 10 (current):
1. Capture → OffscreenCanvas (immediate, <50ms)
2. Compress → JPEG/WebP tuned to device constraints
3. Upload → Send directly to backend/LLM
4. Buffer → Retain in IndexedDB sliding window (count & byte capped) for retries
5. Evict → Drop once an acknowledgement arrives or entries age out

Future sprints:
6. Persist (transient) → Optional backend scratch storage for server-side refinement loops
7. Persist (durable)  → Object storage for archival tiers and full-video indexing
```

**Priority Queue:**
```
High Priority (send immediately):
- Text transcripts (small, time-sensitive)
- User-triggered actions (explicit "Refine with Vision")

Medium Priority (send when idle):
- Automatic frame captures (VAD events, video pauses) → sent as base64 JPEG to LLM
- Video frames for note context

Low Priority (batch send):
- High-resolution frames for archival (optional)
- OCR results
```

---

### 5. Holistic Session Reasoning

**Definition:** The agent reasons across the entire video and all accumulated notes, not just the current moment in isolation.

**Cross-Note Context:**
```elixir
# When creating Note N, agent considers:
defmodule Lossy.Agent.NoteReasoner do
  def create_note_with_context(transcript, state) do
    context = %{
      # Temporal context
      previous_notes: get_notes_before(state.timestamp, window: 60),
      next_notes: get_notes_after(state.timestamp, window: 60),

      # Topical context
      related_notes: find_similar_notes(transcript, threshold: 0.7),

      # Visual context
      frames_at_timestamp: get_frames_near(state.timestamp, window: 5),

      # User behavior context
      user_actions: get_recent_actions(window: 30),  # Pauses, seeks, replays

      # Global patterns
      session_themes: extract_themes(state.all_notes),
      terminology_style: infer_user_style(state.all_notes)
    }

    # LLM prompt includes all context
    structured_note = LLM.structure_with_context(transcript, context)

    # Post-process for consistency
    structured_note
    |> align_terminology(context.terminology_style)
    |> check_redundancy(context.related_notes)
    |> add_cross_references(context.previous_notes)
  end
end
```

**Agent Capabilities:**
- **Merge overlapping notes**: "These 3 notes about audio levels can be consolidated"
- **Update previous notes**: "Based on note at 2:00, I'm refining earlier note at 1:00 to be more specific"
- **Fill gaps**: "You've provided feedback on intro and conclusion, but not the middle section - would you like to review that?"
- **Synthesize themes**: "You've mentioned 'pacing' 5 times - here's a summary note"

**Implementation:**
```elixir
# AgentSession maintains full session state
defmodule Lossy.Agent.Session do
  defstruct [
    session_id: nil,
    user_id: nil,
    video_id: nil,

    # Full session context
    all_notes: [],
    all_frames: [],
    all_transcripts: [],
    user_actions: [],

    # Latent review state for diffusion
    review_state: %{
      notes: [],           # Current note set
      relations: [],       # Edges: overlaps, contradicts, supports
      evidence: [],        # Transcript spans, frames, OCR, tools
      energy: nil,         # Current energy score
      iteration: 0         # Denoising iteration count
    },

    # Continuous monitoring
    status: :observing | :processing | :refining,
    last_activity: nil
  ]

  # Periodic refinement loop
  def handle_info(:refine_review_state, state) do
    new_review_state =
      state.review_state
      |> apply_denoising_step()  # One iteration of diffusion
      |> reduce_energy()         # Merge duplicates, improve specificity

    # Broadcast updated notes to clients
    broadcast_note_updates(new_review_state.notes)

    # Schedule next refinement
    Process.send_after(self(), :refine_review_state, 5_000)  # Every 5 seconds

    {:noreply, %{state | review_state: new_review_state}}
  end
end
```

---

### 6. Latency-Budgeted Work Scheduling

**Definition:** The agent schedules work to maintain UI responsiveness, deferring expensive operations during active user interaction and processing during idle periods.

**Work Tiers:**
```javascript
// Immediate (<100ms) - Never deferred
const immediateWork = {
  displayDraftNote: true,       // Show text from transcript immediately
  updateWaveform: true,          // Visual feedback during recording
  videoSeek: true,               // Click timeline marker → seek video
  captureFrame: true             // Grab frame for context
};

// Fast (<500ms) - Run during pauses/scrubs
const fastWork = {
  localTranscription: true,      // Whisper Tiny
  keywordClassification: true,   // Text-based emoji chips
  localMergeNotes: true          // Combine nearby duplicates
};

// Medium (1-3s) - Run during idle or low activity
const mediumWork = {
  localTranscription: true,      // ONNX Whisper (local-only, Sprint 11)
  noteStructuring: true,         // GPT-4o-mini
  frameUpload: true,             // Send frames to backend for LLM vision
  ocrExtraction: true            // Text from frames
};

// Expensive (>3s) - Batch at end of sections or session
const expensiveWork = {
  visionRefinement: true,        // GPT-4o Vision API
  globalMerge: true,             // Deduplicate all notes
  semanticSearch: true,          // pgvector similarity queries
  sessionSummary: true           // High-level review synthesis
};
```

**Scheduler:**
```javascript
class WorkScheduler {
  constructor() {
    this.queue = {
      immediate: [],
      fast: [],
      medium: [],
      expensive: []
    };

    this.budget = {
      immediate: Infinity,        // Always run
      fast: 500,                  // 500ms per 5-second window
      medium: 2000,               // 2s per 5-second window
      expensive: 5000             // 5s per 30-second window
    };

    this.spent = {
      fast: 0,
      medium: 0,
      expensive: 0
    };
  }

  schedule(workItem, priority) {
    this.queue[priority].push(workItem);

    if (priority === 'immediate') {
      return this.execute(workItem);
    }

    // Defer based on budget availability
    this.processQueue();
  }

  processQueue() {
    // During active recording: Only immediate + fast work
    if (this.isUserActive()) {
      this.processQueueTier('fast');
      return;
    }

    // During pauses/scrubs: Fast + medium work
    if (this.isUserIdle()) {
      this.processQueueTier('fast');
      this.processQueueTier('medium');
    }

    // During long idle (>10s): All work including expensive
    if (this.getUserIdleTime() > 10000) {
      this.processQueueTier('expensive');
    }
  }
}
```

---

## Agentic Agent Architecture

> **Implementation Roadmap:** Always-on observation is being introduced in phases. Sprint 10 delivers passive audio triggers and a debug view while preserving the current per-recording backend. Sprint 11 adds local-only transcription with browser-based VAD. Sprint 12 improves passive mode quality with Silero VAD. Sprint 13 extends the lifecycle to continuous sessions. Frame capture and diffusion-style refinement land after persistent review state is in place. Each phase should be feature-gated so manual controls remain available during rollout.

### Agent Lifecycle

**Phase 1: Activation (Side Panel Opens)**
```
User opens side panel on video URL
  ↓
Service worker detects video context
  ↓
Backend: Spawn or resume AgentSession GenServer
  ↓
Initialize monitoring:
  - AudioChannel connection
  - VideoChannel connection
  - Frame capture rules
  - Local storage for session
  ↓
Agent enters :observing state
```

**Phase 2: Passive Observation**
```
Agent observes (no UI interruption):
  - Audio stream (VAD monitoring for speech)
  - Video playback state (play/pause/seek events)
  - Periodic frame sampling (minimum interval)

Stores locally:
  - Audio buffer (rolling 60s window)
  - Video frames as base64 JPEG (IndexedDB)
  - User interaction events

Uploads asynchronously:
  - Transcript fragments as they complete
  - Video frames (medium priority, sent to multimodal LLM)
  - User events (for behavior analysis)
```

**Phase 3: Active Processing (VAD Detects Speech)**
```
VAD detects speech start
  ↓
Capture timestamp + video state
  ↓
Buffer audio until VAD detects silence
  ↓
Trigger transcription (local Whisper or cloud)
  ↓
Automatic frame capture (rule-based)
  ↓
Send transcript + frame to backend
  ↓
AgentSession:
  - Structure note with cross-session context
  - Check for redundancy with existing notes
  - Generate draft with confidence score
  - Broadcast to UI
  ↓
Show draft note immediately (opacity based on confidence)
  ↓
Queue refinement work (medium priority)
```

**Phase 4: Iterative Refinement (Background)**
```
Every 5-10 seconds while session active:
  ↓
AgentSession.refine_review_state()
  ↓
Apply one denoising iteration:
  - Merge duplicate notes
  - Add visual specificity (from frames)
  - Improve consistency (terminology, structure)
  - Increase confidence scores
  ↓
Broadcast updates (only changed notes, incremental)
  ↓
UI updates in place (fade animation for changes)
```

**Phase 5: Session End (Side Panel Closes)**
```
User closes side panel or navigates away
  ↓
AgentSession: Persist full state to database
  ↓
Final refinement pass (global merge, session summary)
  ↓
Cleanup:
  - Upload remaining frames
  - Delete local IndexedDB entries
  - Close channels
  ↓
AgentSession enters hibernation (keep for 10 minutes for resume)
  ↓
If not resumed: Terminate GenServer
```

---

## Data Structures for Diffusion

### Review State
```elixir
defmodule Lossy.Agent.ReviewState do
  @type t :: %__MODULE__{
    notes: [Note.t()],
    relations: [Relation.t()],
    evidence: [Evidence.t()],
    iteration: integer(),
    energy: float()
  }

  defstruct [
    notes: [],
    relations: [],
    evidence: [],
    iteration: 0,
    energy: nil
  ]
end
```

### Note (Extended)
```elixir
defmodule Lossy.Agent.Note do
  defstruct [
    id: nil,
    timespan: {start_sec, end_sec},
    topic_labels: ["pacing", "audio"],
    text_draft: "Draft text",
    rationale: "Why this note exists",
    confidence: 0.0..1.0,
    evidence_refs: [
      {:transcript, span_id},
      {:frame, timestamp, frame_id},
      {:user_action, :pause, timestamp}
    ],
    status: :draft | :firmed | :posted | :archived
  ]
end
```

### Relations (Graph Edges)
```elixir
defmodule Lossy.Agent.Relation do
  @type relation_type ::
    :overlaps          # Time overlap
    | :duplicates      # Semantic similarity > 0.8
    | :contradicts     # Conflicting claims
    | :supports        # Reinforces claim
    | :sequence        # Note A precedes Note B
    | :refinement_of   # Note B is refined version of Note A

  defstruct [
    source_note_id: nil,
    target_note_id: nil,
    type: :overlaps,
    confidence: 0.0..1.0
  ]
end
```

### Evidence Cache
```elixir
defmodule Lossy.Agent.Evidence do
  defstruct [
    id: nil,
    type: :transcript | :frame | :ocr | :user_action,
    timestamp: nil,
    data: %{
      # For transcript: {text, start_time, end_time}
      # For frame: {base64_jpeg, width, height, trigger_reason}
      # For OCR: {text, bounding_boxes, confidence}
      # For user_action: {action, metadata}
    },
    refs: []  # Which notes reference this evidence
  ]
end
```

---

## Energy Function Implementation

```elixir
defmodule Lossy.Agent.EnergyFunction do
  @doc """
  Calculate total energy for current review state.
  Lower energy = better review quality.

  Goal: Minimize this score through denoising iterations.
  """
  def calculate_energy(review_state) do
    redundancy_penalty(review_state.notes)
    + coverage_penalty(review_state.notes, review_state.evidence)
    - specificity_reward(review_state.notes)
    - grounding_reward(review_state.notes, review_state.evidence)
    + consistency_penalty(review_state.notes)
  end

  # Penalize overlapping notes with similar claims
  defp redundancy_penalty(notes) do
    notes
    |> find_pairs_with_overlap()
    |> Enum.map(fn {note_a, note_b} ->
      time_overlap = calculate_time_overlap(note_a, note_b)
      semantic_similarity = calculate_semantic_similarity(note_a.text, note_b.text)

      # High penalty if both high overlap AND high similarity
      time_overlap * semantic_similarity * 10
    end)
    |> Enum.sum()
  end

  # Reward specific, actionable language
  defp specificity_reward(notes) do
    notes
    |> Enum.map(fn note ->
      # Count specific elements
      has_timestamp = String.contains?(note.text, ~r/\d+:\d+/)
      has_concrete_verb = String.contains?(note.text, ~r/(cut|trim|adjust|increase|decrease|replace)/)
      has_measurement = String.contains?(note.text, ~r/(\d+%|\d+dB|\d+px|\d+s)/)

      # More specific = higher reward
      (if has_timestamp, do: 2, else: 0) +
      (if has_concrete_verb, do: 3, else: 0) +
      (if has_measurement, do: 2, else: 0)
    end)
    |> Enum.sum()
  end

  # Reward notes linked to evidence
  defp grounding_reward(notes, evidence) do
    notes
    |> Enum.map(fn note ->
      evidence_count = length(note.evidence_refs)

      # More evidence = higher confidence
      cond do
        evidence_count >= 3 -> 5  # Transcript + frame + user action
        evidence_count == 2 -> 3  # Transcript + frame
        evidence_count == 1 -> 1  # Transcript only
        true -> 0                 # No evidence (bad!)
      end
    end)
    |> Enum.sum()
  end

  # Penalize inconsistent terminology
  defp consistency_penalty(notes) do
    # Extract all terms related to same concept
    term_groups = extract_term_groups(notes)

    # Penalize variation (e.g., "audio levels" vs "sound quality" vs "volume")
    term_groups
    |> Enum.map(fn group ->
      variation_count = length(group.variants)
      if variation_count > 1, do: variation_count * 2, else: 0
    end)
    |> Enum.sum()
  end
end
```

---

## Controller Policy (Which Operation Next?)

```elixir
defmodule Lossy.Agent.Controller do
  @doc """
  Decide which denoising operation to apply next.

  Strategy: Prioritize operations that reduce energy most per unit cost/latency.
  """
  def select_next_operation(review_state, budget) do
    operations = [
      # Cheap operations (run frequently)
      %{
        type: :local_merge,
        cost: 50,        # 50ms
        expected_benefit: calculate_merge_benefit(review_state),
        priority: :high
      },
      %{
        type: :relabel,
        cost: 20,        # 20ms
        expected_benefit: calculate_relabel_benefit(review_state),
        priority: :high
      },

      # Medium operations (run occasionally)
      %{
        type: :visual_confirm,
        cost: 1500,      # 1.5s (frame capture + GPT-4o Vision call)
        expected_benefit: calculate_visual_benefit(review_state),
        priority: :medium
      },
      %{
        type: :ocr,
        cost: 800,       # 800ms
        expected_benefit: calculate_ocr_benefit(review_state),
        priority: :medium
      },

      # Expensive operations (run rarely)
      %{
        type: :global_merge,
        cost: 5000,      # 5s (full graph traversal)
        expected_benefit: calculate_global_merge_benefit(review_state),
        priority: :low
      },
      %{
        type: :session_summary,
        cost: 3000,      # 3s (LLM synthesis)
        expected_benefit: calculate_summary_benefit(review_state),
        priority: :low
      }
    ]

    # Filter by budget
    affordable = Enum.filter(operations, &(&1.cost <= budget))

    # Sort by benefit-to-cost ratio
    affordable
    |> Enum.sort_by(&(&1.expected_benefit / &1.cost), :desc)
    |> List.first()
  end

  # Calculate expected benefit based on current review state
  defp calculate_merge_benefit(review_state) do
    # High benefit if many overlapping notes exist
    overlapping_pairs = find_overlapping_notes(review_state.notes)
    length(overlapping_pairs) * 10
  end

  defp calculate_visual_benefit(review_state) do
    # High benefit if notes have low confidence or mention visual elements
    review_state.notes
    |> Enum.filter(fn note ->
      note.confidence < 0.6 or mentions_visual_element?(note.text)
    end)
    |> length()
    |> Kernel.*(15)
  end
end
```

---

## UI Contract: Progressive Note Visibility

```javascript
// Notes appear progressively as confidence increases

// Phase 1: Anchor (immediate, after VAD)
<div class="note note-anchor" style="opacity: 0.3">
  <span class="timestamp">1:23</span>
  <span class="topic-chip">pacing</span>
  <!-- No text yet, just placeholder -->
</div>

// Phase 2: Draft (1-2s, after transcription)
<div class="note note-draft" style="opacity: 0.6">
  <span class="timestamp">1:23</span>
  <span class="topic-chip">pacing</span>
  <p class="note-text">The pacing is slow here</p>
  <span class="confidence">60%</span>
</div>

// Phase 3: Refined (3-5s, after visual context)
<div class="note note-refined" style="opacity: 0.9">
  <span class="timestamp">1:23-1:35</span>
  <span class="topic-chip">pacing</span>
  <p class="note-text">
    The pacing is slow during the product demo section -
    consider cutting the repetitive UI walkthrough
  </p>
  <span class="confidence">85%</span>
  <span class="evidence-count">3 evidence items</span>
</div>

// Phase 4: Firmed (user confirmation or timeout)
<div class="note note-firmed" style="opacity: 1.0">
  <span class="timestamp">1:23-1:35</span>
  <span class="topic-chip">pacing</span>
  <p class="note-text">
    The pacing is slow during the product demo section -
    consider cutting the repetitive UI walkthrough
  </p>
  <button class="post-btn">Post to Frame.io</button>
</div>
```

**Key UX Principles:**
- Show drafts immediately (low opacity) - gives instant feedback
- Progressively increase opacity as confidence grows
- Subtle fade animation when text updates (not jarring)
- "Why" affordance links to evidence (frame thumbnail + transcript + OCR)
- Merges show as "Combined 2 related notes" toast

---

## Engineering Implications

### Performance Budgets
```javascript
const performanceBudgets = {
  // Time from speech start to anchor visible
  anchoring: 100,     // 100ms

  // Time from silence to draft visible
  drafting: 1500,     // 1.5s (transcription + structuring)

  // Time from draft to refined
  refinement: 2000,   // 2s (frame capture + LLM structuring)

  // Global merge latency
  globalMerge: 5000,  // 5s (full graph traversal)

  // UI update latency (incremental)
  uiUpdate: 100       // 100ms (React/Vue diffing)
};
```

### Cost Governors
```elixir
defmodule Lossy.Agent.CostGovernor do
  @max_session_cost_cents 50  # $0.50 per session
  @max_vision_calls 20        # Max 20 GPT-4o Vision calls per session

  def can_run_operation?(session, operation) do
    case operation do
      :vision_refinement ->
        session.cost_spent < @max_session_cost_cents and
        session.vision_calls < @max_vision_calls

      :local_transcription ->
        true  # Free, always allow (Sprint 11: local-only)

      _ ->
        true
    end
  end

  def track_cost(session, operation, cost_cents) do
    %{session |
      cost_spent: session.cost_spent + cost_cents,
      vision_calls: session.vision_calls + (if operation == :vision_refinement, do: 1, else: 0)
    }
  end
end
```

### Robustness Guarantees
```elixir
# Never delete user-visible notes silently
defmodule Lossy.Agent.NoteOperations do
  @doc """
  Merge two notes - creates new note, archives originals (traceable).
  """
  def merge_notes(note_a, note_b) do
    merged = %Note{
      text: synthesize_text(note_a.text, note_b.text),
      timespan: merge_timespans(note_a.timespan, note_b.timespan),
      evidence_refs: note_a.evidence_refs ++ note_b.evidence_refs,
      confidence: (note_a.confidence + note_b.confidence) / 2,
      status: :draft
    }

    # Archive originals (don't delete!)
    Videos.update_note(note_a, %{status: :archived, merged_into: merged.id})
    Videos.update_note(note_b, %{status: :archived, merged_into: merged.id})

    Videos.create_note(merged)
  end
end
```

---

## When NOT to Use Diffusion

**Use Simple Autoregressive for:**
1. **Super short sessions** (1-2 notes) - Overhead not justified
2. **Real-time live review** where showing evolving drafts is distracting
3. **Streaming demos** where instant, fixed output is expected

**Use Diffusion for:**
1. **Multi-note review sessions** (5+ notes) - Global coherence pays off
2. **Async workflow** where notes refine in background
3. **High-quality output** where accuracy > speed

---

## Summary

**Agentic principles transform Lossy from a tool into a companion:**

1. **Context-Aware Passive Observation** - Always ready, never intrusive
2. **Progressive Evidence Accumulation** - Build understanding across modalities
3. **Diffusion-Style Iterative Refinement** - Global coherence, not autoregressive accumulation
4. **Frame Capture Rules & Adaptive Bandwidth** - Systematic visual context collection
5. **Holistic Session Reasoning** - Cross-note synthesis and consistency
6. **Latency-Budgeted Work Scheduling** - Maintain UI responsiveness

**Result:**
Notes that start as rough drafts and iteratively converge to precise, actionable feedback grounded in multimodal evidence.

---

**Next:** See `docs/sprints/SPRINT_11_local_only_transcription.md` for current implementation sprint (local-only transcription), and `docs/sprints/SPRINT_12_passive_mode_polish.md` for the next sprint (Silero VAD improvements). Sprint 10 (always-on foundations) is complete.
