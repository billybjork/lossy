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

  // Clean up box drag state
  ctx.boxDragStart = null;
  ctx.boxDragCurrent = null;
  ctx.isDraggingBox = false;
  ctx.boxSelectedMaskIds = new Set();
  ctx.boxPreviewMaskData = null;
  ctx.lastBoxSegmentTime = null;
  ctx.boxFinalSelectionIds = [];
  if (ctx.boxDragRect) {
    ctx.boxDragRect.remove();
    ctx.boxDragRect = null;
  }

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
 * Handles two primary modes:
 * 1. Selection Mode: If the cursor is over an existing mask, spotlight it.
 * 2. Segmentation Mode: If the cursor is over empty space, generate a preview.
 */
function tick(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (!ctx.active) return;

  // Box drag mode takes precedence - disable normal tick behavior
  // (box drag has its own visual feedback and segmentation logic)
  if (ctx.isDraggingBox) {
    return;
  }

  // No cursor yet - show waiting message
  if (!ctx.lastMouse) {
    updateStatus(ctx, hooks.jsContainer, 'Move cursor to select', 'searching');
    return;
  }

  // Multi-point mode has its own logic, skip normal flow
  if (ctx.lockedPoints.length > 0) {
    handleMultiPointTick(ctx, hooks);
    return;
  }

  // --- Single-point (hover) mode ---

  const hit = findMaskUnderCursor(ctx.lastMouse, hooks);

  // Mode 1: Selection (a mask was found under the cursor)
  if (hit) {
    ctx.spotlightedMaskId = hit.maskId;
    ctx.spotlightHitType = hit.hitType;
    ctx.spotlightMaskType = hit.maskType;

    clearPreview(ctx);
    hooks.updateHighlight();
    resetSpotlightOverlay(ctx);

    const statusText = hit.hitType === 'pixel' ? 'Spotlighting…' :
                       hit.maskType === 'text' ? 'Text region ready' :
                       'Region ready';
    updateStatus(ctx, hooks.jsContainer, statusText, 'ready');
    return; // Done for this tick, we are in selection mode.
  }

  // Mode 2: Segmentation (no mask under cursor, generate preview)
  if (ctx.spotlightedMaskId) {
    ctx.spotlightedMaskId = null;
    ctx.spotlightHitType = null;
    ctx.spotlightMaskType = null;
    hooks.updateHighlight();
  }

  // Embeddings ready?
  if (!hooks.embeddingsReady()) {
    hooks.ensureEmbeddings();
    updateStatus(ctx, hooks.jsContainer, 'Preparing embeddings…', 'searching');
    ctx.needsSegment = true;
    return;
  }

  // Fire segmentation (or queue if in flight)
  if (ctx.inFlight) {
    ctx.needsSegment = true;
  } else {
    fireSegmentation(ctx, hooks);
  }
}

/**
 * Handles the logic for a tick when in multi-point selection mode.
 */
function handleMultiPointTick(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  // Clear any single-point spotlighting
  if (ctx.spotlightedMaskId !== null) {
    ctx.spotlightedMaskId = null;
    ctx.spotlightHitType = null;
    ctx.spotlightMaskType = null;
    hooks.updateHighlight();
  }

  resetSpotlightOverlay(ctx);

  // Embeddings ready?
  if (!hooks.embeddingsReady()) {
    hooks.ensureEmbeddings();
    updateStatus(ctx, hooks.jsContainer, 'Preparing embeddings…', 'searching');
    ctx.needsSegment = true;
    return;
  }

  // Fire segmentation (or queue if in flight)
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
  area: number; // For sorting
  score: number; // For ranking
}

/**
 * Find the best mask under the cursor using a scoring system.
 * This function assesses all masks under the cursor and returns the one
 * with the highest score, prioritizing precision (pixel hits) and smaller size.
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

  const hits: MaskHit[] = [];

  for (const mask of Array.from(masks)) {
    const rect = mask.getBoundingClientRect();
    const inBbox = clientX >= rect.left && clientX <= rect.right &&
                   clientY >= rect.top && clientY <= rect.bottom;

    if (!inBbox) continue;

    const maskId = mask.dataset.maskId || '';
    const maskType = (mask.dataset.maskType || 'manual') as 'text' | 'object' | 'manual';
    const area = rect.width * rect.height;

    let hitType: 'pixel' | 'bbox' = 'bbox';
    let isPixelHit = false;

    // All masks can have pixel-perfect hit testing now
    if (hooks.maskCacheReady() && hooks.maskCache.has(maskId)) {
      isPixelHit = isPointOverMaskPixel(maskId, clientX, clientY, mask, hooks.maskCache);
      if (isPixelHit) {
        hitType = 'pixel';
      }
    }

    // Score the hit:
    // - Pixel hits are worth more than bbox hits.
    // - Smaller areas are better (score is inversely proportional to area).
    // - Text masks get a slight boost to win ties.
    const score =
      (isPixelHit ? 1e6 : 0) +         // Pixel hits are high priority
      (1e6 / (area || 1)) +            // Smaller area is better
      (maskType === 'text' ? 1 : 0);   // Text masks are slightly preferred

    hits.push({
      maskId,
      hitType,
      maskType,
      area,
      score,
    });
  }

  if (hits.length === 0) return null;

  // Return the hit with the highest score
  return hits.sort((a, b) => b.score - a.score)[0];
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
 * Convert container coordinates to image coordinates.
 * Uses getBoundingClientRect() to account for CSS transforms (zoom).
 */
function getImageCoordinates(
  pos: { x: number; y: number } | null,
  hooks: SmartSelectHooks
): { x: number; y: number } | null {
  if (!pos) return null;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return null;

  // Use getBoundingClientRect() for dimensions - accounts for CSS transforms
  const imgRect = img.getBoundingClientRect();
  const displayWidth = imgRect.width;
  const displayHeight = imgRect.height;
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
 * Render visual markers for locked points.
 * Uses clientWidth/clientHeight (layout size) since markers are children of
 * the transformed container and will be scaled by the zoom.
 */
function renderPointMarkers(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (!ctx.pointMarkersContainer) return;

  ctx.pointMarkersContainer.innerHTML = '';

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  // Use clientWidth/clientHeight for layout dimensions (pre-transform)
  // since markers are children of the transformed container and scale with it
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
  // Use clientWidth/clientHeight for layout dimensions (pre-transform)
  // since canvas is a child of the transformed container and scales with it
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

// ============ Box Drag Handling ============

const BOX_DRAG_THRESHOLD = 5; // Minimum distance to start box drag
const BOX_SEGMENT_DEBOUNCE_MS = 200; // Debounce for box segmentation requests

/**
 * Handle mousedown in Smart Select - store potential drag start
 */
export function handleSmartSelectMouseDown(
  ctx: SmartSelectContext,
  event: MouseEvent,
  hooks: SmartSelectHooks
): void {
  if (!ctx.active) return;
  if (event.button !== 0) return; // Left click only

  const containerRect = hooks.container.getBoundingClientRect();
  const containerX = event.clientX - containerRect.left;
  const containerY = event.clientY - containerRect.top;

  // Store potential drag start (we'll determine click vs drag on move/up)
  ctx.boxDragStart = { x: containerX, y: containerY };
  ctx.boxDragCurrent = null;
  ctx.isDraggingBox = false;
}

/**
 * Handle mousemove in Smart Select - track drag, update visuals, request SAM2
 */
export function handleSmartSelectMouseMove(
  ctx: SmartSelectContext,
  event: MouseEvent,
  hooks: SmartSelectHooks
): void {
  if (!ctx.active) return;
  if (!ctx.boxDragStart) return;

  const containerRect = hooks.container.getBoundingClientRect();
  const currentX = event.clientX - containerRect.left;
  const currentY = event.clientY - containerRect.top;

  // Calculate distance from start
  const dx = currentX - ctx.boxDragStart.x;
  const dy = currentY - ctx.boxDragStart.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Check threshold for starting box drag
  if (distance < BOX_DRAG_THRESHOLD && !ctx.isDraggingBox) return;

  // Enter box drag mode
  if (!ctx.isDraggingBox) {
    ctx.isDraggingBox = true;
    // Clear any existing point segmentation preview
    clearPreview(ctx);
    ctx.spotlightedMaskId = null;
    ctx.spotlightHitType = null;
    ctx.spotlightMaskType = null;
  }

  ctx.boxDragCurrent = { x: currentX, y: currentY };

  // Update visual feedback
  updateBoxDragVisuals(ctx, hooks);

  // Request SAM2 segmentation using box center as point prompt
  requestBoxSegmentation(ctx, hooks);
}

/**
 * Handle mouseup in Smart Select - finalize box selection or delegate to click
 */
export function handleSmartSelectMouseUp(
  ctx: SmartSelectContext,
  event: MouseEvent,
  hooks: SmartSelectHooks
): void {
  if (!ctx.active) return;

  if (ctx.isDraggingBox) {
    // Was a box drag - finalize selection
    finalizeBoxSelection(ctx, hooks);
  } else if (ctx.boxDragStart) {
    // Was a click (not a drag) - delegate to point click handler
    handleSmartSelectClick(ctx, event, hooks);
  }

  // Reset drag start (but keep other box state for Command release)
  ctx.boxDragStart = null;
}

/**
 * Update visual feedback during box drag
 */
function updateBoxDragVisuals(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  if (!ctx.boxDragStart || !ctx.boxDragCurrent || !ctx.isDraggingBox) return;

  const jsContainer = hooks.jsContainer;
  if (!jsContainer) return;

  // Create or reuse drag rect element
  if (!ctx.boxDragRect) {
    const rect = document.createElement('div');
    rect.className = 'smart-select-box-drag';
    rect.style.cssText = `
      position: absolute;
      border: 2px dashed rgb(59, 130, 246);
      background: rgba(59, 130, 246, 0.15);
      pointer-events: none;
      z-index: 55;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 10px rgba(59, 130, 246, 0.3);
    `;
    jsContainer.appendChild(rect);
    ctx.boxDragRect = rect;
  }

  // Calculate box bounds in container coordinates
  const left = Math.min(ctx.boxDragStart.x, ctx.boxDragCurrent.x);
  const top = Math.min(ctx.boxDragStart.y, ctx.boxDragCurrent.y);
  const width = Math.abs(ctx.boxDragCurrent.x - ctx.boxDragStart.x);
  const height = Math.abs(ctx.boxDragCurrent.y - ctx.boxDragStart.y);

  ctx.boxDragRect.style.left = `${left}px`;
  ctx.boxDragRect.style.top = `${top}px`;
  ctx.boxDragRect.style.width = `${width}px`;
  ctx.boxDragRect.style.height = `${height}px`;
  ctx.boxDragRect.style.display = 'block';

  // Find and highlight qualifying masks (50%+ overlap)
  const dragRect = { left, top, right: left + width, bottom: top + height };
  const qualifyingMasks = findMasksWithOverlap(dragRect, hooks, 0.5);
  ctx.boxSelectedMaskIds = new Set(qualifyingMasks);

  // Update mask highlights
  highlightQualifyingMasks(ctx, hooks);
}

/**
 * Find masks with at least minOverlapRatio (e.g., 0.5 = 50%) of their bbox inside the drag rect
 */
function findMasksWithOverlap(
  dragRect: { left: number; top: number; right: number; bottom: number },
  hooks: SmartSelectHooks,
  minOverlapRatio: number
): string[] {
  const masks = hooks.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const qualifying: string[] = [];

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return qualifying;

  // Get scale factors for converting image coords to container coords
  const imgRect = img.getBoundingClientRect();
  const displayWidth = imgRect.width;
  const displayHeight = imgRect.height;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(
    img,
    hooks.imageWidth,
    hooks.imageHeight
  );

  const scaleX = displayWidth / naturalWidth;
  const scaleY = displayHeight / naturalHeight;

  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    if (!maskId) return;

    // Get mask bbox from dataset (in image coordinates)
    const bboxX = parseFloat(mask.dataset.bboxX || '0');
    const bboxY = parseFloat(mask.dataset.bboxY || '0');
    const bboxW = parseFloat(mask.dataset.bboxW || '0');
    const bboxH = parseFloat(mask.dataset.bboxH || '0');

    if (bboxW <= 0 || bboxH <= 0) return;

    // Convert mask bbox to container coordinates
    const maskLeft = bboxX * scaleX;
    const maskTop = bboxY * scaleY;
    const maskRight = (bboxX + bboxW) * scaleX;
    const maskBottom = (bboxY + bboxH) * scaleY;

    // Calculate intersection area
    const intersectLeft = Math.max(dragRect.left, maskLeft);
    const intersectTop = Math.max(dragRect.top, maskTop);
    const intersectRight = Math.min(dragRect.right, maskRight);
    const intersectBottom = Math.min(dragRect.bottom, maskBottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      // No intersection
      return;
    }

    const intersectArea = (intersectRight - intersectLeft) * (intersectBottom - intersectTop);
    const maskArea = (maskRight - maskLeft) * (maskBottom - maskTop);
    const overlapRatio = intersectArea / maskArea;

    if (overlapRatio >= minOverlapRatio) {
      qualifying.push(maskId);
    }
  });

  return qualifying;
}

/**
 * Highlight masks that qualify for box selection
 */
function highlightQualifyingMasks(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  const masks = hooks.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    const isQualifying = ctx.boxSelectedMaskIds.has(maskId);

    mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

    if (isQualifying) {
      mask.classList.add('mask-selected');
    } else {
      mask.classList.add('mask-dimmed');
    }
  });

  // Update segment mask canvas highlights via the hook
  hooks.updateHighlight();
}

/**
 * Request SAM2 segmentation using multiple points across the box.
 * Uses a grid of positive points to encourage SAM2 to segment the entire region.
 */
async function requestBoxSegmentation(
  ctx: SmartSelectContext,
  hooks: SmartSelectHooks
): Promise<void> {
  if (!ctx.boxDragStart || !ctx.boxDragCurrent || !ctx.isDraggingBox) return;
  if (!hooks.embeddingsReady()) {
    hooks.ensureEmbeddings();
    updateStatus(ctx, hooks.jsContainer, 'Preparing embeddings…', 'searching');
    return;
  }

  // Debounce segmentation requests
  const now = Date.now();
  if (ctx.lastBoxSegmentTime && now - ctx.lastBoxSegmentTime < BOX_SEGMENT_DEBOUNCE_MS) {
    ctx.needsSegment = true;
    return;
  }

  if (ctx.inFlight) {
    ctx.needsSegment = true;
    return;
  }

  ctx.lastBoxSegmentTime = now;
  ctx.inFlight = true;
  ctx.needsSegment = false;

  // Calculate box bounds in container coordinates
  const left = Math.min(ctx.boxDragStart.x, ctx.boxDragCurrent.x);
  const right = Math.max(ctx.boxDragStart.x, ctx.boxDragCurrent.x);
  const top = Math.min(ctx.boxDragStart.y, ctx.boxDragCurrent.y);
  const bottom = Math.max(ctx.boxDragStart.y, ctx.boxDragCurrent.y);

  const boxWidth = right - left;
  const boxHeight = bottom - top;

  // Generate a grid of points across the box (3x3 grid = 9 points)
  // This tells SAM2 "I want ALL of this region"
  const gridPoints: SegmentPoint[] = [];
  const gridSize = 3;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // Position points at 25%, 50%, 75% of the box dimensions
      const t = (col + 1) / (gridSize + 1);
      const s = (row + 1) / (gridSize + 1);

      const containerX = left + boxWidth * t;
      const containerY = top + boxHeight * s;

      const imgCoords = getImageCoordinates({ x: containerX, y: containerY }, hooks);
      if (imgCoords) {
        gridPoints.push({ x: imgCoords.x, y: imgCoords.y, label: 1 });
      }
    }
  }

  if (gridPoints.length === 0) {
    ctx.inFlight = false;
    return;
  }

  updateStatus(ctx, hooks.jsContainer, 'Finding region…', 'searching');

  try {
    const result = await hooks.segment(gridPoints);

    if (!ctx.active || !ctx.isDraggingBox) {
      ctx.inFlight = false;
      return;
    }

    if (result.success && result.maskData) {
      ctx.boxPreviewMaskData = result.maskData;
      renderPreviewMask(ctx, result.maskData, hooks);
      updateStatus(ctx, hooks.jsContainer, 'Box preview ready', 'ready');
    }
  } catch (error) {
    console.error('[SmartSelect] Box segmentation error:', error);
  } finally {
    ctx.inFlight = false;
    if (ctx.needsSegment && ctx.active && ctx.isDraggingBox) {
      requestBoxSegmentation(ctx, hooks);
    }
  }
}

/**
 * Finalize box selection - store results for Command release handler
 */
function finalizeBoxSelection(ctx: SmartSelectContext, hooks: SmartSelectHooks): void {
  // Store final selection for Command key release
  ctx.boxFinalSelectionIds = Array.from(ctx.boxSelectedMaskIds);

  // If we have a box preview mask, store it as lastMaskData for consistency
  if (ctx.boxPreviewMaskData) {
    ctx.lastMaskData = ctx.boxPreviewMaskData;
  }

  // Keep box visuals visible until Command is released
  // (cleanup happens in exitSmartSelect or resetBoxDrag)
}

/**
 * Reset box drag state
 */
export function resetBoxDrag(ctx: SmartSelectContext): void {
  ctx.boxDragStart = null;
  ctx.boxDragCurrent = null;
  ctx.isDraggingBox = false;
  ctx.boxSelectedMaskIds = new Set();
  ctx.boxPreviewMaskData = null;
  ctx.lastBoxSegmentTime = null;
  ctx.boxFinalSelectionIds = [];
  cleanupBoxDragVisuals(ctx);
}

/**
 * Clean up box drag visual elements
 */
function cleanupBoxDragVisuals(ctx: SmartSelectContext): void {
  if (ctx.boxDragRect) {
    ctx.boxDragRect.remove();
    ctx.boxDragRect = null;
  }
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
