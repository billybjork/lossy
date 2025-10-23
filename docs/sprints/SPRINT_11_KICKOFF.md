# Sprint 11 Implementation Kickoff

**Copy this prompt into your next Claude Code conversation to begin Sprint 11 implementation:**

---

## Context

I'm ready to start implementing **Sprint 11: Passive Mode Quality & Polish** for the Lossy video feedback extension. This sprint focuses on replacing the current energy-based VAD with **Silero VAD (ONNX + WebAssembly)** to fix critical bugs and improve accuracy.

## Critical Bug We're Fixing

The current energy-based VAD has a **critical infinite recording bug**:
- VAD detects `speech_start` but never detects `speech_end` in presence of background noise
- Background noise (keyboard, breathing, room tone) keeps energy above threshold
- Recording continues for 100+ seconds until backend force-transcribes
- Server logs show continuous `[warning] Max duration reached, forcing transcription`

**Root cause:** Energy threshold (0.02) can't distinguish speech from background noise, so it never sees 500ms of continuous silence needed to trigger `speech_end`.

## Sprint 11 Goals

Read the full spec: `@docs/sprints/SPRINT_11_passive_mode_polish.md`

**Primary deliverables:**
1. ✅ Silero VAD Integration (ONNX Runtime Web + WebAssembly)
2. ✅ Visual Status Indicators (status badge, browser action badge)
3. ✅ Auto-Pause Video During Speech (new proactive feature)
4. ✅ Waveform Visualizer (in debug drawer)
5. ✅ Automatic VAD Restart & Circuit Breaker
6. ✅ Debug Drawer Improvements (fix broken indicators)

**Success criteria:**
- False positive rate <5% (down from 10-20%)
- **Infinite recording bug eliminated:** 0% of recordings hit max duration
- Proper speech_end detection within 500ms of actual silence
- <10ms inference latency

## Current Architecture

**Existing VAD files:**
- `extension/src/offscreen/vad-detector.js` - EnergyVAD, SileroVAD (stub), HybridVAD
- `extension/src/offscreen/offscreen.js` - VAD lifecycle (startVAD, stopVAD)
- `extension/src/background/service-worker.js` - Passive event handler (speech_start/speech_end)

**Current flow:**
```
AudioWorklet (in offscreen.js)
  → EnergyVAD.processAudio()
  → Emits speech_start/speech_end
  → Service worker handles passive_event
```

**Problem:** EnergyVAD at lines 43-97 in vad-detector.js works correctly, but can't detect silence reliably.

## Implementation Plan

### Phase 1: Silero ONNX Integration (Start Here)

**Step 1:** Set up ONNX Runtime Web
- Add `onnxruntime-web` to package.json
- Research: Check latest stable version and WebAssembly backend setup
- Configure webpack to bundle ONNX Runtime properly

**Step 2:** Download/host Silero VAD model
- Model: `silero_vad.onnx` v5 (~2MB)
- Research: Find official Silero model URL (GitHub releases or CDN)
- Decision needed: Self-host or use CDN? (see Open Questions in sprint doc)
- Cache in IndexedDB or rely on browser cache?

**Step 3:** Implement SileroVAD class
- File: `extension/src/offscreen/vad-detector.js` (lines 128-155 are stubs)
- Implement `loadModel()` - load ONNX model, create inference session
- Implement `processAudio()` - run inference on Float32Array audio frames
- Match existing interface: emit speech_start/speech_end like EnergyVAD
- Use same state machine pattern: silence → speech → maybe_silence → silence

**Step 4:** Test Silero in isolation
- Create test harness in debug drawer
- Show inference latency, confidence scores
- Verify: speech_start and speech_end fire correctly

**Key Research Questions:**
1. What's the exact API for `onnxruntime-web` InferenceSession?
2. What input shape/format does Silero v5 expect? (likely 16kHz PCM, Float32Array)
3. What's the output format? (confidence score 0-1)
4. Do we need sample rate conversion in AudioWorklet or offscreen?

## Request for You

**Start with Phase 1, Step 1-2:**

1. Research the latest approach for integrating ONNX Runtime Web with Silero VAD in a Chrome extension
2. Find the official Silero VAD v5 ONNX model URL
3. Propose a specific implementation plan for loading the model (CDN vs self-host, caching strategy)
4. Show me example code for initializing ONNX Runtime Web with WebAssembly backend

Once we have ONNX Runtime set up and the model loading figured out, we'll implement the SileroVAD class.

## Reference Materials

- Sprint 11 spec: `@docs/sprints/SPRINT_11_passive_mode_polish.md`
- Agentic principles: `@docs/05_AGENTIC_PRINCIPLES.md` (for proactive behavior guidelines)
- Current VAD implementation: `@extension/src/offscreen/vad-detector.js`
- Current VAD usage: `@extension/src/offscreen/offscreen.js` (lines 540-703)

## Important Notes

- **No energy-based fallback** - WebAssembly is universally supported (99% Chrome 57+)
- **WebAssembly only** - No WebGPU (Silero is CPU-optimized, <1ms inference)
- **Clear error handling** - If model fails to load, show user-facing error message
- **Research-driven** - We researched this thoroughly, Silero is the right choice

---

Let's start by getting ONNX Runtime Web set up and the Silero model loading. Ready when you are!
