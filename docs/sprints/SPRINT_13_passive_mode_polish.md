# Sprint 13: Passive Mode Quality & Polish

**Status:** 📋 Planned
**Priority:** High
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD baseline)
- 🔜 Sprint 11 – Local-Only Transcription (browser-based VAD + transcription)
- 🔜 Sprint 13 – Continuous Session Persistence
- 🔜 Sprint 14+ – Automated Frame Capture & Diffusion

---

## Purpose

Improve passive mode quality, accuracy, and user experience through ML-based VAD (Silero ONNX), visual status indicators, waveform visualizer, and automatic restart capabilities. These enhancements will reduce false positives from ~10-20% to <5%, provide better visibility into system state, and improve reliability.

**Scope:** Passive mode quality improvements only. Does NOT include frame capture or continuous sessions (deferred to Sprint 13+).

---

## Goals

### Primary Deliverables

1. **Silero VAD Integration**
   - Replace energy-based VAD with ML-based Silero ONNX model
   - WebAssembly inference in offscreen document
   - No fallback (WebAssembly is universally supported in modern Chrome)
   - Target: <5% false positive rate (down from 10-20%)

2. **Visual Status Indicators**
   - Status badge showing current VAD state
   - Real-time state indicator (observing, recording, cooldown, error)
   - Browser action badge for extension icon
   - Optional video overlay during recording

3. **Auto-Pause Video During Speech** *(Proactive Agent Behavior)*
   - Automatically pause video when VAD detects speech start
   - Resume playback after speech ends (with configurable delay)
   - Prevents video audio from contaminating transcription
   - Keeps video from progressing while user is speaking
   - User can disable this behavior in settings (default: ON)
   - First-time users see brief explanation: "Video will auto-pause when you speak"

4. **Waveform Visualizer**
   - Real-time audio waveform in debug drawer
   - Visual confirmation that mic is working
   - Debugging tool for VAD issues
   - Shows when audio crosses detection threshold

5. **Automatic VAD Restart & Circuit Breaker**
   - Auto-restart VAD on heartbeat failure
   - Circuit breaker pattern (max restarts, backoff)
   - User notification when VAD fails permanently
   - Telemetry for reliability metrics

6. **Debug Drawer Improvements**
   - Fix non-functional indicators in current debug drawer
   - Show real-time VAD metrics (latency, detection count)
   - Display current session statistics
   - Logging for troubleshooting

### Success Criteria

- [ ] Silero VAD reduces false positive rate to <5% (measured in controlled environment)
- [ ] Status badge clearly shows current VAD state at all times
- [ ] Video automatically pauses/resumes during speech with <100ms latency
- [ ] Waveform visualizer helps users debug mic/VAD issues
- [ ] Automatic restart recovers from 95% of VAD failures
- [ ] Debug drawer shows accurate real-time metrics

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
- Silero VAD ONNX model (~2MB, silero_vad.onnx v5)
- Use `onnxruntime-web` directly (note: `@ricky0123/vad-web` is deprecated)
- WebAssembly-only (no WebGPU - unnecessary for VAD's <1ms inference time)
- Inference in offscreen document (AudioWorklet can't run ONNX)

**Why This Fixes the Bug:**
- **ML-trained speech/silence discrimination:** Silero distinguishes actual speech from background noise
- **Proper speech boundaries:** Returns confidence scores that clearly indicate speech vs silence
- **No energy threshold ambiguity:** ML model trained on thousands of hours of real-world audio
- **Result:** Reliable `speech_start` AND `speech_end` events, recordings stop properly

**Architecture:**
```
AudioWorklet (in offscreen.js)
    │
    ├─ Capture audio frames (128 samples, 8ms @ 16kHz)
    ├─ Send to offscreen document via postMessage
    │
    ▼
Offscreen Document - SileroVAD
    │
    ├─ Buffer audio until 512 samples available (32ms @ 16kHz)
    ├─ Run ONNX inference (<1ms per 512-sample frame)
    ├─ Maintain LSTM states (h, c) between frames
    ├─ Speech probability > 0.5? ──► speech_start event
    ├─ Speech probability < 0.35 for 500ms? ──► speech_end event
    │
    ▼
Service Worker (passive event handler)
    │
    ├─ On speech_start: Start recording, pause video
    ├─ On speech_end: Stop recording, resume video
    └─ Send audio to backend for transcription
```

**Implementation Steps:**
1. **Install dependencies:**
   - `npm install onnxruntime-web@1.22.0` - ONNX Runtime for WebAssembly
   - `npm install @ricky0123/vad-web@0.0.28` - For Silero v5 model file

2. **Configure webpack:**
   - Add CopyWebpackPlugin to copy `silero_vad_v5.onnx` to `dist/models/`
   - Copy ONNX Runtime WASM files to `dist/wasm/`
   - See "Research Findings" section for webpack config example

3. **Update manifest.json:**
   - Add `models/silero_vad_v5.onnx` and `wasm/*.wasm` to `web_accessible_resources`
   - Ensure CSP allows `wasm-unsafe-eval` if needed

4. **Implement SileroVAD class in vad-detector.js:**
   - `loadModel()` - Initialize ONNX Runtime with WebAssembly backend
   - `processAudio()` - Buffer 128-sample chunks until 512 samples available
   - `processFrame()` - Run inference on 512-sample frames with LSTM state management
   - `resetState()` - Reset LSTM h/c states to zeros
   - See "Research Findings" for complete code example

5. **Update HybridVAD:**
   - Remove energy-based fallback (per Sprint 13 goals)
   - Use Silero as primary VAD (no hybrid mode)
   - Handle model loading failures with clear error message

6. **Test and validate:**
   - Verify model loads successfully in offscreen document
   - Test speech detection with background noise (keyboard, breathing)
   - Confirm speech_end fires within 500ms of silence (fixes infinite recording bug)
   - Measure inference latency (<5ms target)

**Acceptance Criteria:**
- Silero loads successfully on Chrome 57+ (100% of potential extension users)
- False positive rate <5% in controlled testing
- **Proper speech boundary detection:** `speech_end` reliably detected within 500ms of actual silence
- No more "infinite recording" bug (recordings stop properly when user finishes speaking)
- Inference latency <5ms per 30ms audio frame
- Clear error message if model fails to load (with troubleshooting instructions)

---

### 2. Visual Status Indicators

**Current State:**
- Text status in sidepanel: "🎤 Passive mode enabled"
- No indication of VAD state (observing vs recording)
- No browser-level indicator

**Proposed Solution:**

**A. Sidepanel Status Badge:**
```html
<div class="vad-status-badge" data-state="observing">
  <div class="indicator"></div>
  <span class="label">Observing</span>
</div>
```

States:
- `disabled` (gray) - Passive mode off
- `observing` (green) - Listening for speech
- `recording` (red, pulsing) - Currently recording
- `cooldown` (yellow) - Cooldown period after recording
- `error` (red) - VAD failed

**B. Browser Action Badge:**
- Show recording count on extension icon
- Example: "3" (3 notes created this session)
- Red background when recording

**C. Optional Video Overlay:**
- Subtle indicator in video player during recording
- User can disable in settings

**Implementation Steps:**
1. Add CSS for status badge (colors, animations)
2. Update sidepanel.js to listen for passive_status_update events
3. Implement chrome.action.setBadgeText() for extension icon
4. Add optional canvas overlay in content script

**Acceptance Criteria:**
- Status badge updates in real-time (< 100ms latency)
- Browser badge shows current note count
- Overlay is non-intrusive and can be disabled

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

### 4. Waveform Visualizer

**Current State:**
- No visual feedback of audio input
- Difficult to debug VAD sensitivity issues

**Proposed Solution:**

**Canvas-based waveform display:**
- Real-time audio amplitude visualization
- Energy threshold line overlay
- Detected speech segments highlighted (green)
- 5-10 second history window

**Architecture:**
```
AudioWorklet
    │
    ├─ Sample audio every 100ms
    ├─ Send to offscreen via postMessage
    │
    ▼
Offscreen document
    │
    ├─ Forward to sidepanel via chrome.runtime.sendMessage
    │
    ▼
Sidepanel (Canvas rendering)
    │
    ├─ Draw waveform (requestAnimationFrame)
    ├─ Overlay threshold line
    └─ Highlight speech segments
```

**Implementation Steps:**
1. Add canvas element to sidepanel
2. Sample audio in AudioWorklet (downsampled to ~10Hz)
3. Broadcast samples to sidepanel
4. Render waveform with Canvas API
5. Add controls: zoom, pause, clear

**Acceptance Criteria:**
- Waveform updates at 10fps minimum
- Clearly shows when audio crosses threshold
- Helps users tune VAD sensitivity
- Performance: <5% CPU usage for rendering

---

### 5. Automatic VAD Restart & Circuit Breaker

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

### 6. Debug Drawer Improvements

**Current State:**
- Debug drawer exists in sidepanel but indicators are non-functional
- No real-time VAD metrics display
- Limited visibility into system state

**Proposed Solution:**

**Fix and enhance debug drawer:**
- Display current VAD state (observing, recording, cooldown, error)
- Show real-time detection metrics (latency, confidence scores)
- Session statistics (notes created, detection count, uptime)
- Error logging with timestamps
- Manual controls for fallback when needed

**Debug Metrics to Display:**
```javascript
{
  vadStatus: "observing" | "recording" | "cooldown" | "error",
  detectionLatency: "3ms",           // Last inference time
  lastConfidence: 0.85,              // Last Silero confidence score
  sessionsCreated: 12,               // Notes created this session
  detectionCount: 15,                // Total speech detections
  uptime: "45min",                   // How long passive mode running
  errors: [                          // Recent errors with timestamps
    { time: "14:32:15", msg: "Model load failed" }
  ]
}
```

**Implementation Steps:**
1. Fix broken indicators in current debug drawer
2. Add real-time VAD metrics display
3. Wire up Silero confidence scores to debug UI
4. Add session statistics tracking
5. Implement error log display with copy button

**Acceptance Criteria:**
- All debug drawer indicators functional and updating in real-time
- Metrics help troubleshoot VAD issues
- Error logs provide actionable information
- Debug drawer can be hidden/shown without affecting performance

---

## Implementation Phases

### Phase 1: Silero VAD Integration (1-2 weeks)

**Week 1: Foundation Setup**
- Day 1-2: Install dependencies, configure webpack, update manifest.json
- Day 3-4: Implement SileroVAD.loadModel() with ONNX Runtime Web initialization
- Day 5: Implement audio buffering (128 → 512 samples) and LSTM state management

**Week 2: Integration & Testing**
- Day 1-2: Implement SileroVAD.processFrame() with inference pipeline
- Day 3: Integrate with existing AudioWorklet in offscreen.js
- Day 4: Update HybridVAD to use Silero (remove energy fallback)
- Day 5: Testing and performance tuning (measure latency, test background noise handling)

**Key Deliverables:**
- ✅ Model loads from bundled extension file
- ✅ 512-sample frame buffering working
- ✅ LSTM states maintained between frames, reset on silence
- ✅ Infinite recording bug fixed (proper speech_end detection)
- ✅ Inference latency <5ms per frame

### Phase 2: Visual Indicators & Auto-Pause (1 week)
- Status badge in sidepanel
- Browser action badge for extension icon
- Optional video overlay during recording
- Auto-pause/resume video on speech detection
- Playback state tracking

### Phase 3: Waveform Visualizer (1 week)
- Canvas-based waveform in debug drawer
- Real-time audio amplitude visualization
- Threshold overlay for debugging

### Phase 4: Reliability & Circuit Breaker (1 week)
- Automatic VAD restart on failure
- Circuit breaker pattern with exponential backoff
- User notifications for permanent failures

### Phase 5: Debug Drawer Improvements (0.5 weeks)
- Fix broken indicators
- Wire up real-time metrics
- Add error logging

**Total Estimated Time:** 4-5 weeks

---

## Deferred Items (Sprint 13+)

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
| **Waveform rendering perf** | High CPU usage, battery drain | Throttle frame rate, use requestAnimationFrame, render in debug drawer only |
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
- Waveform visualizer reduces "VAD not working" support requests by 50%
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
   - AudioWorklet produces 128-sample chunks → buffer until 512 samples available
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
AudioWorklet (128 samples @ 16kHz, 8ms chunks)
    ↓
Buffer accumulator (until 512 samples available)
    ↓
Silero inference (512 samples → confidence score)
    ↓
State machine (silence → speech → maybe_silence → silence)
    ↓
Events: speech_start / speech_end
```

**Webpack Configuration:**
```javascript
// Copy model and WASM files to dist/
new CopyWebpackPlugin({
  patterns: [
    {
      from: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
      to: 'models/silero_vad_v5.onnx'
    },
    {
      from: 'node_modules/onnxruntime-web/dist/*.wasm',
      to: 'wasm/[name][ext]'
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
        "wasm/*.wasm"
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
- npm package: `@ricky0123/vad-web@0.0.28/dist/silero_vad_v5.onnx`
- CDN: `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.28/dist/silero_vad_v5.onnx`
- GitHub: `https://github.com/ricky0123/vad/blob/master/silero_vad_v5.onnx`
- Official: `https://github.com/snakers4/silero-vad` (original source)

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
3. **✅ Sample rate conversion:** Not needed (AudioWorklet already at 16kHz)
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
