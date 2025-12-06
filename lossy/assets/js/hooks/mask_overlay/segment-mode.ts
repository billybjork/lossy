/**
 * Segment Mode Controller
 *
 * Interactive segmentation mode with brush-based region selection.
 * Integrates with SAM (Segment Anything Model) for real-time mask generation.
 */

import type { MaskOverlayState, SegmentPoint, BrushStroke, MaskData, SegmentResponse } from './types';
import type { PointPrompt } from '../../ml/types';
import type { InferenceProvider } from '../../ml/inference-provider';
import { douglasPeucker, uniformSubsample } from './utils';

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

    // Add mousemove listener for brush cursor
    container.addEventListener('mousemove', (e: MouseEvent) => {
      if (!state.segmentMode || !state.cursorOverlay) return;
      updateBrushCursor(e, container, state);
    });

    // Show/hide cursor on enter/leave
    container.addEventListener('mouseenter', () => {
      if (state.segmentMode && state.cursorOverlay) {
        state.cursorOverlay.style.display = 'block';
      }
    });
    container.addEventListener('mouseleave', () => {
      if (state.cursorOverlay) {
        state.cursorOverlay.style.display = 'none';
      }
    });
  }

  // Immediately show brush cursor at last known position
  if (state.cursorOverlay && state.lastMousePosition) {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      const displayWidth = img.clientWidth;
      const naturalWidth = img.naturalWidth || state.imageWidth;
      const displayBrushSize = (state.brushSize / naturalWidth) * displayWidth;

      state.cursorOverlay.style.left = `${state.lastMousePosition.x}px`;
      state.cursorOverlay.style.top = `${state.lastMousePosition.y}px`;
      state.cursorOverlay.style.width = `${displayBrushSize}px`;
      state.cursorOverlay.style.height = `${displayBrushSize}px`;
      state.cursorOverlay.style.display = 'block';
    }
  }

  // Hide default cursor in segment mode
  container.style.cursor = 'none';

  // Notify server
  callbacks.pushEvent("enter_segment_mode", {});

  console.log('[SegmentMode] Entered segment mode');

  // Pre-compute embeddings if using local provider
  const inferenceProvider = getInferenceProvider();
  if (inferenceProvider && !isExtensionAvailable() && !state.embeddingsReady) {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img && img.complete) {
      console.log('[SegmentMode] Computing embeddings...');
      try {
        await inferenceProvider.computeEmbeddings(state.documentId, img);
        state.embeddingsReady = true;
        console.log('[SegmentMode] Embeddings ready');
      } catch (error) {
        console.error('[SegmentMode] Failed to compute embeddings:', error);
      }
    }
  }
}

/**
 * Exit segment mode
 * Cleans up UI overlays and resets state
 */
export function exitSegmentMode(
  container: HTMLElement,
  state: MaskOverlayState,
  callbacks: {
    updateHighlight: () => void,
    pushEvent: (event: string, payload: unknown) => void
  }
): void {
  state.segmentMode = false;
  state.segmentPoints = [];
  state.segmentPending = false;

  // Clear brush state
  state.currentStroke = [];
  state.strokeHistory = [];
  state.isDrawingStroke = false;

  // Update visual state
  container.classList.remove('segment-mode');

  // Clear point markers
  if (state.pointMarkersContainer) {
    state.pointMarkersContainer.innerHTML = '';
  }

  // Remove brush canvas
  if (state.brushCanvas) {
    state.brushCanvas.remove();
    state.brushCanvas = null;
  }

  // Remove preview mask
  if (state.previewMaskCanvas) {
    state.previewMaskCanvas.remove();
    state.previewMaskCanvas = null;
  }

  // Remove cursor overlay
  if (state.cursorOverlay) {
    state.cursorOverlay.remove();
    state.cursorOverlay = null;
  }

  // Restore highlight state
  callbacks.updateHighlight();

  // Notify server
  callbacks.pushEvent("exit_segment_mode", {});

  console.log('[SegmentMode] Exited segment mode');
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
  const naturalWidth = img.naturalWidth || imageWidth;
  const naturalHeight = img.naturalHeight || imageHeight;

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
  const displayWidth = img.clientWidth;
  const naturalWidth = img.naturalWidth || state.imageWidth;
  const displayBrushSize = (state.brushSize / naturalWidth) * displayWidth;

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
  state: MaskOverlayState
): void {
  if (!state.isDrawingStroke || state.currentStroke.length === 0) return;

  const point = getImageCoordinates(event, container, state.imageWidth, state.imageHeight);
  if (!point) return;

  const label = state.currentStroke[0].label;
  state.currentStroke.push({ x: point.x, y: point.y, label });

  // Draw the stroke visual
  drawBrushPoint(point.x, point.y, label, state);
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
    return;
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

  // Trigger segmentation
  requestSegmentCallback();
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

  console.log(`[SegmentMode] Removed stroke, ${state.strokeHistory.length} remaining`);
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
  const naturalWidth = img.naturalWidth || state.imageWidth;
  const naturalHeight = img.naturalHeight || state.imageHeight;

  const displayX = (imgX / naturalWidth) * displayWidth;
  const displayY = (imgY / naturalHeight) * displayHeight;
  const displayRadius = (state.brushSize / naturalWidth) * displayWidth;

  // Draw filled circle
  ctx.beginPath();
  ctx.arc(displayX, displayY, Math.max(2, displayRadius / 2), 0, Math.PI * 2);
  ctx.fillStyle = label === 1 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
  ctx.fill();
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

  console.log(`[SegmentMode] Requesting segment with ${sampledPoints.length} points from ${state.strokeHistory.length} strokes`);

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
 * Render preview mask from segmentation result
 */
export function renderPreviewMask(maskData: MaskData, state: MaskOverlayState): void {
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

    // Draw mask scaled to canvas
    ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);

    // Apply blue tint
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Insert into DOM
    if (state.pointMarkersContainer && state.pointMarkersContainer.parentNode === state.container) {
      state.container.insertBefore(canvas, state.pointMarkersContainer);
    } else {
      state.container.appendChild(canvas);
    }
    state.previewMaskCanvas = canvas;
  };

  maskImg.onerror = () => {
    console.warn('[SegmentMode] Failed to load preview mask');
  };

  maskImg.src = maskData.mask_png;
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

      console.log('[SegmentMode] Segment confirmed');
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
