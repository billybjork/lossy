# Sprint Roadmap

**Project:** Lossy - Voice-First Video Companion
**Last Updated:** 2025-10-19

---

## Current Status

✅ **Latest Completed Sprint:** [Sprint 06 - Platform-Specific Video Adapters](./archive/SPRINT_06_platform_adapters.md)
📅 **Completed:** 2025-10-19
🎯 **Achievement:** Adapter architecture with TikTok, YouTube, Frame.io, Vimeo, Air, Wipster, and Iconik support

---

## Sprint Overview

### Active Sprints

| Sprint | Status | Goal | Duration |
|--------|--------|------|----------|
| None | - | - | - |

### Upcoming Sprints

| Sprint | Status | Goal | Duration |
|--------|--------|------|----------|
| [07 - Auto Posting](./SPRINT_07_auto_posting.md) | ⏳ Planned | Browserbase automation + Oban workers | 3-5 days |

### Planned Sprints (Not Yet Scheduled)

| Sprint | Goal | Duration |
|--------|------|----------|
| [TBD - Auth](./planned/SPRINT_TBD_auth.md) | User authentication & multi-user support | 2-3 days |
| [TBD - Polish](./planned/SPRINT_TBD_polish.md) | UX polish & animations | 3-4 days |

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
- [LiveView Patterns](../04_LIVEVIEW_PATTERNS.md)
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
- WASM Whisper (local transcription)
- CLIP emoji tokens (visual context)
- Multi-note merging
- Platform-specific optimizations
