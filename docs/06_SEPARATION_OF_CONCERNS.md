# Separation of Concerns: Leaning on Phoenix

## Goal
- Reduce the amount of business logic that currently lives inside the Chrome extension codebase.
- Centralise stateful orchestration inside Phoenix/Elixir where we already have resilient processes, PubSub, and a relational store.
- Make the JavaScript surface area mostly about DOM integrations, media capture, and UX polish.

## Summary of Gaps
- **Voice session lifecycle and heuristics** (auto-pause, cooldowns, circuit breakers) are implemented entirely in `extension/src/background/modules/voice-session-manager.js`, leaving `Lossy.Agent.Session` with a narrow remit.
- **Note hydration, deduplication, and storage limits** are executed in `extension/src/sidepanel/sidepanel.js` and backed by IndexedDB, despite Phoenix already owning the canonical note store.
- **Video context tracking** (active tab, SPA navigation, session invalidation) is coordinated in the service worker (`tab-manager.js`, `video-context-manager.js`) rather than in an Elixir process that could inform every client via PubSub.
- **Telemetry buffering and error reporting** are trapped inside the extension (`service-worker.js`, `shared/telemetry-emitter.js`) instead of flowing into Phoenix for retention, alerting, and LiveView surfacing.
- **Automation workflows** (note refinement, posting queue coordination) are initiated from the side panel/service worker instead of using Oban and Phoenix channels to own the work graph.

## Authentication & Protocol Negotiation
- Extension joins Phoenix channels with a short-lived JWT retrieved via `POST /api/auth/extension_token`, signed using existing Phoenix session cookies. The token includes `user_id`, a stable `device_id`, an expiry, and the requested protocol version.
- Tokens are cached in `chrome.storage.local`, refreshed proactively when the expiry is near or when Phoenix rejects a join. Phoenix validates signature, expiry, and user/device claims before accepting a connection.
- Channel handshakes negotiate protocol versions: `v1` (legacy transcript-only) and `v2` (voice events + Phoenix-owned sessions). Phoenix replies with the active version and supported feature flags so the extension can fall back gracefully if needed.

## VAD Processing Boundary
- The extension keeps responsibility for audio capture, VAD processing, ring buffers, and local speech detection. Phoenix will never receive raw PCM/WebM chunks; it only consumes high-level events such as `speech_start`, `speech_end`, `silence_timeout`, metrics summaries, and locally transcribed text.
- The voice session GenServer must assume events can be replayed (e.g., after reconnect) and reconcile state without access to the original audio.

## Opportunities to Shift into Elixir

### 1. Voice Session Orchestration
- **Today:** JS manages VAD state, cooldowns, circuit-breakers, timers, and timestamp routing (`voice-session-manager.js`, `recording-context-state.js`, `service-worker.js`). The Phoenix `AudioChannel` only receives final transcripts.
- **Shift:** Extend `Lossy.Agent.Session` (or introduce `Lossy.Agent.VoiceSession`) to hold the full session state machine: observing → recording → cooldown, guard timers, video context reconciliation, telemetry counters. Channel push events (`speech_start`, `speech_end`, `metrics`, `heartbeat`) can be relayed from the extension and resolved server-side.
- **Why Phoenix:** OTP supervision and `Process.send_after/3` give us durable timers; multiple tabs/devices can observe the same session via PubSub; behaviour is easier to test with `ExUnit`.
- **Implementation Notes:**
  1. Introduce a dedicated `Lossy.Agent.VoiceSession` process that wraps `Lossy.Agent.Session` and owns session metadata (video_id, tab_id, guard timers).
  2. Add Phoenix channel events (`voice_event`, `voice_status`, `heartbeat`) so the extension becomes a thin adapter that forwards hardware signals.
  3. Move cooldown, guard, and auto-resume logic into Elixir, exposing decisions back to the extension as channel pushes.
  4. Emit telemetry via `Phoenix.PubSub` / `Telemetry` events so LiveView and logs stay in sync.
  5. Define reconnection semantics: the extension shares `last_known_state` (session_id, state, last_event_timestamp, sequence) and replays up to 100 buffered critical events. Phoenix accepts contiguous events or instructs a reset if states diverge.
  6. Timeouts fall back to a local pending queue whenever Phoenix is unavailable for more than ~30s, ensuring notes/transcripts are preserved.

### 2. Note Hydration & Caching
- **Today:** The side panel keeps a per-video memory cache plus IndexedDB persistence, handles pruning, dedup, and render state via `notesCache` helpers (`sidepanel.js`, `NoteLoader`, `shared/db.js`).
- **Shift:** Let `LossyWeb.NotesChannel` deliver initial note lists, stream updates, and acknowledge deletions. Add server-side pagination/expiry and push `note_deleted` / `note_updated` events. The extension only needs to render the stream it receives.
- **Why Phoenix:** Centralised data prevents cache drift, eliminates IndexedDB maintenance, and makes note replay consistent across clients. We can reuse `Lossy.Videos` queries for filtering and ordering instead of reimplementing them in JS.
- **Implementation Notes:**
  1. Expand `NotesChannel` join reply to include the current notes plus metadata (cursor, counts) so the panel has all it needs without IndexedDB.
  2. Broadcast `note_deleted`, `note_updated`, and `video_summary` via PubSub when Elixir mutates data (`Videos.delete_note/1`, `Videos.update_note/2`).
  3. Replace sidepanel cache helpers with a simple `LiveSocket` consumer that trusts channel pushes. Keep a small in-memory list purely for DOM diffing.
  4. Retain a minimal IndexedDB queue for `pending_notes` that could not be delivered to Phoenix (offline mode). Once the channel acknowledges receipt the note is removed from the queue.
  5. Expose `Lossy.Videos` queries (e.g., `list_notes/1` with filters, pagination) to support future filters without shipping more JS.

### 3. Video Context, Platform Detection & Session Tracking
- **Today:** The service worker and content script cooperate via `TabManager` and `video-context-manager` to decide which video is current, debounce SPA navigation, and rehydrate context after reload. Platform detection heuristics live in multiple places (`service-worker.js`, adapters) as hostname includes checks.
- **Shift:** Persist video-session state in Elixir using a process or table that tracks `video_id`, `tab_id`, `url`, `title`, `platform`, and `session_id`. Centralise platform detection/validation in a `Lossy.Platforms` module so the extension and automation layer both rely on the same adapter definitions. Once a content script signals `video_detected`, register the context server-side and broadcast changes. The extension only announces DOM events; Phoenix becomes the source of truth for “which video is active” and powers other clients (LiveView dashboards, automation agent).
- **Why Phoenix:** SPA navigation logic, platform policy, and multi-window reconciliation all benefit from a shared state map. OTP supervision keeps context alive even if the extension restarts.
- **Implementation Notes:**
  1. Add a `Lossy.Agent.VideoContext` Registry or ETS-backed cache keyed by session/user.
  2. Implement `Lossy.Platforms` adapters (detection, validation, canonical IDs) and expose them through `VideoChannel`.
  3. Generate a build-time `platform_adapters.json` artifact from Phoenix so the extension bundler ships the same adapter definitions; version the manifest for compatibility.
  4. Modify `VideoChannel` to acknowledge and broadcast context updates (`video_context_updated`, `video_cleared`) using the enriched platform metadata.
  5. Let `Lossy.Agent.Session` subscribe to these updates so timestamps stay correct without JS-side guards.
  6. Deliver context snapshots to the extension through channel pushes when side panel focus changes and enforce a last-active-tab-wins policy: Phoenix informs other tabs when ownership changes, and non-owners render read-only UI until the context becomes available again.

### 4. Telemetry, Analytics & Note Quality
- **Today:** `telemetry-emitter.js` and the service worker buffer WARN/ERROR events locally. Note filtering uses a fixed 0.3 confidence threshold inside `Lossy.Agent.Session`.
- **Shift:** Add a Phoenix channel (or REST endpoint via `Req`) that accepts telemetry payloads and note outcomes. Persist events in Postgres (or ETS) and stream them to LiveView dashboards. Use the same data to build adaptive note-quality policies per user/platform.
- **Why Phoenix:** Centralised telemetry enables alerting, aggregated analytics, and long-term tuning of note thresholds.
- **Implementation Notes:**
  1. Create a `Lossy.Telemetry` context with schemas for `telemetry_events` and note quality feedback.
  2. Extend the extension logger to push events via a `TelemetryChannel` (or reuse `NotesChannel` with telemetry topics).
  3. Surface a LiveView debug panel replacing the current HTML debug drawer.
  4. Protect dashboards with Phoenix session authentication plus an admin role check.
  5. Introduce a `Lossy.NoteQuality` module with clear MVP heuristics (e.g., hard min 0.25, base threshold from `user_settings`, category-specific bumps after repeated deletions) while logging outcomes for future ML work.
  6. Loop aggregated metrics back into the voice session process (e.g., adjusting cooldowns, auto-pause behaviour).

### 5. Automation & Job Coordination
- **Today:** The side panel triggers note refinement (`refine_note_with_vision`) and will eventually handle posting via direct channel pushes (`service-worker.js` around the `refine_note_with_vision` handler).
- **Shift:** Use Oban workers to enqueue refinements/posting requests so the extension only issues intents. Phoenix handles retries, visibility into job state, and ensures tasks survive browser restarts.
- **Why Phoenix:** Job orchestration, retries, and observability belong with Oban. It keeps Chrome code thin and makes automated posting consistent.
- **Implementation Notes:**
  1. Add an Oban queue (`:automation`) with workers for `RefineNote` and `PostNote`.
  2. Change service worker handlers to push intents via `VideoChannel` (`refine_note`, `queue_posting`), letting Elixir enqueue the job and broadcast status updates.
  3. Extend `Videos` context with helpers to transition note statuses and store job outcomes.

### 6. Feature Flags, Preferences & Policies
- **Today:** Feature toggles live in `chrome.storage.local` (`shared/settings.js`), making them per-browser and invisible to Phoenix. Note-confidence thresholds are global constants.
- **Shift:** Persist feature flags and note policies in Phoenix (`Lossy.Users.Settings`) so we can sync across devices, expose admin controls, and drive server-side decisions (e.g., auto-post gating, vision refinements).
- **Implementation Notes:**
  1. Introduce a `user_settings` table with fields mirroring the extension toggles plus note-quality preferences (minimum confidence, categories to auto-firm, platform overrides).
  2. Sync on extension startup via REST or channel join payload.
  3. Use Phoenix to enforce defaults, run migrations, and compose policies for automation workers.
  4. Feed settings into `Lossy.Agent.VoiceSession` / `Lossy.NoteQuality` so the session engine respects user-configured behaviour.

## Suggested Implementation Roadmap
1. **Session Orchestration Phase**
   - Stand up `Lossy.Agent.VoiceSession`.
   - Add channel events for voice lifecycle.
   - Remove cooldown/guard logic from `voice-session-manager.js` after parity tests.
2. **Notes, Video & Platform Phase**
   - Expand `NotesChannel` and `VideoChannel` responses/broadcasts.
   - Replace IndexedDB caches with channel-driven state.
   - Store active video contexts and platform metadata in Phoenix and sync to extension.
   - Share platform adapters between Phoenix and the extension bundle (generate adapter manifests during build).
3. **Telemetry, Quality & Jobs Phase**
   - Implement telemetry ingestion context + LiveView dashboard.
   - Route `refine_note_with_vision` and future posting flows through Oban workers.
   - Replace JS debug drawer with LiveView, consuming the new telemetry sources.
   - Build `Lossy.NoteQuality` heuristics using telemetry and user prefs.
4. **Settings & Policy Phase**
   - Add user settings schema/API.
   - Wire extension bootstrapping to pull/push settings via Phoenix.
   - Integrate note-quality and feature policies into the voice session process.

## Migration & Rollback Strategy
- Feature flags (e.g., `phoenix_voice_session`, `phoenix_notes_channel`, `phoenix_video_context`) gate each capability. Flags default to false and are enabled gradually per user/cohort.
- Extension detects server capability/version during channel join and falls back to legacy JS paths when Phoenix flags are disabled or versions mismatch.
- Existing IndexedDB caches can be dropped during rollout (no production data yet), but hooks remain if we later need to export pending notes for early adopters.
- During rollback Phoenix toggles flags off, prompting the extension to revert to legacy code paths without a redeploy. Legacy logic remains in the bundle for at least one release cycle.
- Voice sessions in progress during rollout are checkpointed in Elixir (session/timestamp) so reconnecting extensions can resume gracefully.

## Measuring Success
- Side panel bundle sheds the IndexedDB and voice session state machine code.
- Phoenix processes expose testable behaviour (unit + integration tests) for voice lifecycle, note delivery, telemetry ingestion.
- LiveView dashboards display the same telemetry now only visible in the extension’s debug drawer.
- New automation tasks are retriable/observable in Oban without manual Chrome interaction.
- P95 note delivery latency < 500ms (speech_end → rendered in side panel).
- Session recovery time after network disconnect < 2s.
- Zero data loss during simulated network interruptions (pending queue drains cleanly once Phoenix returns).
