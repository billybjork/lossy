# Sprint Roadmap

**Project:** Lossy - Voice-First Video Companion
**Last Updated:** 2025-10-14

---

## Current Status

🚧 **Active Sprint:** [Sprint 01 - Audio Streaming (No Auth)](./SPRINT_01_audio_streaming.md)
📅 **Started:** 2025-10-14
🎯 **Goal:** Get audio flowing from extension → backend → extension without authentication

---

## Sprint Overview

| Sprint | Status | Goal | Duration |
|--------|--------|------|----------|
| [00 - Scaffolding](./SPRINT_00_scaffolding.md) | ✅ Complete | Project foundations & build setup | 1 day |
| [01 - Audio Streaming](./SPRINT_01_audio_streaming.md) | 🚧 In Progress | Audio capture + Phoenix Channels (no auth) | 2-3 days |
| [02 - Transcription](./SPRINT_02_transcription.md) | ⏳ Planned | OpenAI Whisper + GPT-4o note structuring | 2-3 days |
| [03 - Video Integration](./SPRINT_03_video_integration.md) | ⏳ Planned | Content scripts + video timestamp anchoring | 2-3 days |
| [04 - Auto Posting](./SPRINT_04_auto_posting.md) | ⏳ Planned | Browserbase automation + Oban workers | 3-5 days |
| [05 - Auth](./SPRINT_05_auth.md) | ⏳ Future | User authentication & multi-user support | 2-3 days |
| [06 - Polish](./SPRINT_06_polish.md) | ⏳ Future | On-video overlays + UX refinements | 3-4 days |

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
- [Project Overview](../01_PROJECT_OVERVIEW.md)
- [Architecture](../02_ARCHITECTURE.md)
- [LiveView Patterns](../03_LIVEVIEW_PATTERNS.md)
- [Browserbase Integration](../04_BROWSERBASE_INTEGRATION.md)
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
