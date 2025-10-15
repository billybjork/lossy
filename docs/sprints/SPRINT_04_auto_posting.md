# Sprint 04: Auto-Posting with Browserbase

**Status:** ⏳ Planned
**Estimated Duration:** 3-5 days

---

## Goal

Automatically post high-confidence notes to video platforms using Browserbase automation and Oban background jobs.

---

## Prerequisites

- ✅ Sprint 03 complete (video integration working)
- ⏳ Browserbase account & API keys
- ⏳ Python environment with Playwright

---

## Deliverables

- [ ] Python agent posts comments to YouTube/Vimeo/Air
- [ ] Oban worker queues high-confidence notes
- [ ] Retry logic for failed posts
- [ ] Note status tracking (ghost → posting → posted)
- [ ] Side panel shows posting progress
- [ ] Posted comment permalink stored

---

## Technical Tasks

### Task 1: Python Browserbase Agent

- `priv/python/agent_playwright.py`
- Navigate to video at timestamp
- Post comment
- Extract permalink

### Task 2: Elixir Bridge

- `lib/lossy/automation/python_bridge.ex`
- Call Python script via `System.cmd`
- Parse JSON output

### Task 3: Oban Worker

- `lib/lossy/workers/apply_note_worker.ex`
- Queue notes with confidence > 0.7
- Retry logic (max 3 attempts)
- Update note status

---

## Reference Documentation

See [04_BROWSERBASE_INTEGRATION.md](../04_BROWSERBASE_INTEGRATION.md) for:
- Complete Browserbase API integration guide
- Session management and auth flow
- Error handling strategies
- Python agent implementation details
- Port communication patterns (Phase 2)

---

## Next Sprint

👉 [Sprint 05 - Authentication](./SPRINT_05_auth.md)
