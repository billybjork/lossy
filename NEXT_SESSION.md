# Lossy - Next Session: Complete Phase 1 Image Selection

## Current State

Phase 1 is **partially complete**. We have:

✅ **Working Infrastructure**
- Extension: manifest, build system (Vite), keyboard shortcut (Cmd+Shift+L)
- Background worker: programmatic injection, API integration, tab management
- Backend: Phoenix API, Asset storage, CORS support, LiveView editor
- Simple viewport screenshot capture (captures entire visible page)
- Database: documents, assets, text_regions with stubbed detection
- Real-time LiveView updates via PubSub

✅ **End-to-End Flow (Current)**
1. Press Cmd+Shift+L on any page
2. Extension captures entire viewport screenshot
3. Uploads to backend, creates Document + Asset
4. Editor opens in new tab with LiveView
5. After ~1s, 3 stubbed text regions appear (no page reload needed)
6. Click to select regions, edit text, save to database

**Latest commit:** `5e2aab3` - "Complete Phase 1: End-to-end screenshot capture and editor"

## What's Missing: The Real Phase 1 UX

According to `docs/implementation/roadmap.md` and `docs/implementation/extension.md`, Phase 1 should have:

❌ **DOM Scanner** (`extension/lib/dom-scanner.ts`)
- Find all `<img>` elements on the page
- Find `<picture>` elements
- Find elements with CSS `background-image`
- Filter by minimum size (≥100x100px)
- Filter by visibility (in viewport, not hidden)
- Return array of candidate images with bounding rects

❌ **Selection Overlay UI** (`extension/content/overlay.ts`)
- Dim entire page with semi-transparent overlay
- Highlight ALL candidate images with blue borders
- User clicks an image OR uses arrow keys to navigate
- Press Enter to select, Escape to cancel
- Clean event listener management (no memory leaks)

❌ **Smart Capture Logic** (`extension/lib/capture.ts`)
- **Direct URL extraction**: For normal `<img>` tags, extract `img.currentSrc` or `img.src`
  - Send URL to backend (faster, better quality than screenshot)
- **Background image extraction**: Parse CSS `background-image` for URL
- **Screenshot fallback**: For transformed/rotated images or when direct URL unavailable
  - Crop screenshot to selected region only
  - Handle `devicePixelRatio` correctly
  - Account for scroll position
- Return `CapturePayload` with either `imageUrl` OR `imageData`

❌ **Edge Cases**
- No images found: show friendly toast message
- CORS issues: gracefully fall back to screenshot
- Very large images: handle appropriately
- Test on diverse websites

## Goal for This Session

**Implement Option A: Full Phase 1 completion (5-9 hours)**

Build proper image selection flow matching the design docs:
1. User presses Cmd+Shift+L
2. Extension scans DOM for candidate images
3. Page dims, all candidate images highlighted with borders
4. User selects image (click or keyboard)
5. Extension intelligently captures (URL or cropped screenshot)
6. Uploads to backend
7. Editor opens with selected image

## Implementation Plan

### 1. Create DOM Scanner (1-2 hours)

**File**: `extension/lib/dom-scanner.ts`

```typescript
interface CandidateImage {
  element: HTMLElement;
  type: 'img' | 'picture' | 'background';
  rect: DOMRect;
  imageUrl?: string;
}

export function findCandidateImages(): CandidateImage[]
```

**Requirements**:
- Find `<img>` elements: use `document.querySelectorAll('img')`
- Find `<picture>` elements: extract the active `<img>` child
- Find background images: scan computed styles for `background-image`
- Filter: `rect.width >= 100 && rect.height >= 100`
- Filter: element is visible (not `display: none`, has dimensions)
- Extract URLs where possible

**Reference**: `docs/implementation/extension.md` lines 184-260

### 2. Create Selection Overlay (2-3 hours)

**File**: `extension/content/overlay.ts`

```typescript
export class CaptureOverlay {
  constructor(candidates: CandidateImage[]);
  // Show overlay, handle selection, cleanup
}
```

**Requirements**:
- Full-page dim overlay (`background: rgba(0, 0, 0, 0.45)`)
- Highlight boxes for each candidate (`border: 3px solid #3B82F6`)
- Click handler on each highlight
- Keyboard navigation:
  - Arrow keys: cycle through candidates
  - Enter: select current
  - Escape: cancel and cleanup
- Proper event listener cleanup (remove on destroy)
- Pass selected candidate to capture logic

**Reference**: `docs/implementation/extension.md` lines 262-350

### 3. Create Smart Capture (1-2 hours)

**File**: `extension/lib/capture.ts`

```typescript
export async function captureImage(candidate: CandidateImage): Promise<CapturePayload>
```

**Requirements**:
- **Case 1: Direct Image** - For `<img>` tags with accessible URLs
  - Check image is not transformed (rotated, skewed)
  - Extract `img.currentSrc || img.src`
  - Return `{ imageUrl: url, boundingRect: rect }`

- **Case 2: Background Image** - For CSS backgrounds
  - Parse URL from `background-image: url(...)`
  - Return `{ imageUrl: url, boundingRect: rect }`

- **Case 3: Screenshot Fallback**
  - Request full viewport screenshot from background worker
  - Create canvas with correct dimensions (account for devicePixelRatio)
  - Crop to selected region using bounding rect
  - Account for scroll position
  - Return `{ imageData: base64, boundingRect: rect }`

**Reference**: `docs/implementation/extension.md` lines 352-423

### 4. Update Content Script (1 hour)

**File**: `extension/content/content.ts`

**Changes**:
- Import and use `findCandidateImages()` from dom-scanner
- Import and use `CaptureOverlay` from overlay
- Import and use `captureImage()` from capture
- Replace current simple screenshot with full selection flow:

```typescript
function startCapture() {
  const candidates = findCandidateImages();

  if (candidates.length === 0) {
    showToast('No images found on this page');
    return;
  }

  new CaptureOverlay(candidates, async (selected) => {
    const payload = await captureImage(selected);
    sendToBackground(payload);
  });
}
```

**Reference**: `docs/implementation/extension.md` lines 425-473

### 5. Update Backend (30 min)

**File**: `lossy/lib/lossy_web/controllers/capture_controller.ex`

**Changes**:
- Handle `image_url` in payload (direct URL from extension)
- If `image_url` provided: download image from URL and save
- If `image_data` provided: decode base64 and save (current behavior)
- Create Asset record with appropriate metadata

### 6. Testing & Edge Cases (1-2 hours)

Test on variety of sites:
- ✅ Image galleries: Unsplash, Pinterest
- ✅ News sites: NY Times, TechCrunch (mixed content)
- ✅ Social media: Twitter, Reddit (avatars, embedded images)
- ✅ E-commerce: Amazon (product images)
- ✅ Background images: Sites using CSS backgrounds
- ✅ Edge cases: No images, CORS errors, transformed images

## Key Files to Reference

**Design Docs**:
- `docs/implementation/roadmap.md` - Phase 1 checklist (lines 56-108)
- `docs/implementation/extension.md` - Complete implementation guide
- `docs/data-model.md` - CapturePayload schema

**Current Code**:
- `extension/content/content.ts` - Current simple capture
- `extension/background/service-worker.ts` - Background worker
- `extension/types/capture.ts` - Type definitions
- `lossy/lib/lossy_web/controllers/capture_controller.ex` - API endpoint
- `lossy/lib/lossy/assets.ex` - Image storage

## Expected Outcome

After this session, Phase 1 will be **fully complete**:
- ✅ User can select specific images from page (not just viewport screenshot)
- ✅ DOM scanning finds all candidate images
- ✅ Professional selection UI with dimmed overlay and highlights
- ✅ Smart capture logic (direct URL vs screenshot)
- ✅ Works across diverse websites
- ✅ Ready for Phase 2: Real ML text detection

## Notes

- Extension already has proper initialization guard (prevents duplicate listeners)
- Phoenix server running at `http://localhost:4000`
- Extension built with `npm run build` in `extension/` directory
- Commit changes when complete with descriptive message
- Follow TypeScript patterns from existing extension code
- Match UX inspiration: Screenity (capture UI) and Shottr (minimal overlay)
