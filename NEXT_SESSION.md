# Lossy - Next Session Continuation Prompt

## Context

Lossy is a browser extension + Phoenix backend for editing text in captured web images. We've completed Phase 0 (foundational infrastructure) and have a working skeleton.

## What We've Built (Phase 0 - COMPLETED ✅)

### Phoenix Backend (`lossy/`)
- **Database**: 5 tables (users, assets, documents, text_regions, processing_jobs) with migrations run successfully
- **Schemas**: All domain models with validations, relationships, and Document status state machine
- **Contexts**: `Documents` and `Assets` modules with CRUD operations
- **API**: `POST /api/captures` endpoint working (tested with curl)
- **LiveView**: `/capture/:id` route displaying document details
- **Config**: Full configuration from docs/configuration.md applied
- **Task.Supervisor**: Set up for async job processing

### Browser Extension (`extension/`)
- **Build**: TypeScript + Vite + Manifest V3
- **Keyboard Shortcut**: Cmd/Ctrl+Shift+L activates capture
- **Content Script**: Shows overlay, sends capture to API
- **Background Worker**: Handles shortcuts, API integration, opens editor tab
- **Working**: Loads in Chrome, activates on web pages, opens editor correctly

### Current State
- Phoenix server: Running at `http://localhost:4000`
- Extension: Built in `extension/dist/`, loaded in Chrome
- Git: All changes committed (commit: 9e42a2e)

## What's Next (Phase 1)

According to `docs/implementation/roadmap.md`, Phase 1 focuses on:

1. **Image Capture Flow**
   - Actually capture screenshots from web pages (HTML2Canvas or native APIs)
   - Upload image data to backend
   - Save as Asset records
   - Associate with Document

2. **Basic Text Detection (Stubbed)**
   - For MVP, manually create fake text regions to test the flow
   - Update Document status: `queued_detection` → `detecting` → `awaiting_edits`
   - Create TextRegion records with bbox data

3. **LiveView Editor UI (Basic)**
   - Display the captured image
   - Show text region overlays (rectangles showing detected text)
   - Basic text editing interface (just update `current_text` field)
   - Save changes back to database

4. **Working End-to-End Flow**
   - Capture image from web → Upload → Create document → Show in editor → Edit text → See changes

## Key Files to Reference

**Design Docs:**
- `docs/implementation/roadmap.md` - Phase 1 checklist
- `docs/data-model.md` - Database schema and status transitions
- `docs/implementation/backend.md` - Phoenix implementation details
- `docs/implementation/extension.md` - Extension implementation details

**Phoenix Code:**
- `lossy/lib/lossy_web/controllers/capture_controller.ex` - API endpoint
- `lossy/lib/lossy_web/live/capture_live.ex` - Editor UI
- `lossy/lib/lossy/documents.ex` - Context module

**Extension Code:**
- `extension/background/service-worker.ts` - Background worker
- `extension/content/content.ts` - Content script

## Starting the Session

1. Start Phoenix server: `cd lossy && mix phx.server`
2. Verify extension is loaded in Chrome at `chrome://extensions/`
3. Test current flow: Press Cmd+Shift+L on any web page

## Session Goal

Implement Phase 1 to get a working end-to-end flow:
- Capture actual screenshots from web pages
- Upload images to backend and save as Assets
- Create fake text regions for testing
- Build basic LiveView editor to display image and edit text

Target: 2-3 hours of work to complete Phase 1.

## Important Notes

- Data model spec is non-negotiable - follow docs/data-model.md exactly
- Validate Document status transitions per state machine
- Extension already has keyboard shortcut working - just need real capture
- LiveView editor should be simple for MVP - no fancy canvas yet
- Use stubbed text detection (no ML integration yet)

Let's build Phase 1 and get the first complete capture-to-edit flow working!
