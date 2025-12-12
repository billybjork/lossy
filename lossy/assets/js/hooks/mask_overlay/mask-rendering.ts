/**
 * Mask Rendering Engine
 *
 * Visual rendering of masks using canvas-based overlays.
 * Handles segment mask rendering, highlighting, and shimmer effects.
 */

import type { MaskOverlayState, CachedMask } from './types';
import { MASK_COLORS, HOVER_COLOR } from './types';
import { isSmartSelectActive } from './smart-select-mode';

/**
 * Render segment masks (type: 'object') as semi-transparent overlays
 * Creates canvas elements for each mask and caches them for performance
 */
export function renderSegmentMasks(
  container: HTMLElement,
  maskImageCache: Map<string, CachedMask>
): { pendingLoads: number; promise: Promise<void> } {
  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) {
    return { pendingLoads: 0, promise: Promise.resolve() };
  }

  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const loadPromises: Promise<void>[] = [];

  // Track mask ids present in the DOM so we can prune stale cache entries
  const domMaskIds = new Set<string>();
  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    if (maskId) domMaskIds.add(maskId);
  });

  // Remove cached canvases for masks that were deleted
  maskImageCache.forEach((cached, maskId) => {
    if (!domMaskIds.has(maskId)) {
      cached.canvas.remove();
      maskImageCache.delete(maskId);
    }
  });

  // Track color index assignment for new masks
  let nextColorIndex = maskImageCache.size;

  masks.forEach((mask: HTMLElement) => {
    const maskType = mask.dataset.maskType;
    const maskUrl = mask.dataset.maskUrl;
    const maskId = mask.dataset.maskId || '';
    const bboxX = parseFloat(mask.dataset.bboxX || '0') || 0;
    const bboxY = parseFloat(mask.dataset.bboxY || '0') || 0;
    const bboxW = parseFloat(mask.dataset.bboxW || '0') || 0;
    const bboxH = parseFloat(mask.dataset.bboxH || '0') || 0;

    // Render canvas overlays for object/manual segments with mask URLs
    if ((maskType !== 'object' && maskType !== 'manual') || !maskUrl) return;
    if (!maskId || bboxW <= 0 || bboxH <= 0) return;

    // If already cached, ensure canvas is re-attached after LiveView patching
    const cached = maskImageCache.get(maskId);
    if (cached) {
      cached.bbox = { x: bboxX, y: bboxY, w: bboxW, h: bboxH };

      if (!mask.contains(cached.canvas)) {
        mask.appendChild(cached.canvas);
      }

      return;
    }

    // Assign a color index for this mask
    const colorIndex = nextColorIndex % MASK_COLORS.length;
    nextColorIndex++;

    // Load the mask image
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';

    const loadPromise = new Promise<void>((resolve) => {
      maskImg.onload = () => {
        // Create canvas sized to the bbox
        const canvas = document.createElement('canvas');
        canvas.className = 'segment-mask-canvas';
        canvas.dataset.maskId = maskId;
        canvas.width = bboxW;
        canvas.height = bboxH;

        const ctx = canvas.getContext('2d')!;

        // Enable high-quality image smoothing
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Draw only the bbox portion of the mask
        ctx.drawImage(maskImg, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);

        // Extract alpha data before applying any fill
        const alphaData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Style the canvas
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = '0';
        canvas.style.transition = 'opacity 0.15s';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        // Insert canvas inside the mask div
        mask.appendChild(canvas);

        // Cache canvas, alpha data, color assignment, and bbox
        maskImageCache.set(maskId, {
          canvas,
          alphaData,
          colorIndex,
          bbox: { x: bboxX, y: bboxY, w: bboxW, h: bboxH }
        });

        resolve();
      };

      maskImg.onerror = () => {
        console.warn('[MaskRendering] Failed to load mask image:', maskUrl);
        resolve();
      };
    });

    loadPromises.push(loadPromise);

    maskImg.src = maskUrl;
  });

  const pendingLoads = loadPromises.length;
  const promise = pendingLoads > 0 ? Promise.all(loadPromises).then(() => { /* no-op */ }) : Promise.resolve();

  return { pendingLoads, promise };
}

/**
 * Update highlight state for all masks
 * Applies visual classes based on hover/selection state
 */
export function updateHighlight(
  container: HTMLElement,
  state: MaskOverlayState,
  updateSegmentMaskHighlightCallback: () => void
): void {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const hasHover = state.hoveredMaskId !== null;

  // In Smart Select, disable pointer events on all masks
  if (isSmartSelectActive(state.smartSelectCtx)) {
    masks.forEach((mask: HTMLElement) => {
      mask.style.pointerEvents = 'none';
    });
  } else {
    masks.forEach((mask: HTMLElement) => {
      const maskId = mask.dataset.maskId || '';
      const isHovered = maskId === state.hoveredMaskId;
      const isSelected = state.selectedMaskIds.has(maskId);

      // Restore pointer events
      mask.style.pointerEvents = '';

      // Remove all state classes
      mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

      // Apply appropriate class
      if (isSelected) {
        mask.classList.add('mask-selected');
      } else if (isHovered) {
        mask.classList.add('mask-hovered');
      } else {
        mask.classList.add('mask-idle');
      }
    });
  }

  // Update cursor on container
  if (isSmartSelectActive(state.smartSelectCtx)) {
    container.style.cursor = 'crosshair';
  } else {
    container.style.cursor = hasHover ? 'pointer' : 'crosshair';
  }

  // Update segment mask overlays
  updateSegmentMaskHighlightCallback();
}

/**
 * Update segment mask visibility and styling
 * Uses canvas-based crisp outlines with unique per-mask colors
 */
export function updateSegmentMaskHighlight(
  maskImageCache: Map<string, CachedMask>,
  selectedMaskIds: Set<string>,
  hoveredMaskId: string | null,
  dragIntersectingIds: Set<string>
): void {
  maskImageCache.forEach((cached: CachedMask, maskId: string) => {
    const canvas = cached.canvas;
    const isHovered = maskId === hoveredMaskId || dragIntersectingIds.has(maskId);
    const isSelected = selectedMaskIds.has(maskId);

    if (isSelected) {
      // Selected: bold colored fill + colored outline
      const color = MASK_COLORS[cached.colorIndex];
      applyMaskVisuals(maskId, maskImageCache, {
        fill: color.fill,
        stroke: color.stroke,
        strokeWidth: 4
      });
      canvas.style.opacity = '1';
    } else if (isHovered) {
      // Hover: intense fill only, no border
      applyMaskVisuals(maskId, maskImageCache, { fill: HOVER_COLOR.fill });
      canvas.style.opacity = '1';
    } else {
      // Idle: hidden
      canvas.style.opacity = '0';
    }
  });
}

/**
 * Trigger shimmer animation effect on masks
 * Uses CSS-based animation for better performance.
 * @param targetMaskIds - Optional set of mask IDs to shimmer. If not provided, shimmers all masks.
 */
export function triggerShimmer(
  container: HTMLElement,
  targetMaskIds?: Set<string>
): void {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  if (masks.length === 0) return;

  // Collect masks to shimmer with their Y positions for staggering
  const masksToShimmer: Array<{ mask: HTMLElement; y: number }> = [];
  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    if (targetMaskIds && !targetMaskIds.has(maskId)) return;

    const y = parseFloat(mask.dataset.bboxY || '0') || 0;
    masksToShimmer.push({ mask, y });
  });

  if (masksToShimmer.length === 0) return;

  // Sort by Y position (top to bottom)
  masksToShimmer.sort((a, b) => a.y - b.y);

  // Calculate animation timing based on number of masks
  const maskCount = masksToShimmer.length;
  const baseDuration = maskCount > 5 ? 400 : 600;
  const staggerDelay = maskCount > 1 ? Math.min(80, 300 / maskCount) : 0;

  masksToShimmer.forEach(({ mask }, index) => {
    const delay = index * staggerDelay;
    const maskType = mask.dataset.maskType;
    const isSegment = maskType === 'object' || maskType === 'manual';

    setTimeout(() => {
      if (isSegment) {
        // For segment masks, apply shimmer to the canvas element
        const canvas = mask.querySelector('.segment-mask-canvas') as HTMLCanvasElement | null;
        if (canvas) {
          canvas.classList.add('segment-shimmer');
          canvas.style.setProperty('--shimmer-duration', `${baseDuration}ms`);

          setTimeout(() => {
            canvas.classList.remove('segment-shimmer');
            canvas.style.removeProperty('--shimmer-duration');
          }, baseDuration);
        }
      } else {
        // For text regions, use existing CSS shimmer
        mask.classList.add('mask-shimmer');
        mask.style.animationDuration = `${baseDuration}ms`;

        setTimeout(() => {
          mask.classList.remove('mask-shimmer');
          mask.style.removeProperty('animation-duration');
        }, baseDuration);
      }
    }, delay);
  });
}

/**
 * Generate circular offsets for drawing stroke outline.
 * Uses dense, sub-pixel sampling to keep edges smooth after scaling.
 */
function getStrokeOffsets(
  strokeWidth: number,
  samples: number = 24
): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  const seen = new Set<string>();
  const radius = Math.max(1, strokeWidth);
  const step = (Math.PI * 2) / samples;

  const addOffset = (dx: number, dy: number) => {
    const key = `${dx.toFixed(2)},${dy.toFixed(2)}`;
    if (!seen.has(key)) {
      seen.add(key);
      offsets.push([dx, dy]);
    }
  };

  for (let i = 0; i < samples; i++) {
    const angle = i * step;
    addOffset(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }

  // Inner ring smooths out jagged corners on small masks
  const innerRadius = radius * 0.6;
  for (let i = 0; i < samples; i++) {
    const angle = i * step;
    addOffset(Math.cos(angle) * innerRadius, Math.sin(angle) * innerRadius);
  }

  // Ensure center pixel is represented
  addOffset(0, 0);

  return offsets;
}

/**
 * Build a scaled alpha texture for the current mask.
 * Scales to device pixel ratio and adds a tiny feather to avoid staircase edges.
 */
function buildAlphaTexture(alphaData: ImageData, targetW: number, targetH: number): HTMLCanvasElement {
  const source = document.createElement('canvas');
  source.width = alphaData.width;
  source.height = alphaData.height;
  source.getContext('2d')!.putImageData(alphaData, 0, 0);

  const target = document.createElement('canvas');
  target.width = targetW;
  target.height = targetH;
  const ctx = target.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;

  // Light feathering keeps strokes from looking pixelated when downscaled
  const dpr = window.devicePixelRatio || 1;
  const blurRadius = Math.min(0.65, 0.35 * dpr);
  ctx.filter = `blur(${blurRadius}px)`;
  ctx.drawImage(source, 0, 0, targetW, targetH);
  ctx.filter = 'none';

  return target;
}

// ============ Unified Mask Rendering ============

export interface MaskVisualsOptions {
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Unified mask rendering function.
 * Renders a mask with fill color and optional stroke outline.
 *
 * @param maskId - The mask ID to render
 * @param maskImageCache - Cache of mask alpha data
 * @param options - Rendering options (fill color, optional stroke)
 */
export function applyMaskVisuals(
  maskId: string,
  maskImageCache: Map<string, CachedMask>,
  options: MaskVisualsOptions
): void {
  const cached = maskImageCache.get(maskId);
  if (!cached) return;

  const { canvas, alphaData } = cached;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { fill, stroke, strokeWidth = 3 } = options;
  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(w * dpr));
  const targetH = Math.max(1, Math.round(h * dpr));

  // Scale mask to device pixel ratio to avoid aliasing on high-DPI screens
  const alphaTexture = buildAlphaTexture(alphaData, targetW, targetH);

  // Clear canvas
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'source-over';

  // If stroke is provided, create stroke layer first
  if (stroke) {
    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = targetW;
    strokeCanvas.height = targetH;
    const strokeCtx = strokeCanvas.getContext('2d')!;
    strokeCtx.imageSmoothingEnabled = true;

    // Use dense offsets + a tiny blur to smooth jagged edges
    strokeCtx.filter = `blur(${Math.min(0.8, 0.5 * dpr)}px)`;
    const offsets = getStrokeOffsets(strokeWidth * dpr, 32);
    for (const [dx, dy] of offsets) {
      strokeCtx.drawImage(alphaTexture, dx, dy);
    }
    strokeCtx.filter = 'none';

    // Cut out the original mask to leave only the stroke
    strokeCtx.globalCompositeOperation = 'destination-out';
    strokeCtx.drawImage(alphaTexture, 0, 0);

    // Apply stroke color
    strokeCtx.globalCompositeOperation = 'source-in';
    strokeCtx.fillStyle = stroke;
    strokeCtx.fillRect(0, 0, targetW, targetH);

    // Draw stroke layer
    ctx.drawImage(strokeCanvas, 0, 0, w, h);
  }

  // Create and draw fill layer
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = targetW;
  fillCanvas.height = targetH;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.imageSmoothingEnabled = true;
  fillCtx.drawImage(alphaTexture, 0, 0);
  fillCtx.globalCompositeOperation = 'source-in';
  fillCtx.fillStyle = fill;
  fillCtx.fillRect(0, 0, targetW, targetH);

  ctx.drawImage(fillCanvas, 0, 0, w, h);

  // Reset composite operation
  ctx.globalCompositeOperation = 'source-over';
}

// Spotlight fill color for dimmed (non-spotlighted) masks
const SPOTLIGHT_FILL_DIM = 'rgba(255, 255, 255, 0.15)';

/**
 * Update spotlight effects on segment mask canvases
 * Called during Command key hover mode to highlight/dim masks based on cursor position
 * Spotlighted mask shows actual image (true spotlight), others are dimmed
 */
export function updateSegmentMaskSpotlight(
  maskImageCache: Map<string, CachedMask>,
  spotlightedMaskId: string | null
): void {
  const img = document.getElementById('editor-image') as HTMLImageElement | null;

  maskImageCache.forEach((cached: CachedMask, maskId: string) => {
    const canvas = cached.canvas;
    const isSpotlighted = maskId === spotlightedMaskId;

    // Set smooth transition timing for filter/opacity but NOT z-index
    canvas.style.transition = 'filter 0.35s ease-out, opacity 0.35s ease-out';

    if (isSpotlighted && img) {
      // For spotlighted mask: draw actual image with mask as cutout
      // This shows the real image through the mask region (true spotlight effect)
      applyImageCutout(canvas, img, cached.alphaData, cached.bbox);

      // Subtle glow around the spotlighted region
      canvas.style.filter = `
        drop-shadow(0 0 4px rgba(255, 255, 255, 0.5))
        drop-shadow(0 0 12px rgba(255, 255, 255, 0.3))
      `;
      canvas.style.opacity = '1';
      // Ensure spotlighted mask is above the spotlight overlay (z-index 45)
      canvas.style.zIndex = '50';
    } else {
      // For non-spotlighted masks: apply dim fill using unified function
      applyMaskVisuals(maskId, maskImageCache, { fill: SPOTLIGHT_FILL_DIM });

      // Subtle glow for non-hovered masks
      canvas.style.filter = `
        drop-shadow(0 0 4px rgba(255, 255, 255, 0.08))
        drop-shadow(0 0 10px rgba(255, 255, 255, 0.05))
      `;
      canvas.style.opacity = '0.2';
      // Reset z-index for non-spotlighted masks
      canvas.style.zIndex = '';
    }
  });
}

/**
 * Draw the source image onto a canvas using mask alpha as cutout
 * Creates true spotlight effect - shows actual image through mask region
 *
 * The canvas is sized to the bbox dimensions and positioned at bbox location.
 * We must draw only the corresponding portion of the source image.
 */
function applyImageCutout(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  alphaData: ImageData,
  bbox: { x: number; y: number; w: number; h: number }
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw only the bbox portion of the source image
  ctx.drawImage(
    img,
    bbox.x, bbox.y, bbox.w, bbox.h,  // source rect (in image coordinates)
    0, 0, canvas.width, canvas.height  // dest rect (fill canvas)
  );

  // Use mask alpha to cut out the shape
  // IMPORTANT: putImageData ignores globalCompositeOperation, so we must use drawImage
  ctx.globalCompositeOperation = 'destination-in';

  // Create temp canvas with alpha mask, then draw it (drawImage respects compositing)
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = alphaData.width;
  tempCanvas.height = alphaData.height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(alphaData, 0, 0);

  // Draw the alpha mask using drawImage (respects composite operation)
  ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);

  // Reset composite operation
  ctx.globalCompositeOperation = 'source-over';
}
