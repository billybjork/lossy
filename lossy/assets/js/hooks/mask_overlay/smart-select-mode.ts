/**
 * Smart Select Controller - Simplified
 *
 * Command-key Smart Select with point-based refinement.
 * Uses straightforward inFlight/needsSegment queue pattern instead of complex state machine.
 */

import type { SmartSelectContext, SegmentPoint, MaskData, CachedMask } from './types';
import { getImageNaturalDimensions } from './utils';

// ============ Constants ============

const LOOP_INTERVAL_MS = 100;  // Update loop interval

// ============ Hooks Interface ============

export interface SmartSelectHooks {
  container: HTMLElement;
  jsContainer: HTMLElement | null;
  maskCache: Map<string, CachedMask>;
  maskCacheReady: () => boolean;
  imageWidth: number;
  imageHeight: number;
  embeddingsReady: () => boolean;
  shiftHeld: () => boolean;
  segment: (points: SegmentPoint[]) => Promise<{ success: boolean; maskData?: MaskData }>;
  updateHighlight: () => void;
  pushEvent: (event: string, payload: unknown) => void;
  ensureEmbeddings: () => void;
}

// ============ Core Entry/Exit ============

/**
 * Enter Smart Select - set up visuals and start the update loop
 */
export function enterSmartSelect(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  // Initialize state
  ctx.active = true;
  ctx.spotlightedMaskId = null;
  ctx.spotlightHitType = null;
  ctx.spotlightMaskType = null;
  ctx.textCutoutEl = null;
  ctx.lockedPoints = [];
  ctx.lastMaskData = null;
  ctx.inFlight = false;
  ctx.needsSegment = false;

  // Visual setup
  hooks.container.classList.add('smart-select-mode');
  hooks.container.style.cursor = 'crosshair';

  // Create DOM elements
  createSpotlightOverlay(ctx, hooks.jsContainer);
  createPointMarkersContainer(ctx, hooks.jsContainer);
  resetSpotlightOverlay(ctx);
  updateStatus(ctx, hooks.jsContainer, 'Scanning…', 'searching');

  // Start the continuous update loop
  startLoop(ctx, hooks);

  // Kick off embeddings computation (async, loop will pick up when ready)
  hooks.ensureEmbeddings();

  // Notify server
  hooks.pushEvent('enter_smart_select', {});
}

/**
 * Exit Smart Select - clean up everything
 */
export function exitSmartSelect(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  // Stop loop first
  stopLoop(ctx);

  // Reset state
  ctx.active = false;
  ctx.spotlightedMaskId = null;
  ctx.spotlightHitType = null;
  ctx.spotlightMaskType = null;
  ctx.lockedPoints = [];
  ctx.lastMaskData = null;
  ctx.inFlight = false;
  ctx.needsSegment = false;

  // Clean up DOM
  hooks.container.classList.remove('smart-select-mode');
  hooks.container.style.cursor = '';
  removeSpotlightOverlay(ctx);
  removePointMarkers(ctx);
  removePreviewMask(ctx);
  removeStatus(ctx);
  if (ctx.textCutoutEl) {
    ctx.textCutoutEl.remove();
    ctx.textCutoutEl = null;
  }

  // Force cleanup any stragglers
  forceCleanupSmartSelectElements(ctx);

  // Restore normal highlights
  hooks.updateHighlight();

  // Notify server
  hooks.pushEvent('exit_smart_select', {});
}

// ============ Update Loop ============

/**
 * Start the continuous update loop.
 */
function startLoop(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (ctx.loopIntervalId !== null) return;

  // Run immediately on entry
  tick(ctx, hooks);

  ctx.loopIntervalId = window.setInterval(() => {
    if (!ctx.active) {
      stopLoop(ctx);
      return;
    }
    tick(ctx, hooks);
  }, LOOP_INTERVAL_MS);
}

/**
 * Stop the update loop
 */
function stopLoop(ctx: SmartSelectContext): void {
  if (ctx.loopIntervalId !== null) {
    clearInterval(ctx.loopIntervalId);
    ctx.loopIntervalId = null;
  }
}

/**
 * Core tick function - called by loop every 100ms.
 * Simple logic: spotlight pixel hits, segment when nothing is already under the cursor.
 */
function tick(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (!ctx.active) return;

  // No cursor yet - show waiting message
  if (!ctx.lastMouse) {
    updateStatus(ctx, hooks.jsContainer, 'Move cursor to select', 'searching');
    return;
  }

  // If we have locked points, skip spotlight logic - we're in multi-point mode
  if (ctx.lockedPoints.length === 0) {
    // 1. Pixel hit? Spotlight and done.
    const hit = findMaskUnderCursor(ctx.lastMouse, hooks);
    if (hit?.hitType === 'pixel') {
      ctx.spotlightedMaskId = hit.maskId;
      ctx.spotlightHitType = 'pixel';
      ctx.spotlightMaskType = hit.maskType;
      clearPreview(ctx);
      resetSpotlightOverlay(ctx);
      hooks.updateHighlight();
      updateStatus(ctx, hooks.jsContainer, 'Spotlighting…', 'ready');
      return;
    }

    // 2. Bbox or empty - update spotlight state
    ctx.spotlightedMaskId = hit?.maskId ?? null;
    ctx.spotlightHitType = hit?.hitType ?? null;
    ctx.spotlightMaskType = hit?.maskType ?? null;
    if (hit) {
      hooks.updateHighlight();

      if (hit.maskType === 'text') {
        clearPreview(ctx);
        updateStatus(ctx, hooks.jsContainer, 'Text region ready', 'ready');
        return;
      }

      resetSpotlightOverlay(ctx);
    }
  } else {
    // Clear spotlight when in multi-point mode
    if (ctx.spotlightedMaskId !== null) {
      ctx.spotlightedMaskId = null;
      ctx.spotlightHitType = null;
      ctx.spotlightMaskType = null;
      hooks.updateHighlight();
    }

    resetSpotlightOverlay(ctx);
  }

  // 3. Embeddings ready?
  if (!hooks.embeddingsReady()) {
    hooks.ensureEmbeddings();
    updateStatus(ctx, hooks.jsContainer, 'Preparing embeddings…', 'searching');
    ctx.needsSegment = true;
    return;
  }

  // 4. Fire segmentation (or queue if in flight)
  if (ctx.inFlight) {
    ctx.needsSegment = true;
  } else {
    fireSegmentation(ctx, hooks);
  }
}

// ============ Segmentation ============

/**
 * Fire segmentation request. Simple queue pattern:
 * - Set inFlight=true, needsSegment=false
 * - Run segmentation
 * - On complete: set inFlight=false, re-fire if needsSegment
 */
async function fireSegmentation(ctx: SmartSelectContext, hooks: SmartSelectHooks): Promise<void> {
  if (ctx.inFlight) return;
  if (!ctx.active) return;

  ctx.inFlight = true;
  ctx.needsSegment = false;

  const points = buildPoints(ctx, hooks);
  if (points.length === 0) {
    ctx.inFlight = false;
    return;
  }

  updateStatus(ctx, hooks.jsContainer, 'Finding region…', 'searching');

  try {
    const result = await hooks.segment(points);

    if (!ctx.active) {
      // Exited while waiting
      ctx.inFlight = false;
      return;
    }

    if (result.success && result.maskData) {
      ctx.lastMaskData = result.maskData;
      renderPreviewMask(ctx, result.maskData, hooks);
      updateStatus(ctx, hooks.jsContainer, 'Preview ready', 'ready');
    }
  } catch (error) {
    // Swallow errors and continue loop; UI status remains last known value
  } finally {
    ctx.inFlight = false;
    // If queued, fire again
    if (ctx.needsSegment && ctx.active) {
      fireSegmentation(ctx, hooks);
    }
  }
}

/**
 * Build points array from locked points + cursor
 */
function buildPoints(ctx: SmartSelectContext, hooks: SmartSelectHooks): SegmentPoint[] {
  const points: SegmentPoint[] = [...ctx.lockedPoints];

  // Add cursor point if no locked points or if we want live preview
  if (ctx.lastMouse) {
    const coords = getImageCoordinates(ctx.lastMouse, hooks);
    if (coords) {
      points.push({
        x: coords.x,
        y: coords.y,
        label: hooks.shiftHeld() ? 0 : 1,
      });
    }
  }

  return points;
}

// ============ Hit Testing ============

interface MaskHit {
  maskId: string;
  hitType: 'pixel' | 'bbox';
  maskType: 'text' | 'object' | 'manual';
}

/**
 * Find mask under cursor with bbox-first, pixel-refined hit testing
 */
function findMaskUnderCursor(
  cursorPos: { x: number; y: number },
  hooks: SmartSelectHooks
): MaskHit | null {
  const containerRect = hooks.container.getBoundingClientRect();
  const clientX = cursorPos.x + containerRect.left;
  const clientY = cursorPos.y + containerRect.top;

  const masks = hooks.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  if (masks.length === 0) return null;

  // Check masks in reverse order (top-most first)
  for (const mask of Array.from(masks).reverse()) {
    const rect = mask.getBoundingClientRect();
    const inBbox = clientX >= rect.left && clientX <= rect.right &&
                   clientY >= rect.top && clientY <= rect.bottom;

    if (!inBbox) continue;

    const maskId = mask.dataset.maskId || '';
    const maskType = mask.dataset.maskType;

    const kind = maskType === 'object' || maskType === 'manual' ? (maskType as 'object' | 'manual') : 'text';

    // Text regions: bbox is sufficient
    if (kind === 'text') {
      return { maskId, hitType: 'bbox', maskType: kind };
    }

    // Object/manual: try pixel hit if cache ready
    if (hooks.maskCacheReady() && hooks.maskCache.has(maskId)) {
      const isPixelHit = isPointOverMaskPixel(maskId, clientX, clientY, mask, hooks.maskCache);
      if (isPixelHit) {
        return { maskId, hitType: 'pixel', maskType: kind };
      }
      // In bbox but not on pixel - continue checking other masks
      continue;
    }

    // Cache not ready - return bbox hit
    return { maskId, hitType: 'bbox', maskType: kind };
  }

  return null;
}

/**
 * Check if a point is over an opaque pixel of a segment mask
 */
function isPointOverMaskPixel(
  maskId: string,
  clientX: number,
  clientY: number,
  maskElement: HTMLElement,
  maskCache: Map<string, CachedMask>
): boolean {
  const cached = maskCache.get(maskId);
  if (!cached) return false;

  const { alphaData } = cached;
  const rect = maskElement.getBoundingClientRect();

  // Get position relative to mask element
  const displayX = clientX - rect.left;
  const displayY = clientY - rect.top;

  // Convert to alpha data coordinates
  const scaleX = alphaData.width / rect.width;
  const scaleY = alphaData.height / rect.height;
  const dataX = Math.floor(displayX * scaleX);
  const dataY = Math.floor(displayY * scaleY);

  // Check bounds
  if (dataX < 0 || dataX >= alphaData.width || dataY < 0 || dataY >= alphaData.height) {
    return false;
  }

  // Get alpha value
  const pixelIndex = (dataY * alphaData.width + dataX) * 4;
  const alpha = alphaData.data[pixelIndex + 3];

  return alpha > 10;
}

// ============ Point Handling ============

/**
 * Handle click in Smart Select - adds a locked point
 */
export function handleSmartSelectClick(
  ctx: SmartSelectContext,
  event: MouseEvent,
  hooks: SmartSelectHooks
): void {
  if (!ctx.active) return;

  const containerRect = hooks.container.getBoundingClientRect();
  const containerX = event.clientX - containerRect.left;
  const containerY = event.clientY - containerRect.top;

  const coords = getImageCoordinates({ x: containerX, y: containerY }, hooks);
  if (!coords) return;

  const point: SegmentPoint = {
    x: coords.x,
    y: coords.y,
    label: event.shiftKey ? 0 : 1, // 0 = negative, 1 = positive
  };

  ctx.lockedPoints.push(point);
  ctx.spotlightedMaskId = null;
  ctx.spotlightHitType = null;
  ctx.spotlightMaskType = null;
  ctx.needsSegment = true;

  renderPointMarkers(ctx, hooks);

  // Fire immediately if embeddings ready and not in flight
  if (!ctx.inFlight && hooks.embeddingsReady()) {
    fireSegmentation(ctx, hooks);
  }
}

/**
 * Update cursor position for the loop to use
 */
export function updateCursorPosition(ctx: SmartSelectContext, x: number, y: number): void {
  ctx.lastMouse = { x, y };
}

// ============ Coordinate Conversion ============

/**
 * Convert container coordinates to image coordinates
 */
function getImageCoordinates(
  pos: { x: number; y: number } | null,
  hooks: SmartSelectHooks
): { x: number; y: number } | null {
  if (!pos) return null;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return null;

  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(
    img,
    hooks.imageWidth,
    hooks.imageHeight
  );

  const x = (pos.x / displayWidth) * naturalWidth;
  const y = (pos.y / displayHeight) * naturalHeight;

  return { x, y };
}

// ============ DOM Elements ============

/**
 * Create the dark spotlight overlay
 */
function createSpotlightOverlay(ctx: SmartSelectContext, jsContainer: HTMLElement | null): void {
  if (!jsContainer || ctx.spotlightOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'smart-select-spotlight-overlay';
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(1px);
    pointer-events: none;
    z-index: 45;
    opacity: 0;
    transition: opacity 0.3s ease-out;
  `;

  jsContainer.appendChild(overlay);
  ctx.spotlightOverlay = overlay;

  // Fade in
  requestAnimationFrame(() => {
    if (overlay.style) {
      overlay.style.opacity = '1';
    }
  });
}

/**
 * Remove spotlight overlay
 */
function removeSpotlightOverlay(ctx: SmartSelectContext): void {
  if (ctx.spotlightOverlay) {
    ctx.spotlightOverlay.remove();
    ctx.spotlightOverlay = null;
  }
}

function resetSpotlightOverlay(ctx: SmartSelectContext): void {
  if (ctx.spotlightOverlay) {
    ctx.spotlightOverlay.style.opacity = '1';
    ctx.spotlightOverlay.style.background = 'rgba(0, 0, 0, 0.75)';
  }
}

function setOverlayTransparent(ctx: SmartSelectContext): void {
  // Deprecated: keep overlay visible; text spotlight uses cutout instead.
}


/**
 * Create point markers container
 */
function createPointMarkersContainer(ctx: SmartSelectContext, jsContainer: HTMLElement | null): void {
  if (!jsContainer || ctx.pointMarkersContainer) return;

  const container = document.createElement('div');
  container.className = 'smart-select-point-markers';
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 100;
  `;

  jsContainer.appendChild(container);
  ctx.pointMarkersContainer = container;
}

/**
 * Remove point markers
 */
function removePointMarkers(ctx: SmartSelectContext): void {
  if (ctx.pointMarkersContainer) {
    ctx.pointMarkersContainer.remove();
    ctx.pointMarkersContainer = null;
  }
}

/**
 * Render visual markers for locked points
 */
function renderPointMarkers(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (!ctx.pointMarkersContainer) return;

  ctx.pointMarkersContainer.innerHTML = '';

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(
    img,
    hooks.imageWidth,
    hooks.imageHeight
  );

  for (const point of ctx.lockedPoints) {
    const displayX = (point.x / naturalWidth) * displayWidth;
    const displayY = (point.y / naturalHeight) * displayHeight;

    const marker = document.createElement('div');
    marker.className = `smart-select-point-marker ${point.label === 1 ? 'positive' : 'negative'}`;
    marker.style.left = `${displayX}px`;
    marker.style.top = `${displayY}px`;
    ctx.pointMarkersContainer.appendChild(marker);
  }
}

/**
 * Render preview mask (spotlight effect showing image through mask)
 */
function renderPreviewMask(
  ctx: SmartSelectContext,
  maskData: MaskData,
  hooks: SmartSelectHooks
): void {
  // Store for confirmation
  ctx.lastMaskData = maskData;

  // Remove old preview
  removePreviewMask(ctx);

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  const jsContainer = hooks.jsContainer;
  if (!img || !jsContainer) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'smart-select-preview-mask';
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 50;
    transition: filter 0.35s ease-out, opacity 0.25s ease-out;
  `;

  const dpr = window.devicePixelRatio || 1;
  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  canvas.width = Math.max(1, Math.round(displayWidth * dpr));
  canvas.height = Math.max(1, Math.round(displayHeight * dpr));
  const canvasCtx = canvas.getContext('2d')!;
  canvasCtx.scale(dpr, dpr);
  canvasCtx.imageSmoothingEnabled = true;
  canvasCtx.imageSmoothingQuality = 'high';

  // Load mask PNG
  const maskImg = new Image();
  maskImg.onload = () => {
    if (!ctx.active) return;

    // Build a lightly feathered mask to smooth edges
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext('2d')!;
    maskCtx.imageSmoothingEnabled = true;
    maskCtx.imageSmoothingQuality = 'high';
    maskCtx.filter = `blur(${Math.min(0.8, 0.45 * dpr)}px)`;
    maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.filter = 'none';

    // Draw source image
    canvasCtx.drawImage(img, 0, 0, displayWidth, displayHeight);

    // Use mask as alpha channel to create cutout effect
    canvasCtx.globalCompositeOperation = 'destination-in';
    canvasCtx.drawImage(maskCanvas, 0, 0, displayWidth, displayHeight);
    canvasCtx.globalCompositeOperation = 'source-over';

    // Subtle glow to mirror spotlight effect on existing masks
    canvas.style.filter = `
      drop-shadow(0 0 4px rgba(255, 255, 255, 0.5))
      drop-shadow(0 0 12px rgba(255, 255, 255, 0.35))
    `;

    jsContainer.appendChild(canvas);
    ctx.previewCanvas = canvas;
  };

  maskImg.onerror = () => {
    // Leave status untouched; preview stays absent
  };

  maskImg.src = maskData.mask_png;
}

/**
 * Remove preview mask
 */
function removePreviewMask(ctx: SmartSelectContext): void {
  if (ctx.previewCanvas) {
    ctx.previewCanvas.remove();
    ctx.previewCanvas = null;
  }
}

/**
 * Clear preview (when switching to spotlight mode)
 */
function clearPreview(ctx: SmartSelectContext): void {
  removePreviewMask(ctx);
  ctx.lastMaskData = null;
}

/**
 * Update status badge
 */
function updateStatus(
  ctx: SmartSelectContext,
  jsContainer: HTMLElement | null,
  text: string,
  mode: 'searching' | 'ready'
): void {
  if (!jsContainer) return;

  let badge = ctx.statusEl;
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'smart-select-status-indicator';
    badge.innerHTML = `
      <div class="smart-select-status-dot"></div>
      <div class="smart-select-status-text"></div>
    `;
    badge.style.pointerEvents = 'none';
    jsContainer.appendChild(badge);
    ctx.statusEl = badge;
  }

  badge.dataset.state = mode;
  const textNode = badge.querySelector('.smart-select-status-text');
  if (textNode) {
    textNode.textContent = text;
  }
}

/**
 * Remove status badge
 */
function removeStatus(ctx: SmartSelectContext): void {
  if (ctx.statusEl) {
    ctx.statusEl.remove();
    ctx.statusEl = null;
  }
}

/**
 * Force cleanup of any orphaned Smart Select elements
 */
export function forceCleanupSmartSelectElements(ctx?: SmartSelectContext): void {
  try {
    const jsContainer = document.getElementById('js-overlay-container');
    if (jsContainer) {
      const orphans = jsContainer.querySelectorAll(
        '.smart-select-point-markers, .smart-select-preview-mask, .smart-select-spotlight-overlay, .smart-select-status-indicator'
      );
      orphans.forEach(el => {
        try {
          el.remove();
        } catch (e) {
          // Ignore
        }
      });
    }

    // Null out context references
    if (ctx) {
      ctx.spotlightOverlay = null;
      ctx.pointMarkersContainer = null;
      ctx.previewCanvas = null;
      ctx.statusEl = null;
    }
  } catch (error) {
    console.error('[SmartSelect] Error in force cleanup:', error);
  }
}

// ============ Undo ============

/**
 * Undo the last locked point.
 * Returns true if a point was removed, false if there were no points.
 */
export function undoLastPoint(ctx: SmartSelectContext, hooks: SmartSelectHooks): boolean {
  if (!ctx.active || ctx.lockedPoints.length === 0) {
    return false;
  }

  const removed = ctx.lockedPoints.pop();

  // Re-render point markers
  renderPointMarkers(ctx, hooks);

  if (ctx.lockedPoints.length === 0) {
    // No more points - clear preview and let loop handle spotlight mode
    clearPreview(ctx);
    ctx.needsSegment = true;
  } else {
    // Still have points - re-segment
    ctx.needsSegment = true;
    if (!ctx.inFlight && hooks.embeddingsReady()) {
      fireSegmentation(ctx, hooks);
    }
  }

  return true;
}

// ============ Readiness Notifications ============

/**
 * Notify Smart Select that embeddings are now ready.
 * Fires segmentation immediately if needed.
 */
export function notifyEmbeddingsReady(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (ctx.active && ctx.needsSegment && !ctx.inFlight) {
    fireSegmentation(ctx, hooks);
  }
}

/**
 * Notify Smart Select that mask cache is now ready.
 * Triggers immediate tick so pixel hit testing becomes available.
 */
export function notifyMaskCacheReady(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (ctx.active) {
    tick(ctx, hooks);
  }
}

// ============ Exports for index.ts ============

/**
 * Get the currently spotlighted mask ID (for highlight rendering)
 */
export function getSpotlightedMaskId(ctx: SmartSelectContext | null): string | null {
  return ctx?.spotlightedMaskId ?? null;
}

/**
 * Check if Smart Select is active
 */
export function isSmartSelectActive(ctx: SmartSelectContext | null): boolean {
  return ctx !== null && ctx.active;
}
