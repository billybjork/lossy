# Sprint 07: Hybrid Local Transcription (WASM Whisper)

**Status:** 🟡 Planned  
**Duration:** 3-4 days  
**Owner:** Extension + Backend pairing  
**Related Sprints:**  
- ✅ Sprint 01 – Audio Streaming (binary transport working)  
- ✅ Sprint 02 – Cloud Transcription & Note Structuring  
- 🔜 Sprint 08 – SigLIP Frame Embeddings (depends on shared GPU scheduler from this sprint)  

---

## Goal

Move transcription into the browser by default while preserving the existing cloud Whisper flow as an automatic fallback. This sprint wires Transformers.js Whisper Tiny into the offscreen document, streams partial/final transcripts to Phoenix, and updates the backend state machine so it no longer requires raw audio to reach OpenAI for every note.

### Success Metrics

- 🎯 End-to-end “ghost comment ready” latency ≤ 1.0 s on WebGPU-capable machines (5 s utterance).  
- 🎯 Local transcription usable on ≥ 70 % of target hardware (Chrome M-series laptops, recent Windows machines).  
- 🛟 Transparent fallback to cloud when local inference fails or capability probe reports insufficient resources.  
- 📊 Telemetry differentiates local vs cloud runs and captures transcription timing buckets.

---

## Prerequisites

- Phoenix Channels + AgentSession is stable (`lossy/lib/lossy/agent/session.ex`).  
- Service worker ↔︎ offscreen messaging is reliable (`extension/src/background/service-worker.js`, `extension/src/offscreen/offscreen.js`).  
- OpenAI API credentials configured for fallback path.  
- `@huggingface/transformers` dependency added to the extension workspace (`cd extension && npm install @huggingface/transformers`).  
- Feature flag plumbing agreed: extension reads `features.localSttEnabled` from `chrome.storage.local`, backend reads `LOCAL_STT_ENABLED` env var.  

---

## Deliverables

- [ ] Capability probe + cached model loader in the offscreen document (WebGPU first, WASM fallback).  
- [ ] Whisper Tiny integration using Transformers.js with streaming partial/final transcripts.  
- [ ] Updated AgentSession flow that accepts client-supplied transcripts and only hits `Lossy.Inference.Cloud.transcribe_audio/1` when needed.  
- [ ] Side panel UX showing transcription source (local/cloud) and partial output progress.  
- [ ] Structured telemetry + Phoenix logs for edge-case diagnostics (timeouts, device fallbacks).  
- [ ] Regression tests (unit + integration) covering both local and cloud flows.  

---

## Technical Tasks

### Task 0: Dependency & Feature Flag Wiring

**Files:** `extension/package.json`, `extension/src/shared/settings.js` (new), `lossy/config/runtime.exs`

- Install `@huggingface/transformers` and verify bundler configuration supports dynamic import (see `docs/TECHNICAL_REFERENCES.md §7`).  
- Add shared settings helper to read/write `features.localSttEnabled` from `chrome.storage.local` with sensible default (`"auto"`).  
- Gate Phoenix config with `LOCAL_STT_ENABLED` env var and expose via `Application.compile_env(:lossy, :local_stt_enabled, true)`.  
- Document manual override procedure in `docs/TECHNICAL_REFERENCES.md`.  

### Task 1: Capability Detection & Model Lifecycle (Offscreen)

**Files:** `extension/src/offscreen/offscreen.js`, new helper in `extension/src/offscreen/whisper-loader.js`  

- Implement probe sequence:
  - Check `navigator.gpu` / adapter limits.
  - Estimate available memory (heuristic from `performance.memory` when present; otherwise use user agent rules).
  - Respect user preference (settings toggle; default to auto).  
- Implement model loader:
  - Lazy-load `@huggingface/transformers` pipeline after first successful probe.
  - Cache binaries via Cache Storage (`onnx-models-v1`) + IndexedDB fallback (`docs/TECHNICAL_REFERENCES.md`).  
  - Handle cold-start progress events → service worker for UI messaging.  
- Add lightweight self-test (e.g., 1 s synthetic audio) to short-circuit to cloud when local inference is clearly too slow (>2 s).  
  ```javascript
  // See docs/TECHNICAL_REFERENCES.md §7 for context
  export function generateSyntheticAudio(sampleRate = 16_000) {
    const ctx = new AudioContext({ sampleRate });
    const buffer = ctx.createBuffer(1, sampleRate, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.05;
    }
    return buffer;
  }
  ```

### Task 2: Local Whisper Integration & Partial Streaming

**Files:** `extension/src/offscreen/offscreen.js`, new worker module if needed (`extension/src/offscreen/whisper-worker.js`)  

- Integrate Transformers.js Whisper Tiny EN with options (reference `docs/TECHNICAL_REFERENCES.md §7`):
  - `device: 'webgpu'`, `dtype: 'fp16'`, fallback to `'wasm'` and `int8`.  
  - Use chunked transcription (`chunk_length_s: 15`, `stride_length_s: 5`) to minimize RAM while allowing partial words.  
- Maintain rolling buffer keyed by VAD on/off:
  - When VAD detects speech start, start streaming partial transcripts every ~500 ms (`:asr_partial`).  
  - Emit `:asr_final` when speech ends or timeout reached; include word timestamps for future alignment.  
- Send transcripts through service worker to `AudioChannel` with new events:
  ```json
  { action: 'transcript_partial', sessionId, text, confidence }
  { action: 'transcript_final', sessionId, text, words, source: 'local' }
  ```
- On failure paths (exception, timeout, GPU lost), notify service worker to trigger cloud fallback (`action: 'transcript_fallback_required'`).  
- Introduce lightweight GPU job coordinator (`extension/src/offscreen/gpu-job-queue.js`) that prevents Whisper and upcoming SigLIP workloads from running concurrently; expose `enqueueGpuTask(kind, fn)` API for Sprint 08 reuse.  

### Task 3: Phoenix Channel & AgentSession Updates

**Files:** `lossy/lib/lossy_web/channels/audio_channel.ex`, `lossy/lib/lossy/agent/session.ex`, new helper `lossy/lib/lossy/inference/router.ex`  

- Extend `AudioChannel` to accept new events:
  - `"transcript_partial"` → broadcast to PubSub for LiveView progress.  
  - `"transcript_final"` → pass to AgentSession `handle_cast({:transcript, payload})`.  
- Update AgentSession state machine:
  - Track source (`:local | :cloud`) for metrics.  
  - If transcript arrives while still buffering audio, skip `Cloud.transcribe_audio/1`.  
  - Preserve existing cloud path when no transcript received after configurable grace period (e.g., 2 s after `stop_recording`).  
- Extract STT routing logic into dedicated module (per docs snippet `Lossy.Inference.STTRouter`), replacing HTTPoison with Req for all Whisper/GPT calls (includes refactoring `Lossy.Inference.Cloud` and updating `mix.exs`).  
- Emit telemetry events (`[:lossy, :stt, :started]`, `:completed`, `:fallback`) with metadata for dashboards.  

```
:listening
    │ (stop command / VAD silence with transcript pending)
    ├──────────────┐
    ▼              │
:transcribing (grace timer T)
    │   ┌──────────┘
    │   │ transcript_final before T expires
    ▼   │
:structuring (source: :local)
    │
    └─► completion / note created

If grace timer expires without transcript → fall back:
:transcribing (cloud) → call router → :structuring (source: :cloud)
```

### Task 4: Service Worker Coordination & UI Feedback

**Files:** `extension/src/background/service-worker.js`, `extension/src/sidepanel/sidepanel.js`  

- Expand message handling:
  - Relay partial/final transcript events to side panel immediately.  
  - When fallback triggered, stop local worker, send buffered audio to Phoenix, and surface status badge (“Cloud assist”).  
- Update current vanilla side panel (from Sprint 01) to surface status:
  - Display spinner with “Local STT (GPU)” or “Local STT (CPU)” depending on device and probe result.  
  - Show fallback toast when switching to cloud; reset once final transcript confirmed.  
- Ensure messages are scoped per tab via `MessageRouter` and add developer console logging guards to keep noise manageable.  

### Task 5: Observability, Error Handling & Cleanup

**Files:** `extension/src/shared/telemetry.js` (new), `lossy/lib/lossy/telemetry.ex`  

- Instrument timing in offscreen context and forward aggregated stats (e.g., histogram buckets).  
- Record fallback reasons (permission denied, model load error, GPU missing, slow inference).  
- Ensure offscreen document detaches models on suspension to free memory; rehydrate quickly on resume using caches.  
- Add feature flag/config to disable local STT remotely if major bug discovered (`chrome.storage.local.features.localSttEnabled`, `LOCAL_STT_ENABLED=false`).  
- Implement circuit breaker (`Lossy.Inference.CircuitBreaker`) that demotes a user/device to cloud after N consecutive local failures and resets after cool-down; persist counts in ETS or per-session cache.  
- Wire Phoenix Telemetry to LiveDashboard metrics (e.g., `lossy_stt_local_success_rate`, latency histograms).  

---

## Testing & Validation

- **Unit Tests (Elixir):**  
  - AgentSession transitions when receiving transcript before/after audio.  
  - STTRouter selects correct backend based on config/environment.  
- **Integration Tests (JS):**  
  - Mocked Transformers.js pipeline returning deterministic transcripts.  
  - Capability probe edge cases (no `navigator.gpu`, low memory).  
  - End-to-end fallback case: force local failure → ensure cloud transcription path runs and note persists.  
- **Manual QA:**  
  - Chrome stable on M-series MacBook (WebGPU).  
  - Windows laptop without WebGPU (forces WASM).  
  - Device with restricted permissions → ensure direct cloud fallback with clear UX.  
- **Telemetry Verification:** Confirm metrics flow to console/logs, and aggregator differentiates local vs cloud runs.  

---

## Rollout Plan

1. Ship behind feature flags: backend `LOCAL_STT_ENABLED` env var, extension `chrome.storage.local.features.localSttEnabled` (values: `"auto" | "force_local" | "force_cloud"`).  
2. Dogfood internally, collect telemetry for 24 h; monitor LiveDashboard metric `lossy_stt_local_success_rate`.  
3. Enable for beta cohort by pushing storage override via remote config service.  
4. Remove flag once telemetry confirms latency target and fallback rate <10 %; document migration plan for legacy cloud-only users.  

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Large model download delays first run | High latency at start | Warm caches during onboarding, prefetch on idle, display “Preparing transcription (~300 MB)” UX |
| WebGPU conflicts with SigLIP | Dropped frames / GPU errors | Shared job scheduler: queue siglip runs until STT idle; expose priority knobs |
| Transformers.js bundle size hits MV3 limits | Extension packaging failure | Lazy-load via dynamic import hosted on CDN; leverage Cache Storage instead of bundling weights |
| Fallback loop (local fails repeatedly) | User frustration | Circuit breaker disables local STT after N failures and persists preference |
| Privacy concerns about cached audio | Compliance issues | Confirm only text leaves browser when local active; document cache retention policy |

---

## Out of Scope

- Advanced diarization or multi-speaker separation (future enhancement).  
- Whisper model fine-tuning or multi-language support.  
- Deploying SigLIP inference (handled in Sprint 08).  
- Extension settings UI polish beyond basic toggle.  
- Migration of historical cloud-only transcripts to local-first storage model.  

---

## Done When

- Local-first transcription runs end-to-end with observed latency improvements.  
- Cloud fallback remains functional and covered by automated tests.  
- Telemetry dashboards confirm usage split and highlight failures.  
- Updated documentation (overview + architecture) checked in to reflect new default.  
