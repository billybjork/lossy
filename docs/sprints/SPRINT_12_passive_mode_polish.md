# Sprint 12: Passive Mode Quality & Polish

**Status:** 📋 Planned
**Priority:** Medium
**Owner:** TBD
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (passive audio VAD baseline)
- 🔜 Sprint 11 – Automated Frame Capture
- 🔜 Sprint 13 – Continuous Session Persistence
- 🔜 Sprint 14+ – Diffusion & Cost Governance

---

## Purpose

Improve passive mode quality, accuracy, and user experience through ML-based VAD, visual feedback, debugging tools, and user-configurable settings. These enhancements address false positives, provide better visibility into system state, and allow users to adapt the system to their environment.

**Scope:** Passive mode quality improvements only. Does NOT include frame capture (Sprint 11) or continuous sessions (Sprint 13).

---

## Goals

### Primary Deliverables

1. **Silero VAD Integration**
   - Replace/supplement energy-based VAD with ML-based Silero ONNX model
   - WebAssembly/WebGPU inference in offscreen document
   - Fallback to energy-based VAD if Silero fails to load
   - Target: <5% false positive rate (down from 10-20%)

2. **Visual Status Indicators**
   - Status badge showing VAD mode (energy vs Silero vs disabled)
   - Real-time state indicator (observing, recording, cooldown, error)
   - Browser action badge for extension icon
   - Optional video overlay during recording

3. **Waveform Visualizer**
   - Real-time audio waveform in sidepanel
   - Energy threshold overlay
   - Visual confirmation that mic is working
   - Debugging tool for VAD tuning

4. **VAD Tuning UI**
   - User-adjustable sensitivity/threshold sliders
   - Min duration and cooldown controls
   - Preset configurations (quiet room, office, noisy environment)
   - Real-time preview of settings impact

5. **Automatic VAD Restart & Circuit Breaker**
   - Auto-restart VAD on heartbeat failure
   - Circuit breaker pattern (max restarts, backoff)
   - User notification when VAD fails permanently
   - Telemetry for reliability metrics

6. **Telemetry & Metrics Dashboard**
   - Display avg detection latency, false positive rate
   - Speech segments per session
   - VAD mode usage (energy vs Silero)
   - Export telemetry for analysis

### Success Criteria

- [ ] Silero VAD reduces false positive rate to <5% (measured in controlled environment)
- [ ] Status badge clearly shows current VAD state at all times
- [ ] Waveform visualizer helps users debug mic/VAD issues
- [ ] VAD tuning UI allows users to adapt to their environment
- [ ] Automatic restart recovers from 95% of VAD failures
- [ ] Telemetry dashboard provides actionable insights

---

## Detailed Requirements

### 1. Silero VAD Integration

**Current State:**
- Energy-based RMS detection (threshold 0.02)
- ~10-20% false positive rate in noisy environments
- Fast (<5ms per frame) but not very accurate

**Proposed Solution:**
- Silero VAD ONNX model (~2MB, silero_vad.onnx)
- Library: `@ricky0123/vad-web` or `onnxruntime-web`
- Hybrid mode: Silero for detection, energy as fallback
- Inference in offscreen document (AudioWorklet can't run ONNX)

**Architecture:**
```
AudioWorklet (energy threshold)
    │
    ├─ Energy > threshold? ──► Send frames to offscreen
    │
    ▼
Offscreen document (Silero ONNX)
    │
    ├─ Run inference (~20ms per frame)
    ├─ Confidence > 0.5? ──► speech_start
    │
    ▼
Service worker (passive event handler)
```

**Implementation Steps:**
1. Load Silero ONNX model in offscreen document
2. Add Silero inference function (takes Float32Array PCM, returns confidence)
3. Modify VAD detector to send frames to Silero when energy threshold met
4. Add fallback logic if Silero fails (use energy-only)
5. Add toggle in settings: "Enable ML-based VAD" (default ON if supported)

**Acceptance Criteria:**
- Silero loads successfully on supported browsers (Chrome/Edge with WebAssembly)
- False positive rate <5% in controlled testing
- Inference latency <50ms per frame
- Graceful fallback to energy-based VAD if Silero unavailable

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
  <span class="label">Observing (Silero)</span>
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

### 3. Waveform Visualizer

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

### 4. VAD Tuning UI

**Current State:**
- Energy threshold hardcoded (0.02)
- MIN_DURATION_MS hardcoded (500ms)
- COOLDOWN_MS hardcoded (500ms)
- No user control

**Proposed Solution:**

**Settings panel with sliders:**

```html
<div class="vad-tuning">
  <h3>VAD Sensitivity</h3>

  <label>
    Energy Threshold: <span id="threshold-value">0.02</span>
    <input type="range" id="energy-threshold" min="0.01" max="0.05" step="0.001" value="0.02">
  </label>

  <label>
    Min Duration (ms): <span id="duration-value">500</span>
    <input type="range" id="min-duration" min="200" max="2000" step="100" value="500">
  </label>

  <label>
    Cooldown (seconds): <span id="cooldown-value">3</span>
    <input type="range" id="cooldown" min="1" max="10" step="1" value="3">
  </label>

  <div class="presets">
    <button data-preset="quiet">Quiet Room</button>
    <button data-preset="office">Office</button>
    <button data-preset="noisy">Noisy Environment</button>
  </div>
</div>
```

**Presets:**
- **Quiet Room:** Threshold 0.01, Min 300ms, Cooldown 2s (sensitive, fast)
- **Office:** Threshold 0.02, Min 500ms, Cooldown 3s (default, balanced)
- **Noisy:** Threshold 0.04, Min 1000ms, Cooldown 5s (conservative, slow)

**Implementation Steps:**
1. Add settings UI to sidepanel
2. Persist settings to chrome.storage.local
3. Send config updates to offscreen document when changed
4. Update VAD detector to use dynamic thresholds
5. Show waveform preview for instant feedback

**Acceptance Criteria:**
- Settings persist across sessions
- Changes take effect immediately (<100ms)
- Waveform shows impact of threshold changes
- Presets cover common use cases

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

### 6. Telemetry & Metrics Dashboard

**Current State:**
- Telemetry logged to console only
- No persistent metrics
- No user-facing dashboard

**Proposed Solution:**

**Metrics to track:**
- VAD detection latency (median, p95, p99)
- False positive rate (user-reported via "Delete note" action)
- Speech segments per session
- VAD mode usage (energy vs Silero %)
- Restart attempts and success rate
- Session duration and note count

**Dashboard UI:**
```html
<div class="telemetry-dashboard">
  <h3>Passive Mode Metrics</h3>

  <div class="metric">
    <label>Detection Latency:</label>
    <span id="latency-median">127ms</span> (median)
  </span>

  <div class="metric">
    <label>False Positive Rate:</label>
    <span id="false-positive-rate">3.2%</span>
  </div>

  <div class="metric">
    <label>VAD Mode:</label>
    <span id="vad-mode">Silero (98% uptime)</span>
  </div>

  <div class="metric">
    <label>This Session:</label>
    <span id="session-stats">12 notes, 45min duration</span>
  </div>

  <button id="export-telemetry">Export Metrics (CSV)</button>
  <button id="reset-telemetry">Reset</button>
</div>
```

**Implementation Steps:**
1. Persist metrics to chrome.storage.local
2. Add telemetry dashboard to sidepanel (collapsible section)
3. Implement CSV export for analysis
4. Add "Report False Positive" button to notes (increments counter)
5. Weekly telemetry summary notification (optional)

**Acceptance Criteria:**
- Metrics persist across sessions
- Dashboard updates in real-time
- CSV export includes all metrics
- False positive tracking via user feedback

---

## Implementation Phases

### Phase 1: Silero VAD (2 weeks)
- Week 1: ONNX model integration, inference pipeline
- Week 2: Fallback logic, testing, tuning

### Phase 2: Visual Feedback (1 week)
- Status badge, browser action badge, optional overlay

### Phase 3: Debugging Tools (1-2 weeks)
- Waveform visualizer, VAD tuning UI

### Phase 4: Reliability (1 week)
- Circuit breaker, automatic restart, error handling

### Phase 5: Metrics (1 week)
- Telemetry dashboard, CSV export, false positive tracking

**Total Estimated Time:** 6-7 weeks

---

## Deferred Items (Sprint 13+)

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

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Silero model too large** | Slow load times, high bandwidth | Lazy load model on first use, cache in IndexedDB |
| **Silero inference too slow** | Increased latency, missed speech | WebGPU acceleration if available, fallback to energy-based |
| **Waveform rendering perf** | High CPU usage, battery drain | Throttle frame rate, use requestAnimationFrame, make optional |
| **Circuit breaker too aggressive** | VAD disabled when it could work | Conservative limits (3 restarts, 1min window) |
| **False positive tracking bias** | Users over-report false positives | Require confirmation, explain impact |
| **Telemetry storage limits** | chrome.storage.local quota exceeded | Rolling window (last 7 days), aggregate older data |

---

## Success Metrics

### Quality
- False positive rate <5% (down from 10-20% with energy-only)
- VAD detection latency <150ms median
- Silero uptime >95% (fallback <5%)

### User Experience
- Users can tune VAD to their environment (measured via settings usage)
- Waveform visualizer reduces "VAD not working" support requests by 50%
- Status badge improves user confidence in system state

### Reliability
- Auto-restart recovers from 95% of transient VAD failures
- Circuit breaker prevents endless restart loops
- Telemetry identifies failure patterns for future improvements

---

## Open Questions

1. **Silero model hosting:** Self-host or CDN? Trade-off: privacy vs speed
2. **WebGPU support:** Worth the complexity for faster inference?
3. **Waveform in main UI or debug drawer?** Balance: visibility vs clutter
4. **Telemetry opt-in or opt-out?** Privacy vs data quality
5. **False positive threshold:** What % is acceptable to users?

---

**Document Version:** 1.0 (Planning)
**Last Updated:** 2025-10-22
**Author:** Claude Code
