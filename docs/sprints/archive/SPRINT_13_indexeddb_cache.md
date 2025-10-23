# Sprint 13: IndexedDB Cache for Notes & Library

**Status:** ✅ Complete  
**Estimated Duration:** 1-2 days

---

## Goal

Persist the sidepanel's notes and video library data in the browser so previously fetched content loads instantly, survives extension/browser restarts, and remains accessible during brief offline windows. Use IndexedDB (via Dexie.js) as a lightweight cache layered on top of existing Phoenix Channels + PostgreSQL.

---

## Pre-Sprint Baseline

- Notes and transcripts are kept only in-memory (`notesCache` `Map` in `extension/src/sidepanel/sidepanel.js`, around line 30); they disappear on reload and require a fresh `get_notes` push over the channel.
- The video library is stored in a simple array (`videoLibraryCache` in the same file, around line 1330) and re-fetched from the service worker every time the tab is opened or filters change.
- We already rely on Phoenix Channels for real-time updates and `chrome.storage` for user settings, but there is no persistence layer for content data.
- IndexedDB is currently used only by the Whisper loader for ONNX assets; no shared database module exists for application data.

---

## Implementation Notes

- Added a shared Dexie singleton (`extension/src/shared/db.js`) with stores for notes, videos, and sync metadata.
- Sidepanel now hydrates notes from IndexedDB before requesting `get_notes`, keeping cached arrays in sync via write-through on `note_created` and delete flows.
- Video library tab renders cached results immediately, then refreshes in the background and upserts fresh data into IndexedDB for future sessions.
- Introduced helper utilities for normalizing cached items and lightweight logging around cache hits/misses.
- Outstanding follow-up: add quota guardrails/telemetry and eviction logic once metrics are wired up.

---

## Why Now

- **Perceived performance:** cached notes can render in <50 ms instead of waiting ~200-500 ms for the channel roundtrip, eliminating UI flicker when switching videos.
- **Resilience:** previously loaded notes and library items remain visible if the socket reconnects or the backend is briefly unavailable.
- **Offline grace period:** users can reference (and potentially queue edits for) recent notes without connectivity, aligning with project principles around graceful degradation.
- **Low effort / high impact:** small bundle increase (~15 KB gzipped with Dexie) and minimal churn in the existing architecture compared to heavier alternatives (Electric SQL).

---

## Deliverables

- [x] Dexie-based database module (`extension/src/shared/db.js`) with stores for `notes`, `videos`, and `sync_metadata`.
- [x] Cache hydration on sidepanel load: render from IndexedDB first, then reconcile with live Phoenix data.
- [x] Channel/event handlers write-through to IndexedDB (create, delete, and future update events).
- [x] Video library fetch adopts cache-first + background refresh pattern with basic filter support.
- [ ] Storage quota guardrails and metrics/logging for cache hits vs server fallbacks. *(Follow-up: add eviction + telemetry hook)*
- [x] Automated smoke test (Playwright or Puppeteer) or manual test script covering warm start, cold start, offline mode, and deletion flow. *(Manual checklist: `docs/manual_tests/indexeddb_cache.md`)*
- [x] Documentation updates (e.g., `docs/TECHNICAL_REFERENCES.md`) describing the IndexedDB schema and eviction policy.

---

## Implementation Outline

### Task 1: Shared Database Module
- Add Dexie to `extension/package.json` and bundle config.
- Create `extension/src/shared/db.js` exporting a singleton Dexie instance with stores:
  - `notes`: `id` primary key, indexes on `video_id`, `timestamp_seconds`, and `[video_id+timestamp_seconds]`.
  - `videos`: `id` primary key, indexes on `status`, `platform`, and `last_viewed_at`.
  - `sync_metadata`: key/value store for last sync timestamps and schema version.
- Include `version()` migrations to support future schema changes (e.g., status flags).

### Task 2: Notes Cache Integration
- Replace the `Map`-only `storeNoteInCache` logic with a write-through to Dexie while still maintaining the in-memory map for fast reuse.
- On `renderNotesFromCache`, fall back to Dexie when the in-memory cache is empty; repopulate the map with the result.
- Extend Phoenix channel handlers (`note_created`, future `note_updated`, delete acknowledgements) to persist changes and tag notes with `synced_at`.
- Handle deletes by removing rows from Dexie and the in-memory map. Consider storing soft-delete markers if needed for offline-first flows.

### Task 3: Video Library Cache
- On library tab activation:
  1. Load and render cached videos from Dexie.
  2. Fire background fetch via service worker (`list_videos`).
  3. Write fresh results back to Dexie and re-render if data changed.
- Apply filters client-side for cached data before the network response returns, keeping parity with backend filtering rules.
- Store metadata such as `last_synced_at`, `platform`, `status`, and note counts to enable richer offline filtering.

### Task 4: Sync & Observability (Deferred)
- Track `sync_metadata` keys for each video to support incremental fetches later (e.g., `notes_last_synced_at`).
- Emit telemetry for cache hits/misses, quota usage, and sync errors.
- Add lightweight eviction strategy (e.g., limit to N videos or M notes per video, pruning oldest entries).

---

## Testing & Validation

- Warm start: load sidepanel twice without closing the tab; confirm second load renders instantly from IndexedDB.
- Cold start: reload the extension or browser; cached notes and library entries should still appear before the network response.
- Offline mode: disconnect from backend, open a video that was previously synced; notes remain readable, attempts to modify surface clear errors.
- Delete flow: remove a note while online; ensure it disappears from the UI, Dexie, and stays gone after reload.
- Storage quota: simulate full cache to confirm eviction strategy prevents write failures.

---

## Risks & Mitigations

- **Service worker lifetime:** ensure cache writes happen in the sidepanel context (or via dedicated worker) so they are not lost when the service worker sleeps.
- **Data drift:** backend updates that occur while the panel is closed could leave stale data; mitigate by timestamping caches and forcing a full refresh when the socket rejoins.
- **Bundle size:** Dexie adds ~50 KB minified (~15 KB gzipped); acceptable but monitor for future growth.
- **Concurrency:** multiple sidepanel instances (e.g., incognito) writing simultaneously—Dexie handles transactions, but we should guard against duplicate listeners.
- **Security:** cached data lives in IndexedDB; ensure sensitive fields (if any) remain encrypted or consider purging on explicit logout once auth lands.

---

## Dependencies & Follow-ups

- Requires Dexie dependency approval and inclusion in webpack bundle.
- Align with upcoming authentication work so user-specific caches can be scoped/cleared on logout.
- Future enhancement: queue offline note creation edits with retry semantics (out of scope for this sprint).
