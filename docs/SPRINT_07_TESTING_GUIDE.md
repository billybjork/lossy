# Sprint 07: Local vs Cloud Transcription A/B Testing Guide

**Created:** 2025-10-20
**Purpose:** Compare latency and performance between local (Transformers.js Whisper) and cloud (OpenAI API) transcription

---

## Overview

This guide helps you measure and compare transcription performance between:
- **Local Transcription:** Whisper Tiny running in-browser via Transformers.js (WebGPU or WASM)
- **Cloud Transcription:** OpenAI Whisper API (cloud fallback)

The side panel now includes real-time transcription status indicators and toggles for easy mode switching.

---

## Prerequisites

### Backend Setup
1. Ensure Phoenix server is running:
   ```bash
   cd lossy
   mix phx.server
   ```

2. Verify OpenAI API key is configured in `.env`:
   ```bash
   OPENAI_API_KEY=sk-...
   ```

### Extension Setup
1. Extension should be built and loaded in Chrome:
   ```bash
   cd extension
   npm run build
   # Load dist/ folder as unpacked extension in Chrome
   ```

2. Open Chrome DevTools for extension debugging:
   - **Offscreen Document:** chrome://extensions → Lossy → "Inspect views: offscreen.html"
   - **Service Worker:** chrome://extensions → Lossy → "Inspect views: service worker"
   - **Side Panel:** Right-click in side panel → Inspect

---

## Side Panel UI Components

The side panel now includes a **Transcription Status** section with:

### Status Badge
- **LOCAL (WebGPU)** - Green badge indicating local transcription using GPU acceleration
- **LOCAL (WASM)** - Blue badge indicating local transcription using CPU fallback
- **CLOUD** - Yellow badge indicating cloud API transcription
- **CLOUD (FALLBACK)** - Yellow badge when local failed and fell back to cloud
- **INACTIVE** - Gray badge when no transcription is running

### Timing Information
Real-time display showing:
- Current transcription mode (Auto/Force Local/Force Cloud)
- Progress messages ("Transcribing locally...", "Transcribing via cloud...")
- Completion timing: "Completed in 2.34s (local)" or "Completed in 1.89s (cloud)"

### Mode Toggle Buttons
Three buttons to control transcription mode:

1. **Auto** (Default)
   - Attempts local transcription first
   - Falls back to cloud if local fails
   - Best for production use

2. **Force Local**
   - Only uses local transcription
   - Useful for testing local-only performance
   - Errors will not fall back to cloud

3. **Force Cloud**
   - Only uses cloud transcription (bypasses local)
   - Useful for testing cloud-only performance
   - Simulates pre-Sprint-07 behavior

---

## A/B Testing Procedure

### Test Setup

1. **Open a test video:**
   - Navigate to any supported platform (YouTube, TikTok, Frame.io, Vimeo, etc.)
   - Open the extension side panel
   - Verify "Video: HH:MM:SS" timestamp is updating

2. **Choose your test utterance:**
   - Prepare a consistent 5-10 second test phrase
   - Example: "This pacing feels a bit slow here, maybe speed it up in editing"
   - Use the same phrase for both local and cloud tests

### Test 1: Force Cloud (Baseline)

1. **Set mode to Force Cloud:**
   - Click "Force Cloud" button in side panel
   - Timing info should show: "Forced: Cloud transcription only"

2. **Record utterance:**
   - Click "🎤 Start Listening"
   - Status badge should remain INACTIVE (no local transcription)
   - Speak your test phrase clearly
   - Click waveform to stop recording

3. **Observe timing:**
   - Watch status badge change to "CLOUD"
   - Timing will show "Transcribing via cloud..."
   - Note the completion time: "Completed in X.XXs (cloud)"

4. **Check console logs:**
   - **Service Worker Console:**
     ```
     [Lossy] Starting cloud transcription...
     [Lossy] Cloud transcription complete in XXXXms
     ```
   - **Phoenix Logs:**
     ```
     [session_xyz] Starting cloud transcription (XXXXX bytes)
     [session_xyz] Cloud transcription complete in XXXXms: "This pacing feels..."
     ```

5. **Record results:**
   - Cloud transcription time: _______ ms
   - Total end-to-end time (start → note appears): _______ s

### Test 2: Force Local

1. **Reload the page:**
   - Refresh to clear audio buffers
   - Wait for video detection to complete

2. **Set mode to Force Local:**
   - Click "Force Local" button in side panel
   - Timing info should show: "Forced: Local transcription only"

3. **First run (cold start with model download):**
   - Click "🎤 Start Listening"
   - Speak the same test phrase
   - Click waveform to stop recording

4. **Observe model loading (first time only):**
   - **Offscreen Console:**
     ```
     [Offscreen] Loading Whisper model...
     [Offscreen] Detected capabilities: webgpu=true, device=webgpu
     [Offscreen] Model loaded (may take ~30s for first download)
     ```
   - Status badge shows "LOCAL (WebGPU)" or "LOCAL (WASM)"
   - Model is cached for subsequent uses (~100MB in browser cache)

5. **Observe transcription:**
   - Timing shows "Transcribing locally..."
   - **Offscreen Console:**
     ```
     [Offscreen] Transcribing 5.2s of audio
     [Offscreen] Local transcription complete in XXXXms
     [Offscreen] Transcript: "This pacing feels..."
     ```
   - Status shows completion time: "Completed in X.XXs (local)"

6. **Record results:**
   - Local transcription time (cold start): _______ ms
   - Total end-to-end time: _______ s
   - Device type (WebGPU or WASM): _______

7. **Second run (warm start with cached model):**
   - Record the same phrase again
   - Model should load instantly from cache
   - Observe faster initialization time
   - Local transcription time (warm start): _______ ms

### Test 3: Auto Mode (Recommended)

1. **Reload page and set to Auto:**
   - Click "Auto" button in side panel
   - Timing info: "Auto: Local with cloud fallback"

2. **Normal recording (local success):**
   - Record your test phrase
   - Should use local transcription
   - Badge shows "LOCAL (WebGPU)" or "LOCAL (WASM)"

3. **Forced fallback test (optional):**
   - To simulate local failure, disable network in DevTools while recording
   - Badge should show "CLOUD (FALLBACK)"
   - Timing: "Local failed, using cloud fallback"

---

## Expected Performance Benchmarks

Based on Sprint 07 goals:

| Metric | Local (WebGPU) | Local (WASM) | Cloud (OpenAI) |
|--------|----------------|--------------|----------------|
| **Cold Start** (first model load) | 30-60s | 45-90s | 0s (no model) |
| **Warm Start** (cached model) | <1s | 1-2s | 0s |
| **5s Audio Transcription** | 0.5-1.5s | 2-5s | 1-3s |
| **Total E2E Latency** (5s audio) | ≤1.0s | 2-6s | 2-4s |
| **Success Rate** | >70% | >90% | >99% |

### Target: Local (WebGPU) on M-series Mac
- **Goal:** ≤1.0s end-to-end latency for 5s utterance
- **Expected:** 0.5-1.5s transcription time + ~0.3s structuring = ~0.8-1.8s total

---

## Console Log Cheat Sheet

### Extension Logs to Watch

**Offscreen Document** (`chrome://extensions → Inspect offscreen.html`):
```javascript
[Offscreen] Detected capabilities: webgpu=true, device=webgpu, estimatedMemoryMB=XXX
[Offscreen] Loading Whisper model...
[Offscreen] Model loaded
[Offscreen] Transcribing 5.2s of audio
[Offscreen] Local transcription complete in 1234ms
[Offscreen] Transcript: "This pacing feels..."
```

**Service Worker** (`chrome://extensions → Inspect service worker`):
```javascript
[Lossy] Local transcript received: This pacing feels...
[Lossy] Local transcript sent to backend
```

**Side Panel** (`Right-click panel → Inspect`):
```javascript
[SidePanel] Transcription mode set to: auto
[SidePanel] 📝 Adding transcript for video XXXX
```

### Backend Logs to Watch

**Phoenix Console** (`mix phx.server`):
```elixir
[info] Final transcript received (local): This pacing feels... (XX bytes)
[info] [session_xyz] Received local transcript: This pacing feels...
[info] [session_xyz] Note structured (source: local): %{category: "pacing", ...}
```

Or for cloud:
```elixir
[info] [session_xyz] Starting cloud transcription (XXXXX bytes)
[info] [session_xyz] Cloud transcription complete in XXXXms: This pacing feels...
[info] [session_xyz] Note structured (source: cloud): %{category: "pacing", ...}
```

---

## Troubleshooting

### Local Transcription Not Starting

**Symptom:** Badge stays INACTIVE even in Force Local mode

**Check:**
1. Offscreen document console for errors
2. Verify WebGPU availability: `navigator.gpu` in offscreen console
3. Check `chrome://gpu` for WebGPU support
4. Verify settings: `chrome.storage.local.get(['localSttMode'])` in console

**Common Causes:**
- Browser doesn't support WebGPU (falls back to WASM)
- Transformers.js failed to load (check network in DevTools)
- Feature flag misconfigured

### Cloud Fallback Not Working

**Symptom:** Local fails but doesn't fall back to cloud

**Check:**
1. Verify mode is "Auto" not "Force Local"
2. Check service worker console for fallback messages
3. Verify Phoenix connection: AudioChannel should be connected
4. Check OpenAI API key configuration

### Model Download Stuck

**Symptom:** "Loading model..." never completes

**Check:**
1. Network tab in DevTools - should see ~100MB download from HuggingFace CDN
2. Check browser cache: DevTools → Application → Cache Storage
3. Try clearing cache and retry: `chrome.storage.local.clear()`

### Timing Numbers Don't Match Expectations

**Possible Reasons:**
- CPU throttling (Chrome DevTools can slow down execution)
- Network latency (affects cloud timing)
- First run includes model loading time
- GPU busy with other tasks
- Browser tab backgrounded (throttles execution)

---

## Data Collection Template

Use this template to record your test results:

```
## Test Run: [Date/Time]
**System:** [M1 Mac / Intel Mac / Windows]
**Browser:** Chrome [Version]
**WebGPU Available:** [Yes/No]

### Cloud Baseline (Force Cloud)
- Transcription Time: _____ ms
- End-to-End Time: _____ s
- Success: [Yes/No]

### Local (Force Local)
- **Cold Start:**
  - Model Load Time: _____ s
  - Transcription Time: _____ ms
  - End-to-End Time: _____ s
  - Device: [WebGPU/WASM]
  - Success: [Yes/No]

- **Warm Start:**
  - Transcription Time: _____ ms
  - End-to-End Time: _____ s
  - Success: [Yes/No]

### Auto Mode
- Transcription Time: _____ ms
- Source Used: [Local/Cloud]
- End-to-End Time: _____ s
- Success: [Yes/No]

### Notes:
[Any observations, issues, or unexpected behavior]
```

---

## Next Steps After Testing

1. **If local is faster:**
   - Verify accuracy matches cloud transcription
   - Test on multiple platforms (YouTube, TikTok, etc.)
   - Test with different audio conditions (background noise, accents)

2. **If cloud is faster:**
   - Check if model is loading from cache (warm start)
   - Verify GPU utilization (Activity Monitor / Task Manager)
   - Consider if model size could be optimized

3. **Report findings:**
   - Update Sprint 07 progress in `docs/sprints/SPRINT_07_local_transcription.md`
   - Document any edge cases or failures
   - Propose next steps for optimization
