# Browser Extension Implementation

This guide covers the implementation details for the Lossy browser extension (Chrome/Edge/Firefox using Manifest V3).

## Goals

The extension:
- Captures images from web pages
- Provides a selection UI overlay
- Runs local text detection using ONNX Runtime (PP-OCRv3)
- Sends captured images + detected regions to the backend
- Opens the editor interface

**Local ML inference runs in an offscreen document for MV3 CSP compliance.**

## Inspiration

Take UX cues from:
- **Screenity**: Elegant capture UI and selection interactions
- **Shottr**: Clean, minimal overlay design

---

## Architecture

### Manifest V3 Structure

```
extension/
├── manifest.json
├── background/
│   └── service-worker.ts     # Background service worker
├── content/
│   ├── content.ts            # Content script (DOM interaction)
│   └── overlay.ts            # Selection overlay UI
├── lib/
│   ├── capture.ts            # Image capture logic
│   ├── onnx-session.ts       # ONNX Runtime session management
│   └── text-detection.ts     # PP-OCRv3 inference pipeline
├── offscreen/
│   ├── offscreen.html        # Offscreen document for ML inference
│   └── offscreen.ts          # Message handler for detection requests
├── public/
│   ├── models/det_v3.onnx    # PP-OCRv3 DBNet model
│   └── ort-wasm-*.wasm       # ONNX Runtime WASM/WebGPU backends
└── types/
    └── capture.ts            # Shared types
```

---

## Manifest Configuration

**Key fields**:

```json
{
  "manifest_version": 3,
  "name": "Lossy",
  "version": "0.1.0",
  "description": "Edit text in any image on the web",

  "permissions": [
    "activeTab",
    "scripting",
    "offscreen"
  ],

  "host_permissions": [
    "https://*/*",
    "http://*/*"
  ],

  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },

  "background": {
    "service_worker": "background/service-worker.ts",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["https://*/*", "http://*/*"],
      "js": ["content/content.ts"],
      "run_at": "document_idle"
    }
  ],

  "commands": {
    "capture": {
      "suggested_key": {
        "default": "Ctrl+Shift+L",
        "mac": "Command+Shift+L"
      },
      "description": "Capture image from page"
    }
  },

  "action": {
    "default_title": "Capture image with Lossy"
  },

  "web_accessible_resources": [
    {
      "resources": ["models/*", "*.wasm", "*.mjs"],
      "matches": ["https://*/*", "http://*/*"]
    }
  ]
}
```

**Permissions Rationale**:
- `activeTab`: Access DOM of active tab
- `scripting`: Inject content scripts programmatically
- `offscreen`: Create offscreen documents for ML inference (MV3 CSP compliant)
- `host_permissions`: Needed for capturing images and making fetch requests
- `content_security_policy`: Allow WASM execution for ONNX Runtime

---

## Background Service Worker

**Responsibilities**:
- Listen for keyboard shortcuts and browser action clicks
- Inject/activate content script
- Receive captured images from content script
- POST images to backend
- Open new tab with editor

**Implementation** (`background/service-worker.ts`):

```typescript
// Listen for keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture') {
    activateCapture();
  }
});

// Listen for browser action (toolbar icon) click
chrome.action.onClicked.addListener(() => {
  activateCapture();
});

async function activateCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id) return;

  // Inject content script if not already present
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/content.js']
  });

  // Send message to activate capture mode
  chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' });
}

// Listen for captured images from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMAGE_CAPTURED') {
    handleImageCapture(message.payload, sender.tab!)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;  // Keep channel open for async response
  }
});

async function handleImageCapture(payload: CapturePayload, tab: chrome.tabs.Tab) {
  // POST to backend
  const response = await fetch('https://lossy.app/api/captures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_url: tab.url,
      image_url: payload.imageUrl,
      image_data: payload.imageData,
      bounding_rect: payload.boundingRect
    })
  });

  const { id } = await response.json();

  // Open editor in new tab
  chrome.tabs.create({ url: `https://lossy.app/capture/${id}` });

  return { success: true, captureId: id };
}
```

---

## Content Script

**Responsibilities**:
- Find candidate images in DOM
- Show selection overlay
- Capture selected image
- Send to background script

### Finding Candidate Images (`dom-scanner.ts`)

```typescript
interface CandidateImage {
  element: HTMLElement;
  type: 'img' | 'picture' | 'background' | 'canvas';
  rect: DOMRect;
  imageUrl?: string;
}

export function findCandidateImages(): CandidateImage[] {
  const candidates: CandidateImage[] = [];

  // 1. Find <img> elements
  document.querySelectorAll('img').forEach(img => {
    const rect = img.getBoundingClientRect();
    if (isVisible(rect) && isLargeEnough(rect)) {
      candidates.push({
        element: img,
        type: 'img',
        rect,
        imageUrl: img.currentSrc || img.src
      });
    }
  });

  // 2. Find <picture> elements
  document.querySelectorAll('picture').forEach(picture => {
    const img = picture.querySelector('img');
    if (img) {
      const rect = img.getBoundingClientRect();
      if (isVisible(rect) && isLargeEnough(rect)) {
        candidates.push({
          element: picture,
          type: 'picture',
          rect,
          imageUrl: img.currentSrc || img.src
        });
      }
    }
  });

  // 3. Find elements with background-image
  document.querySelectorAll('*').forEach(el => {
    const style = window.getComputedStyle(el);
    const bgImage = style.backgroundImage;

    if (bgImage && bgImage !== 'none' && !bgImage.startsWith('linear-gradient')) {
      const rect = el.getBoundingClientRect();
      if (isVisible(rect) && isLargeEnough(rect)) {
        candidates.push({
          element: el as HTMLElement,
          type: 'background',
          rect,
          imageUrl: extractUrlFromBackground(bgImage)
        });
      }
    }
  });

  return candidates;
}

function isVisible(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function isLargeEnough(rect: DOMRect): boolean {
  const MIN_SIZE = 100;  // 100x100 pixels minimum
  return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
}

function extractUrlFromBackground(bgImage: string): string | undefined {
  const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
  return match ? match[1] : undefined;
}
```

### Selection Overlay (`overlay.ts`)

```typescript
export class CaptureOverlay {
  private overlay: HTMLDivElement;
  private candidates: CandidateImage[];
  private currentIndex = 0;
  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      this.currentIndex = (this.currentIndex + 1) % this.candidates.length;
      this.updateHighlight();
    } else if (e.key === 'ArrowLeft') {
      this.currentIndex = (this.currentIndex - 1 + this.candidates.length) % this.candidates.length;
      this.updateHighlight();
    } else if (e.key === 'Enter') {
      this.selectCandidate(this.currentIndex);
    } else if (e.key === 'Escape') {
      this.cancel();
    }
  };

  constructor(candidates: CandidateImage[]) {
    this.candidates = candidates;
    this.overlay = this.createOverlay();
    this.attachEventListeners();
  }

  private createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'lossy-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      cursor: crosshair;
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  private attachEventListeners() {
    this.candidates.forEach((candidate, index) => {
      const highlight = this.createHighlight(candidate.rect);

      highlight.addEventListener('click', () => this.selectCandidate(index));
      this.overlay.appendChild(highlight);
    });

    document.addEventListener('keydown', this.handleKeydown, true);
  }

  private createHighlight(rect: DOMRect): HTMLDivElement {
    const highlight = document.createElement('div');
    highlight.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid #3B82F6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
      pointer-events: auto;
      transition: all 0.2s ease;
    `;
    return highlight;
  }

  private selectCandidate(index: number) {
    const candidate = this.candidates[index];
    this.cleanup();
    // Trigger capture
    captureImage(candidate);
  }

  private cancel() {
    this.cleanup();
  }

  private cleanup() {
    this.overlay.remove();
    document.removeEventListener('keydown', this.handleKeydown, true);
  }
}
```

### Image Capture (`capture.ts`)

```typescript
export async function captureImage(candidate: CandidateImage): Promise<CapturePayload> {
  // Case 1: Direct image URL available
  if (candidate.imageUrl && isDirectImage(candidate)) {
    return {
      imageUrl: candidate.imageUrl,
      boundingRect: rectToJSON(candidate.rect)
    };
  }

  // Case 2: Need to screenshot
  const imageData = await captureRegionScreenshot(candidate.rect);
  return {
    imageData,
    boundingRect: rectToJSON(candidate.rect)
  };
}

function isDirectImage(candidate: CandidateImage): boolean {
  // Check if image is not heavily transformed (rotated, skewed, etc.)
  const el = candidate.element;
  const style = window.getComputedStyle(el);
  const transform = style.transform;

  return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
}

async function captureRegionScreenshot(rect: DOMRect): Promise<string> {
  const response = await chrome.runtime.sendMessage({
    type: 'CAPTURE_TAB'
  });

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d')!;
  const img = new Image();
  img.src = response.dataUrl;

  await new Promise(resolve => (img.onload = resolve));

  const viewX = Math.max(rect.left + window.scrollX, 0);
  const viewY = Math.max(rect.top + window.scrollY, 0);

  ctx.drawImage(
    img,
    Math.round(viewX * dpr),
    Math.round(viewY * dpr),
    Math.round(rect.width * dpr),
    Math.round(rect.height * dpr),
    0,
    0,
    Math.round(rect.width * dpr),
    Math.round(rect.height * dpr)
  );

  return canvas.toDataURL('image/png');
}

function rectToJSON(rect: DOMRect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}
```

### Main Content Script (`content.ts`)

```typescript
import { findCandidateImages } from './dom-scanner';
import { CaptureOverlay } from './overlay';
import { captureImage } from './capture';

// Listen for capture activation
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  }
});

async function startCapture() {
  // Find all candidate images
  const candidates = findCandidateImages();

  if (candidates.length === 0) {
    showOverlayToast('No sizeable images detected. Try scrolling or choose a different page.');
    return;
  }

  // Show selection overlay
  const overlay = new CaptureOverlay(candidates);

  // Wait for user selection...
  // (handled by overlay event listeners)
}

function showOverlayToast(message: string) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(31, 41, 55, 0.9);
    color: white;
    padding: 8px 16px;
    border-radius: 6px;
    z-index: 2147483647;
    font-family: sans-serif;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
```

---

## Type Definitions

**Shared types** (`types/capture-request.ts`):

```typescript
export interface CapturePayload {
  imageUrl?: string;      // Direct URL if available
  imageData?: string;     // Base64 data URL if screenshot
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  textRegions?: DetectedRegion[]; // Optional: local detection payload
}

export interface CaptureResponse {
  success: boolean;
  captureId?: string;
  error?: string;
}

export interface DetectedRegion {
  bbox: { x: number; y: number; width: number; height: number };
  polygon: Array<{ x: number; y: number }>;
  confidence?: number;
}
```

---

## Build & Development

### Build Tool

Use **Vite** with `vite-plugin-web-extension` or **Webpack** with appropriate loaders.

**Vite config example**:

```typescript
import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';

export default defineConfig({
  plugins: [
    webExtension({
      manifest: './manifest.json'
    })
  ]
});
```

### Development Workflow

1. **Build in watch mode**: `npm run dev`
2. **Load unpacked extension** in Chrome: `chrome://extensions`
3. **Reload extension** after changes
4. **Test on various websites** with different image types

---

## Testing Strategy

### Unit Tests

Test pure functions in isolation:
- `findCandidateImages()` with mock DOM
- `isVisible()`, `isLargeEnough()` with mock rects
- `extractUrlFromBackground()` with sample CSS strings

### Integration Tests

Test full capture flow:
1. Inject content script
2. Simulate user selecting image
3. Verify correct payload sent to background
4. Mock backend API and verify request

### Manual Testing

Test on variety of sites:
- Image-heavy sites (Instagram, Pinterest)
- News sites with varied layouts
- Sites with background images
- Sites with transformed images (rotated, scaled)

### Local Text Detection (Implemented)

The extension runs text detection locally using:
- **Model**: PP-OCRv3 DBNet (~2.3MB ONNX model)
- **Runtime**: ONNX Runtime Web with WebGPU backend (falls back to WASM)
- **Architecture**: Offscreen document for MV3 CSP compliance

Performance:
- WebGPU: ~90ms inference (after shader compilation)
- WASM fallback: ~400ms inference

The detected `textRegions` are attached to the `CapturePayload`, allowing the backend to skip cloud detection entirely

---

## Edge Cases & Handling

### No Images Found
- Show user-friendly message
- Suggest trying a different page

### Cross-Origin Images
- If image URL is cross-origin, fall back to screenshot
- Handle CORS errors gracefully

### Very Large Images
- Optionally downsample before sending to backend
- Or send URL and let backend handle it

### Dynamic Content
- Re-scan DOM if user navigates (SPA)
- Handle lazy-loaded images

### Shadow DOM
- Extend scanner to traverse shadow roots

---

## Performance Considerations

- **Lazy scan**: Only scan when user activates capture (not on page load)
- **Throttle hover effects**: Use CSS transitions, avoid JS on every mousemove
- **Efficient DOM queries**: Use querySelectorAll once, cache results
- **Cancel ongoing captures**: If user presses Escape or navigates away

---

## Security Considerations

- **CSP**: Ensure extension works on pages with strict Content Security Policy
- **XSS**: Never inject unsanitized content into DOM
- **HTTPS**: Only send data to HTTPS backend
- **Permissions**: Request minimal permissions needed

---

## Future Enhancements

1. **Canvas support**: Detect and capture `<canvas>` elements
2. **Video frames**: Capture frame from `<video>` elements
3. **Multiple selections**: Allow selecting multiple images at once
4. **Custom region**: Let user draw custom rectangle (like screenshot tools)
5. **Annotation**: Add arrows/highlights before sending to editor
6. **History**: Show recently captured images

---

## References

- [Chrome Extension MV3 docs](https://developer.chrome.com/docs/extensions/mv3/)
- [chrome.scripting API](https://developer.chrome.com/docs/extensions/reference/scripting/)
- [chrome.tabs API](https://developer.chrome.com/docs/extensions/reference/tabs/)
- [Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
