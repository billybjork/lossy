# Implementation Roadmap

This document outlines the phase-by-phase plan for implementing the Lossy MVP.

## Overview

The roadmap is structured to deliver a **vertical slice** as quickly as possible:
- Each phase builds on the previous
- Focus on end-to-end functionality first
- Polish and optimization come later

**Estimated Timeline**: 6-8 weeks for MVP (Phases 0-4)

### Current Progress (As of Nov 2025)

| Phase | Status | Completion |
|-------|--------|------------|
| **Phase 0: Skeleton** | ✅ Complete | 100% |
| **Phase 1: Extension MVP** | ✅ Complete | 100% |
| **Phase 2: Text Detection** | ⚠️ In Progress | 60% (Infrastructure ready, ML stubbed) |

| **Phase 4: Export** | ❌ Not Started | 5% (Storage ready) |
| **Phase 5: UX Polish** | ❌ Not Started | 0% |
| **Phase 6: Local Detection** | ❌ Not Started | 5% (Type contracts only) |

**Overall MVP Progress**: ~40% complete

**🎯 Next Critical Steps:**
1. Complete Phase 2: Integrate real ML text detection (replace stub)

3. Complete Phase 4: Add export functionality

**🏆 Major Achievements:**
- Production-quality extension with smart capture
- Robust backend with Oban job processing
- Comprehensive security hardening (SSRF protection)
- Real-time LiveView editor with PubSub updates

---

## Phase 0: Skeleton (Week 1) ✅ COMPLETE

**Goal**: Set up project infrastructure with stubbed functionality.

### Tasks

#### Backend Setup
- [x] Create Phoenix project: `mix phx.new lossy`
- [x] Configure PostgreSQL database
- [x] Create migrations for core tables:
  - `users` (minimal, just id for now)
  - `documents` (with new lifecycle fields, asset references, metrics JSONB)
  - `assets`
  - `text_regions` (with polygons + optional text)
  - `processing_jobs` (subject_type, attempts, locked_at)
- [x] Run migrations: `mix ecto.migrate`
- [x] Generate context: `Lossy.Documents`
- [x] Create schema modules: `Document`, `TextRegion`, `ProcessingJob`

#### API Endpoints
- [x] Basic REST API: `POST /api/captures`
  - Accept JSON payload
  - Create stubbed `Document` record
  - Support optional `text_regions` array (for future local detection payloads)
  - Return document id and status
- [x] Test with curl or Postman

#### LiveView Stub
- [x] Create LiveView module: `CaptureLive`
- [x] Add route: `GET /capture/:id`
- [x] Display placeholder image and mock text regions
- [x] Verify LiveView loads and renders

#### Verification
- [x] Can POST to `/api/captures` and get document id
- [x] Can navigate to `/capture/:id` and see LiveView
- [x] Database tables exist and are queryable

**Enhancements Beyond Roadmap:**
- ✨ Migrated to Oban job processing (more robust than Task.Supervisor)
- ✨ Added SSRF protection and comprehensive security validation
- ✨ Implemented comprehensive state machine with 6 status states
- ✨ Enhanced data model with width/height columns and source URL verification

---

## Phase 1: Extension MVP (Week 2) ✅ COMPLETE

**Goal**: Build working browser extension that captures images and sends to backend.

### Tasks

#### Extension Structure
- [x] Create `extension/` directory
- [x] Set up build tool (Vite or Webpack)
- [x] Create `manifest.json` with:
  - Manifest V3 config
  - Permissions: `activeTab`, `scripting`
  - Commands: `Cmd+Shift+L` / `Ctrl+Shift+L`
  - Browser action

#### Background Script
- [x] Implement service worker: `background/service-worker.ts`
- [x] Listen for keyboard shortcut and browser action
- [x] Inject content script into active tab
- [x] Handle messages from content script
- [x] POST captured image to backend API
- [x] Open new tab with editor URL

#### Content Script
- [x] Implement DOM scanner: `lib/dom-scanner.ts`
  - Find `<img>` elements
  - Find `<picture>` elements
  - Find elements with `background-image`
  - Filter by size and visibility
- [x] Implement overlay UI: `content/overlay.ts`
  - Dim page
  - Highlight candidate images
  - Handle click and keyboard selection
  - Bind/unbind keyboard listeners cleanly to avoid memory leaks
- [x] Implement capture logic: `lib/capture.ts`
  - Extract direct image URL when possible
  - Fall back to region screenshot
  - Crop screenshots using device pixel ratio + scroll offsets
  - Show inline overlay toast instead of `alert()` when no images are found
  - Send to background script
- [x] Define optional local text detection payload contract (`textRegions`) for future WebGPU mode

#### Integration
- [x] Wire up extension → backend flow
- [x] Test on various websites (news, social media, image galleries)
- [x] Handle edge cases (no images found, CORS issues)

#### Verification
- [x] Can trigger extension with keyboard shortcut
- [x] Can select image from page
- [x] Image is sent to backend and document is created
- [x] Editor tab opens with correct document id

**Enhancements Beyond Roadmap:**
- ✨ SVG mask overlay with professional spotlight effect
- ✨ Smart capture decision-making (URL vs screenshot based on accessibility)
- ✨ Keyboard navigation with arrow keys
- ✨ Auto-scrolling to keep selected images in viewport
- ✨ Duplicate initialization prevention
- ✨ Inline toast notifications (no alerts)
- ✨ Comprehensive TypeScript type safety throughout

---

## Phase 2: Cloud Text Detection (Week 3) ⚠️ IN PROGRESS

**Goal**: Integrate text detection model and display detected regions in editor.

**Status**: Infrastructure complete, ML integration pending (currently using stubbed data)

### Tasks

#### ML Service Integration
- [ ] Sign up for Replicate account and get API key
- [ ] Research available PaddleOCR or DBNet models on Replicate
- [ ] Implement `Lossy.ML.FalClient` module
  - `create_prediction/2`
  - `get_prediction/1`
  - `await_completion/1`
- [ ] Implement `Lossy.ML.TextDetection` module
  - `detect/1` (takes image path, returns regions)
  - Parse model output into structured format

#### Backend Processing
- [x] Implement `Documents.enqueue_text_detection/1`
  - ✅ Create `ProcessingJob` record (using Oban, not Task.Supervisor)
  - ✅ Enqueue async job via Oban worker
- [x] Implement `Documents.execute_text_detection/1` (STUBBED)
  - ⚠️ Currently creates 3 fake text regions for testing
  - [ ] Call actual ML service
  - [ ] Parse real results
  - [x] Create `TextRegion` records for each detected box
  - [x] Update document status to `:awaiting_edits`
  - [x] Broadcast update via PubSub
- [x] Support bypassing cloud detection when `text_regions` are provided by the extension (future flag but code path ready)

#### LiveView Updates
- [x] Subscribe to PubSub updates in `CaptureLive.mount/3`
- [x] Show "Finding text..." skeleton while `status == :pending_detection`
- [x] Handle `{:document_updated, document}` message
- [x] Display detected text boxes when regions arrive

#### Canvas Rendering (Implemented via HTML/CSS instead)
- [x] ~~Implement `CanvasEditor` JS hook~~ (Used HTML overlay approach instead)
  - [x] Display image
  - [x] Draw bounding boxes for each region (as positioned divs)
  - [x] Highlight regions on hover
- [x] ~~Register hook in `app.js`~~ (Not needed with HTML approach)
- [x] Add CSS styling for canvas and overlays

#### Verification
- [x] Upload image via extension
- [x] Text detection runs automatically (with stubbed data)
- [x] LiveView shows loading state, then displays detected regions
- [x] Regions are visible as overlays ~~on canvas~~ on image

**Implementation Improvements:**
- ✨ Upgraded to Oban workers for reliable job processing
- ✨ Comprehensive error handling and retry logic
- ✨ HTML/CSS overlay rendering (simpler than Canvas, works great for bounding boxes)

**Next Steps:**
- 🔴 **CRITICAL**: Replace stubbed text detection in `lossy/lib/lossy/workers/text_detection.ex:13-35` with actual Replicate/PaddleOCR integration

---



---

## Phase 4: Export & Upscaling (Week 5) ❌ NOT STARTED

**Goal**: Allow users to download edited images, optionally with HD upscaling.

**Status**: Storage infrastructure ready, export features not implemented

### Tasks

#### Export Functionality
- [ ] Add "Download PNG" button to editor header
- [ ] Implement `download` event handler in LiveView
  - Option 1: Send file path, browser downloads via link
  - Option 2: Use `push_event` to trigger client-side download
- [ ] Implement client-side download in JS hook
  - Create `<a>` tag with `href` and `download` attribute
  - Programmatically click to trigger download

#### Upscaling (Optional HD Export)
- [ ] Research Real-ESRGAN model on Replicate
- [ ] Implement `Lossy.ML.Upscaling` module
  - `upscale/2` (takes image path and scale factor)
  - Call Real-ESRGAN model
  - Download and save upscaled result
- [ ] Add "Enhance (HD)" button to editor
- [ ] Implement `enhance_export` event handler
  - Create `ProcessingJob` for upscaling
  - Call upscaling service on `working_image_path`
  - Update document with upscaled version
  - Trigger download

#### File Storage
- [x] Configure local file storage for MVP
  - [x] Create `priv/static/uploads/` directory
  - [x] Store images there during development
- [ ] Add cleanup task (optional) to delete old files

#### Verification
- [ ] Click "Download PNG" and verify file downloads
- [ ] File is the edited image with new text
- [ ] (If implemented) Click "Enhance (HD)" and download upscaled version

**Foundation in Place:**
- ✅ Local file storage configured in `priv/static/uploads/`
- ✅ Asset management system with SHA256 hashing
- ✅ Static file serving configured
- ✅ Document status supports `:export_ready` state

---

## Phase 5: UX Polish & Optimistic Mode (Week 6)

**Goal**: Improve user experience with better interactions and faster editing.

### Tasks

#### Optimistic Mode
- [ ] Add toggle in editor UI: "Instant Editing"
- [ ] When enabled, store pre-processed backgrounds proactively
- [ ] When user edits text, rendering is instant (background already processed)

#### Keyboard Shortcuts
- [ ] Tab / Shift+Tab: Navigate between regions
- [ ] Enter: Edit selected region
- [ ] Escape: Cancel editing
- [ ] Cmd+S / Ctrl+S: Download image

#### Font Picker
- [ ] Curate list of 20-30 Google Fonts
- [ ] Add dropdown in regions panel
- [ ] Allow changing font family per region
- [ ] Update region and re-render text

#### Visual Polish

- [ ] Add success/error toasts
- [ ] Improve region selection highlighting
- [ ] Add hover effects and animations

#### Performance
- [ ] Debounce canvas rendering during drag
- [ ] Use `temporary: true` for large LiveView assigns
- [ ] Optimize image serving (CDN or caching headers)

#### Verification
- [ ] Optimistic mode makes editing feel instant
- [ ] Keyboard shortcuts work as expected
- [ ] Font changes apply correctly
- [ ] UI feels polished and responsive

---

## Phase 6: Local Text Detection (Optional, Week 7-8)

**Goal**: Move text detection to local (browser) for faster results and offline support.

### Tasks

#### Model Preparation
- [ ] Convert DBNet MobileNet model to ONNX
- [ ] Quantize to INT8 or FP16
- [ ] Test inference with ONNX Runtime Web

#### Extension Integration
- [ ] Bundle ONNX model in extension (or lazy-load)
- [ ] Integrate ONNX Runtime Web library
- [ ] Implement local detection in content script
- [ ] Fall back to cloud if local detection fails

#### Backend Changes
- [ ] Make text detection optional in backend
- [ ] Accept pre-detected regions from extension
- [ ] Skip cloud detection if regions provided

#### Verification
- [ ] Extension detects text locally (no API call)
- [ ] Detection completes in <1 second
- [ ] Results are accurate
- [ ] Falls back to cloud gracefully if needed

---

## Post-MVP: Future Enhancements

### Short-Term (v1.1 - v1.3)
- [ ] User accounts and authentication
- [ ] Save and manage multiple documents
- [ ] Better font matching (visual similarity)
- [ ] Support for rotated/curved text
- [ ] Undo/redo functionality
- [ ] Project folders and organization

### Medium-Term (v2.0 - v2.5)
- [ ] Non-text layers (stickers, shapes, filters)
- [ ] Video frame editing
- [ ] Batch processing
- [ ] Collaborative editing
- [ ] Mobile app (React Native or Flutter)
- [ ] Self-hosted option

### Long-Term (v3.0+)

- [ ] Plugin system for custom tools
- [ ] API for third-party integrations
- [ ] White-label solution for enterprises
- [ ] Vector graphics support

---

## Success Metrics

### Phase 0-1 (Extension + Backend) ✅ ACHIEVED
- ✅ Extension successfully captures images
- ✅ Backend receives and stores images
- ✅ Editor loads and displays image
- ✅ **BONUS**: Extension works with keyboard shortcuts, smart URL detection, and professional UI
- ✅ **BONUS**: Backend includes Oban job processing and SSRF protection

### Phase 2 (Text Detection) ⚠️ PARTIAL
- ⏳ Detection accuracy >90% on varied images (stubbed, not yet measured)
- ⏳ Detection completes in <5 seconds (infrastructure ready, ML integration pending)
- ✅ LiveView real-time updates working
- ✅ Region display and interaction functional

### Phase 3 (Editing) ❌ NOT ACHIEVED

- ⏳ Text rendering matches original style reasonably well
- ⏳ End-to-end edit takes <20 seconds
- ✅ Basic text editing UI functional (no inpainting yet)

### Phase 4 (Export) ❌ NOT ACHIEVED
- ⏳ Downloaded images are high quality
- ⏳ File size is reasonable (<5MB for typical images)
- ✅ Storage infrastructure ready

### Phase 5 (Polish) ❌ NOT ACHIEVED
- ⏳ Editing feels fast and responsive
- ⏳ No major UX friction points
- ⏳ Users can successfully edit multiple regions

### MVP Overall - Target Metrics
- ⏳ Can capture, edit, and export an image in <60 seconds
- ✅ Works on at least 80% of tested websites (extension capture phase)
- ✅ No critical bugs (so far)
- ⏳ Ready for alpha user testing (needs Phase 2-4 completion)

---

## Risk Mitigation

### Technical Risks

**Risk**: ML models don't perform well on real-world images
- **Mitigation**: Test on diverse dataset early; have fallback to manual region selection

**Risk**: Replicate API has high latency or cost
- **Mitigation**: Monitor usage; consider self-hosted as backup

**Risk**: Extension doesn't work on all websites (CORS, CSP)
- **Mitigation**: Document limitations; add screenshot fallback

**Risk**: Image processing is slow on large images
- **Mitigation**: Downsample images before processing; add warnings for very large images

### Product Risks

**Risk**: Users don't find the product useful
- **Mitigation**: User testing early (Phase 3); iterate based on feedback

**Risk**: Competing products launch first
- **Mitigation**: Move fast; focus on differentiation (better UX, local inference)

---

## Next Steps

### ✅ Completed
1. ~~**Start with Phase 0**: Set up Phoenix project and database~~ ✅ Done
2. ~~**Phase 1**: Build browser extension~~ ✅ Done

### 🔄 In Progress
3. **Complete Phase 2**: Replace stubbed text detection with real ML integration
   - File to update: `lossy/lib/lossy/workers/text_detection.ex:13-35`
   - Integrate Replicate API + PaddleOCR/DBNet model
   - See [Text Detection Implementation](ml-integration.md) for details

### 🎯 Coming Next

5. **Phase 4**: Add export and upscaling features
6. **Test constantly**: Manual testing after each task
7. **Iterate**: If something doesn't work, adjust and continue
8. **Ship early**: Get MVP in front of users as soon as Phase 4 is done

**Current Status**: Foundation is rock-solid. Phases 0-1 exceeded expectations with production-quality implementations. Now focus on ML integration (Phase 2-3) to unlock the core editing workflow.
