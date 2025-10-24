# Sprint TBD: Analytics & Telemetry Foundation

**Status:** ⏳ Planned  
**Estimated Duration:** 2-3 days

---

## Goal

Establish a unified analytics and telemetry layer covering both the Chrome extension and Phoenix backend so we can monitor product health, performance, and user outcomes. Deliver structured event pipelines, dashboards, and developer-facing hooks that convert existing console logs and TODOs into actionable metrics.

---

## Current Signals & Gaps

| Area | Current State | Gap |
|------|---------------|-----|
| Voice Mode mode VAD (Sprint 10) | Debug drawer counters (`speechDetections`, `ignoredShort`, `avgLatencyMs`) updated in-memory | No persistence, no historical tracking, no alerting |
| Local transcription (Sprint 07) | TODO to emit `[:lossy, :stt, ...]` telemetry events | Events never shipped; success/fallback rate unknown |
| Continuous sessions (Sprint 15 planned) | Design references mailbox depth telemetry | Implementation pending |
| IndexedDB cache (Sprint 13) | Console logs for cache hits/prunes | No metrics for hit rate, eviction frequency, quota usage |
| Automated frame capture (planned) | Budget/cost guardrails rely on telemetry | Requires infrastructure before GA |
| Browser automation (advanced doc) | Emits `:note_posted` telemetry stub | Needs standard payload + aggregation |
| Product analytics | No funnel or retention analytics; only raw Phoenix logs |

---

## Deliverables

- [ ] Extension telemetry module (`extension/src/shared/telemetry.js`) with buffered, reliable event dispatch.
- [ ] Phoenix telemetry router (`lossy/lib/lossy/telemetry.ex`) attaching to core processes (STT, voice mode agent, cache eviction).
- [ ] Event schema catalog (YAML/JSON) describing payloads, PII handling, sampling rules.
- [ ] Storage/transport: initial implementation via Phoenix Channel -> Oban job -> PostgreSQL `analytics_events` table.
- [ ] Grafana/LiveDashboard boards for:
  - Voice Mode mode detection quality (latency, ignored segments, false positives).
  - STT success rate (local vs fallback).
  - Cache health (IndexedDB hit rate, eviction counts, quota usage).
- [ ] Debug drawer updates surfacing aggregated metrics (past 5 minutes window) to developers.
- [ ] Privacy/opt-out switch (env flag + per-user setting placeholder) complying with data retention guidelines.
- [ ] Documentation: telemetry quickstart, schema reference, alert thresholds.

---

## Implementation Outline

### Task 1: Telemetry Architecture
- Define event taxonomy (extension, backend, automation) in `docs/telemetry/events.yml`.
- Create shared constants helper to prevent mismatched event names.
- Decide on transport (Phoenix Channel `telemetry` topic) with exponential backoff + disk queue fallback in the extension.

### Task 2: Extension Instrumentation
- Build `telemetry.js` with:
  - `emit(eventName, payload, options)` API.
  - Offline buffer in IndexedDB (`telemetry_events` store) with retry.
  - Rate limiting/batching per event family.
- Instrument existing hotspots:
  - Voice Mode session counters (`extension/src/background/service-worker.js`).
  - Notes cache hits/misses & evictions (`extension/src/sidepanel/sidepanel.js`).
  - Library fetch durations & error rates.

### Task 3: Backend Telemetry Pipeline
- Add `Lossy.Telemetry` module wiring `:telemetry.attach_many/4` handlers.
- Persist events via Oban worker (`Lossy.Workers.TelemetryIngest`) writing to `analytics_events` table.
- Expose LiveDashboard metrics (Telemetry.Metrics) for key counters/averages.
- Implement quota/alert scaffolding (e.g., `lossy_cache_evictions_total`, `lossy_vad_latency_ms`).

### Task 4: Visualization & Alerts
- Create Grafana/Prometheus integration (or LiveDashboard pages) for:
  - Voice Mode mode detection KPIs.
  - STT local vs fallback success.
  - Cache eviction rate & storage usage.
- Define alert thresholds (e.g., fallback rate > 20%, cache eviction spike) with playbooks.

### Task 5: Developer Experience
- Extend voice mode mode debug drawer to display rolling averages (using telemetry subscriber).
- Add CLI task `mix telemetry.dump --since 1h` for quick inspection.
- Document onboarding: how to add new events, test locally, and validate in staging.

---

## Event Schema (Initial Draft)

| Event | Source | Key Fields | Purpose |
|-------|--------|------------|---------|
| `lossy.voice mode.speech_detected` | Background SW | latency_ms, amplitude, ignored (bool), session_id | Monitor VAD performance |
| `lossy.voice mode.segment_ignored` | Background SW | reason (`short`, `cooldown`, `noise`), duration_ms | Tune thresholds |
| `lossy.stt.request` / `lossy.stt.completed` / `lossy.stt.fallback` | Backend | mode (`local_webgpu`, `local_wasm`), duration_ms, error_msg | Local STT health |
| `lossy.cache.notes_hit` / `miss` / `evicted` | Sidepanel | video_id hash, warm_start (bool), evicted_count | Cache effectiveness |
| `lossy.cache.videos_evicted` | Sidepanel | evicted_count | Track library churn |
| `lossy.automation.note_posted` | Backend | platform, latency_ms, retries | Browser automation quality |
| `lossy.error.extension` | Extension | component, code, recoverable (bool) | Error budget |

---

## Testing & Validation

- Unit tests for telemetry buffer edge cases (backoff, offline mode).
- Integration test: simulate voice mode session and assert metrics written to `analytics_events`.
- Manual smoke:
  1. Trigger voice mode mode, verify dashboard updates.
  2. Force cache eviction and confirm metric increments.
  3. Disconnect network, emit events, reconnect → ensure queued events flush.
- Load test: fire 1k events/min to ensure Oban ingestion keeps up (<10% drop).

---

## Risks & Mitigations

- **PII leakage:** enforce payload whitelist + hashing for IDs.
- **Extension storage quota:** telemetry buffer uses capped IndexedDB store with FIFO eviction.
- **Network cost:** batch events, compress payloads; allow telemetry disable in dev.
- **Alert fatigue:** start with dashboards only, introduce alerts after baseline collected.

---

## Dependencies & Follow-ups

- Coordinate with upcoming Continuous Sessions (Sprint 15) to reuse mailbox telemetry patterns.
- Align with Browserbase automation to reuse `:telemetry.execute/3` helpers.
- Future: integrate with product analytics platform (e.g., PostHog/Amplitude) once backend pipeline validated.

