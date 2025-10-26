# Sprint 15 – Phoenix Responsibility Shift

## Sprint Goal
Move the voice session lifecycle, note delivery, platform detection, telemetry, and user policy orchestration out of the Chrome extension and into Phoenix. By the end of the sprint the extension should act primarily as a hardware/UI bridge while Elixir owns durable session state, authoritative data, and analytics.

## Dependencies & Pre-Work
- ✅ Review `docs/06_SEPARATION_OF_CONCERNS.md` for target architecture.
- ✅ Confirm Browser extension builds with latest JS changes (baseline QA run).
- 🔄 Identify any in-flight branches that modify voice-session JS so we can sequence merges.
- 🔄 Ensure Oban queues are running locally (for upcoming automation jobs).
- 🔄 Update local dev tooling (Makefile/script/docker-compose) for single-command Phoenix + extension boot.

## Milestones

### Milestone 0 – Foundations (Target: Week 1 (Foundations))
**Objective:** Establish authentication, settings, feature flags, migration scaffolding, and rollback levers before shipping server-driven behaviour.

1. **Channel authentication**
   - Design join payload with JWT containing `{user_id, device_id, exp, protocol_version}` signed by Phoenix.
   - Extension obtains token via `POST /api/auth/extension_token`, reusing the Phoenix session cookie from the logged-in web app.
   - Persist token (and device_id) in `chrome.storage.local`; refresh when exp < 5 minutes remaining or channel join fails with `unauthenticated`.
   - Server validates signature, expiry, and user/device match before accepting channel join; audit and rate-limit join attempts.
2. **User settings schema**
   - Add `user_settings` table + context exposing read/write APIs for feature flags and thresholds.
   - Seed defaults for existing cohorts.
3. **Feature flags**
   - Add Phoenix feature flag module (`phoenix_voice_session`, `phoenix_notes_channel`, `phoenix_video_context`, `phoenix_telemetry`, etc.).
   - Extension detects flags/version via channel join response; legacy code paths remain gated.
4. **Migration helpers**
   - Confirm we can drop existing IndexedDB caches (no production data yet); leave optional export hooks if early testers appear.
   - Document rollout/rollback plan in runbooks.
5. **Protocol negotiation**
   - Define protocol versions: `v1` (legacy transcript-only AudioChannel) and `v2` (voice events + Phoenix-owned session).
   - During join the extension sends `{requested_version: 2}`; Phoenix responds with `{supported_versions: [1,2], active_version, features}`.
   - If Phoenix only supports `v1`, the extension falls back to legacy JS logic; if the extension only supports `v1`, Phoenix operates in compatibility mode.

### Milestone 1 – Voice Session Engine (Target: Week 1)
**Objective:** Elixir owns the voice session state machine; extension pushes hardware events only.

1. **Process scaffold**
   - Add `Lossy.Agent.VoiceSession` (GenServer supervised by `SessionSupervisor`).
   - Model states: `:idle`, `:observing`, `:recording`, `:cooldown`, `:error`.
   - Include `:disconnected` / `:reconnecting` states for network recovery.
   - Persist key fields: `user_id`, `video_id`, `session_id`, `timestamp`, cooldown timers, counters.
2. **Channel contract**
   - Extend `LossyWeb.AudioChannel` (or add `VoiceChannel`) to accept `voice_event` (`speech_start`, `speech_end`, `metrics`, `heartbeat`, `error`) and broadcast `voice_status`.
   - Include channel protocol version negotiation + feature flag handshake.
   - Update extension service worker to forward events without modifying local state (`voice-session-manager.js` reduced to dispatch + UI updates).
3. **Cooldown & guard logic**
   - Implement timers in `VoiceSession` (`Process.send_after/3`) for idle timeout, cooldown, guard windows.
   - Persist state transitions in ETS or DB table (`voice_sessions`) for crash recovery.
4. **Telemetry hooks**
   - Emit `:telemetry` events on state transitions, errors, and metrics ingestion.
5. **Resilience**
   - Define reconnection data: `last_known_state = %{session_id, current_state, last_event_timestamp, sequence_number}` cached in the extension.
   - Buffer up to 100 critical events (`speech_start`, `speech_end`, `heartbeat`) in FIFO order; drop oldest on overflow.
   - Replay includes sequence numbers. Phoenix accepts contiguous events when state aligns; on mismatch Phoenix pushes `:reset_session`, causing the extension to clear buffers and request fresh state.
   - Define timeout/fallback behaviour: if Phoenix unreachable >30s, queue note/transcript locally and surface warning UI.
6. **QA & rollout**
   - Update manual testing checklist for voice mode.
   - Ensure extension gracefully handles session restarts initiated by Phoenix.

### Milestone 1.5 – Platform Adapter Core (Target: Week 1-2 overlap)
**Objective:** Deliver canonical platform detection to support video context work early.

1. **`Lossy.Platforms` core**
   - Define adapter behaviour (detect, normalize URL, extract video id, canonical metadata).
   - Implement adapters for YouTube, Vimeo, Frame.io, Iconik, Generic with unit tests.
2. **Channel integration**
   - `VideoChannel.video_detected` uses adapters to validate incoming data and stores canonical IDs.
   - Broadcast platform metadata to clients and expose in video context registry.
3. **Extension handshake**
   - Extension bundles a generated `platform_adapters.json` at build time (exported from Phoenix) and hydrates adapter registry from that artifact.
   - Update voice session start to rely on Phoenix-confirmed `video_id` where available.
4. **Feature flagging**
   - Gate new adapter path behind `phoenix_platform_adapters` flag for gradual rollout.

### Milestone 2 – Notes & Video Context Authority (Target: Week 2)
**Objective:** Phoenix streams authoritative note lists and video context, replacing IndexedDB caches and tab bookkeeping.

1. **NotesChannel enhancements**
   - `join` reply returns paginated notes + metadata.
   - Broadcasts cover `note_created`, `note_updated`, `note_deleted`, `video_summary`.
   - Add helper queries in `Lossy.Videos` for pagination and filtering.
2. **Side panel refactor**
   - Replace IndexedDB cache with in-memory store + `pending_notes` queue persisted via IndexedDB only for offline/undelivered notes.
   - Consume channel replies/streams directly with lightweight in-memory list for DOM diffing.
3. **Video context registry**
   - Create `Lossy.Agent.VideoContext` (Registry/ETS) storing `{session_id, video_id, tab_info, platform, current_url}`.
   - Extend `VideoChannel` to broadcast `video_context_updated`/`video_context_cleared`.
   - Modify content script to request context from Phoenix first, falling back to local detection only when absent (leveraging Milestone 1.5 adapters).
   - Multi-window policy: last active tab wins ownership (timestamp + sequence). Phoenix notifies other tabs with `:context_taken` to display read-only status. When the owner closes/disconnects, Phoenix broadcasts `:context_available` so another tab can claim ownership. Switching context ends the previous voice session.
4. **Automation alignment**
   - Ensure agent session uses Phoenix context to set timestamps (remove JS guard duplication).

### Milestone 3 – Platform Delivery & Tooling (Target: Week 3)
**Objective:** Finalize adapter parity, extension build integration, and tooling improvements.

1. **Manifest/build integration**
   - Generate adapter manifest during Phoenix build and commit/publish it for the extension bundler to consume (build-time contract).
   - Ensure adapters are versioned; extension verifies compatibility before use.
2. **Extended testing**
   - Manual smoke across supported platforms (SPAs, embeds).
   - Add regression tests for cross-device scenarios.
3. **Developer tooling**
   - Provide mocks/stubs for adapter responses to support extension-only development without Phoenix.

### Milestone 4a – Telemetry Ingestion (Target: Week 4)
**Objective:** Persist telemetry events reliably and expose raw data for analysis.

1. **Telemetry ingestion**
   - Create `Lossy.Telemetry` context + `telemetry_events` table.
   - Add `TelemetryChannel` or REST endpoint for extension to POST events (`telemetry-emitter.js` update).
2. **Resilience**
   - Buffer telemetry on the extension when offline and flush when Phoenix ack received.
   - Alerting hooks (PromEx/Grafana) for ingest failure.

### Milestone 4b – Analytics, Dashboards & Note Quality (Target: Week 5)
**Objective:** Turn telemetry into actionable insights and adaptive policies.

1. **Dashboard**
   - Build LiveView dashboard (protected path) showing session health, latency, error trends.
   - Include historical analytics queries (avg latency, failure rates).
   - Protect dashboard via Phoenix session with admin role check.
2. **Note quality module**
   - Add `Lossy.NoteQuality` with MVP heuristics:
     * Hard minimum confidence `>= 0.25` (absolute floor).
     * Base threshold from `user_settings.min_confidence` (default `0.3`).
     * If a user deletes 5 notes of the same category within a session, raise threshold for that category to `max(base + 0.1, 0.4)` for the remainder of the session.
   - Document future enhancements (ML/adaptive models) for follow-up sprints.
   - Hook into `Lossy.Agent.VoiceSession` before persisting notes; log decisions to telemetry.
3. **Feedback loop**
   - Record note deletions / overrides from UI; feed into telemetry.
   - Adjust thresholds per user/platform and persist decisions for later review (configurable via feature flags/settings).

### Milestone 5 – Settings & Policy Sync (Target: Week 6)
**Objective:** Complete end-to-end synchronization of user preferences and policies (extending the foundation laid in Milestone 0).**

1. **Schema**
   - Reuse the `user_settings` table created in Milestone 0; ensure any additional fields required by note quality are migrated up front.
2. **API / Channel**
   - On extension bootstrap, fetch settings from Phoenix; sync mutations back.
3. **Integration**
   - Voice session and note quality modules consume settings (e.g., auto-pause toggle, min confidence).
   - Side panel uses server-provided defaults instead of Chrome storage.
4. **Migration cleanup**
   - Remove legacy storage reads/writes once parity confirmed.

## Stretch Goals (Optional)
- Integrate Oban workers (`RefineNote`, `PostNote`) with the new telemetry to show job pipelines end-to-end.
- Add automated tests (Playwright) that assert behaviour across extension and Phoenix after the refactor.

## Deployment & Rollout Strategy
- **Version negotiation:** Channels include `protocol_version` and feature flags in join replies; clients downgrade gracefully.
- **Sequence:** Deploy Phoenix first (backward-compatible), monitor for 24h, then roll out extension update. Feature flags default off until confidence gained.
- **Gradual enablement:** Enable flags for 1% → 10% → 50% → 100% cohorts over two weeks while monitoring telemetry (disconnect rate, error counts).
- **Rollback:** Toggle feature flags off to revert to legacy JS behaviour without redeploying. Keep legacy paths in extension for one release cycle. Ensure data sync (notes, settings) works both directions during transition.

## Rollback Plan
- Immediate disable via Phoenix flags if errors spike.
- Extension detects disabled features and reactivates legacy workflows (voice session JS, IndexedDB caches).
- Maintain migration scripts to re-import IndexedDB data if necessary.

## Testing & QA
- Unit tests for new Elixir modules (`VoiceSession`, `VideoContext`, `Platforms`, `Telemetry`, `NoteQuality`).
- Integration tests for channel protocols, including disconnect/reconnect scenarios.
- End-to-end Playwright flow: voice capture → Phoenix session → note render → automation hook.
- Load testing: 100 concurrent voice sessions, P95 note delivery <500ms; monitor CPU/memory usage.
- Chaos testing: simulate Phoenix restarts, network partitions, forced reconnects.
- Manual extension smoke tests each milestone (voice capture, timeline markers, note rendering, offline queue drain).
- LiveView dashboard verification for telemetry data ingestion and alerting thresholds.

## Success Criteria
- Voice sessions survive extension reloads and report status via Phoenix.
- Side panel renders notes without IndexedDB; channel streams reflect CRUD operations.
- Platform metadata is canonical and shared across server and extension.
- Telemetry dashboard surfaces session metrics; note filtering adapts based on telemetry/user settings.
- Extension settings round-trip through Phoenix with no divergence.
- Deployment completes via feature-flag ramp with no critical rollback.
- Offline queues drain successfully after reconnect with zero data loss.
