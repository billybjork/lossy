# Sprint 14: Passive Mode Quality & Polish

**Status:** 📋 Planned
**Priority:** High
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD baseline)
- 🔜 Sprint 11 – Local-Only Transcription (browser-based VAD + transcription)
- 🔜 Sprint 14 – Continuous Session Persistence
- 🔜 Sprint 15+ – Automated Frame Capture & Diffusion

---

## Purpose

Improve passive mode quality, accuracy, and user experience through ML-based VAD (Silero ONNX), visual status indicators, waveform visualizer, and automatic restart capabilities. These enhancements will reduce false positives from ~10-20% to <5%, provide better visibility into system state, and improve reliability.

**Scope:** Passive mode quality improvements only. Does NOT include frame capture or continuous sessions (deferred to Sprint 14+).

---

## Goals

### Primary Deliverables

1. **Silero VAD Integration**
   - Ship a single, always-on Silero v5 pipeline backed by `onnxruntime-web`
   - Run inference from the offscreen document using WASM with 512-sample frames
   - Surface clear errors + auto-retries when Silero cannot initialize (graceful degradation)
   - Target: <5% false positive rate (down from 10-20%) and reliable `speech_end` detection

2. **Passive Mode Feedback & Telemetry**
   - Reuse the existing passive status chip and waveform, wiring them to live Silero telemetry
   - Add Chrome action badge updates (recording state + note count)
   - Surface initialization / error states in the side panel and debug drawer
   - Optional lightweight video overlay remains deferred unless needed

3. **Auto-Pause Video During Speech** *(Proactive Agent Behavior)*
   - Automatically pause video when VAD detects speech start
   - Resume playback after speech ends (with configurable delay)
   - Prevent video audio from contaminating transcription and keep the timeline in sync
   - User can disable this behavior in settings (default: ON)
   - First-time users see brief explanation: "Video will auto-pause when you speak"

4. **Reliability Guardrails**
   - Auto-restart Silero on heartbeat failures with exponential backoff
   - Circuit breaker pattern (max restarts, cool-down window)
   - Clear status + user notification when VAD fails permanently
   - Telemetry for restart attempts and uptime

5. **Debug Drawer Instrumentation**
   - Wire the existing debug drawer elements to real metrics (latency, detections, errors)
   - Display current session statistics and last Silero confidence score
   - Provide quick actions for manual recovery when passive mode has failed

### Success Criteria

- [ ] Silero initializes successfully on supported Chrome builds and reduces false positives to <5%
- [ ] Passive status chip, waveform, and Chrome action badge reflect real VAD state within 100 ms
- [ ] Video automatically pauses/resumes during speech with <100 ms latency and respects manual pauses
- [ ] Auto-retry + circuit breaker recover from 95% of transient failures and surface errors clearly
- [ ] Debug drawer shows accurate real-time metrics (detections, latency, last confidence, restart count)

---

## Detailed Requirements

### 1. Silero VAD Integration

**Current State:**
- Energy-based RMS detection (threshold 0.02)
- ~10-20% false positive rate in noisy environments
- **Critical bug:** VAD often never detects `speech_end` in presence of background noise
  - Background noise (keyboard, breathing, room tone) keeps energy > threshold
  - Recording continues indefinitely until max duration (100s) forces transcription
  - Results in logs showing continuous "Max duration reached" warnings
- Fast (<5ms per frame) but not very accurate

**Proposed Solution:**
- Bundle the Silero v5 ONNX model (~2 MB) with the extension and run it via `onnxruntime-web`
- Keep inference inside the offscreen document, using a dedicated `AudioContext` + `ScriptProcessor` to feed frames
- Maintain a lightweight frame buffer (160-sample chunks → 512-sample tensors) and persist Silero LSTM state between calls
- Treat Silero as the single source of truth; if initialization fails, surface the error, stop passive mode, and offer retry guidance

**Why This Fixes the Bug:**
- **ML-trained speech/silence discrimination:** Silero distinguishes actual speech from background noise
- **Proper speech boundaries:** Returns confidence scores that clearly indicate speech vs silence
- **No energy threshold ambiguity:** ML model trained on thousands of hours of real-world audio
- **Result:** Reliable `speech_start` AND `speech_end` events, recordings stop properly while staying simple to reason about

**Architecture:**
```
Offscreen AudioContext (ScriptProcessor, 16 kHz, bufferSize 1024)
    │
    ├─ Capture audio frames (1024 samples ≈ 64 ms)
    ├─ Slice into 160-sample chunks, push into ring buffer
    │
    ▼
SileroVAD (onnxruntime-web, WASM)
    │
    ├─ Pull 512-sample tensors from buffer (≈32 ms of audio)
    ├─ Run inference (<1 ms per frame)
    ├─ Maintain LSTM (h, c) state between frames
    ├─ Speech probability > 0.5? ──► speech_start event
    ├─ Speech probability < 0.35 for 500 ms? ──► speech_end event
    └─ Report inference time + confidence back to telemetry stream
```

**Implementation Steps:**
1. **Install dependency:** `npm install onnxruntime-web@1.22.0` (already copying WASM via webpack).
2. **Vendor model:** Check in `silero_vad_v5.onnx` under `extension/public/models/` and extend CopyPlugin so the model ships in `dist/models/`.
3. **Update manifest.json:** Include `models/silero_vad_v5.onnx` and `onnx/*.wasm` in `web_accessible_resources`. MV3 already allows WASM; no CSP update needed beyond existing config.
4. **Implement SileroVAD:** Replace the placeholder class with real loading/inference logic, including:
   - `loadModel()` with WASM env configuration (`numThreads = 1`, custom `wasmPaths`)
   - Frame buffering utilities (160 → 512 samples)
   - LSTM state lifecycle + reset on silence or explicit stop
   - Confidence/latency reporting hooks for telemetry
   - Adjust the passive `ScriptProcessor` to `bufferSize = 1024` and feed the frame buffer continuously
5. **Retire HybridVAD:** Replace the current hybrid orchestrator with a single Silero-backed controller. On load failure:
   - Emit a `passive_event` error to the service worker
   - Stop passive mode, show actionable UI, and wait for user retry or automatic restart policy
6. **Test and validate:**
   - Confirm model loads in the offscreen document and respects MV3 sandboxing
   - Measure detection quality in quiet vs noisy environments (<5% false positives)
   - Verify `speech_end` fires within 500 ms of silence and prevents infinite recordings
   - Record inference latency (<5 ms target) and expose it in debug telemetry

**Acceptance Criteria:**
- Silero loads successfully on Chrome 57+ (100% of potential extension users)
- False positive rate <5% in controlled testing
- **Proper speech boundary detection:** `speech_end` reliably detected within 500ms of actual silence
- No more "infinite recording" bug (recordings stop properly when user finishes speaking)
- Inference latency <5ms per 30ms audio frame
- Clear error message if model fails to load (with troubleshooting instructions)

---

### 2. Passive Mode Feedback & Telemetry

**Current State:**
- Main side panel already shows a passive status chip + waveform container
- Waveform component runs locally but is not connected to real VAD telemetry
- Chrome action badge is unused, and debug drawer values are static placeholders

**Proposed Solution:**

**A. Wire existing UI to live data**
- Drive the passive status chip (`idle | observing | recording | cooldown | error`) directly from service-worker telemetry events
- Toggle the waveform container based on Silero state and update styling when recording
- Display last inference latency and Silero confidence under the debug drawer telemetry rows

**B. Chrome action badge**
- Show active recording count on the extension icon
- Highlight recording state (e.g., red badge background) while speech is in progress
- Clear badge when passive mode is idle or disabled

**C. Error surfacing**
- Reuse `passiveErrorMessage` element to show actionable Silero initialization failures
- Provide “Retry” / “Disable passive mode” quick actions inside the debug drawer
- Log failures with timestamps for easier debugging

**Implementation Steps:**
1. Extend `passive_status_update` payloads to include state, last latency, confidence, and note count.
2. Update `sidepanel.js` to hydrate the status chip, waveform, telemetry rows, and error area with those values.
3. Hook `chrome.action.setBadgeText()` / `setBadgeBackgroundColor()` into the service worker whenever passive state changes.
4. Add debug drawer buttons for “Retry VAD” and “Disable passive mode”, wiring them to service-worker commands.

**Acceptance Criteria:**
- Status chip, waveform, and badge update within 100 ms of state changes
- Users can see last Silero latency + confidence in the debug drawer
- Error states provide clear remediation without digging into console logs

---

### 3. Auto-Pause Video During Speech

**Current State:**
- Video continues playing while user speaks
- Video audio contaminates user's speech in transcription
- User must manually pause video before speaking
- Video timestamp continues advancing during feedback

**Proposed Solution:**

**Automatic pause/resume on VAD events:**
- When VAD detects `speech_start`: pause video immediately
- When VAD detects `speech_end`: wait brief delay (500ms), then resume playback
- Store pre-pause playback state (was it already paused?)
- Only resume if video was playing before speech started
- User setting to disable auto-pause (default: enabled)

**Architecture:**
```
Service worker (VAD event handler)
    │
    ├─ On speech_start:
    │   1. Query video playback state via content script
    │   2. If playing → send pause command
    │   3. Store state: {wasPlaying: true, timestamp: 1:23}
    │
    ├─ On speech_end:
    │   1. Wait 500ms (debounce in case user starts speaking again)
    │   2. Check stored state
    │   3. If wasPlaying → send play command
    │
    ▼
Content script (video control)
    │
    ├─ Receive pause/play commands
    ├─ Find video element via platform adapter
    ├─ Execute videoElement.pause() or .play()
    └─ Send confirmation back to service worker
```

**Implementation Steps:**
1. Add `pauseVideo()` and `resumeVideo()` methods to platform adapters
2. Modify service worker VAD handlers to send pause/resume messages
3. Add playback state tracking (was video playing before pause?)
4. Implement 500ms debounce before auto-resume
5. Add user setting: "Auto-pause video during speech" (default ON)
6. Show one-time onboarding tooltip: "💡 Video will auto-pause when you speak to prevent audio mixing"
7. Handle edge cases: user manually pauses during recording, video ends during speech

**Acceptance Criteria:**
- Video pauses within 100ms of speech detection
- Video resumes only if it was playing before speech (respects user's pause state)
- 500ms delay prevents resume if user speaks again quickly
- No pause/resume if user has disabled setting
- First-time users see one-time explanation of auto-pause behavior
- Works across all supported platforms (YouTube, Vimeo, etc.)

---

### 4. Reliability Guardrails

**Current State:**
- Heartbeat detects VAD failures (logged to console)
- No automatic restart
- User must manually restart passive mode

**Proposed Solution:**

**Circuit breaker pattern:**

```javascript
const circuitBreaker = {
  maxRestarts: 3,
  resetWindow: 60000, // 1 minute
  restartCount: 0,
  lastRestart: 0,
  state: 'closed' // closed, open, half-open
};

async function handleHeartbeatFailure() {
  if (circuitBreaker.state === 'open') {
    console.log('[Passive] Circuit breaker open, not restarting VAD');
    notifyUser('VAD failed permanently. Please check microphone and reload extension.');
    return;
  }

  const now = Date.now();
  if (now - circuitBreaker.lastRestart > circuitBreaker.resetWindow) {
    // Reset counter after 1 minute
    circuitBreaker.restartCount = 0;
  }

  if (circuitBreaker.restartCount >= circuitBreaker.maxRestarts) {
    // Open circuit
    circuitBreaker.state = 'open';
    console.error('[Passive] Max restart attempts reached, opening circuit');
    notifyUser('VAD failed after 3 restart attempts. Please reload extension.');
    return;
  }

  // Attempt restart
  circuitBreaker.restartCount++;
  circuitBreaker.lastRestart = now;

  console.log(`[Passive] Restarting VAD (attempt ${circuitBreaker.restartCount}/${circuitBreaker.maxRestarts})`);

  try {
    await stopVAD();
    await sleep(1000 * circuitBreaker.restartCount); // Exponential backoff
    await startVAD();

    // Success - transition to half-open
    circuitBreaker.state = 'half-open';
    console.log('[Passive] VAD restarted successfully');
  } catch (err) {
    console.error('[Passive] VAD restart failed:', err);
    // Try again on next heartbeat failure
  }
}
```

**Implementation Steps:**
1. Add circuit breaker state machine to service worker
2. Modify heartbeat handler to attempt restart on failure
3. Implement exponential backoff (1s, 2s, 3s delays)
4. Add user notifications for permanent failures
5. Telemetry: log restart attempts and success/failure

**Acceptance Criteria:**
- VAD auto-restarts on transient failures (mic permission temporarily denied)
- Circuit opens after 3 failed restart attempts
- User notified when VAD fails permanently
- Telemetry tracks restart success rate

---

### 5. Debug Drawer Instrumentation

**Current State:**
- Debug drawer exists in sidepanel but indicators are non-functional
- No real-time VAD metrics display
- Limited visibility into system state

**Proposed Solution:**

**Fix and enhance debug drawer:**
- Display current VAD state (observing, recording, cooldown, error)
- Show real-time detection metrics (latency, confidence scores)
- Session statistics (notes created, detection count, uptime, restart attempts)
- Error logging with timestamps + remediation shortcuts
- Manual controls for retrying Silero or disabling passive mode

**Debug Metrics to Display:**
```javascript
{
  vadStatus: "observing" | "recording" | "cooldown" | "error",
  detectionLatency: "3ms",           // Last inference time
  lastConfidence: 0.85,              // Last Silero confidence score
  sessionsCreated: 12,               // Notes created this session
  detectionCount: 15,                // Total speech detections
  uptime: "45min",                   // How long passive mode running
  restartAttempts: 1,                // Auto-restart count during session
  errors: [                          // Recent errors with timestamps
    { time: "14:32:15", msg: "Model load failed" }
  ]
}
```

**Implementation Steps:**
1. Fix broken indicators in current debug drawer
2. Add real-time VAD metrics display
3. Wire up Silero confidence and latency to debug UI
4. Add session statistics tracking (detections, notes, restart attempts, uptime)
5. Implement error log display with copy button + remediation actions

**Acceptance Criteria:**
- All debug drawer indicators functional and updating in real-time
- Metrics help troubleshoot VAD issues
- Error logs provide actionable information
- Debug drawer can be hidden/shown without affecting performance

---

## Implementation Phases

### Phase 1: Silero VAD Integration (1 week)
- Install `onnxruntime-web`, vendor Silero model, update webpack/manifest
- Implement SileroVAD load/inference pipeline + frame buffering
- Replace HybridVAD with Silero-only controller and expose telemetry hooks
- Smoke-test across quiet/noisy environments, record latency + confidence

### Phase 2: Passive Feedback & Telemetry (0.5 week)
- Extend service-worker telemetry payloads (state, latency, confidence, counts)
- Hook side panel status chip, waveform, and debug drawer to live data
- Add Chrome action badge + error UI wiring

### Phase 3: Auto-Pause Video (0.5 week)
- Add playback state capture + pause/resume helpers to platform adapters
- Integrate with passive event handler (500 ms resume debounce, respect manual pauses)
- Provide user setting + onboarding tip

### Phase 4: Reliability Guardrails (0.5 week)
- Implement heartbeat auto-retry with exponential backoff
- Add circuit breaker with user notification when threshold exceeded
- Capture restart telemetry + surface in debug drawer

### Phase 5: Debug Drawer Instrumentation (0.5 week)
- Wire metrics to UI, add restart/error logs, expose remediation actions
- Polish copy/styling and validate toggle performance

**Total Estimated Time:** ~3 weeks

---

## Deferred Items (Sprint 14+)

### VAD Tuning UI (Deferred - Not Currently Needed)
- User-adjustable sensitivity/threshold sliders
- Min duration and cooldown controls
- Preset configurations (quiet room, office, noisy)
- Real-time preview of settings impact

### Advanced VAD Features
- Speaker diarization (identify multiple speakers)
- Language detection (trigger different models per language)
- Noise cancellation preprocessing

### Advanced Tuning
- Per-platform VAD profiles (YouTube vs Vimeo)
- Adaptive threshold based on ambient noise
- Machine learning-based threshold optimization

### Privacy Controls
- Pause/resume passive mode per tab
- Exclude domains from passive mode
- Audio sample review before upload (paranoid mode)

### Full Telemetry Dashboard (Deferred)
- Persistent metrics storage
- CSV export for analysis
- False positive tracking via user feedback
- Weekly summary notifications

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Silero model fails to load** | VAD unusable, passive mode broken | Clear error message with troubleshooting steps, retry logic |
| **Silero inference slower than expected** | Increased latency, missed speech | Profile in real-world conditions, optimize sample rate conversion |
| **Auto-pause annoys users** | Users disable feature, poor UX | Make configurable (default ON), 500ms debounce, respect manual pause state |
| **Platform adapter pause/play fails** | Auto-pause doesn't work on some sites | Graceful degradation, test across all platforms, log failures |
| **Telemetry UI perf** | High CPU usage, battery drain | Throttle waveform updates, reuse existing canvas, only render when passive mode active |
| **Circuit breaker too aggressive** | VAD disabled when it could work | Conservative limits (3 restarts, 1min window), user can override |
| **WebAssembly compatibility** | Model won't run | Extremely low risk (99% browser support), but detect and show error if needed |

---

## Success Metrics

### Quality
- False positive rate <5% (down from 10-20% with energy-only)
- **Infinite recording bug eliminated:** 0% of recordings hit max duration timeout
- VAD detection latency <10ms median (Silero inference + overhead)
- Proper speech boundary detection: speech_end fires within 500ms of actual silence
- Silero uptime >99% (model loading success rate)

### User Experience
- Auto-pause prevents video audio contamination in transcripts
- Users can speak freely without manually pausing video
- Passive telemetry + error surfacing reduce "VAD not working" support requests by 50%
- Status badge improves user confidence in system state
- Debug drawer provides actionable troubleshooting information

### Reliability
- Auto-restart recovers from 95% of transient VAD failures
- Circuit breaker prevents endless restart loops
- Clear error messages guide users to solutions

---

## Research Findings & Implementation Decisions

**Research Date:** 2025-10-22
**Research Summary:** Comprehensive investigation into ONNX Runtime Web + Silero VAD integration for Chrome MV3 extensions

### Key Decisions Made

1. **✅ Silero model hosting:** Self-host (bundle with extension via webpack)
   - **NOT CDN** - ensures reliability, offline support, privacy, and no CORS issues
   - Model bundled in `extension/dist/models/silero_vad_v5.onnx` (~2MB)
   - Browser automatically caches extension files (no IndexedDB needed)

2. **✅ Model version:** Silero VAD v5 from `@ricky0123/vad-web@0.0.28`
   - v5 is proven stable (3x faster than v4, 6000+ languages)
   - v6 exists but v5 is battle-tested in production
   - Model file: `silero_vad_v5.onnx` (~2MB ONNX opset 15/16)

3. **✅ ONNX Runtime version:** `onnxruntime-web@1.22.0` (latest stable as of Jan 2025)

4. **✅ WebAssembly backend only:** NO WebGPU
   - Silero optimized for CPU (<1ms inference)
   - WebAssembly universally supported (Chrome 57+, 99% coverage)
   - Configuration: `numThreads: 1` (required for Chrome extensions), `simd: true`

5. **✅ Chrome MV3 compatibility:** Offscreen document architecture
   - Service workers have "no available backend found" errors with ONNX
   - Our existing offscreen document bypasses this limitation
   - WASM files served via `web_accessible_resources` in manifest.json

6. **✅ Frame size:** 512 samples (32ms at 16kHz)
   - Silero v5 requires exactly 512-sample frames (vs 1536 for legacy model)
   - ScriptProcessor (bufferSize 1024) slices into 160-sample chunks → buffer until 512 samples available
   - Processing ~31 frames/second at 16kHz

7. **✅ Confidence threshold:** 0.5 (recommended for v5)
   - Based on @ricky0123/vad defaults for Silero v5
   - Negative/silence threshold: 0.35
   - Can tune after initial testing if needed

8. **✅ LSTM state management:** Maintain hidden/cell states between frames
   - Input states: `h` [2,1,64], `c` [2,1,64] (initialized to zeros)
   - Output states: `hn` [2,1,64], `cn` [2,1,64] (feed back as next input)
   - Reset to zeros when speech ends (isolate utterances)

9. **✅ Model caching:** Browser cache (automatic for extension files)
   - No IndexedDB implementation needed
   - Extension files cached by Chrome automatically
   - Model loads from disk on offscreen document creation

10. **✅ Waveform location:** Debug drawer only (reduces clutter)

11. **✅ VAD Tuning UI:** Deferred (Silero defaults work well)

12. **✅ Telemetry dashboard:** Deferred (focus on basic debug metrics)

### Model Specifications (Silero VAD v5)

**Input Tensors:**
- `input`: Float32Array, shape `[1, 512]` - normalized audio samples [-1.0, 1.0]
- `sr`: Int64Array, shape `[1]` - sample rate (always 16000)
- `h`: Float32Array, shape `[2, 1, 64]` - LSTM hidden state
- `c`: Float32Array, shape `[2, 1, 64]` - LSTM cell state

**Output Tensors:**
- `output`: Float32Array, shape `[1, 1]` - speech confidence [0.0, 1.0]
- `hn`: Float32Array, shape `[2, 1, 64]` - updated hidden state
- `cn`: Float32Array, shape `[2, 1, 64]` - updated cell state

**Performance:**
- Inference latency: <1ms per 512-sample frame
- Model size: ~2MB
- Sample rate: 16kHz (also supports 8kHz)
- Languages: 6000+

### Implementation Architecture

**Model Loading:**
```javascript
// In offscreen document
import * as ort from 'onnxruntime-web';

// Configure for Chrome extension
ort.env.wasm.numThreads = 1; // Required for extensions
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = chrome.runtime.getURL('wasm/');

// Load model
const modelPath = chrome.runtime.getURL('models/silero_vad_v5.onnx');
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all'
});
```

**Audio Processing Flow:**
```
ScriptProcessor (bufferSize 1024, 16 kHz mono)
    ↓
Slice to 160-sample Float32 frames
    ↓
Ring buffer (collect 3 x 160 frames → 512-sample tensor)
    ↓
Silero inference (512 samples → confidence score, <1 ms)
    ↓
State machine (silence → speech → maybe_silence → silence)
    ↓
Events + telemetry: speech_start / speech_end / error
```

**Webpack Configuration:**
```javascript
// Copy model and WASM files to dist/
new CopyWebpackPlugin({
  patterns: [
    {
      from: 'public/models/silero_vad_v5.onnx',
      to: 'models/silero_vad_v5.onnx'
    },
    {
      from: 'node_modules/onnxruntime-web/dist/*.wasm',
      to: 'onnx/[name][ext]'
    },
    {
      from: 'node_modules/onnxruntime-web/dist/*.mjs',
      to: 'onnx/[name][ext]'
    }
  ]
})
```

**Manifest.json Updates:**
```json
{
  "web_accessible_resources": [
    {
      "resources": [
        "models/silero_vad_v5.onnx",
        "onnx/*.wasm"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### Reference Implementation

**Proven working implementation:** `@ricky0123/vad` (GitHub: ricky0123/vad)
- Production-ready browser VAD using ONNX Runtime Web + Silero
- Successfully handles Chrome extension constraints
- Source available for reference

**Model URLs (for reference):**
- Primary source: `https://github.com/snakers4/silero-vad` (official releases)
- Mirror: `https://github.com/ricky0123/vad/blob/master/silero_vad_v5.onnx`
- npm mirror: `@ricky0123/vad-web@0.0.28/dist/silero_vad_v5.onnx` (use for verification only)

### Chrome Extension Challenges & Solutions

**Challenge 1:** Service workers can't initialize ONNX Runtime WASM backend
- **Error:** "no available backend found", "import() is disallowed on ServiceWorkerGlobalScope"
- **Solution:** Use offscreen document (already implemented in Sprint 10)

**Challenge 2:** WASM files fail to load in extension context
- **Error:** "Failed to fetch" for .wasm files
- **Solution:** Configure `web_accessible_resources` + `ort.env.wasm.wasmPaths`

**Challenge 3:** Multithreading breaks in extension environment
- **Error:** SharedArrayBuffer / Web Workers unavailable in some contexts
- **Solution:** Set `numThreads: 1` (Silero is fast enough single-threaded)

### Answered Questions

1. **✅ Silero confidence threshold:** 0.5 (default for v5, can tune later)
2. **✅ Model caching:** Browser cache (automatic, no IndexedDB)
3. **✅ Sample rate conversion:** Not needed (offscreen AudioContext already runs at 16 kHz)
4. **✅ False positive threshold:** <5% is achievable with Silero v5
5. **✅ Model hosting:** Self-host bundled with extension (NOT CDN)

### Remaining Open Questions

1. **Parameter tuning:** Should we adjust `minSpeechDurationMs` or `minSilenceDurationMs` for Silero?
   - Current: 500ms speech minimum, 500ms silence to trigger speech_end
   - Silero may allow shorter thresholds due to better accuracy

2. **Negative threshold:** Use 0.35 for negative/silence detection (from @ricky0123/vad)?
   - Could help with faster speech_end detection

3. **State reset timing:** Reset LSTM states on every silence, or maintain across session?
   - Current plan: Reset on speech_end (isolate utterances)
   - Alternative: Maintain states across entire session

---

**Document Version:** 3.0 (Research Findings & Implementation Decisions)
**Last Updated:** 2025-10-22
**Author:** Claude Code
**Changes from v2.1:** Added comprehensive "Research Findings & Implementation Decisions" section with:
- ONNX Runtime Web + Silero VAD v5 integration research
- Detailed model specifications (input/output tensors, LSTM states)
- Chrome MV3 extension challenges & solutions
- Self-host model decision (bundled via webpack, NOT CDN)
- Complete implementation architecture with code examples
- Answered all open questions from previous versions
**Changes from v2.0:** Added auto-pause video during speech (deliverable #3)
**Changes from v1.0:** Removed energy-based fallback (unnecessary with 99% WebAssembly support), removed WebGPU (Silero optimized for CPU), deferred VAD Tuning UI and full Telemetry Dashboard (not currently needed), reduced timeline from 6-7 weeks to 4-5 weeks
