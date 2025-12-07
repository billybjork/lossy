/**
 * Segment Mode Controller
 *
 * Command-key segment mode with point-based region selection.
 * Integrates with SAM (Segment Anything Model) for real-time mask generation.
 */

import type { MaskOverlayState, SegmentPoint, MaskData } from './types';
import type { InferenceProvider } from '../../ml/inference-provider';
import { getImageNaturalDimensions, debugLog } from './utils';

/**
 * Enter segment mode
 * Sets up spotlight overlay and point markers container
 */
export async function enterSegmentMode(
  container: HTMLElement,
  state: MaskOverlayState,
  getInferenceProvider: () => InferenceProvider | null,
  isExtensionAvailable: () => boolean,
  callbacks: {
    updateHighlight: () => void,
    pushEvent: (event: string, payload: unknown) => void
  }
): Promise<void> {
  state.segmentMode = true;
  state.segmentPending = false;
  state.lockedSegmentPoints = [];

  // Clear any mask selection
  state.selectedMaskIds = new Set();
  state.hoveredMaskId = null;

  // Update visual state
  container.classList.add('segment-mode');
  container.style.cursor = 'crosshair';

  // Dim existing masks and disable pointer events
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  masks.forEach((mask: HTMLElement) => {
    mask.classList.add('mask-dimmed');
  });
  callbacks.updateHighlight();

  // Get the protected container that LiveView won't touch
  const jsContainer = document.getElementById('js-overlay-container');

  // Create point markers container
  if (!state.pointMarkersContainer && jsContainer) {
    state.pointMarkersContainer = document.createElement('div');
    state.pointMarkersContainer.className = 'segment-point-markers';
    state.pointMarkersContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 100;';
    jsContainer.appendChild(state.pointMarkersContainer);
  }

  // Create spotlight overlay
  createSpotlightOverlay(state);

  // Notify server
  callbacks.pushEvent("enter_segment_mode", {});

  debugLog('[SegmentMode] Entered segment mode');

  // Ensure embeddings are ready for segmentation
  const inferenceProvider = getInferenceProvider();
  const extensionAvailable = isExtensionAvailable();

  if (extensionAvailable) {
    // Extension handles its own embeddings - mark as ready
    state.embeddingsReady = true;
    debugLog('[SegmentMode] Extension available, embeddings ready');
  } else if (inferenceProvider && !state.embeddingsReady) {
    // Check if auto-segmentation is in progress - if so, embeddings are being computed
    // and we should NOT try to compute them again (would cause ONNX memory corruption)
    if (state.autoSegmentInProgress) {
      debugLog('[SegmentMode] Auto-segmentation in progress, waiting for embeddings...');
      // Embeddings will be marked ready when first batch arrives
      // Don't block - segmentation will work once embeddings are ready
    } else {
      // Local inference - need to compute embeddings
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      if (img) {
        debugLog('[SegmentMode] Computing embeddings...');
        try {
          await inferenceProvider.computeEmbeddings(state.documentId, img);
          state.embeddingsReady = true;
          debugLog('[SegmentMode] Embeddings ready');
        } catch (error) {
          console.error('[SegmentMode] Failed to compute embeddings:', error);
        }
      }
    }
  } else if (inferenceProvider && state.embeddingsReady) {
    debugLog('[SegmentMode] Embeddings already computed');
  }
}

/**
 * Exit segment mode
 * Cleans up overlays and resets state
 */
export function exitSegmentMode(
  container: HTMLElement,
  state: MaskOverlayState,
  callbacks: {
    updateHighlight: () => void,
    pushEvent: (event: string, payload: unknown) => void
  }
): void {
  debugLog('[SegmentMode] Exiting segment mode...');

  try {
    // Set state first to prevent race conditions
    state.segmentMode = false;
    state.segmentPending = false;
    state.lockedSegmentPoints = [];
    state.spotlightedMaskId = null;

    // Clear live segment state
    if (state.liveSegmentDebounceId !== null) {
      clearTimeout(state.liveSegmentDebounceId);
      state.liveSegmentDebounceId = null;
    }
    state.lastLiveSegmentRequestId = null;

    // Update visual state
    container.classList.remove('segment-mode');

    // Remove point markers container
    if (state.pointMarkersContainer) {
      state.pointMarkersContainer.remove();
      state.pointMarkersContainer = null;
    }

    // Remove preview mask
    if (state.previewMaskCanvas) {
      state.previewMaskCanvas.remove();
      state.previewMaskCanvas = null;
    }
    state.lastMaskData = null;

    // Remove spotlight overlay
    removeSpotlightOverlay(state);

    // Restore cursor style
    container.style.cursor = '';

    // Force cleanup any remaining segment mode elements (belt and suspenders)
    forceCleanupSegmentElements(state);

    // Restore highlight state
    callbacks.updateHighlight();

    // Notify server
    callbacks.pushEvent("exit_segment_mode", {});

    debugLog('[SegmentMode] Successfully exited segment mode');
  } catch (error) {
    console.error('[SegmentMode] Error during exit, forcing cleanup:', error);
    state.segmentMode = false;
    forceCleanupSegmentElements(state);
  }
}

/**
 * Force cleanup of all segment mode DOM elements
 * Also nulls out state references to prevent stale pointers
 */
export function forceCleanupSegmentElements(state?: MaskOverlayState): void {
  try {
    const jsContainer = document.getElementById('js-overlay-container');
    if (jsContainer) {
      const segmentElements = jsContainer.querySelectorAll(
        '.segment-point-markers, .segment-preview-mask, .segment-spotlight-overlay'
      );
      segmentElements.forEach(el => {
        try {
          el.remove();
        } catch (e) {
          console.warn('[SegmentMode] Error removing element:', e);
        }
      });
      if (segmentElements.length > 0) {
        debugLog(`[SegmentMode] Force cleaned ${segmentElements.length} segment elements`);
      }
    }

    // Null out state references to prevent stale pointers
    if (state) {
      state.pointMarkersContainer = null;
      state.previewMaskCanvas = null;
      state.spotlightOverlay = null;
      state.lastMaskData = null;
    }
  } catch (error) {
    console.error('[SegmentMode] Error in force cleanup:', error);
  }
}

/**
 * Convert mouse event to image coordinates
 */
export function getImageCoordinates(
  event: MouseEvent,
  container: HTMLElement,
  imageWidth: number,
  imageHeight: number
): { x: number; y: number } | null {
  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return null;

  const containerRect = container.getBoundingClientRect();
  const displayX = event.clientX - containerRect.left;
  const displayY = event.clientY - containerRect.top;

  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(img, imageWidth, imageHeight);

  const x = (displayX / displayWidth) * naturalWidth;
  const y = (displayY / displayHeight) * naturalHeight;

  return { x, y };
}

/**
 * Render preview mask from segmentation result
 * Shows actual image through mask shape (spotlight effect)
 */
export function renderPreviewMask(maskData: MaskData, state: MaskOverlayState): void {
  // Store mask data for confirmation
  state.lastMaskData = maskData;

  // Remove old preview
  if (state.previewMaskCanvas) {
    state.previewMaskCanvas.remove();
  }

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  // Create canvas for preview
  const canvas = document.createElement('canvas');
  canvas.className = 'segment-preview-mask';
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 50;
  `;

  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;

  const ctx = canvas.getContext('2d')!;

  // Load mask PNG
  const maskImg = new Image();
  maskImg.onload = () => {
    if (!state.segmentMode) return;

    // Draw source image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Use mask as alpha channel to create cutout effect (spotlight)
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);

    // Insert into DOM
    const jsContainer = document.getElementById('js-overlay-container');
    if (jsContainer) {
      jsContainer.appendChild(canvas);
    }
    state.previewMaskCanvas = canvas;
  };

  maskImg.onerror = () => {
    console.warn('[SegmentMode] Failed to load preview mask');
  };

  maskImg.src = maskData.mask_png;
}

/**
 * Render visual markers for locked segment points
 * Shows small circles at each locked point location (blue=positive, red=negative)
 */
export function renderPointMarkers(
  points: SegmentPoint[],
  state: MaskOverlayState
): void {
  if (!state.pointMarkersContainer) return;

  // Clear existing markers
  state.pointMarkersContainer.innerHTML = '';

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(
    img,
    state.imageWidth,
    state.imageHeight
  );

  for (const point of points) {
    // Convert image coordinates to display coordinates
    const displayX = (point.x / naturalWidth) * displayWidth;
    const displayY = (point.y / naturalHeight) * displayHeight;

    const marker = document.createElement('div');
    marker.className = `segment-point-marker ${point.label === 1 ? 'positive' : 'negative'}`;
    marker.style.left = `${displayX}px`;
    marker.style.top = `${displayY}px`;
    state.pointMarkersContainer.appendChild(marker);
  }
}

/**
 * Create dark spotlight overlay for segment mode
 */
export function createSpotlightOverlay(state: MaskOverlayState): void {
  const jsContainer = document.getElementById('js-overlay-container');
  if (!jsContainer || state.spotlightOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'segment-spotlight-overlay';
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
  state.spotlightOverlay = overlay;

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
export function removeSpotlightOverlay(state: MaskOverlayState): void {
  if (state.spotlightOverlay) {
    state.spotlightOverlay.remove();
    state.spotlightOverlay = null;
  }
  state.spotlightedMaskId = null;
}
