# Sprint TBD: Automated Frame Capture Strategy

**Status:** 🔄 Deferred (was Sprint 13, now TBD)
**Priority:** Medium (deferred in favor of Sprint 11: Local-Only Transcription and Sprint 13: Passive Mode Polish)
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 08 – Visual Intelligence (manual "Refine with Vision" button)
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD)
- 🔜 Sprint 11 – Local-Only Transcription (browser-based VAD + transcription)
- 🔜 Sprint 13 – Passive Mode Polish (Silero VAD)
- 🔜 Sprint 14 – Continuous Session Persistence
- 🔜 Sprint 15+ – Diffusion Refinement & Cost Governance

**Note:** This sprint has been deferred to prioritize improving passive mode quality with Silero VAD. Frame capture will be revisited after continuous session persistence is established.

---

## Purpose

Automatically capture video frames during passive mode recordings to provide visual context for notes. This bridges the gap between Sprint 08's manual "Refine with Vision" button and a fully automated multimodal agent that understands both what was said and what was on screen.

**Key Constraint:** Must stay within cost budget ($0.50/session target from Sprint 15+) while providing meaningful visual enrichment.

---

## Goals

### Primary Deliverables

1. **Frame Capture Trigger Strategy**
   - Define when frames are captured (VAD events, time intervals, video events)
   - Implement frame extraction from video element using Canvas API
   - Route frames through existing visual intelligence pipeline (from Sprint 08)
   - Attach frame embeddings to notes automatically

2. **Client-Side Storage & Upload Queue**
   - IndexedDB sliding window for frame storage
   - Count-based and/or byte-based eviction limits
   - Upload queue with retry logic (exponential backoff)
   - Handle network failures gracefully

3. **Backend Persistence Decision**
   - **Option A:** No persistence (stream directly to LLM context)
   - **Option B:** Transient storage (Redis with TTL)
   - **Option C:** Durable storage (S3/blob storage)
   - Select based on cost, latency, and retrieval needs

4. **Cost Governance**
   - Frame capture rate limits (frames/minute, frames/session)
   - Upload size limits (KB/frame, MB/session)
   - GPT-4o Vision token accounting per session
   - User-facing quota indicators

5. **Quality Metrics & Telemetry**
   - Frames captured vs uploaded vs embedded
   - Upload success/failure rates
   - Storage usage (bytes in IndexedDB)
   - Cost per session tracking

### Success Criteria

- [ ] Frames automatically captured on speech detection (no user action required)
- [ ] Frame embeddings attached to notes and available for enrichment
- [ ] IndexedDB storage stays within limits (count + byte caps)
- [ ] Upload failures handled with retry (max 3 retries, exponential backoff)
- [ ] Average cost per session < $0.50 (tracked via telemetry)
- [ ] No regressions in note creation latency (<2s end-to-end)

---

## Open Questions (To Resolve in Sprint TBD)

### 1. Capture Trigger Strategy

**Options:**
- **A. VAD-only:** Capture frame on every `speech_start` event
- **B. Time-based:** Capture frame every N seconds during recording
- **C. Hybrid:** VAD + minimum interval (e.g., max 1 frame per 5 seconds)
- **D. Multi-trigger:** VAD + video pause/play + scrub events

**Tradeoffs:**
- VAD-only: Tight coupling to speech, may miss visual context before speech
- Time-based: Predictable cost, may capture irrelevant frames
- Hybrid: Balances relevance and cost, adds complexity
- Multi-trigger: Most comprehensive, highest cost

**Recommendation:** Start with **Option C (Hybrid)** - capture on speech_start but enforce minimum 5-second interval. Provides visual context for each utterance without excessive redundancy.

### 2. Storage Approach

**Options:**
- **A. Count-only limit:** Max 50 frames in IndexedDB, FIFO eviction
- **B. Byte limit:** Max 10 MB in IndexedDB, evict oldest when full
- **C. Sliding time window:** Keep last 30 minutes of frames
- **D. Hybrid:** Count AND byte limits (whichever hits first)

**Tradeoffs:**
- Count-only: Simple, but doesn't account for frame size variance
- Byte limit: Better resource control, requires size tracking
- Time window: Aligns with session duration, complex eviction logic
- Hybrid: Most robust, highest implementation complexity

**Recommendation:** Start with **Option D (Hybrid)** - max 50 frames AND max 10 MB. Protects against both excessive count and large files.

### 3. Backend Persistence

**Options:**
- **A. No persistence:** Frames sent to LLM context, discarded after
- **B. Transient (Redis):** Store for session duration + TTL (1 hour)
- **C. Durable (S3):** Permanent storage with embedding index

**Tradeoffs:**
- No persistence: Lowest cost, can't revisit frames for refinement
- Transient: Supports session replay, moderate cost, complexity
- Durable: Full audit trail, highest cost and storage overhead

**Recommendation:** Start with **Option B (Transient)** - store in Redis with 1-hour TTL. Allows note enrichment during session without long-term storage costs. Evaluate in Sprint 14 if permanent storage is needed.

### 4. Upload Retry Strategy

**Options:**
- **A. Immediate fail:** Single upload attempt, log failure
- **B. Simple retry:** Retry 3 times with fixed delay
- **C. Exponential backoff:** Retry with increasing delays (1s, 2s, 4s)
- **D. Queue persistence:** Save failed uploads to IndexedDB, retry on reconnect

**Tradeoffs:**
- Immediate fail: Simplest, loses frames on network blip
- Simple retry: Better reliability, may overwhelm failing network
- Exponential backoff: Industry standard, good balance
- Queue persistence: Most robust, high complexity

**Recommendation:** Start with **Option C (Exponential backoff)** - retry up to 3 times with 1s, 2s, 4s delays. Log failures but don't block note creation. Defer queue persistence to Sprint 14.

### 5. Cost Per Session Target

**Constraints:**
- GPT-4o Vision: ~$0.01 per frame (varies by resolution and tokens)
- Target budget: $0.50 per session (from Sprint 15+ planning)
- Calculation: $0.50 / $0.01 = **max 50 frames per session**

**Frame Capture Rate Analysis:**
- Typical session: 30 minutes
- Average speech segments: ~12 per session (based on Sprint 10 telemetry)
- Hybrid strategy (5-second min interval): ~12 frames per session
- **Headroom:** 50 frame budget - 12 actual = **38 frame buffer** ✅

**Recommendation:** Set hard limit at 50 frames per session. Current capture rate (~12 frames) is well within budget.

---

## Technical Design

### A. Frame Capture Flow

```
VAD detects speech_start
      │
      ▼
Service worker checks:
  - Last capture time > 5 seconds ago?
  - Session frame count < 50?
      │
      ├─ NO  ─► Skip capture (log telemetry)
      │
      └─ YES ─► Send message to content script
                  │
                  ▼
Content script captures frame:
  - Get video element current frame
  - Draw to Canvas (resize to 640x360)
  - Extract as JPEG blob (quality 0.8)
  - Send to offscreen document
                  │
                  ▼
Offscreen generates embedding:
  - Reuse visual intelligence pipeline
  - Generate 1536-dim vector
  - Return embedding + metadata
                  │
                  ▼
Service worker uploads:
  - Send to backend via Phoenix channel
  - Retry up to 3x on failure
  - Store in IndexedDB on success
                  │
                  ▼
Backend processes:
  - Store in Redis with session_id key
  - Attach embedding to AgentSession
  - Link to note via note_id
                  │
                  ▼
Note enrichment (async):
  - GPT-4o uses frame embedding in context
  - Enhances note.text with visual details
  - Updates note.confidence if visual context helps
```

### B. IndexedDB Schema

```javascript
// extension/src/shared/frame-storage.js

const FRAME_STORE_NAME = 'frames';
const MAX_FRAMES = 50;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const frameSchema = {
  id: 'uuid',              // Unique frame ID
  sessionId: 'string',     // Links to AgentSession
  noteId: 'string',        // Links to created note
  timestamp: 'number',     // Video timestamp (seconds)
  capturedAt: 'number',    // Capture time (Date.now())
  blob: 'Blob',            // JPEG image data
  size: 'number',          // Blob size in bytes
  embedding: 'Float32Array', // 1536-dim vector
  uploaded: 'boolean',     // Upload status
  retryCount: 'number'     // Retry attempts
};

// Eviction policy: FIFO when count > MAX_FRAMES OR total size > MAX_BYTES
```

### C. Backend Changes

**Phoenix Channel Handler:**
```elixir
# lib/lossy_web/channels/audio_channel.ex

@impl true
def handle_in("frame_upload", %{"frame" => frame_data, "metadata" => metadata}, socket) do
  session_id = socket.assigns.session_id

  # Store in Redis with 1-hour TTL
  frame_key = "session:#{session_id}:frame:#{metadata["frame_id"]}"
  Lossy.Cache.set(frame_key, frame_data, ttl: 3600)

  # Attach embedding to AgentSession
  case Lossy.Agent.Session.add_frame_embedding(session_id, metadata) do
    :ok ->
      {:reply, {:ok, %{uploaded: true}}, socket}

    {:error, reason} ->
      Logger.error("Frame upload failed: #{inspect(reason)}")
      {:reply, {:error, %{reason: "Upload failed"}}, socket}
  end
end
```

**AgentSession Update:**
```elixir
# lib/lossy/agent/session.ex

defmodule Lossy.Agent.Session do
  use GenServer

  defstruct [
    # ... existing fields ...
    frame_embeddings: [],     # List of {frame_id, embedding, timestamp} tuples
    frame_count: 0            # Telemetry counter
  ]

  def add_frame_embedding(session_id, metadata) do
    GenServer.call(via_tuple(session_id), {:add_frame_embedding, metadata})
  end

  @impl true
  def handle_call({:add_frame_embedding, metadata}, _from, state) do
    frame_embedding = {
      metadata["frame_id"],
      metadata["embedding"],
      metadata["timestamp"]
    }

    new_state = %{state |
      frame_embeddings: [frame_embedding | state.frame_embeddings],
      frame_count: state.frame_count + 1
    }

    Logger.info("[#{state.session_id}] Frame added (total: #{new_state.frame_count})")

    {:reply, :ok, new_state}
  end
end
```

---

## Implementation Phases

### Phase 1: Frame Capture (Week 1)
- [ ] Content script: Canvas-based frame extraction
- [ ] Service worker: Capture trigger logic (hybrid VAD + interval)
- [ ] Frame size optimization (resize to 640x360, JPEG quality 0.8)
- [ ] Telemetry: Capture rate, skip rate, frame sizes

### Phase 2: Storage & Upload (Week 2)
- [ ] IndexedDB frame store with eviction policy
- [ ] Upload queue with exponential backoff retry
- [ ] Phoenix channel `frame_upload` handler
- [ ] Redis transient storage with TTL

### Phase 3: Integration & Enrichment (Week 3)
- [ ] Link frames to notes via `note_id`
- [ ] AgentSession embedding accumulation
- [ ] Note enrichment with visual context (Task 6 from Sprint 08)
- [ ] Cost tracking telemetry

### Phase 4: Testing & Tuning (Week 4)
- [ ] End-to-end testing with real sessions
- [ ] Cost analysis (frames per session, $ per session)
- [ ] Performance testing (upload latency, storage limits)
- [ ] Tune capture rate and quality based on results

---

## Deferred Items (Sprint 14+)

### Sprint 14: Continuous Session Persistence
- Persistent upload queue (survive extension reload)
- Frame batch uploads (reduce channel overhead)
- Long-lived session frame history
- Durable storage decision (if needed)

### Sprint 15+: Diffusion & Cost Governance
- Frame relevance scoring (skip redundant frames)
- Smart frame selection (scene change detection)
- Cross-session frame deduplication
- User quota management and notifications

### Nice-to-Have (Not Scoped)
- Frame preview in sidepanel (thumbnail gallery)
- Manual frame delete (privacy controls)
- Frame annotation tools (draw bounding boxes)
- Export frames with notes (PDF report generation)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Upload failures** | Frames lost, visual context missing | Exponential backoff retry, log failures, don't block note creation |
| **Storage quota exceeded** | IndexedDB write failures | Eviction policy enforced before writes, telemetry alerts |
| **High cost per session** | Budget overrun ($0.50 target) | Hard limit at 50 frames, telemetry tracking, user quotas |
| **Embedding generation slow** | Increased note latency | Run embedding generation async, don't block note creation |
| **Backend Redis memory** | Storage costs | 1-hour TTL, monitor memory usage, evict on pressure |
| **Privacy concerns** | User discomfort with auto-capture | Clear UI indicators, settings to disable frame capture |

---

## Success Metrics

### Functional
- ✅ Frames captured on every speech segment (respecting interval limit)
- ✅ Frame embeddings attached to notes within 2 seconds of capture
- ✅ Upload success rate > 95% (with retry logic)
- ✅ Storage eviction works (no quota errors)

### Performance
- ✅ Frame capture latency < 200ms (Canvas extraction + encoding)
- ✅ Upload latency < 500ms (including embedding generation)
- ✅ No increase in note creation latency (still <2s end-to-end)

### Cost
- ✅ Average frames per session: ~12 (well under 50 budget)
- ✅ Average cost per session: <$0.20 (under $0.50 target)
- ✅ Storage usage: <5 MB per session average

### Quality
- ✅ Visual context improves note confidence scores (A/B test)
- ✅ User-reported value: "frames helped understanding" > 70%
- ✅ No false captures (frames from ads, loading screens filtered)

---

## Research Questions for Sprint TBD

1. **Optimal capture resolution:** 640x360 vs 1280x720 vs full HD? (cost vs quality tradeoff)
2. **JPEG quality setting:** 0.6 vs 0.8 vs 0.9? (file size vs visual fidelity)
3. **Embedding model:** Reuse Sprint 08 model or upgrade? (cost vs accuracy)
4. **Frame relevance:** How often do frames actually improve note quality? (measure confidence delta)
5. **User perception:** Do users want auto-capture or manual control? (UX research)

---

**Document Version:** 1.0 (Planning)
**Last Updated:** 2025-10-22
**Author:** Claude Code
