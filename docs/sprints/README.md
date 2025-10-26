# Sprint Roadmap

**Project:** Lossy - Voice-First Video Companion
**Last Updated:** 2025-10-23

---

## Current Status

🎉 **Latest:** Sprint 12 (Notes Channel Refactor + Voice Mode Mode Tab Switching) completed 2025-10-23
📋 **Active:** None
🔜 **Next:** Sprint 14 (Voice Mode Mode Polish) or Sprint 15 (Continuous Sessions)

---

## Sprint Overview

### Active Sprints

| Sprint | Status | Goal | Duration |
|--------|--------|------|----------|
| None | - | - | - |

### Upcoming Sprints

| Sprint | Status | Goal | Duration |
|--------|--------|------|----------|
| None scheduled | - | - | - |

### Planned Sprints (Not Yet Scheduled)

| Sprint | Goal | Duration |
|--------|------|----------|
| [14 - Voice Mode Mode Polish](./SPRINT_14_voice mode_mode_polish.md) | UX improvements, status indicators, error recovery | 2-3 days |
| [16 - Continuous Sessions](./SPRINT_16_continuous_sessions.md) | Session persistence across browser restarts + state recovery | 3-4 days |
| [TBD - Emoji Chips](./planned/SPRINT_TBD_emoji_chips.md) | Text-based visual feedback tokens using transcription | 2-3 days |
| [TBD - Auto Posting](./planned/SPRINT_TBD_auto_posting.md) | Browserbase automation + Oban workers | 3-5 days |
| [TBD - Auth](./planned/SPRINT_TBD_auth.md) | User authentication & multi-user support | 2-3 days |
| [TBD - Polish](./planned/SPRINT_TBD_polish.md) | General UX polish & animations | 3-4 days |
| [TBD - Analytics & Telemetry](./planned/SPRINT_TBD_analytics_telemetry.md) | Unified metrics pipeline, dashboards, cache + VAD instrumentation | 2-3 days |

### Completed Sprints

| Sprint | Completed | Goal | Duration |
|--------|-----------|------|----------|
| [00 - Scaffolding](./archive/SPRINT_00_scaffolding.md) | ✅ 2025-10-14 | Project foundations & build setup | 1 day |
| [01 - Audio Streaming](./archive/SPRINT_01_audio_streaming.md) | ✅ 2025-10-14 | Audio capture + Phoenix Channels (no auth) | 1 day |
| [02 - Cloud Transcription](./archive/SPRINT_02_transcription.md) | ✅ 2025-10-14 | OpenAI Whisper + GPT-4o note structuring | 1 day |
| [03 - Video Integration](./archive/SPRINT_03_video_integration.md) | ✅ 2025-10-14 | Content scripts + video timestamp anchoring | 3 days |
| [04 - Tab Management](./archive/SPRINT_04_tab_management.md) | ✅ 2025-10-15 | Multi-tab context tracking & message routing | 2 days |
| [05 - Reliability](./archive/SPRINT_05_reliability_improvements.md) | ✅ 2025-10-16 | Self-healing architecture + 95%+ reliability | 6 days |
| [06 - Platform Adapters](./archive/SPRINT_06_platform_adapters.md) | ✅ 2025-10-19 | Plugin-based adapter architecture for multi-platform support | 3 days |
| [07 - Local Transcription](./archive/SPRINT_07_local_transcription.md) | ✅ 2025-10-20 | Browser-side Whisper Tiny with WebGPU/WASM + cloud fallback | 3 days |
| [08 - GPT-4o Vision Integration](./archive/SPRINT_08_siglip_vision.md) | ✅ 2025-10-20 | Cloud-based visual context enrichment for notes | 2 days |
| [09 - Video Library](./archive/SPRINT_09_video_library.md) | ✅ 2025-10-22 | Video history management, queue system, and auto-status transitions | 2 days |
| [10 - Always-On Agent](./archive/SPRINT_10_always_on_agent.md) | ✅ 2025-10-22 | VAD-driven voice mode recording with energy-based speech detection | 1 day |
| [11 - Local-Only Transcription](./archive/SPRINT_11_local_only_transcription.md) | ✅ 2025-10-22 | Removed cloud transcription, 100% local privacy with WebGPU/WASM | 1 day |
| [12 - Notes Channel Refactor](./archive/SPRINT_12_notes_channel_refactor.md) | ✅ 2025-10-23 | Direct Phoenix Channel subscription + voice mode mode tab switching fix | 3 hours |
| [13 - IndexedDB Cache](./archive/SPRINT_13_indexeddb_cache.md) | ✅ 2025-10-23 | Sidepanel/Dexie caching for notes & video library | 1 day |

---

## Sprint Philosophy

Each sprint follows these principles:

- ✅ **Shippable**: Working software at end of sprint
- ✅ **Testable**: Clear acceptance criteria
- ✅ **Focused**: Single clear objective
- ✅ **Vertical**: Full-stack feature slices
- ✅ **Documented**: Learnings captured in sprint file

---

## How to Use This System

### Starting a Sprint

1. Read the sprint file (e.g., `SPRINT_01_audio_streaming.md`)
2. Review prerequisites and dependencies
3. Follow technical tasks sequentially
4. Test against deliverables checklist

### Completing a Sprint

1. ✅ All deliverables checked off
2. 📝 Testing checklist verified
3. 🎓 Notes section updated with learnings
4. 🔄 Update this README with status
5. 📋 Plan next sprint

### Sprint File Format

Each sprint file contains:
- **Status Badge**: Current state
- **Goal**: One-sentence objective
- **Prerequisites**: What must be done first
- **Duration Estimate**: Realistic time expectation
- **Deliverables**: Concrete checkboxes
- **Technical Tasks**: Step-by-step implementation
- **Testing Checklist**: Verification steps
- **Notes**: Decisions, gotchas, learnings

---

## Quick Links

- [Main Docs Index](../INDEX.md)
- [Project Overview](../01_OVERVIEW.md)
- [Development Principles](../02_PRINCIPLES.md)
- [Architecture](../03_ARCHITECTURE.md)
- [Browserbase Integration](../05_BROWSERBASE_INTEGRATION.md)
- [Technical References](../TECHNICAL_REFERENCES.md)

---

## Milestones

### MVP (Minimum Viable Product)
**Target:** Sprints 00-04 complete
**Timeline:** ~2 weeks
**Outcome:** Can record voice, get transcripts, see notes, auto-post to platforms

### Production Ready
**Target:** Sprints 00-06 complete
**Timeline:** ~3-4 weeks
**Outcome:** Full UX, auth system, ready for real users

### Future Enhancements
- Text-based emoji chips (sentiment feedback visualization)
- Semantic search with embeddings
- Multi-note merging
- Platform-specific optimizations
- Advanced diarization / multi-speaker separation
