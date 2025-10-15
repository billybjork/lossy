# Sprint 02: Transcription & Note Structuring

**Status:** ⏳ Planned
**Estimated Duration:** 2-3 days

---

## Goal

Replace fake transcripts with real OpenAI Whisper API transcription and GPT-4o-mini note structuring. Store structured notes in database with confidence scores.

---

## Prerequisites

- ✅ Sprint 01 complete (audio streaming working)
- ⏳ OpenAI API key obtained
- ⏳ Audio chunks arriving at backend

---

## Deliverables

- [ ] OpenAI Whisper transcribes audio chunks
- [ ] GPT-4o-mini structures transcripts into actionable notes
- [ ] Notes have category, confidence, and cleaned text
- [ ] Notes stored in database with status tracking
- [ ] Side panel shows real transcripts and structured notes
- [ ] Error handling for API failures

---

## Technical Tasks

### Task 1: Inference Module (Backend)

Create `lib/lossy/inference/cloud.ex` with:
- `transcribe(audio_binary)` - Whisper API integration
- `structure_note(transcript, timestamp)` - GPT-4o-mini with few-shot examples
- Input validation and sanitization
- Error recovery and logging

### Task 2: Audio Channel Updates

- Buffer audio chunks into complete utterances
- Call inference module asynchronously
- Push transcript and structured note to client
- Store notes in database

### Task 3: Schema & Context

- Create `lib/lossy/videos.ex` context
- Create `lib/lossy/videos/note.ex` schema
- Functions: `create_note/1`, `list_notes/1`, `get_note!/1`

### Task 4: Side Panel UI Updates

- Display raw transcript
- Display structured note with category badge
- Show confidence score visually (opacity/color)
- Handle loading states

---

## Notes

This sprint involves external API calls. Plan for:
- Rate limiting
- Timeout handling
- Cost monitoring (Whisper API costs per minute)

---

## Next Sprint

👉 [Sprint 03 - Video Integration](./SPRINT_03_video_integration.md)
