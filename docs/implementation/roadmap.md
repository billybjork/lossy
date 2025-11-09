# Implementation Roadmap

This document outlines the phase-by-phase plan for implementing the Lossy MVP.

## Overview

The roadmap is structured to deliver a **vertical slice** as quickly as possible:
- Each phase builds on the previous
- Focus on end-to-end functionality first
- Polish and optimization come later

**Estimated Timeline**: 6-8 weeks for MVP (Phases 0-4)

---

## Phase 0: Skeleton (Week 1)

**Goal**: Set up project infrastructure with stubbed functionality.

### Tasks

#### Backend Setup
- [ ] Create Phoenix project: `mix phx.new lossy`
- [ ] Configure PostgreSQL database
- [ ] Create migrations for core tables:
  - `users` (minimal, just id for now)
  - `documents`
  - `text_regions`
  - `processing_jobs`
- [ ] Run migrations: `mix ecto.migrate`
- [ ] Generate context: `Lossy.Documents`
- [ ] Create schema modules: `Document`, `TextRegion`, `ProcessingJob`

#### API Endpoints
- [ ] Basic REST API: `POST /api/captures`
  - Accept JSON payload
  - Create stubbed `Document` record
  - Return document id and status
- [ ] Test with curl or Postman

#### LiveView Stub
- [ ] Create LiveView module: `CaptureLive`
- [ ] Add route: `GET /capture/:id`
- [ ] Display placeholder image and mock text regions
- [ ] Verify LiveView loads and renders

#### Verification
- [ ] Can POST to `/api/captures` and get document id
- [ ] Can navigate to `/capture/:id` and see LiveView
- [ ] Database tables exist and are queryable

---

## Phase 1: Extension MVP (Week 2)

**Goal**: Build working browser extension that captures images and sends to backend.

### Tasks

#### Extension Structure
- [ ] Create `extension/` directory
- [ ] Set up build tool (Vite or Webpack)
- [ ] Create `manifest.json` with:
  - Manifest V3 config
  - Permissions: `activeTab`, `scripting`
  - Commands: `Cmd+Shift+L` / `Ctrl+Shift+L`
  - Browser action

#### Background Script
- [ ] Implement service worker: `background/service-worker.ts`
- [ ] Listen for keyboard shortcut and browser action
- [ ] Inject content script into active tab
- [ ] Handle messages from content script
- [ ] POST captured image to backend API
- [ ] Open new tab with editor URL

#### Content Script
- [ ] Implement DOM scanner: `lib/dom-scanner.ts`
  - Find `<img>` elements
  - Find `<picture>` elements
  - Find elements with `background-image`
  - Filter by size and visibility
- [ ] Implement overlay UI: `content/overlay.ts`
  - Dim page
  - Highlight candidate images
  - Handle click and keyboard selection
- [ ] Implement capture logic: `lib/capture.ts`
  - Extract direct image URL when possible
  - Fall back to region screenshot
  - Send to background script

#### Integration
- [ ] Wire up extension → backend flow
- [ ] Test on various websites (news, social media, image galleries)
- [ ] Handle edge cases (no images found, CORS issues)

#### Verification
- [ ] Can trigger extension with keyboard shortcut
- [ ] Can select image from page
- [ ] Image is sent to backend and document is created
- [ ] Editor tab opens with correct document id

---

## Phase 2: Cloud Text Detection (Week 3)

**Goal**: Integrate text detection model and display detected regions in editor.

### Tasks

#### ML Service Integration
- [ ] Sign up for Replicate account and get API key
- [ ] Research available PaddleOCR or DBNet models on Replicate
- [ ] Implement `Lossy.ML.ReplicateClient` module
  - `create_prediction/2`
  - `get_prediction/1`
  - `await_completion/1`
- [ ] Implement `Lossy.ML.TextDetection` module
  - `detect/1` (takes image path, returns regions)
  - Parse model output into structured format

#### Backend Processing
- [ ] Implement `Documents.enqueue_text_detection/1`
  - Create `ProcessingJob` record
  - Spawn async task via `Task.Supervisor`
- [ ] Implement `Documents.execute_text_detection/1`
  - Call ML service
  - Parse results
  - Create `TextRegion` records for each detected box
  - Update document status to `:ready`
  - Broadcast update via PubSub

#### LiveView Updates
- [ ] Subscribe to PubSub updates in `CaptureLive.mount/3`
- [ ] Show "Finding text..." skeleton while `status == :pending_detection`
- [ ] Handle `{:document_updated, document}` message
- [ ] Display detected text boxes when regions arrive

#### Canvas Rendering
- [ ] Implement `CanvasEditor` JS hook
  - Load image onto canvas
  - Draw bounding boxes for each region
  - Highlight regions on hover
- [ ] Register hook in `app.js`
- [ ] Add CSS styling for canvas and overlays

#### Verification
- [ ] Upload image via extension
- [ ] Text detection runs automatically
- [ ] LiveView shows loading state, then displays detected regions
- [ ] Regions are visible as overlays on canvas

---

## Phase 3: Inpainting & Single-Region Edit (Week 4)

**Goal**: Enable editing text in a single region with background inpainting.

### Tasks

#### ML Service: Inpainting
- [ ] Research LaMa model on Replicate
- [ ] Implement `Lossy.ML.Inpainting` module
  - `inpaint/2` (takes image path and bbox)
  - Create binary mask for region
  - Call LaMa model
  - Download and save inpainted result
- [ ] Test inpainting with sample images

#### Image Processing
- [ ] Implement `Lossy.ImageProcessing.Compositor`
  - Use Mogrify (ImageMagick) to composite patches
- [ ] Implement `Lossy.ImageProcessing.TextRenderer`
  - Use Mogrify to render text onto image
  - Support font family, size, weight, color
- [ ] Test compositing and text rendering locally

#### Backend Workflow
- [ ] Implement `Documents.inpaint_region/1`
  - Create `ProcessingJob` for inpainting
  - Spawn async task
- [ ] Implement `Documents.execute_inpainting/2`
  - Calculate inpaint bbox (region + padding)
  - Call inpainting service
  - Composite patch into `working_image_path`
  - Render new text
  - Update region status to `:rendered`
  - Broadcast update

#### Editor UI: Text Editing
- [ ] Add click handler to select region
- [ ] Show inline contenteditable div over region
- [ ] On blur/Enter, send `phx-push-event` to LiveView with new text
- [ ] Handle `update_region_text` event in LiveView
  - Update `TextRegion.current_text` in DB
  - Enqueue inpainting job
  - Optimistically update UI

#### Verification
- [ ] Click on detected text region
- [ ] Edit text in inline editor
- [ ] Press Enter or click away
- [ ] Background is inpainted (text removed)
- [ ] New text is rendered in place
- [ ] Canvas updates with final result

---

## Phase 4: Export & Upscaling (Week 5)

**Goal**: Allow users to download edited images, optionally with HD upscaling.

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
- [ ] Configure local file storage for MVP
  - Create `priv/static/uploads/` directory
  - Store images there during development
- [ ] Add cleanup task (optional) to delete old files

#### Verification
- [ ] Click "Download PNG" and verify file downloads
- [ ] File is the edited image with new text
- [ ] (If implemented) Click "Enhance (HD)" and download upscaled version

---

## Phase 5: UX Polish & Optimistic Mode (Week 6)

**Goal**: Improve user experience with better interactions and faster editing.

### Tasks

#### Optimistic Mode
- [ ] Add toggle in editor UI: "Instant Editing"
- [ ] When enabled, enqueue inpainting for **all** regions immediately after detection
- [ ] Store inpainted backgrounds proactively
- [ ] When user edits text, rendering is instant (background already inpainted)

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
- [ ] Add loading spinners for inpainting/upscaling
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
- [ ] Advanced ML models (better inpainting, font recognition)
- [ ] Plugin system for custom tools
- [ ] API for third-party integrations
- [ ] White-label solution for enterprises
- [ ] Vector graphics support

---

## Success Metrics

### Phase 0-1 (Extension + Backend)
- Extension successfully captures images
- Backend receives and stores images
- Editor loads and displays image

### Phase 2 (Text Detection)
- Detection accuracy >90% on varied images
- Detection completes in <5 seconds

### Phase 3 (Editing)
- Inpainting quality is good (background looks natural)
- Text rendering matches original style reasonably well
- End-to-end edit takes <20 seconds

### Phase 4 (Export)
- Downloaded images are high quality
- File size is reasonable (<5MB for typical images)

### Phase 5 (Polish)
- Editing feels fast and responsive
- No major UX friction points
- Users can successfully edit multiple regions

### MVP Overall
- Can capture, edit, and export an image in <60 seconds
- Works on at least 80% of tested websites
- No critical bugs
- Ready for alpha user testing

---

## Risk Mitigation

### Technical Risks

**Risk**: ML models don't perform well on real-world images
- **Mitigation**: Test on diverse dataset early; have fallback to manual region selection

**Risk**: Replicate API has high latency or cost
- **Mitigation**: Monitor usage; consider fal.ai or self-hosted as backup

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

1. **Start with Phase 0**: Set up Phoenix project and database
2. **Work sequentially**: Don't skip ahead; each phase builds on previous
3. **Test constantly**: Manual testing after each task
4. **Iterate**: If something doesn't work, adjust and continue
5. **Ship early**: Get MVP in front of users as soon as Phase 4 is done

**Ready to begin?** Start with [Backend Implementation](backend.md) for detailed setup instructions.
