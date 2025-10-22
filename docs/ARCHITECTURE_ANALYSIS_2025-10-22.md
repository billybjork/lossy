# Lossy Video Note-Taking Extension - Current Architecture Analysis

**Analysis Date:** October 22, 2025
**Current Sprint:** 09 (Planning - Emoji Chips)
**Latest Shipped Features:** Sprint 08 (GPT-4o Vision), Sprint 07 (Local Whisper), Sprint 06 (Platform Adapters)

---

## Executive Summary

Lossy is a browser extension for capturing voice feedback while reviewing videos. The system combines client-side audio capture and ML inference with backend processing to generate structured, timestamped notes. The architecture emphasizes privacy (WASM-first transcription), real-time feedback, and multi-platform video support.

**Key Architectural Principle:** Strict separation between client (UI, audio, local inference) and server (business logic, external APIs, persistence).

---

## 1. VIDEO FRAME CAPTURE - Current State

### Architecture Overview

**Location:** `extension/src/content/core/frame-capturer.js`

Frame capture is fully implemented and production-ready. It supports two modes:

#### Mode 1: 224×224 Aspect-Ratio Stripped (for SigLIP embeddings in Sprint 09)
```
Video Frame → Canvas (224×224) → ImageData → getImageData()
```
- Used for fast embedding generation (input size matches SigLIP model)
- Fast inference: ~150ms WebGPU, ~600ms WASM

#### Mode 2: Aspect-Ratio Preserved (for visual quality in Sprint 08/Vision refinement)
```
Video Frame → Canvas (preserve aspect, max 1024px width) → Base64 JPEG (95% quality)
```
- Prevents squashing of portrait/unusual aspect ratio videos
- Better visual quality for GPT-4o Vision API
- Example: 9:16 video → 576×1024 frame (not 224×224)

### Key Features

**1. Timing Precision**
- Uses `requestVideoFrameCallback()` for precise synchronization when video is playing
- Falls back to `currentTime` when video is paused (critical fix in Sprint 08)
- Timeout safety: if callback doesn't fire within 100ms, uses immediate capture

**2. Error Handling**
- CORS error detection and clear error messages
- Graceful fallback for `OffscreenCanvas` unavailability
- Video readyState validation (requires `HAVE_CURRENT_DATA` or better)

**3. Performance**
- Uses `OffscreenCanvas` when available (better performance than DOM canvas)
- `willReadFrequently: true` optimization for repeated getImageData calls
- Batch capture support: `captureFramesAtTimestamps()`

**4. Current Usage**
- **Sprint 08:** Captured frames sent to GPT-4o Vision for note refinement (manual "Refine with Vision" button)
- **Sprint 09 (planned):** Will drive emoji chip generation via local SigLIP embeddings

### Integration Points

| Component | Flow |
|-----------|------|
| **Service Worker** | Receives `generate_frame_embedding` requests from side panel → routes to offscreen |
| **Offscreen Document** | Receives ImageData → generates embedding with SigLIP → sends back to service worker |
| **Backend (VideoChannel)** | Receives base64 frame → calls GPT-4o Vision API → updates note |

---

## 2. MODELS: Client vs Server Execution

### Client-Side Models (Browser)

#### Whisper (Speech-to-Text)
- **Model:** Xenova/whisper-tiny.en (280MB)
- **Location:** `extension/src/offscreen/whisper-loader.js`
- **Execution:** WASM (default) or WebGPU (if available)
- **Performance:**
  - WebGPU: 50-150ms per second of audio
  - WASM: 200-400ms per second of audio
- **Status:** ✅ Shipped (Sprint 07)
- **Fallback:** Cloud (OpenAI Whisper API) if device memory < 150MB

**Memory Requirements:**
```
Model: ~150MB
Runtime: ~100MB
Total: ~250MB minimum
Auto-fallback to cloud if <150MB available
```

**Capability Detection:**
```javascript
// In whisper-loader.js
export async function detectCapabilities() {
  - Check WebGPU availability (navigator.gpu)
  - Check available memory (performance.memory.usedJSHeapSize)
  - Determine device: 'webgpu' (FP16) or 'wasm' (int8)
  - Return canUseLocal flag
}
```

#### SigLIP (Frame-to-Embedding)
- **Model:** Xenova/siglip-base-patch16-224
- **Status:** ✅ Code complete (Sprint 08) - **Not yet used in production**
- **Location:** `extension/src/offscreen/siglip-loader.js`
- **Execution:** WASM (default) or WebGPU (if available)
- **Output:** 768-dimensional embedding vectors
- **Performance:**
  - WebGPU: 50-150ms per frame
  - WASM: 300-600ms per frame
- **Memory:** ~120MB minimum
- **Usage (Sprint 09):** Emoji chip generation (visual categorization)

**Planned Integration:**
```
Video Frame (224×224) → SigLIP Vision Encoder → 768-dim embedding
   ↓
Category Embeddings ("dark scene", "text overlay", "fast cuts")
   ↓
Similarity matching → Emoji display (e.g., 🌑 for "dark")
```

### Server-Side Models (Elixir Backend)

#### Cloud Transcription (OpenAI Whisper API)
- **When:** Local Whisper fails or user selects "Force Cloud" mode
- **Cost:** ~$0.02 per 15 minutes of audio
- **Latency:** 2-5 seconds
- **Quality:** Higher than local Whisper Tiny (uses Whisper Medium/Large)

#### LLM for Note Structuring (OpenAI GPT-4o-mini)
- **Purpose:** Convert raw transcript → structured feedback
- **Prompt:** "Extract actionable feedback, category, confidence"
- **Output:** `{ text, category, confidence }`
- **Cost:** ~$0.001-0.005 per note
- **Latency:** 500ms-2s

#### Vision API (OpenAI GPT-4o Vision)
- **Purpose:** Refine note text using captured video frame
- **Triggered:** User clicks "Refine with Vision" button (explicit, not automatic)
- **Input:** Base64 JPEG image + original note text
- **Output:** Enhanced note text with visual context
- **Cost:** ~$0.01 per refinement
- **Latency:** 1-3 seconds
- **Status:** ✅ Shipped (Sprint 08)

### Model Coordination: GPU Job Queue

**Problem:** Can't run Whisper + SigLIP simultaneously on WebGPU (single GPU).

**Solution:** GPU job queue with priority levels
- **Location:** `extension/src/offscreen/gpu-job-queue.js`
- **Priority Levels:** HIGH (Whisper), NORMAL (SigLIP), LOW (future)
- **Behavior:** Queue tasks, execute sequentially by priority
- **Timeout:** 30s for Whisper, 10s for SigLIP

```javascript
// Example usage in offscreen.js
await enqueueGpuTask(
  'whisper',
  async () => await transcriber(audio),
  { priority: JobPriority.HIGH, timeout: 30000 }
);
```

---

## 3. VAD & TRANSCRIPTION FLOW

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Extension (Browser)                                      │
│                                                          │
│ ┌──────────────────┐  ┌────────────────────────────┐   │
│ │ Side Panel UI    │  │ Offscreen Document         │   │
│ │ (mic button)     │→ │ - getUserMedia()           │   │
│ │                  │  │ - MediaRecorder (Opus)     │   │
│ │                  │  │ - VAD (ricky0123/vad-web)  │   │
│ │                  │  │ - Whisper Model (WASM)     │   │
│ └──────────────────┘  └────────────────────────────┘   │
│        ↓                            ↓                    │
│ Service Worker                      ↓                    │
│ - Routes messages          Audio Chunks (1s)            │
│ - Manages socket           + Full-length copy           │
│ - Coordinates audio        for cloud fallback           │
│        ↓                            ↓                    │
└────────────┼────────────────────────┼────────────────────┘
             │                        │
             ↓ Binary WebSocket       ↓ Both sent
          ┌──────────────────────────────────┐
          │ Backend: AudioChannel            │
          │ - Routes to AgentSession         │
          │ - Receives transcripts           │
          │ - Handles LLM structuring        │
          └──────────────────────────────────┘
             ↓
          AgentSession (GenServer)
             ↓
          Structure Note + Broadcast
```

### Step-by-Step Flow

#### Phase 1: Audio Capture
```
1. User clicks "Record" in side panel
2. Service worker sends "start_recording" to offscreen document
3. Offscreen doc creates AudioContext (16kHz, mono)
4. mediaRecorder.start(1000) → 1-second chunks
5. For local STT: ScriptProcessor captures raw Float32 audio
6. For cloud fallback: MediaRecorder captures WebM/Opus
```

**Settings (from `extension/src/shared/settings.js`):**
```javascript
LOCAL_STT_MODES = {
  AUTO:         // Auto-detect: local if capable, else cloud
  FORCE_LOCAL:  // Local-only (fail if not capable)
  FORCE_CLOUD:  // Cloud-only (skip local Whisper)
}
```

#### Phase 2: Local Transcription (if enabled)
```
1. Offscreen doc accumulates raw audio in audioBuffer
2. User stops recording (or 60s max duration)
3. AudioProcessor stops, offscreen receives stop message
4. If LOCAL enabled:
   a. Concatenate Float32 chunks into single buffer
   b. Enqueue "whisper" job in GPU queue
   c. Load Whisper model (or use cached)
   d. Call transcriber(audio, { chunk_length_s: 15, ... })
   e. Send "transcript_final" to service worker
5. If LOCAL fails:
   a. Send "transcript_fallback_required" to service worker
   b. Cloud fallback handled by backend
```

**Timing:**
- Model load (first time): 2-5s (WebGPU), 5-10s (WASM)
- Model load (cached): <100ms
- Transcription: 500ms-2s depending on duration

#### Phase 3: Backend Processing
```
1. Service worker receives "transcript_final" or audio chunks
2. Sends transcript_final or stops_recording to AudioChannel
3. AudioChannel forwards to AgentSession
4. AgentSession:
   a. If transcript_final: skip cloud transcription
   b. If audio chunks only: call Cloud.transcribe_audio()
5. Cloud.transcribe_audio():
   - Buffers until max 5MB or 60s
   - Calls OpenAI Whisper API
   - Returns transcript
6. structure_note(transcript):
   - Calls Cloud.structure_note(text)
   - GPT-4o-mini extracts: { text, category, confidence }
   - Creates note in database with status: "ghost"
7. Broadcasts note_created event
8. Side panel receives and displays
```

### Current Implementations

| Mode | Status | Notes |
|------|--------|-------|
| Local Whisper (WASM) | ✅ Shipped | Sprint 07 - default if capable |
| Local Whisper (WebGPU) | ✅ Code ready | Auto-used if GPU available |
| Cloud Whisper (OpenAI) | ✅ Shipped | Fallback, always available |
| Local SigLIP | ✅ Code ready | Not yet used, Sprint 09 will integrate |
| Cloud Vision (GPT-4o) | ✅ Shipped | Sprint 08 - manual "Refine with Vision" |

### VAD (Voice Activity Detection)

**Current Status:** Not implemented in shipping code

**Consideration:** `@ricky0123/vad-web` mentioned in docs but not found in current codebase.

**Behavior:** Currently uses **time-based silence detection**:
- User presses mic button
- Records until manual stop
- No automatic silence detection

**Future:** Could add VAD for automatic note boundary detection.

---

## 4. USER FEEDBACK MECHANISMS

### Real-Time UI Feedback (Side Panel)

**Location:** `extension/src/sidepanel/sidepanel.js` + `sidepanel.html`

#### Audio Recording Phase
```
┌─────────────────────────────┐
│ Live Waveform Canvas        │  ← Real-time frequency bars (FFT)
│ ████ ██ ███ █ ██████        │     Updates 60fps while recording
│ ████ ██ ███ █ ██████        │
└─────────────────────────────┘

Status Indicator: 🔴 RECORDING
Record Time: 0:00 → 0:15 → 0:30
```

**Implementation:**
```javascript
class LiveWaveform {
  constructor(canvas, options) { /* configurable */ }
  
  async start() {
    // getUserMedia for visualization (separate from recording)
    // Display frequency/amplitude bars in real-time
  }
  
  drawStaticMode() {
    // Bar chart visualization (current style)
  }
  
  drawScrollingMode() {
    // Scrolling waveform history (future option)
  }
}
```

#### Transcription Phase
```
Status: 🔄 TRANSCRIBING... (local)
Timing: 0ms → 500ms → 1000ms → "Complete in 1.2s"

Mode Badge: [LOCAL] or [CLOUD]
Device: (WebGPU) or (WASM) or (OpenAI)
```

**Elements:**
- `modeBadge` - Shows STT mode (AUTO/LOCAL/CLOUD)
- `timingInfo` - Shows transcription timing
- 3 buttons - Switch between modes (AUTO/FORCE_LOCAL/FORCE_CLOUD)

#### Note Creation Phase
```
┌─────────────────────────────────────────┐
│ 🎙️ "The pacing is slow here"           │  ← Voice input
│ ⬇️ TRANSCRIBING... (0.8s)               │
│ → "The pacing is slow here" (local)     │
│ ⬇️ STRUCTURING...                       │
│ ✅ The pacing is slow here              │  ← Final note
│    Category: PACING                     │
│    Confidence: 95%                      │
│ [Post] [Edit] [Refine with Vision] [×] │
└─────────────────────────────────────────┘
```

### Visual Overlays on Video (Content Script)

**Location:** `extension/src/content/` (various adapters + shared components)

#### 1. Timeline Markers
```
Video Progress Bar:
├─ ●●●●●──────────────────────
│  └─ Note timestamps
└─ Click marker to focus note in side panel
```
- Component: `extension/src/content/shared/timeline-markers.js`
- Shadow DOM for style isolation
- Monitors video metadata (duration loading)
- Auto-reflows on progress bar resize
- Reattaches after fullscreen/SPA navigation

#### 2. Anchor Chip
```
Video corner when recording:
┌──────────────────┐
│ 🎙️ Recording...  │  ← Shows recording state + timestamp
│ 0:15             │
└──────────────────┘
```
- Component: `extension/src/content/shared/anchor-chip.js`
- Displays during active recording
- Shows current timestamp
- Re-parents into fullscreen element

#### 3. Emoji Chips (Sprint 09, not yet shipped)
```
Video during recording:
┌──────────────────┐
│ 🌑 Dark Scenes   │  ← Visual category detected by SigLIP
│ 📊 Data Charts   │
│ 💬 Text Overlay  │
└──────────────────┘
```
- Will appear as video plays
- Auto-fade after 3s or category change
- Generated by local SigLIP embeddings
- No blocking - runs in background via GPU job queue

### Note Post-Creation Feedback

#### Status Badges
```javascript
"ghost"      → 👤 Draft (gray)
"firmed"     → 📌 Saved (blue)
"posted"     → ✅ Posted (green)
"error"      → ❌ Failed (red)
```

#### Refinement Feedback
```
[Refine with Vision]
↓
[Capturing...] (frame capture ~50ms)
↓
[Refining...] (GPT-4o Vision 1-2s)
↓
✅ Note refined with visual context
Text updates in real-time
Video pauses at timestamp (good UX for review)
```

### Smart Logging System

**Location:** `extension/src/content/utils/logger.js`

**Problem:** Extension runs on ALL pages (* pages), generates noise in casual browsing

**Solution:** Smart logger that respects verbosity context
```javascript
const log = createLogger('[VideoLifecycle]');

// Only outputs when:
// 1. Side panel is open (panel_opened message received)
// 2. DevTools console is visible
// Real errors always output (console.error)

log.debug('...')   // Suppressed unless verbose
log.info('...')    // Suppressed unless verbose
log.error('...')   // Always shown (important)
log.warn('...')    // Suppressed unless verbose
```

**Usage:**
```javascript
// In video-lifecycle-manager.js
log.info('Video detected')           // Hidden in casual browsing
console.error('Real failure')        // Always visible

// If panel opens:
chrome.tabs.sendMessage(tab, {action: 'panel_opened'})
// Logger re-enables debug output
```

---

## 5. VISUAL PROCESSING & CONTEXT CAPTURE

### Current Visual Features

#### A. Frame Capture (Implemented - Sprint 08)
- Canvas-based capture with `requestVideoFrameCallback()`
- 224×224 (embedding) or aspect-ratio-preserved (vision API)
- Base64 JPEG encoding for API transmission
- Handles CORS errors gracefully

#### B. Visual Intelligence via GPT-4o Vision (Shipped - Sprint 08)
**Feature:** "Refine with Vision" button on notes

```
User Flow:
1. Voice note created: "The pacing is slow here"
2. User clicks [Refine with Vision]
3. Frame captured at note timestamp
4. Frame + note sent to GPT-4o Vision API
5. API returns enhanced text with visual context
6. Side panel updates: "The pacing is slow during this product demo..."
7. Video pauses at timestamp for review
```

**Data Flow:**
```javascript
// Side panel button click
sidepanel.js → service-worker.js → content-script (capture frame)
                     ↓
            service-worker.js (base64 conversion)
                     ↓
            VideoChannel.refine_note_with_vision
                     ↓
            VisionAPI.refine_note (OpenAI API call)
                     ↓
            Note.update (text + enrichment_source: 'gpt4o_vision')
                     ↓
            PubSub broadcast → side panel updates
```

#### C. Local Frame Embeddings via SigLIP (Code Complete - Not Yet Shipped)

**Current Status:** Implemented in Sprint 08, deferred to Sprint 09 for emoji chips

```javascript
// extension/src/offscreen/siglip-loader.js
export async function generateEmbedding(imageData) {
  const { model, processor } = await loadSigLIPModel();
  const inputs = await processor(imageData);
  const output = await model(inputs);
  return output.pooler_output; // 768-dim Float32Array
}
```

**Planned Usage (Sprint 09):**
```
Video Frame (224×224) 
    ↓
SigLIP Vision Encoder → 768-dim embedding
    ↓
Similarity matching vs. category embeddings:
  - "dark scene" → calculate cosine similarity
  - "text overlay" → calculate cosine similarity
  - "fast cuts" → calculate cosine similarity
    ↓
Display top matching emoji (if similarity > threshold)
    ↓
Fade out after 3s or on category change
```

### Database Visual Context Storage

**Schema:** `videos/note.ex`
```elixir
schema "notes" do
  # ... existing fields ...
  field :enrichment_source, :string  # "none" | "siglip_local" | "gpt4o_vision"
  field :visual_context, :map        # JSON: { embedding, timestamp, device, ... }
end
```

**Updates via:**
- `VideoChannel.enrich_note` - Store embeddings (future)
- `VideoChannel.refine_note_with_vision` - Store refinement source (implemented)

### Platform-Specific Adaptations

**Location:** `extension/src/content/platforms/`

Different video platforms require different selectors/behaviors:

| Platform | Adapter | Status | Key Features |
|----------|---------|--------|--------------|
| YouTube | `youtube-adapter.js` | ✅ Shipped | SPA navigation handling, fullscreen reattachment |
| Vimeo | `vimeo-adapter.js` | ✅ Shipped | Player API integration, lazy-loaded video elements |
| Air.inc | `air-adapter.js` | ✅ Shipped | Custom selector for professional video review |
| Wipster | `wipster-adapter.js` | ✅ Shipped | Heuristic progress bar detection |
| Iconik | `iconik-adapter.js` | ✅ Shipped | Internal/external share view detection |
| TikTok | `tiktok-adapter.js` | ✅ Shipped | Unique DOM structure, fullscreen state |
| Generic | `generic-adapter.js` | ✅ Shipped | Fallback for any HTML5 video |
| FrameIO | `frameio-adapter.js` | ✅ Shipped | Professional collab tool, custom player |

**Adapter Pattern:**
```javascript
class BaseAdapter {
  async detectVideo() { /* Platform-specific selector */ }
  getProgressBar() { /* Platform-specific progress bar selector */ }
  isHealthy() { /* Check if adapter still valid */ }
}
```

---

## Client/Server Boundary Summary

### Clear Division of Responsibilities

**✅ EXTENSION (Client)**
- UI rendering and user interaction
- Audio capture and microphone access
- Video element detection and frame capture
- Local ML inference (Whisper, SigLIP via WASM/WebGPU)
- Real-time waveform visualization
- Shadow DOM overlay management
- Timeline marker rendering

**✅ BACKEND (Server)**
- All database operations (PostgreSQL)
- External API calls (OpenAI, Browserbase)
- Business logic (note structuring, intent extraction)
- Authentication and authorization
- Job orchestration (Oban queues)
- Real-time PubSub messaging (LiveView streams)
- Platform API integrations

### Data Flow Boundaries

```
Audio Chunks:  Browser → WebSocket binary frames → Backend
Transcripts:   Offscreen (WASM) → Browser → Backend text message
Embeddings:    Offscreen (WASM) → Browser → Backend JSON array
Video Frames:  Content Script → Browser → Backend base64 string
Structured Notes: Backend (LLM) → PubSub → Browser UI
```

**Key Rule:** Extension has ZERO direct database access - all data flows through WebSocket channels.

---

## Performance Characteristics

| Component | Latency | Bottleneck | Notes |
|-----------|---------|-----------|-------|
| Frame capture | ~50ms | Camera readiness | Uses requestVideoFrameCallback |
| Whisper (WASM) | 500ms-2s | Model inference | Depends on audio duration |
| Whisper (WebGPU) | 100-500ms | GPU bandwidth | 3-4x faster than WASM |
| GPT-4o-mini | 500ms-2s | API latency | Note structuring |
| GPT-4o Vision | 1-3s | API latency | Frame + refinement |
| Live Waveform | 60fps | Canvas rendering | Real-time frequency display |
| Timeline markers | <100ms | DOM insertion | Shadow DOM isolated |

---

## Known Limitations & Gaps

1. **No VAD (Voice Activity Detection)** - Uses manual stop, not silence detection
2. **SigLIP not in production** - Code complete but emoji chips (Sprint 09) not shipped
3. **No wake word detection** - Always requires manual mic button press
4. **No speaker diarization** - Single-speaker transcription only
5. **No multi-note merging** - Similar nearby notes not consolidated
6. **No persistent visual context** - Embeddings not yet stored in database
7. **No semantic search** - pgvector planned for Sprint 10

---

## Recommended Deep Dives

For specific implementation details, see:

1. **Audio Flow:** `lossy/lib/lossy/agent/session.ex` (80 lines, clear state machine)
2. **Frame Capture:** `extension/src/content/core/frame-capturer.js` (350 lines, well-documented)
3. **Offscreen Coordination:** `extension/src/offscreen/offscreen.js` (500 lines, complex state)
4. **Platform Detection:** `extension/src/content/platforms/bootstrap.js` (adapter selection logic)
5. **Service Worker Routing:** `extension/src/background/service-worker.js` (1300 lines, extensive)

---

## Technology Stack

**Frontend:** Chrome MV3, ES6+, Phoenix.js WebSocket client
**Backend:** Elixir/Phoenix 1.7, PostgreSQL, Oban
**ML Models:** Transformers.js (Whisper, SigLIP via Hugging Face)
**APIs:** OpenAI (Whisper, GPT-4o-mini, GPT-4o Vision), Browserbase
**State Management:** Service Worker (extension), GenServer (backend), PubSub (real-time)

