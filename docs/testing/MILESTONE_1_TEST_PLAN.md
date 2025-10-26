# Milestone 1 Test Plan - Phoenix Voice Session Integration

**Sprint 15 Milestone 1**: Extension integrates with Phoenix voice session when `phoenix_voice_session` flag enabled.

## Test Environment Setup ✅

- ✅ Phoenix server running on port 4000
- ✅ Test user created: `test@lossy.app` / password: `testpassword123`
- ✅ User ID: `2c6ebbe3-5fb9-4366-a538-aba3a515eee4`
- ✅ Feature flag: `phoenix_voice_session: false` (default)
- ✅ Dev login page: `http://localhost:4000/dev/auth`

## How Extension Authentication Works

1. **You log in via browser** at `http://localhost:4000/dev/auth`
2. **Phoenix sets a session cookie** with your `user_id`
3. **Extension reads the cookie** (same domain, `localhost:4000`)
4. **Extension calls `/api/auth/extension_token`** with the cookie
5. **Phoenix issues a JWT token** for channel authentication
6. **Extension uses JWT** to join AudioChannel/VideoChannel

This is why you need to log in via the browser first!

---

## Test Scenarios

### Test 1: Baseline - Flag Disabled (Default Behavior)

**Objective**: Verify existing JavaScript state machine works when flag is disabled.

**Pre-requisites**:
1. **Login at `http://localhost:4000/dev/auth`**
   - Email: `test@lossy.app`
   - Password: `testpassword123`
   - You should see "✅ Logged In Successfully!"

**Steps**:
1. Ensure `phoenix_voice_session` flag is disabled (it is by default)
2. Load/reload Chrome extension
3. Navigate to a YouTube video
4. Open extension console (`chrome://extensions` → Lossy → Service Worker → Console)
5. Start voice mode from extension UI
6. Speak a short phrase
7. Check extension console logs

**Expected Behavior**:
- ✅ Extension console shows: `Phoenix voice session DISABLED - using local JavaScript state machine`
- ✅ Voice mode works normally (existing behavior)
- ✅ Speech detected → recording → note created
- ✅ No voice events sent to Phoenix (no `voice_event` logs in extension)
- ✅ Zero impact on existing functionality

**Phoenix Logs to Check**:
```bash
# Watch Phoenix logs
tail -f lossy/_build/dev/lib/lossy/consolidated/logger.log

# OR in terminal where Phoenix is running
```

**Extension Console**:
```
[Voice Mode] Phoenix voice session DISABLED - using local JavaScript state machine
[Voice Mode] Session active with persistent audio channel
[Voice Mode] Speech detected...
```

---

### Test 2: Enable Flag - Phoenix Controls State Machine

**Objective**: Verify Phoenix voice session controls state machine when flag enabled.

**Setup**: Enable the feature flag
```elixir
# In IEx console (iex -S mix)
Lossy.Settings.update_user_settings("2c6ebbe3-5fb9-4366-a538-aba3a515eee4", %{
  feature_flags: %{"phoenix_voice_session" => true}
})
```

**Steps**:
1. Reload Chrome extension (to clear cached settings)
2. Navigate to YouTube video
3. Start voice mode
4. Speak a short phrase
5. Monitor both Extension console AND Phoenix logs

**Expected Behavior - Extension Console**:
```
[Voice Mode] ✨ Phoenix voice session ENABLED - Phoenix will control state machine
[Voice Mode] Session active with persistent audio channel
[Voice Mode] VAD: state=observing conf=0.850 speech=0ms silence=120ms lat=12.5ms
```

**Expected Behavior - Phoenix Logs**:
```
[info] [AudioChannel:...] Starting Phoenix voice session (feature flag enabled)
[info] [VoiceSession:...] Initialized for user ..., video ...
[info] [VoiceSession:...] Starting to observe for speech
[debug] [AudioChannel:...] Voice event: speech_start (seq: 1)
[info] [VoiceSession:...] Speech started (confidence: 0.95)
[debug] [AudioChannel:...] Voice event: metrics (seq: 2)
[debug] [AudioChannel:...] Voice event: speech_end (seq: 3)
[info] [VoiceSession:...] Speech ended (duration: 2000ms)
```

**Verification Checklist**:
- [ ] Extension logs show "Phoenix voice session ENABLED"
- [ ] Phoenix logs show VoiceSession GenServer starting
- [ ] Sequence numbers increment on each event
- [ ] Phoenix logs show state transitions (observing → recording → cooldown)
- [ ] Notes still get created successfully
- [ ] Extension telemetry updates from Phoenix (speech_detections count)

---

### Test 3: Sequence Number Tracking

**Objective**: Verify sequence numbers increment correctly.

**Setup**: Flag enabled (from Test 2)

**Steps**:
1. Clear extension console
2. Start voice mode
3. Speak multiple times (3-5 short phrases)
4. Check extension console for sequence numbers

**Expected Behavior - Extension Console**:
```javascript
// Each voice event should show incrementing sequence in network tab
{type: "speech_start", data: {...}, sequence: 1}
{type: "metrics", data: {...}, sequence: 2}
{type: "speech_end", data: {...}, sequence: 3}
{type: "metrics", data: {...}, sequence: 4}
{type: "speech_start", data: {...}, sequence: 5}
// ... and so on
```

**Verification**:
- [ ] Sequence numbers start at 1
- [ ] Sequence numbers increment on every voice event
- [ ] No gaps in sequence numbers during normal operation
- [ ] Phoenix logs sequence numbers correctly

---

### Test 4: Event Buffering

**Objective**: Verify extension buffers events when channel disconnected.

**Setup**: Flag enabled

**Steps**:
1. Start voice mode
2. Speak a phrase (verify it works)
3. **Stop Phoenix server** (`Ctrl+C` in terminal)
4. Speak another phrase
5. Check extension console for buffering behavior
6. Restart Phoenix (`mix phx.server`)
7. Observe reconnection

**Expected Behavior**:
- ✅ After Phoenix stops: Extension console shows "Failed to send voice event to Phoenix"
- ✅ Events are buffered locally (check `voiceSession.eventBuffer` in console)
- ✅ Buffer keeps max 100 events (FIFO overflow)
- ✅ After Phoenix restarts: Channel reconnects
- ✅ *(Future)* Reconciliation logic would replay events

**Extension Console Commands**:
```javascript
// In extension service worker console, check buffer:
voiceSession.eventBuffer
// Should show array of buffered events with sequence numbers
```

---

### Test 5: Reconnection Protocol *(Basic)*

**Objective**: Verify channel reconnects cleanly.

**Setup**: Flag enabled, Phoenix running

**Steps**:
1. Start voice mode
2. Note current sequence number
3. Disconnect/reconnect WiFi (or restart Phoenix)
4. Wait for channel to reconnect
5. Continue using voice mode

**Expected Behavior**:
- ✅ Channel disconnects gracefully
- ✅ Phoenix socket attempts reconnection
- ✅ Channel rejoin succeeds
- ✅ VoiceSession starts fresh (for now - full reconciliation in future enhancement)
- ✅ Extension can continue operating

**Note**: Full reconciliation with event replay is foundation-only in this milestone. Future work will implement the reconcile_events call.

---

### Test 6: Toggle Flag During Session

**Objective**: Verify behavior when toggling flag mid-session.

**Steps**:
1. Start voice mode with flag DISABLED
2. Use voice mode (should work with JS state machine)
3. Enable flag via IEx
4. Stop and restart voice mode
5. Verify new behavior kicks in

**Expected Behavior**:
- ✅ Flag changes don't affect active session (cached at join)
- ✅ New session after restart picks up new flag value
- ✅ Clean transition between modes

---

## Success Criteria

### ✅ Must Pass All Tests

- [ ] Test 1: Baseline works (flag disabled = no impact)
- [ ] Test 2: Phoenix controls state machine (flag enabled)
- [ ] Test 3: Sequence numbers increment correctly
- [ ] Test 4: Events buffer when Phoenix unavailable
- [ ] Test 5: Channel reconnects cleanly
- [ ] Test 6: Flag toggle works correctly

### ✅ Phoenix Logs Show

- [ ] VoiceSession GenServer starts when flag enabled
- [ ] State transitions logged (idle → observing → recording → cooldown)
- [ ] Telemetry events emitted (`:telemetry.execute` calls)
- [ ] Sequence numbers received in voice_event handler
- [ ] No errors or crashes

### ✅ Extension Behavior

- [ ] Clean fallback when flag disabled
- [ ] Sequence number tracking working
- [ ] Event buffering (max 100 events)
- [ ] Telemetry syncs from Phoenix
- [ ] No regressions in note creation

---

## Debugging Tips

### Check Phoenix GenServer State

```elixir
# In IEx console
session_id = "your-session-id-from-logs"
Lossy.Agent.VoiceSession.get_state(session_id)
```

### Check Extension State

```javascript
// In extension service worker console (chrome://extensions → Service Worker)
console.log('Phoenix enabled:', voiceSession.phoenixVoiceSessionEnabled)
console.log('Sequence number:', voiceSession.sequenceNumber)
console.log('Event buffer:', voiceSession.eventBuffer)
console.log('Status:', voiceSession.status)
```

### Watch Phoenix Logs in Real-Time

```bash
# Terminal 1: Phoenix server
mix phx.server

# Terminal 2: Grep for voice session events
tail -f /path/to/phoenix.log | grep -i "voicesession\|voice_event"
```

### Network Tab

Open Chrome DevTools → Network tab → WS (WebSocket) → inspect Phoenix socket messages for voice_event payloads.

---

## Known Limitations (Expected in Milestone 1)

- ⚠️ **No event replay yet**: Reconnection creates fresh session (full reconciliation in future enhancement)
- ⚠️ **Platform adapters minimal**: Basic validation only (full adapter port in Milestone 1.5)
- ⚠️ **Manual testing only**: Automated tests deferred to later sprint

---

## Test Results Template

### Test Run: `__________` (Date)

**Tester**: ____________________
**Phoenix Commit**: `8cea7ff`
**Extension Version**: ____________________

| Test | Pass | Fail | Notes |
|------|------|------|-------|
| Test 1: Baseline (flag off) | ☐ | ☐ | |
| Test 2: Phoenix control (flag on) | ☐ | ☐ | |
| Test 3: Sequence numbers | ☐ | ☐ | |
| Test 4: Event buffering | ☐ | ☐ | |
| Test 5: Reconnection | ☐ | ☐ | |
| Test 6: Flag toggle | ☐ | ☐ | |

**Issues Found**:
- ______________________________________________________
- ______________________________________________________

**Overall Assessment**: ☐ Pass ☐ Fail ☐ Needs Work

