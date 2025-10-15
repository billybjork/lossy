# Sprint 03: Video Integration

**Status:** ⏳ Planned
**Estimated Duration:** 2-3 days

---

## Goal

Connect notes to actual video timestamps. Content script detects video player, extracts timestamp when recording starts, and associates notes with specific videos.

---

## Prerequisites

- ✅ Sprint 02 complete (transcription working)
- ⏳ Test videos on YouTube/Vimeo/Air

---

## Deliverables

- [ ] Content script detects video player on page
- [ ] Extract video metadata (URL, platform, timestamp)
- [ ] Send video context when recording starts
- [ ] Backend creates/finds video record
- [ ] Notes linked to video + timestamp
- [ ] On-page anchor chip shows recording timestamp
- [ ] Ghost comment cards appear near player

---

## Technical Tasks

### Task 1: Content Script Video Detection

Platform-specific selectors for:
- YouTube video element
- Vimeo player
- Air video player

### Task 2: Video Context Module (Backend)

- `lib/lossy/videos.ex`
- `find_or_create_video/1` - Idempotent video creation
- Extract platform from URL

### Task 3: On-Page Overlays

- Anchor chip component (shows timestamp)
- Ghost comment cards (preview notes)
- Shadow DOM for style isolation

---

## Next Sprint

👉 [Sprint 04 - Auto Posting](./SPRINT_04_auto_posting.md)
