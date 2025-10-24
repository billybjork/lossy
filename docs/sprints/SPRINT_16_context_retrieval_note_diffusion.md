# Sprint 16: Context Retrieval & Note Diffusion

**Status:** 📋 Planned  
**Priority:** High  
**Owner:** TBD  
**Progress:** 0%

**Related Sprints**
- ✅ Sprint 10 – Always-On Foundations (voice mode audio VAD)
- 🔜 Sprint 11 – Local-Only Transcription (browser-based VAD + transcription)
- 🔜 Sprint 14 – Voice Mode Mode Polish (Silero VAD)
- 🔜 Sprint 15 – Continuous Session Persistence (evidence ledger, context windowing)
- 🔜 Sprint TBD – Automated Frame Capture (ledger-compatible frame ingestion)

---

## Purpose

Transform the continuous session infrastructure into an agent that can:
- Backfill and reconcile context asynchronously after captures arrive late or blobs expire.
- Escalate low-confidence notes intelligently by harvesting additional evidence or prompting the user.
- Surface replay tools that let users and downstream systems inspect ledger-backed evidence when revisiting a video days or months later.

This sprint operationalizes the evidence ledger created in Sprint 15 and turns it into a diffusion-style refinement loop that keeps session knowledge coherent over time.

---

## Goals

### Primary Deliverables

1. **Asynchronous Context Backfilling**
   - Background worker reconciles late-arriving evidence (frames, transcripts, note updates) into existing notes.
   - Re-run note synthesis when newly ingested evidence changes confidence or coverage.
   - Emit `backfill_complete` events to the extension so UI can update drafts post-hoc.

2. **Low-Confidence Escalation Framework**
   - Define multi-tier confidence thresholds (warning, critical).
   - Implement escalation strategies: pull broader ledger windows, request fresh captures, or ask the user for clarification.
   - Log escalation decisions to the ledger (`context_request`, `retry_capture`) with payload hashes for auditability.

3. **Ledger Replay & Diffusion UI**
   - Side panel “Evidence Inspector” showing transcript snippets, frame thumbnails, and note lineage pulled directly from `session_evidence`.
   - Diffusion timeline view: display note mutations over time (initial draft → refinements → merges).
   - Provide export endpoint/API for replaying ledger-backed sessions (JSON + optional media pointers).

4. **Asynchronous Diffusion Tasks**
   - Task supervisor that rehydrates ledger windows and performs secondary note passes (merge duplicates, improve clarity).
   - Respect cost governors (budget per session) and pause diffusion tasks when budgets exceed limits.
   - Record diffusion outputs as `note_revision` ledger entries referencing prior hashes.

5. **Telemetry & Governance**
   - Confidence delta metrics before/after backfill.
   - Escalation rate and resolution tracking.
   - Replay latency metrics (ledger fetch → UI render) with <1 s target.

### Success Criteria

- [ ] Backfill worker processes all pending evidence within 30 s of arrival and updates ledger hashes.
- [ ] Notes flagged <0.6 confidence trigger escalation flows 100% of the time.
- [ ] Evidence Inspector loads full context (transcripts + frames + lineage) in <1 s for typical sessions.
- [ ] Diffusion passes reduce duplicate/overlapping notes by ≥30% in A/B tests.
- [ ] Export endpoint produces reproducible session bundles (hash stable).
- [ ] Telemetry dashboards report confidence deltas and escalation outcomes with <5 min lag.

---

## Detailed Requirements

### 1. Asynchronous Context Backfilling

**Worker Responsibilities**
- Listen to `session_evidence` inserts (frames, transcripts, note updates).
- Determine affected notes via timestamp overlap and semantic similarity.
- Re-run structuring pipeline with refreshed context; update note text, tags, and confidence.
- Append `note_revision` ledger entry capturing old/new hashes, evidence references, and cost.

**Safeguards**
- Cap revisions per note per hour (default 3) to avoid thrashing.
- Skip revisions when changes fall below a semantic delta threshold.
- Emit instrumentation (`backfill_latency_ms`, `revisions_applied`) for dashboards.

### 2. Low-Confidence Escalation Framework

**Confidence Tiers**
- `>=0.8` – Stable (no action).
- `0.6-0.79` – Warning (queue background diffusion pass).
- `<0.6` – Critical (trigger immediate escalation).

**Escalation Flow**
1. Expand retrieval window (±30 s) and re-run synthesis.
2. If still <0.6, enqueue capture request (new frame grab, optional microphone prompt).
3. If unresolved, surface in side panel with user-facing call-to-action (“Need more detail here?”).
4. Log each decision in ledger with deterministic payload hash.

### 3. Ledger Replay & Diffusion UI

**Evidence Inspector**
- React/LiveView component pulling ledger rows ordered by `sequence`.
- Display transcripts (critical) and frame thumbnails (supplementary) with availability status (blob present/expired).
- Allow filtering by note id, timestamp range, evidence type.

**Diffusion Timeline**
- Visualize note evolution: creation, merges, revisions, escalations.
- Provide “jump to evidence” actions that open transcripts/frames inline.
- Maintain parity between extension UI and Phoenix dashboard for support/debugging.

### 4. Asynchronous Diffusion Tasks

**Pipeline**
```
Ledger trigger ─► Fetch context window ─► Run refinement prompt
               └► Check merge candidates ─► Apply updates ─► Record revision
```
- Each diffusion task references the ledger cursor it read to ensure deterministic replay.
- Task supervisor enforces concurrency limits per session (default: 1 active diffusion task).
- Integrate with cost governor; abort tasks when session budget exhausted.

### 5. Telemetry & Governance

- Add Prometheus counters/histograms for `note_confidence_delta`, `escalations_triggered`, `escalations_resolved`.
- Emit structured logs linking diffusion tasks to ledger sequences.
- Build Grafana dashboard panels for replay latency, backfill throughput, escalation backlog.

---

## Implementation Phases

### Phase 1: Backfill Foundation (Week 1-2)
- Oban worker for ledger insert hooks.
- Revision application logic + safeguards.
- Telemetry for backfill latency and revision count.

### Phase 2: Escalation Framework (Week 2-3)
- Confidence tier configuration + runtime toggles.
- Escalation pipeline (retrieve → capture request → user prompt).
- Ledger logging for escalation events.

### Phase 3: Replay & Diffusion UI (Week 3-4)
- Evidence Inspector component (LiveView + extension integration).
- Diffusion timeline view with lineage visualization.
- Export endpoint for session bundles.

### Phase 4: Asynchronous Diffusion Tasks (Week 4-5)
- Task supervisor + refinement prompts.
- Merge detection heuristics + automation.
- Cost governor integration + telemetry.

### Phase 5: Hardening & QA (Week 5-6)
- Load testing for ledger replay / UI latency.
- End-to-end rehearsal with long-lived sessions (30+ days).
- Documentation & runbooks for escalations/backfill.

**Total Estimated Time:** 6 weeks

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Backfill loops** | Endless revisions | Semantic delta thresholds, per-hour revision caps |
| **Escalation fatigue** | User overwhelmed by prompts | Escalation batching, UI rate limits |
| **Replay latency spikes** | Poor UX for Evidence Inspector | Indexes on `session_evidence`, caching hot sessions |
| **Cost overruns** | Budgets exceeded by diffusion tasks | Cost governor enforcement, per-session caps |
| **Ledger drift** | Replays diverge from production notes | Hash comparisons, nightly replay verification |

---

## Deferred Items (Sprint 16+)

- Cross-session context stitching (carry insights across related videos).
- Automated summarization of ledger history into shareable reports.
- User-configurable confidence thresholds and escalation preferences.

---

**Document Version:** 1.0 (Planning)  
**Last Updated:** 2025-10-22  
**Author:** Claude Code (drafted via Codex assistant)

