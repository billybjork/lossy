## Google Drive Adapter Retrospective

### Current Status
- Existing platform adapters removed pending a safer implementation.
- Drive playback consistently black-screened when our content script attached listeners or attempted to proxy controls.
- No regression for other platforms (adapter registry falls back to `GenericAdapter` again).

### Key Findings
- **Player isolation**: Google Drive hosts video in a nested YouTube iframe with strict sandbox policies, limiting DOM access and reacting poorly to script-driven control commands.
- **Timeline integration**: The top-level seek slider exposes progress data (milliseconds) but is tightly bound to Drive's internal state machine; synthetic `input/change` events or value mutations can stall playback.
- **Lifecycle churn**: Drive frequently re-builds the viewer DOM during navigation, causing proxy elements or observers to detach unless carefully scoped.
- **Minimal console clues**: No explicit CSP/permission errors—black screen occurs silently, indicating Drive's player detects interference rather than blocked resources.

### Troubleshooting Checklist for Next Attempt
1. **Environment capture**
   - Record baseline behavior with extension disabled (network + console logs).
   - Capture iframe tree and sandbox attributes immediately after playback starts.
2. **Detection strategy**
   - Read-only scanning of Drive DOM (no mutations) until video confirmed.
   - Prefer passive observers (MutationObserver limited to structural changes) with early teardown.
3. **Control proxy**
   - Avoid writing to native slider or dispatching synthetic events until proven safe.
   - Consider read-only time tracking via `requestAnimationFrame` on slider value without altering it.
   - Evaluate YouTube IFrame API only if Drive’s embed exposes `enablejsapi`; otherwise treat player as opaque.
4. **Isolation testing**
   - Toggle individual behaviors (proxy video creation, listeners, observers) to pinpoint the black-screen trigger.
   - Reproduce in Incognito with minimal extensions to rule out collisions.
5. **Fallback planning**
   - If slider writes remain unsafe, rely on `GenericAdapter` for detection and accept limited marker support.
   - Prepare feature flags to enable/disable Drive adapter remotely once stable.

### Next Steps
- Prototype a detection-only adapter (no control overrides) and validate that playback remains unaffected.
- Document DOM contracts (selectors, iframe hierarchy) and add automated smoke tests using Browserbase once interaction is stable.
- Schedule a shorter follow-up sprint dedicated to instrumentation and incremental enablement rather than full feature parity.
