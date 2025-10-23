# Sprint 11: Local-Only Transcription Simplification

**Status:** ✅ Complete
**Priority:** Medium
**Estimated Time:** 0.5-1 day
**Progress:** 100%

**Related Sprints**
- ✅ Sprint 07 – Local Transcription (hybrid local/cloud)
- 🔜 Sprint 11 – Passive Mode Polish
- 🔜 Sprint 12 – Continuous Session Persistence

---

## Purpose

Simplify transcription architecture by removing cloud fallback and UI mode selection. Use local-only transcription with automatic ONNX Runtime backend selection (WebGPU → WASM).

**Rationale:**
- **WebGPU support:** 70% of users (Chrome 113+, April 2023)
- **WebAssembly support:** 99% of users (Chrome 57+, March 2017)
- **WASM performance acceptable:** 1-3x realtime for passive mode (10-30s transcription for 10s audio)
- **Cloud fallback adds unnecessary complexity:** Network coordination, buffering overhead, privacy concerns
- **Cloud transcription likely slower than WASM** for short clips due to network latency

---

## Goals

### Primary Deliverable

**Remove cloud transcription fallback entirely**
- ONNX Runtime automatically selects best available backend (WebGPU or WASM)
- 70% of users get fast WebGPU inference (2-5s for 10s audio)
- 30% of users get WASM inference (10-30s for 10s audio, still acceptable)
- No network calls for transcription
- No UI controls for STT mode selection

### Success Criteria

- [ ] Cloud transcription code removed from backend and extension
- [ ] Audio buffering to backend removed (no longer needed)
- [ ] STT mode selection UI removed from sidepanel
- [ ] All transcription happens locally via ONNX Runtime (WebGPU or WASM)
- [ ] User experience unchanged for WebGPU-capable browsers
- [ ] Acceptable performance on WASM-only browsers (verified via testing)
- [ ] Simpler codebase with fewer edge cases

---

## Implementation Steps

### 1. Extension Changes (offscreen.js)

**Remove cloud buffering:**
- Remove `ondataavailable` handler that sends audio chunks to backend (offscreen.js:238-250)
- Remove `audio_chunk` message sending
- Keep local audio buffering in `audioBuffer` for ONNX transcription

**Simplify transcription logic:**
- Remove `currentSttMode` state variable
- Remove mode checks (`FORCE_LOCAL`, `FORCE_CLOUD`, `AUTO`)
- Remove `transcript_fallback_required` message handler
- Always attempt local transcription when recording stops

**Update error handling:**
- If local transcription fails, show error to user (no silent fallback)
- Log detailed error for debugging
- Optionally: retry once on failure

### 2. Extension Changes (service-worker.js)

**Remove cloud transcription handlers:**
- Remove `audio_chunk` message handler
- Remove cloud transcription initiation logic
- Remove cloud transcript processing
- Simplify to only handle `transcript_final` from local transcription

**Remove mode management:**
- Remove STT mode storage/retrieval
- Remove mode passing to offscreen document
- Remove `start_recording` mode parameter

### 3. Extension Changes (sidepanel.js)

**Remove STT mode UI:**
- Remove mode selection buttons (`modeAutoBtn`, `modeForceLocalBtn`, `modeForceCloudBtn`)
- Remove mode display/status indicators
- Remove mode-related event listeners
- Clean up UI layout where buttons were removed

### 4. Extension Changes (settings.js)

**Remove STT mode constants:**
- Remove `LOCAL_STT_MODES` enum (`AUTO`, `FORCE_LOCAL`, `FORCE_CLOUD`)
- Remove related settings/defaults

### 5. Backend Changes (Phoenix)

**Remove cloud transcription endpoint:**
- Remove audio chunk buffering in WebSocket handlers
- Remove cloud transcription API calls (if any)
- Remove transcription state management for cloud fallback
- Keep only the handlers for receiving final transcripts from extension

### 6. Documentation Updates

**Update technical docs:**
- Update TECHNICAL_REFERENCES.md to reflect local-only architecture
- Update AGENTS.md if it references cloud transcription
- Note ONNX Runtime automatic backend selection (WebGPU → WASM)

**Update sprint docs:**
- Archive Sprint 07 notes about hybrid approach
- Document decision to go local-only

---

## Code Locations to Modify

### Extension
- `extension/src/offscreen/offscreen.js` (~50 lines removed)
  - Lines 238-250: Remove audio chunk streaming
  - Lines 64-68: Remove STT mode handling
  - Lines 304-311: Remove fallback message
  - Lines 324-327: Remove cloud-only logic

- `extension/src/background/service-worker.js` (~100 lines removed)
  - Remove `audio_chunk` handler
  - Remove cloud transcription logic
  - Remove mode parameter passing

- `extension/src/sidepanel/sidepanel.js` (~50 lines removed)
  - Lines 1190-1203: Remove STT mode buttons and handlers
  - Remove mode status display

- `extension/src/shared/settings.js` (~10 lines removed)
  - Remove `LOCAL_STT_MODES` enum

### Backend (Phoenix)
- `lib/lossy_web/channels/video_channel.ex` (TBD lines)
  - Remove audio chunk buffering
  - Remove cloud transcription handlers

---

## Benefits

### Reduced Complexity
- **~200-300 lines of code removed** across extension and backend
- Fewer edge cases to handle (local vs cloud, fallback logic)
- Simpler state management (no mode tracking)
- Easier to debug (one code path instead of three)

### Better Performance
- **No network overhead** for 100% of users
- **Faster transcription** for most users:
  - WebGPU: 2-5s for 10s audio (70% of users)
  - WASM: 10-30s for 10s audio (30% of users)
  - Cloud: 5-15s + network latency (removed)
- Deterministic performance (no server queue variability)

### Improved Privacy
- **100% local processing** - no audio leaves the device
- No backend storage of audio chunks
- No cloud API calls with audio data

### Better UX
- **Simpler UI** - no confusing mode selection
- **"Just works"** - automatic backend selection
- Consistent behavior across all users

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **WASM too slow on old devices** | Poor UX for 30% of users | Test on low-end devices; WASM still faster than typing; acceptable for passive mode |
| **ONNX model fails to load** | Transcription broken entirely | Show clear error message; provide troubleshooting steps; extremely rare with 99% WASM support |
| **Breaking existing users** | Users relying on cloud mode frustrated | Validate WASM performance is acceptable; communicate change if extension is public |

---

## Testing Plan

1. **WebGPU path (70% of users):**
   - Verify transcription works on Chrome 113+ (WebGPU capable)
   - Measure latency (should be 2-5s for 10s audio)
   - Confirm no network calls made

2. **WASM fallback (30% of users):**
   - Test on older Chrome (pre-113) or with WebGPU disabled
   - Measure latency (should be 10-30s for 10s audio)
   - Verify still usable for passive mode

3. **Error handling:**
   - Simulate ONNX model load failure
   - Verify clear error message shown to user
   - Confirm no silent failures

4. **Regression testing:**
   - Verify passive mode still works end-to-end
   - Verify note creation with transcripts
   - Verify timestamp accuracy preserved

---

## Timeline

**Phase 1: Extension Changes (0.5 day)**
- Remove cloud buffering in offscreen.js
- Remove mode management in service-worker.js
- Remove UI controls in sidepanel.js
- Remove settings constants

**Phase 2: Backend Changes (0.25 day)**
- Remove cloud transcription handlers
- Clean up audio chunk buffering

**Phase 3: Testing & Documentation (0.25 day)**
- Test WebGPU and WASM paths
- Update documentation
- Verify no regressions

**Total:** 0.5-1 day

---

## Decision Log

**Why remove cloud fallback?**
1. WASM has 99% browser support (same as WebAssembly for VAD)
2. WASM performance (1-3x realtime) is acceptable for passive mode
3. Cloud adds significant complexity without meaningful benefit
4. Cloud likely slower than WASM for short clips (network overhead)
5. Privacy: Everything stays local

**Why keep WASM fallback?**
1. WebGPU only 70% browser support (vs 99% for WASM)
2. WASM fallback is automatic via ONNX Runtime (no extra code)
3. Minimal complexity vs meaningful coverage (30% of users)

**Similar to Silero VAD decision:**
- VAD: 99% WASM support → no fallback needed
- Whisper: 99% WASM support → use as fallback for 30% without WebGPU

---

**Document Version:** 1.0
**Created:** 2025-10-22
**Author:** Claude Code
