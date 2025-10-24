# VAD Tuning Guide

Voice Activity Detection (VAD) configuration for Lossy passive mode.

## Default Thresholds

Current defaults in `extension/src/shared/shared-constants.js`:

```javascript
export const VAD_CONFIG = {
  START_THRESHOLD: 0.45,    // Speech start confidence
  END_THRESHOLD: 0.40,      // Silence detection confidence
  MIN_SPEECH_DURATION_MS: 250,   // Minimum speech to record
  MIN_SILENCE_DURATION_MS: 2000, // Silence to end speech
  // ...
};
```

## Why These Values?

### START_THRESHOLD: 0.45
**More sensitive than Silero default (0.50)** to catch speech onset quickly.
- **Trade-off:** Slightly higher false positive rate (background noise might trigger)
- **Benefit:** Better UX - doesn't miss speech starts, feels more responsive

### END_THRESHOLD: 0.40
**Tighter than Silero default (0.35)** for cleaner speech boundary detection.
- **Trade-off:** May cut off very quiet speech endings
- **Benefit:** Reduces chance of VAD staying stuck in "maybe_silence" state

### MIN_SILENCE_DURATION_MS: 2000
**2 seconds tolerance** for natural pauses (breathing, thinking).
- **Trade-off:** Longer recordings if you pause mid-sentence
- **Benefit:** Prevents premature speech_end during natural pauses

## Tuning Scenarios

### Quiet Room (Home Office)
Current defaults work well for most quiet environments.

**If too sensitive:**
```javascript
START_THRESHOLD: 0.50  // Reduce false positives from background noise
```

**If ultra-responsive needed:**
```javascript
START_THRESHOLD: 0.40  // Catch even quieter speech
```

---

### Noisy Office
Background noise (AC, fans, chatter) can trigger false positives.

**Recommended adjustments:**
```javascript
START_THRESHOLD: 0.55    // Raise to filter out ambient noise
END_THRESHOLD: 0.45      // Tighten to avoid lingering in speech state
MIN_SPEECH_DURATION_MS: 500  // Require longer speech to filter noise spikes
```

---

### Meeting Room (Multiple Speakers)
Multiple speakers means more natural pauses and interruptions.

**Recommended adjustments:**
```javascript
MIN_SILENCE_DURATION_MS: 3000  // Tolerate longer pauses between speakers
MAX_SPEECH_DURATION_MS: 90000  // Allow longer continuous discussions (90s)
```

**Note:** VAD will capture one speaker at a time. For multi-speaker scenarios, consider using manual recording mode instead.

---

### Soft-Spoken User
If VAD frequently misses your speech starts:

**Recommended adjustments:**
```javascript
START_THRESHOLD: 0.35    // More sensitive to quieter speech
MIN_SPEECH_DURATION_MS: 200  // Accept shorter utterances
```

**Warning:** Lower thresholds increase false positive rate.

---

## Troubleshooting

### Problem: VAD triggers too often (false positives)

**Symptoms:**
- Recording starts from background noise
- Empty/nonsense notes created
- Passive mode badge flashes frequently

**Solutions:**
1. **Raise START_THRESHOLD:** Try 0.50, 0.55, or 0.60
2. **Increase MIN_SPEECH_DURATION_MS:** Try 500 or 750 to filter noise spikes
3. **Check environment:**
   - Reduce AC/fan noise
   - Move away from noisy appliances
   - Use a better microphone with noise cancellation

---

### Problem: VAD misses speech starts

**Symptoms:**
- Start speaking but VAD doesn't trigger
- First word(s) cut off from notes
- Have to speak louder than feels natural

**Solutions:**
1. **Lower START_THRESHOLD:** Try 0.40 or 0.35
2. **Check microphone:**
   - Verify browser has microphone permission
   - Check mic gain settings in OS
   - Try a different microphone

**Debug:**
Enable debug drawer (gear icon in sidepanel) to see real-time confidence values.

---

### Problem: Recording never ends (stuck in speech state)

**Symptoms:**
- Recording continues indefinitely
- No cooldown period
- Notes created are very long even when you've stopped speaking

**Solutions:**
1. **Lower MIN_SILENCE_DURATION_MS:** Try 1500 or 1000
2. **Adjust END_THRESHOLD:** Try 0.45 (tighter)
3. **Check guards:** VAD has built-in guards at 60s max duration

**Debug:**
Check console for warnings: "Forcing speech_end: no high confidence for 2s (stuck state)"

---

### Problem: Recording cuts off mid-sentence

**Symptoms:**
- Notes truncated while still speaking
- Forced to speak without natural pauses
- Cannot think/breathe between words

**Solutions:**
1. **Raise MIN_SILENCE_DURATION_MS:** Try 2500 or 3000
2. **Speak more continuously:** Reduce pauses between words
3. **Check confidence:** Ensure you're speaking loud enough

**Note:** Some users naturally pause longer. Adjust MIN_SILENCE_DURATION_MS to match your speaking style.

---

## Advanced Tuning

### Circuit Breaker Settings

If VAD crashes frequently:
```javascript
MAX_VAD_RESTART_ATTEMPTS: 3  // Default - increase to 5 for flaky systems
```

### State Machine Timeouts

```javascript
STUCK_STATE_TIMEOUT_MS: 2000  // Force end if no high confidence for 2s
EXTENDED_SILENCE_MULTIPLIER: 1.5  // Force end after 1.5x silence duration
MAX_SPEECH_DURATION_MS: 60000  // Absolute max recording length (60s)
```

**Warning:** Changing these values can affect VAD state machine stability.

---

## Monitoring Performance

### Enable Debug Drawer

1. Click gear icon in sidepanel
2. View real-time telemetry:
   - **Speech Detections:** Total successful speech events
   - **Ignored (Short):** Speech too short (filtered by MIN_SPEECH_DURATION_MS)
   - **Ignored (Cooldown):** Speech during cooldown period
   - **Avg Latency:** VAD inference latency (should be <50ms)
   - **Last Confidence:** Most recent VAD confidence value
   - **Restarts:** Circuit breaker restart count
   - **Recent WARN/ERROR Log:** Inspect the rolling log feed in the debug drawer (click **Refresh Log** to pull the latest entries from the service worker buffer)

### Interpreting Metrics

**High "Ignored (Short)" count:**
- Too many noise spikes triggering VAD
- Solution: Raise START_THRESHOLD or increase MIN_SPEECH_DURATION_MS

**High "Restart" count:**
- VAD crashing frequently
- Solution: Check browser console for errors, consider AudioWorklet issues

**High latency (>100ms):**
- System overloaded or slow WASM execution
- Solution: Close other tabs, check CPU usage

---

## Editing Configuration

### Location
All VAD tunables are in:
```
extension/src/shared/shared-constants.js
```

### Making Changes

1. Edit `shared-constants.js`
2. Rebuild extension: `npm run build`
3. Reload extension in Chrome (chrome://extensions → reload)
4. Test with debug drawer open
5. Iterate until behavior feels natural

### Reset to Defaults

If you break something, restore original values:
```javascript
export const VAD_CONFIG = {
  START_THRESHOLD: 0.45,
  END_THRESHOLD: 0.40,
  MIN_SPEECH_DURATION_MS: 250,
  MIN_SILENCE_DURATION_MS: 2000,
  STUCK_STATE_TIMEOUT_MS: 2000,
  EXTENDED_SILENCE_MULTIPLIER: 1.5,
  MAX_SPEECH_DURATION_MS: 60000,
  MAX_VAD_RESTART_ATTEMPTS: 3,
};
```

---

## FAQ

**Q: Can I tune VAD per-video or per-tab?**
A: No, VAD settings are global. Consider using manual recording mode for specific scenarios.

**Q: Why can't I set START_THRESHOLD below 0.30?**
A: Very low thresholds (< 0.30) cause excessive false positives. The Silero model is not designed for such sensitivity.

**Q: Can I disable VAD entirely?**
A: Yes, just don't start passive mode. Use manual recording (click microphone button) instead.

**Q: How do I enable debug logging?**
A: Debug logging is controlled by `logger.debug()` calls. Currently gated by settings (future enhancement). For now, check browser console.

**Q: Does AudioWorklet affect VAD tuning?**
A: No, AudioWorklet only changes how audio is captured. VAD thresholds remain the same.

---

## See Also

- [PASSIVE_MODE_REFACTOR.md](sprints/PASSIVE_MODE_REFACTOR.md) - Implementation details
- [shared-constants.js](../extension/src/shared/shared-constants.js) - All tunable parameters
- [vad-detector.js](../extension/src/offscreen/vad-detector.js) - VAD state machine implementation

---

**Last Updated:** 2025-10-23
**Silero VAD Version:** V5
**Lossy Version:** Sprint 14+
