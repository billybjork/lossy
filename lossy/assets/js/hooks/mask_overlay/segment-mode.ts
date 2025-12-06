/**
 * Segment Mode Controller
 *
 * Interactive segmentation mode with brush-based region selection.
 * Integrates with SAM (Segment Anything Model) for real-time mask generation.
 */

import type { MaskOverlayState, SegmentPoint, BrushStroke, MaskData, SegmentResponse } from './types';
import type { PointPrompt } from '../../ml/types';
import type { InferenceProvider } from '../../ml/inference-provider';
import { douglasPeucker, uniformSubsample, getImageNaturalDimensions, convertBrushSizeToDisplay, debugLog } from './utils';

/**
 * Enter segment mode
 * Sets up UI overlays and pre-computes embeddings if needed
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
  state.segmentPoints = [];
  state.segmentPending = false;

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

  // Create brush cursor overlay
  if (!state.cursorOverlay && jsContainer) {
    state.cursorOverlay = document.createElement('div');
    state.cursorOverlay.className = 'brush-cursor';
    state.cursorOverlay.style.cssText = `
      position: absolute;
      pointer-events: none;
      border: 2px solid white;
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
      z-index: 200;
      display: none;
      transform: translate(-50%, -50%);
    `;
    jsContainer.appendChild(state.cursorOverlay);

    // IMPORTANT: Store event listener references for proper cleanup
    state.segmentModeCursorMoveHandler = (e: MouseEvent) => {
      if (!state.segmentMode || !state.cursorOverlay) return;
      updateBrushCursor(e, container, state);
    };

    state.segmentModeEnterHandler = () => {
      if (state.segmentMode && state.cursorOverlay) {
        state.cursorOverlay.style.display = 'block';
      }
    };

    state.segmentModeLeaveHandler = () => {
      if (state.cursorOverlay) {
        state.cursorOverlay.style.display = 'none';
      }
    };

    // Add event listeners (which will be removed on exit)
    container.addEventListener('mousemove', state.segmentModeCursorMoveHandler);
    container.addEventListener('mouseenter', state.segmentModeEnterHandler);
    container.addEventListener('mouseleave', state.segmentModeLeaveHandler);
  }

  // Immediately show brush cursor at last known position
  if (state.cursorOverlay && state.lastMousePosition) {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      const displayBrushSize = convertBrushSizeToDisplay(state.brushSize, img, state.imageWidth);

      state.cursorOverlay.style.left = `${state.lastMousePosition.x}px`;
      state.cursorOverlay.style.top = `${state.lastMousePosition.y}px`;
      state.cursorOverlay.style.width = `${displayBrushSize}px`;
      state.cursorOverlay.style.height = `${displayBrushSize}px`;
      state.cursorOverlay.style.display = 'block';
    }
  }

  // Hide default cursor in segment mode
  container.style.cursor = 'none';

  // Create spotlight overlay if in Command key spotlight mode
  if (state.commandKeySpotlightMode) {
    createSpotlightOverlay(state);
  }

  // Notify server
  callbacks.pushEvent("enter_segment_mode", {});

  debugLog('[SegmentMode] Entered segment mode');

  // Pre-compute embeddings if using local provider
  const inferenceProvider = getInferenceProvider();
  if (inferenceProvider && !isExtensionAvailable() && !state.embeddingsReady) {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img && img.complete) {
      debugLog('[SegmentMode] Computing embeddings...');
      try {
        await inferenceProvider.computeEmbeddings(state.documentId, img);
        state.embeddingsReady = true;
        debugLog('[SegmentMode] Embeddings ready');
      } catch (error) {
        console.error('[SegmentMode] Failed to compute embeddings:', error);
        // Don't exit segment mode on embedding failure - user can still try
        // Extension-based inference or other operations
      }
    }
  }
}

/**
 * Exit segment mode
 * Cleans up UI overlays and resets state
 * Uses defensive cleanup to ensure marquee tool reliability
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
    // CRITICAL: Set state first to prevent race conditions
    state.segmentMode = false;
    state.segmentPoints = [];
    state.segmentPending = false;

    // Clear brush state
    state.currentStroke = [];
    state.strokeHistory = [];
    state.isDrawingStroke = false;

    // Clear live segment state
    if (state.liveSegmentDebounceId !== null) {
      clearTimeout(state.liveSegmentDebounceId);
      state.liveSegmentDebounceId = null;
    }
    state.lastLiveSegmentRequestId = null;
    state.liveSegmentInProgress = false;
    state.lastLiveSegmentTime = 0;

    // Update visual state
    container.classList.remove('segment-mode');

    // IMPORTANT: Remove event listeners FIRST (before DOM cleanup)
    // This prevents orphaned listeners from interfering with marquee
    try {
      if (state.segmentModeCursorMoveHandler) {
        container.removeEventListener('mousemove', state.segmentModeCursorMoveHandler);
        state.segmentModeCursorMoveHandler = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing cursor move handler:', e);
    }

    try {
      if (state.segmentModeEnterHandler) {
        container.removeEventListener('mouseenter', state.segmentModeEnterHandler);
        state.segmentModeEnterHandler = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing enter handler:', e);
    }

    try {
      if (state.segmentModeLeaveHandler) {
        container.removeEventListener('mouseleave', state.segmentModeLeaveHandler);
        state.segmentModeLeaveHandler = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing leave handler:', e);
    }

    // Clear point markers
    try {
      if (state.pointMarkersContainer) {
        state.pointMarkersContainer.innerHTML = '';
      }
    } catch (e) {
      console.warn('[SegmentMode] Error clearing point markers:', e);
    }

    // Remove brush canvas
    try {
      if (state.brushCanvas) {
        state.brushCanvas.remove();
        state.brushCanvas = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing brush canvas:', e);
    }

    // Remove preview mask
    try {
      if (state.previewMaskCanvas) {
        state.previewMaskCanvas.remove();
        state.previewMaskCanvas = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing preview mask:', e);
    }

    // Remove cursor overlay
    try {
      if (state.cursorOverlay) {
        state.cursorOverlay.remove();
        state.cursorOverlay = null;
      }
    } catch (e) {
      console.warn('[SegmentMode] Error removing cursor overlay:', e);
    }

    // Remove spotlight overlay
    try {
      removeSpotlightOverlay(state);
    } catch (e) {
      console.warn('[SegmentMode] Error removing spotlight overlay:', e);
    }

    // Restore cursor style
    try {
      container.style.cursor = '';
    } catch (e) {
      console.warn('[SegmentMode] Error restoring cursor:', e);
    }

    // DEFENSIVE: Force cleanup any remaining segment mode elements
    forceCleanupSegmentElements();

    // Restore highlight state
    try {
      callbacks.updateHighlight();
    } catch (e) {
      console.warn('[SegmentMode] Error updating highlight:', e);
    }

    // Notify server
    try {
      callbacks.pushEvent("exit_segment_mode", {});
    } catch (e) {
      console.warn('[SegmentMode] Error notifying server:', e);
    }

    debugLog('[SegmentMode] Successfully exited segment mode');
  } catch (error) {
    console.error('[SegmentMode] CRITICAL: Error during exit, forcing cleanup:', error);
    // Even if everything fails, ensure state is reset
    state.segmentMode = false;
    forceCleanupSegmentElements();
  }
}

/**
 * Force cleanup of all segment mode DOM elements
 * This is a nuclear option to ensure marquee reliability
 */
export function forceCleanupSegmentElements(): void {
  try {
    const jsContainer = document.getElementById('js-overlay-container');
    if (jsContainer) {
      const segmentElements = jsContainer.querySelectorAll(
        '.brush-cursor, .segment-point-markers, .brush-stroke-canvas, .segment-preview-mask, .segment-spotlight-overlay'
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
 * Update brush cursor position and size
 */
export function updateBrushCursor(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState
): void {
  if (!state.cursorOverlay) return;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const containerRect = container.getBoundingClientRect();
  const displayX = event.clientX - containerRect.left;
  const displayY = event.clientY - containerRect.top;

  // Calculate brush size in display coordinates
  const displayBrushSize = convertBrushSizeToDisplay(state.brushSize, img, state.imageWidth);

  // Update cursor position and size
  state.cursorOverlay.style.left = `${displayX}px`;
  state.cursorOverlay.style.top = `${displayY}px`;
  state.cursorOverlay.style.width = `${displayBrushSize}px`;
  state.cursorOverlay.style.height = `${displayBrushSize}px`;
  state.cursorOverlay.style.display = 'block';
}

/**
 * Start a brush stroke
 */
export function startBrushStroke(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState
): void {
  const point = getImageCoordinates(event, container, state.imageWidth, state.imageHeight);
  if (!point) return;

  const label = event.shiftKey ? 0 : 1;  // Shift = negative, normal = positive

  state.isDrawingStroke = true;
  state.currentStroke = [{ x: point.x, y: point.y, label }];

  // Create brush canvas if needed
  if (!state.brushCanvas) {
    createBrushCanvas(state);
  }

  // Start drawing the stroke visual
  drawBrushPoint(point.x, point.y, label, state);
}

/**
 * Continue a brush stroke
 */
export function continueBrushStroke(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState,
  requestLiveSegmentCallback?: () => Promise<void>
): void {
  if (!state.isDrawingStroke || state.currentStroke.length === 0) return;

  const point = getImageCoordinates(event, container, state.imageWidth, state.imageHeight);
  if (!point) return;

  const label = state.currentStroke[0].label;
  state.currentStroke.push({ x: point.x, y: point.y, label });

  // Draw the stroke visual (instant feedback)
  drawBrushPoint(point.x, point.y, label, state);

  // Schedule debounced live segmentation
  if (requestLiveSegmentCallback) {
    scheduleLiveSegmentation(state, requestLiveSegmentCallback);
  }
}

/**
 * Schedule debounced live segmentation during brush stroke
 * Clears previous timer and sets new one to fire after debounce delay
 */
export function scheduleLiveSegmentation(
  state: MaskOverlayState,
  requestLiveSegmentCallback: () => Promise<void>
): void {
  // Clear any pending debounce timer
  if (state.liveSegmentDebounceId !== null) {
    clearTimeout(state.liveSegmentDebounceId);
  }

  // Schedule new inference after debounce delay
  state.liveSegmentDebounceId = window.setTimeout(() => {
    state.liveSegmentDebounceId = null;
    // Only trigger if we have enough points for meaningful inference
    if (state.currentStroke.length >= 3) {
      requestLiveSegmentCallback();
    }
  }, 150); // 150ms debounce matches extension scroll pattern
}

/**
 * Finish a brush stroke
 */
export function finishBrushStroke(
  state: MaskOverlayState,
  requestSegmentCallback: () => Promise<void>
): void {
  if (!state.isDrawingStroke || state.currentStroke.length === 0) {
    state.isDrawingStroke = false;
    // Clear any pending live segment timer
    if (state.liveSegmentDebounceId !== null) {
      clearTimeout(state.liveSegmentDebounceId);
      state.liveSegmentDebounceId = null;
    }
    return;
  }

  // Clear any pending live segment timer
  if (state.liveSegmentDebounceId !== null) {
    clearTimeout(state.liveSegmentDebounceId);
    state.liveSegmentDebounceId = null;
  }

  state.isDrawingStroke = false;

  // Create stroke object
  const stroke: BrushStroke = {
    id: `stroke_${Date.now()}`,
    rawPoints: state.currentStroke.map((p) => ({ x: p.x, y: p.y })),
    sampledPoints: [],
    label: state.currentStroke[0].label,
    brushSize: state.brushSize
  };

  // Sample points from stroke
  stroke.sampledPoints = sampleStrokePoints(stroke);

  // Add to history
  state.strokeHistory.push(stroke);
  state.currentStroke = [];

  // Check if we can reuse recent live segmentation result
  const timeSinceLastLiveSegment = Date.now() - state.lastLiveSegmentTime;
  const canReuseLiveResult = timeSinceLastLiveSegment < 500 &&
                              !state.liveSegmentInProgress &&
                              state.strokeHistory.length === 1; // Only first stroke

  if (!canReuseLiveResult) {
    // Trigger full segmentation with all strokes
    requestSegmentCallback();
  } else {
    debugLog('[SegmentMode] Reusing recent live segmentation result');
  }
}

/**
 * Sample points from a brush stroke using Douglas-Peucker
 */
export function sampleStrokePoints(stroke: BrushStroke): SegmentPoint[] {
  // For single clicks, just use the first point
  if (stroke.rawPoints.length < 3) {
    return [{
      x: stroke.rawPoints[0].x,
      y: stroke.rawPoints[0].y,
      label: stroke.label
    }];
  }

  // Simplify with Douglas-Peucker
  const epsilon = Math.max(5, stroke.brushSize / 4);
  const simplified = douglasPeucker(stroke.rawPoints, epsilon);

  // Limit to max 5 points per stroke
  const maxPointsPerStroke = 5;
  const sampled = uniformSubsample(simplified, maxPointsPerStroke);

  // Convert to SegmentPoint format
  return sampled.map(p => ({ x: p.x, y: p.y, label: stroke.label }));
}

/**
 * Get all sampled points from stroke history
 * Limits total to 10 points for SAM performance
 */
export function getAllSampledPoints(strokeHistory: BrushStroke[]): SegmentPoint[] {
  const allPoints = strokeHistory.flatMap((s: BrushStroke) => s.sampledPoints);
  return uniformSubsample(allPoints, 10);
}

/**
 * Remove the last stroke from history
 */
export function removeLastStroke(
  state: MaskOverlayState,
  callbacks: {
    redrawAllStrokes: () => void,
    requestSegmentFromStrokes: () => Promise<void>
  }
): void {
  if (state.strokeHistory.length === 0) return;

  state.strokeHistory.pop();

  // Redraw stroke visuals
  callbacks.redrawAllStrokes();

  // Update segment points for compatibility
  state.segmentPoints = getAllSampledPoints(state.strokeHistory);

  if (state.strokeHistory.length > 0) {
    callbacks.requestSegmentFromStrokes();
  } else {
    // Clear preview
    if (state.previewMaskCanvas) {
      state.previewMaskCanvas.remove();
      state.previewMaskCanvas = null;
    }
  }

  debugLog(`[SegmentMode] Removed stroke, ${state.strokeHistory.length} remaining`);
}

/**
 * Create brush canvas for visual feedback
 */
export function createBrushCanvas(state: MaskOverlayState): void {
  const jsContainer = document.getElementById('js-overlay-container');
  if (!jsContainer) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'brush-stroke-canvas';
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 60;
  `;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (img) {
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
  }

  jsContainer.appendChild(canvas);
  state.brushCanvas = canvas;
}

/**
 * Draw a single brush point
 */
export function drawBrushPoint(
  imgX: number,
  imgY: number,
  label: number,
  state: MaskOverlayState
): void {
  if (!state.brushCanvas) return;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const ctx = state.brushCanvas.getContext('2d');
  if (!ctx) return;

  // Convert to display coordinates
  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(img, state.imageWidth, state.imageHeight);

  const displayX = (imgX / naturalWidth) * displayWidth;
  const displayY = (imgY / naturalHeight) * displayHeight;
  const displayRadius = convertBrushSizeToDisplay(state.brushSize, img, state.imageWidth);

  // Draw diffuse glow (optimistic mask preview)
  // Use natural brush size based on image dimensions if not specified
  const naturalRadius = displayRadius > 0 ? displayRadius : Math.min(displayWidth, displayHeight) * 0.03;

  if (label === 1) {
    // Positive: Soft blue glow (multiple layers for diffusion)
    const baseColor = [59, 130, 246]; // Blue

    // Outer glow (most diffuse)
    const gradient1 = ctx.createRadialGradient(displayX, displayY, 0, displayX, displayY, naturalRadius * 2);
    gradient1.addColorStop(0, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.15)`);
    gradient1.addColorStop(0.5, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.08)`);
    gradient1.addColorStop(1, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0)`);
    ctx.fillStyle = gradient1;
    ctx.fillRect(displayX - naturalRadius * 2, displayY - naturalRadius * 2, naturalRadius * 4, naturalRadius * 4);

    // Middle glow
    const gradient2 = ctx.createRadialGradient(displayX, displayY, 0, displayX, displayY, naturalRadius * 1.2);
    gradient2.addColorStop(0, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.3)`);
    gradient2.addColorStop(0.6, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.15)`);
    gradient2.addColorStop(1, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0)`);
    ctx.fillStyle = gradient2;
    ctx.fillRect(displayX - naturalRadius * 1.5, displayY - naturalRadius * 1.5, naturalRadius * 3, naturalRadius * 3);

    // Inner core (brightest)
    const gradient3 = ctx.createRadialGradient(displayX, displayY, 0, displayX, displayY, naturalRadius * 0.6);
    gradient3.addColorStop(0, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.5)`);
    gradient3.addColorStop(0.7, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.25)`);
    gradient3.addColorStop(1, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0)`);
    ctx.fillStyle = gradient3;
    ctx.fillRect(displayX - naturalRadius, displayY - naturalRadius, naturalRadius * 2, naturalRadius * 2);
  } else {
    // Negative: Soft red glow for erasing
    const baseColor = [239, 68, 68]; // Red

    const gradient = ctx.createRadialGradient(displayX, displayY, 0, displayX, displayY, naturalRadius * 1.5);
    gradient.addColorStop(0, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.4)`);
    gradient.addColorStop(0.5, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.2)`);
    gradient.addColorStop(1, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(displayX - naturalRadius * 2, displayY - naturalRadius * 2, naturalRadius * 4, naturalRadius * 4);
  }
}

/**
 * Redraw all strokes from history
 */
export function redrawAllStrokes(state: MaskOverlayState): void {
  if (!state.brushCanvas) return;

  const ctx = state.brushCanvas.getContext('2d');
  if (!ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, state.brushCanvas.width, state.brushCanvas.height);

  // Redraw all strokes
  for (const stroke of state.strokeHistory) {
    for (const point of stroke.rawPoints) {
      drawBrushPoint(point.x, point.y, stroke.label, state);
    }
  }
}

/**
 * Request segmentation from strokes
 */
export async function requestSegmentFromStrokes(
  state: MaskOverlayState,
  getInferenceProvider: () => InferenceProvider | null,
  isExtensionAvailable: () => boolean,
  pendingSegmentRequests: Map<string, (result: SegmentResponse) => void>,
  getSegmentRequestCounter: () => number
): Promise<void> {
  if (state.strokeHistory.length === 0) return;
  if (!state.documentId) {
    console.warn('[SegmentMode] No document ID for segmentation');
    return;
  }

  const inferenceProvider = getInferenceProvider();

  // Check if embeddings are ready when using local inference
  if (inferenceProvider && !isExtensionAvailable() && !state.embeddingsReady) {
    console.warn('[SegmentMode] Embeddings not ready yet');
    return;
  }

  state.segmentPending = true;

  // Get sampled points
  const sampledPoints = getAllSampledPoints(state.strokeHistory);
  state.segmentPoints = sampledPoints;

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  const actualWidth = img?.naturalWidth || state.imageWidth;
  const actualHeight = img?.naturalHeight || state.imageHeight;

  debugLog(`[SegmentMode] Requesting segment with ${sampledPoints.length} points from ${state.strokeHistory.length} strokes`);

  try {
    let response: SegmentResponse;

    if (inferenceProvider && !isExtensionAvailable()) {
      const result = await inferenceProvider.segmentAtPoints(
        state.documentId,
        sampledPoints as PointPrompt[],
        { width: actualWidth, height: actualHeight }
      );
      response = {
        success: true,
        mask_png: result.mask_png,
        bbox: result.bbox
      };
    } else {
      // Fall back to extension
      const requestId = `seg_${getSegmentRequestCounter()}`;
      response = await new Promise<SegmentResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingSegmentRequests.delete(requestId);
          reject(new Error('Segment request timeout'));
        }, 10000);

        pendingSegmentRequests.set(requestId, (result: SegmentResponse) => {
          clearTimeout(timeout);
          resolve(result);
        });

        window.postMessage({
          type: 'LOSSY_SEGMENT_REQUEST',
          documentId: state.documentId,
          points: sampledPoints,
          imageSize: { width: actualWidth, height: actualHeight },
          requestId
        }, '*');
      });
    }

    if (response.success && (response.mask || response.mask_png)) {
      const maskData: MaskData = response.mask || {
        mask_png: response.mask_png!,
        bbox: response.bbox!
      };
      renderPreviewMask(maskData, state);
    } else {
      console.warn('[SegmentMode] Segment request failed:', response.error);
    }
  } catch (error) {
    console.error('[SegmentMode] Segment request error:', error);
  } finally {
    state.segmentPending = false;
  }
}

/**
 * Request segmentation from current stroke (live preview during drawing)
 * Uses debouncing and staleness detection to handle rapid updates
 */
export async function requestLiveSegmentFromCurrentStroke(
  state: MaskOverlayState,
  getInferenceProvider: () => InferenceProvider | null,
  isExtensionAvailable: () => boolean,
  pendingSegmentRequests: Map<string, (result: SegmentResponse) => void>,
  getSegmentRequestCounter: () => number
): Promise<void> {
  // Don't start new request if one is in progress
  if (state.liveSegmentInProgress) {
    debugLog('[SegmentMode] Skipping live segment - request in progress');
    return;
  }

  // Need at least a few points for meaningful inference
  if (state.currentStroke.length < 3) {
    return;
  }

  if (!state.documentId) {
    console.warn('[SegmentMode] No document ID for live segmentation');
    return;
  }

  const inferenceProvider = getInferenceProvider();

  // Check if embeddings are ready when using local inference
  if (inferenceProvider && !isExtensionAvailable() && !state.embeddingsReady) {
    console.warn('[SegmentMode] Embeddings not ready for live segmentation');
    return;
  }

  state.liveSegmentInProgress = true;

  // Sample points from current stroke only
  const tempStroke: BrushStroke = {
    id: 'temp_live',
    rawPoints: state.currentStroke.map((p) => ({ x: p.x, y: p.y })),
    sampledPoints: [],
    label: state.currentStroke[0].label,
    brushSize: state.brushSize
  };
  const sampledPoints = sampleStrokePoints(tempStroke);

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  const actualWidth = img?.naturalWidth || state.imageWidth;
  const actualHeight = img?.naturalHeight || state.imageHeight;

  debugLog(`[SegmentMode] Live segmentation with ${sampledPoints.length} points from current stroke`);

  try {
    let response: SegmentResponse;
    const requestId = `live_seg_${getSegmentRequestCounter()}_${Date.now()}`;

    // Store request ID for staleness detection
    state.lastLiveSegmentRequestId = requestId;

    if (inferenceProvider && !isExtensionAvailable()) {
      // Local inference via Web Worker
      const result = await inferenceProvider.segmentAtPoints(
        state.documentId,
        sampledPoints as PointPrompt[],
        { width: actualWidth, height: actualHeight }
      );
      response = {
        success: true,
        mask_png: result.mask_png,
        bbox: result.bbox
      };
    } else {
      // Extension inference via postMessage
      response = await new Promise<SegmentResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingSegmentRequests.delete(requestId);
          reject(new Error('Live segment request timeout'));
        }, 5000); // Shorter timeout for live inference

        pendingSegmentRequests.set(requestId, (result: SegmentResponse) => {
          clearTimeout(timeout);
          resolve(result);
        });

        window.postMessage({
          type: 'LOSSY_SEGMENT_REQUEST',
          documentId: state.documentId,
          points: sampledPoints,
          imageSize: { width: actualWidth, height: actualHeight },
          requestId
        }, '*');
      });
    }

    // Check if this request is still current (not stale)
    if (state.lastLiveSegmentRequestId !== requestId) {
      debugLog('[SegmentMode] Discarding stale live segment response');
      return;
    }

    // Update timestamp for freshness check
    state.lastLiveSegmentTime = Date.now();

    if (response.success && (response.mask || response.mask_png)) {
      const maskData: MaskData = response.mask || {
        mask_png: response.mask_png!,
        bbox: response.bbox!
      };
      renderPreviewMask(maskData, state);
    } else {
      console.warn('[SegmentMode] Live segment request failed:', response.error);
    }
  } catch (error) {
    // Silent failure for live inference - don't interrupt drawing
    console.error('[SegmentMode] Live segment request error:', error);
  } finally {
    // Always clear in-progress flag to allow new requests
    state.liveSegmentInProgress = false;
  }
}

/**
 * Render preview mask from segmentation result
 */
export function renderPreviewMask(maskData: MaskData, state: MaskOverlayState): void {
  // Store mask data for later use (e.g., marching ants)
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
    opacity: 0;
    transition: opacity 150ms ease-out;
  `;

  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;

  const ctx = canvas.getContext('2d')!;

  // Load mask PNG
  const maskImg = new Image();
  maskImg.onload = () => {
    if (!state.segmentMode) return;

    // In spotlight mode, show actual image section with mask as cutout
    // In normal mode, show blue tint
    if (state.spotlightOverlay) {
      // Draw source image
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Use mask as alpha channel to create cutout effect
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
    } else {
      // Draw mask scaled to canvas
      ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);

      // Apply blue tint
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Insert into DOM
    if (state.pointMarkersContainer && state.pointMarkersContainer.parentNode === state.container) {
      state.container.insertBefore(canvas, state.pointMarkersContainer);
    } else {
      state.container.appendChild(canvas);
    }
    state.previewMaskCanvas = canvas;

    // Clear brush trail - only show the mask
    if (state.brushCanvas) {
      const brushCtx = state.brushCanvas.getContext('2d');
      if (brushCtx) {
        brushCtx.clearRect(0, 0, state.brushCanvas.width, state.brushCanvas.height);
      }
    }

    // Fade in smoothly
    requestAnimationFrame(() => {
      if (canvas.style) {
        canvas.style.opacity = '1';
      }
    });
  };

  maskImg.onerror = () => {
    console.warn('[SegmentMode] Failed to load preview mask');
  };

  maskImg.src = maskData.mask_png;
}

/**
 * Create marching ants animation around mask edges
 * Battle-tested approach: use canvas stroke operations with the mask as clipping path
 */
export function createMarchingAnts(
  maskData: MaskData,
  state: MaskOverlayState
): void {
  // Remove any existing marching ants
  removeMarchingAnts(state);

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  // Create canvas for marching ants
  const canvas = document.createElement('canvas');
  canvas.className = 'marching-ants-canvas';
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 51;
  `;

  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;

  const ctx = canvas.getContext('2d')!;

  // Load mask image
  const maskImg = new Image();
  maskImg.onload = () => {
    // Animate marching ants
    let offset = 0;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw the mask to use as a template
      ctx.save();
      ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);

      // Use the mask alpha as a clip for the stroke
      ctx.globalCompositeOperation = 'source-in';

      // Draw black dashed stroke
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -offset;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);

      // Switch to destination-over to draw behind
      ctx.globalCompositeOperation = 'destination-over';

      // Draw white dashed stroke (offset)
      ctx.strokeStyle = '#ffffff';
      ctx.lineDashOffset = -offset - 6;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);

      ctx.restore();

      offset = (offset + 0.5) % 12;
      state.marchingAntsAnimationId = requestAnimationFrame(animate);
    };

    animate();
  };

  maskImg.src = maskData.mask_png;

  // Insert into DOM
  if (state.container) {
    state.container.appendChild(canvas);
    state.marchingAntsCanvas = canvas;
  }
}

/**
 * Remove marching ants animation
 */
export function removeMarchingAnts(state: MaskOverlayState): void {
  if (state.marchingAntsCanvas) {
    state.marchingAntsCanvas.remove();
    state.marchingAntsCanvas = null;
  }
  if (state.marchingAntsAnimationId !== null) {
    cancelAnimationFrame(state.marchingAntsAnimationId);
    state.marchingAntsAnimationId = null;
  }
}

/**
 * Confirm segment and send to server
 */
export async function confirmSegment(
  state: MaskOverlayState,
  getInferenceProvider: () => InferenceProvider | null,
  isExtensionAvailable: () => boolean,
  pendingSegmentRequests: Map<string, (result: SegmentResponse) => void>,
  getSegmentRequestCounter: () => number,
  callbacks: {
    pushEvent: (event: string, payload: unknown) => void,
    exitSegmentMode: () => void
  }
): Promise<void> {
  if (state.segmentPoints.length === 0 && state.strokeHistory.length === 0) return;
  if (!state.documentId) {
    console.warn('[SegmentMode] No document ID');
    return;
  }

  state.segmentPending = true;
  state.pendingSegmentConfirm = true;

  // Capture current mask IDs before confirming (for shimmer effect)
  state.previousMaskIds = new Set(
    Array.from(state.container.querySelectorAll('.mask-region'))
      .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
      .filter(id => id !== '')
  );

  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  const actualWidth = img?.naturalWidth || state.imageWidth;
  const actualHeight = img?.naturalHeight || state.imageHeight;

  try {
    let response: SegmentResponse;
    const inferenceProvider = getInferenceProvider();

    if (inferenceProvider && !isExtensionAvailable()) {
      const result = await inferenceProvider.segmentAtPoints(
        state.documentId,
        state.segmentPoints as PointPrompt[],
        { width: actualWidth, height: actualHeight }
      );
      response = {
        success: true,
        mask_png: result.mask_png,
        bbox: result.bbox
      };
    } else {
      const requestId = `seg_confirm_${getSegmentRequestCounter()}`;
      response = await new Promise<SegmentResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingSegmentRequests.delete(requestId);
          reject(new Error('Segment request timeout'));
        }, 10000);

        pendingSegmentRequests.set(requestId, (result: SegmentResponse) => {
          clearTimeout(timeout);
          resolve(result);
        });

        window.postMessage({
          type: 'LOSSY_SEGMENT_REQUEST',
          documentId: state.documentId,
          points: state.segmentPoints,
          imageSize: { width: actualWidth, height: actualHeight },
          requestId
        }, '*');
      });
    }

    const maskPng = response.mask?.mask_png || response.mask_png;
    const bbox = response.mask?.bbox || response.bbox;
    if (response.success && maskPng) {
      callbacks.pushEvent("confirm_segment", {
        mask_png: maskPng,
        bbox: bbox
      });

      debugLog('[SegmentMode] Segment confirmed');
    } else {
      console.error('[SegmentMode] Failed to get final mask:', response.error);
    }
  } catch (error) {
    console.error('[SegmentMode] Confirm segment error:', error);
  } finally {
    state.segmentPending = false;
    callbacks.exitSegmentMode();
  }
}

/**
 * Create dark spotlight overlay for spacebar hover mode
 * Adds a dark backdrop with radial gradient to create "closing in" effect
 */
export function createSpotlightOverlay(state: MaskOverlayState): void {
  const jsContainer = document.getElementById('js-overlay-container');
  if (!jsContainer || state.spotlightOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'segment-spotlight-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(2px);
    pointer-events: none;
    z-index: 45;
    opacity: 0;
    transition: opacity 0.3s ease-out, background 0.3s ease-out;
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
 * Update spotlight position with radial gradient
 * Creates a radial gradient centered at cursor for enhanced "closing in" feel
 * Uses larger radius and more gradual falloff for smoother edges
 * Ensures edges are always dark to prevent bright periphery artifacts
 */
export function updateSpotlightPosition(
  state: MaskOverlayState,
  x: number,
  y: number
): void {
  if (!state.spotlightOverlay) return;

  state.spotlightOverlay.style.background = `
    radial-gradient(circle 1200px at ${x}px ${y}px,
      rgba(0, 0, 0, 0.5),
      rgba(0, 0, 0, 0.75) 35%,
      rgba(0, 0, 0, 0.88) 60%,
      rgba(0, 0, 0, 0.95))
  `;
}

/**
 * Remove spotlight overlay and reset spotlight state
 */
export function removeSpotlightOverlay(state: MaskOverlayState): void {
  if (state.spotlightOverlay) {
    state.spotlightOverlay.remove();
    state.spotlightOverlay = null;
  }
  state.spotlightedMaskId = null;
}
