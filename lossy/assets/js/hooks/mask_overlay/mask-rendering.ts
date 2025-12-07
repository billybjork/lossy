/**
 * Mask Rendering Engine
 *
 * Visual rendering of masks using canvas-based overlays.
 * Handles segment mask rendering, highlighting, and shimmer effects.
 */

import type { MaskOverlayState, CachedMask } from './types';
import { MASK_COLORS, HOVER_COLOR } from './types';
import { isSegmentModeActive } from './segment-mode';

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

  // Track color index assignment for new masks
  let nextColorIndex = maskImageCache.size;

  masks.forEach((mask: HTMLElement) => {
    const maskType = mask.dataset.maskType;
    const maskUrl = mask.dataset.maskUrl;
    const maskId = mask.dataset.maskId || '';

    // Render canvas overlays for object/manual segments with mask URLs
    if ((maskType !== 'object' && maskType !== 'manual') || !maskUrl) return;

    // Check if already rendered
    if (maskImageCache.has(maskId)) return;

    // Assign a color index for this mask
    const colorIndex = nextColorIndex % MASK_COLORS.length;
    nextColorIndex++;

    // Get bbox coordinates
    const bboxX = parseFloat(mask.dataset.bboxX || '0') || 0;
    const bboxY = parseFloat(mask.dataset.bboxY || '0') || 0;
    const bboxW = parseFloat(mask.dataset.bboxW || '0') || 0;
    const bboxH = parseFloat(mask.dataset.bboxH || '0') || 0;

    if (bboxW <= 0 || bboxH <= 0) return;

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

  // In segment mode, disable pointer events on all masks
  if (isSegmentModeActive(state.segmentCtx)) {
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
  if (isSegmentModeActive(state.segmentCtx)) {
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
      applyMaskWithOutline(maskId, maskImageCache, color.fill, color.stroke, 4);
      canvas.style.opacity = '1';
    } else if (isHovered) {
      // Hover: intense fill only, no border
      applyMaskFillOnly(maskId, maskImageCache, HOVER_COLOR.fill);
      canvas.style.opacity = '1';
    } else {
      // Idle: hidden
      canvas.style.opacity = '0';
    }
  });
}

/**
 * Trigger shimmer animation effect on masks
 * Shows a sweeping gradient effect when masks are first rendered
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
  const baseDuration = maskCount > 5 ? 400 : 600; // Speed up if many masks
  const staggerDelay = maskCount > 1 ? Math.min(80, 300 / maskCount) : 0; // Adaptive stagger

  const shimmerCanvases: HTMLCanvasElement[] = [];

  masksToShimmer.forEach(({ mask }, index) => {
    const maskType = mask.dataset.maskType;
    const delay = index * staggerDelay;

    // For text regions, use CSS shimmer with delay
    if (maskType !== 'object' && maskType !== 'manual') {
      setTimeout(() => {
        mask.classList.add('mask-shimmer');
        mask.style.animationDuration = `${baseDuration}ms`;
      }, delay);
      return;
    }

    // For object/manual segments, create canvas-based shimmer
    const maskUrl = mask.dataset.maskUrl;
    if (!maskUrl) return;

    const bboxX = parseFloat(mask.dataset.bboxX || '0') || 0;
    const bboxY = parseFloat(mask.dataset.bboxY || '0') || 0;
    const bboxW = parseFloat(mask.dataset.bboxW || '0') || 0;
    const bboxH = parseFloat(mask.dataset.bboxH || '0') || 0;
    if (bboxW <= 0 || bboxH <= 0) return;

    // Create shimmer canvas
    const shimmerCanvas = document.createElement('canvas');
    shimmerCanvas.className = 'segment-shimmer-canvas';
    shimmerCanvas.width = bboxW;
    shimmerCanvas.height = bboxH;
    shimmerCanvas.style.cssText = `
      position: absolute;
      left: 0; top: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 10;
    `;
    mask.appendChild(shimmerCanvas);
    shimmerCanvases.push(shimmerCanvas);

    // Load mask and animate with stagger delay
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';
    maskImg.onload = () => {
      // Wait for stagger delay before starting animation
      setTimeout(() => {
        const ctx = shimmerCanvas.getContext('2d')!;
        const duration = baseDuration;
        const startTime = performance.now();

        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);

          // Clear canvas
          ctx.clearRect(0, 0, bboxW, bboxH);

          // Draw the mask
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(maskImg, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);

          // Apply gradient with mask
          ctx.globalCompositeOperation = 'source-in';

          const gradientPos = -1 + (progress * 3);
          const centerX = gradientPos * bboxW;

          const angle = ((110 - 90) * Math.PI) / 180;
          const length = Math.max(bboxW, bboxH) * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          const gradient = ctx.createLinearGradient(
            centerX - cos * length / 2,
            -sin * length / 2,
            centerX + cos * length / 2,
            sin * length / 2
          );
          gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
          gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, bboxW, bboxH);

          // Fade out in last 25%
          if (progress > 0.75) {
            shimmerCanvas.style.opacity = String(1 - ((progress - 0.75) / 0.25));
          }

          if (progress < 1) {
            requestAnimationFrame(animate);
          }
        };

        requestAnimationFrame(animate);
      }, delay);
    };
    maskImg.src = maskUrl;
  });

  // Cleanup after all animations complete (last mask's delay + duration + buffer)
  const totalDuration = (maskCount - 1) * staggerDelay + baseDuration + 50;
  setTimeout(() => {
    masksToShimmer.forEach(({ mask }) => {
      const maskType = mask.dataset.maskType;
      if (maskType !== 'object' && maskType !== 'manual') {
        mask.style.borderColor = 'transparent';
        mask.style.outlineColor = 'transparent';
      }
      mask.classList.remove('mask-shimmer');
      mask.style.removeProperty('animation-duration');
    });

    shimmerCanvases.forEach(canvas => canvas.remove());

    setTimeout(() => {
      masksToShimmer.forEach(({ mask }) => {
        mask.style.removeProperty('border-color');
        mask.style.removeProperty('outline-color');
      });
    }, 200);
  }, totalDuration);
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

/**
 * Draw mask with just fill, no outline (for hover state)
 * Creates an intense highlight without borders
 */
function applyMaskFillOnly(
  maskId: string,
  maskImageCache: Map<string, CachedMask>,
  fillColor: string
): void {
  const cached = maskImageCache.get(maskId);
  if (!cached) return;

  const { canvas, alphaData } = cached;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(w * dpr));
  const targetH = Math.max(1, Math.round(h * dpr));

  // Scale mask to device pixel ratio to avoid aliasing on high-DPI screens
  const alphaTexture = buildAlphaTexture(alphaData, targetW, targetH);
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = targetW;
  fillCanvas.height = targetH;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.imageSmoothingEnabled = true;
  fillCtx.drawImage(alphaTexture, 0, 0);
  fillCtx.globalCompositeOperation = 'source-in';
  fillCtx.fillStyle = fillColor;
  fillCtx.fillRect(0, 0, targetW, targetH);

  // Clear canvas and reset state
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(fillCanvas, 0, 0, w, h);

  // Reset composite operation
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Draw mask with crisp colored outline and semi-transparent fill (Meta SAM style)
 * Creates proper stroke by: dilating mask → coloring → subtracting original → adding fill
 */
function applyMaskWithOutline(
  maskId: string,
  maskImageCache: Map<string, CachedMask>,
  fillColor: string,
  strokeColor: string,
  strokeWidth: number = 3
): void {
  const cached = maskImageCache.get(maskId);
  if (!cached) return;

  const { canvas, alphaData } = cached;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(w * dpr));
  const targetH = Math.max(1, Math.round(h * dpr));

  // Shared alpha texture scaled to device pixel ratio with slight feather
  const alphaTexture = buildAlphaTexture(alphaData, targetW, targetH);

  // Create stroke layer: dilated mask minus original = outline only
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
  strokeCtx.fillStyle = strokeColor;
  strokeCtx.fillRect(0, 0, targetW, targetH);

  // Create fill layer
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = targetW;
  fillCanvas.height = targetH;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.imageSmoothingEnabled = true;
  fillCtx.drawImage(alphaTexture, 0, 0);
  fillCtx.globalCompositeOperation = 'source-in';
  fillCtx.fillStyle = fillColor;
  fillCtx.fillRect(0, 0, targetW, targetH);

  // Composite final result back to display resolution
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(strokeCanvas, 0, 0, w, h);
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
      // For non-spotlighted masks: apply dim fill
      applyMaskFillOnly(maskId, maskImageCache, SPOTLIGHT_FILL_DIM);

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
