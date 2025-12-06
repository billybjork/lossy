/**
 * Mask Rendering Engine
 *
 * Visual rendering of masks using canvas-based overlays.
 * Handles segment mask rendering, highlighting, and shimmer effects.
 */

import type { MaskOverlayState, CachedMask } from './types';
import { MASK_COLORS, HOVER_COLOR } from './types';

/**
 * Render segment masks (type: 'object') as semi-transparent overlays
 * Creates canvas elements for each mask and caches them for performance
 */
export function renderSegmentMasks(
  container: HTMLElement,
  maskImageCache: Map<string, CachedMask>,
  imageWidth: number,
  imageHeight: number
): void {
  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

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

      // Cache canvas, alpha data, and color assignment
      maskImageCache.set(maskId, { canvas, alphaData, colorIndex });
    };

    maskImg.onerror = () => {
      console.warn('[MaskRendering] Failed to load mask image:', maskUrl);
    };

    maskImg.src = maskUrl;
  });
}

/**
 * Update segment mask canvas sizes on resize
 * Currently canvases auto-resize via CSS, but this hook exists for future needs
 */
export function updateSegmentMaskSizes(container: HTMLElement): void {
  const canvases = container.querySelectorAll('.segment-mask-canvas') as NodeListOf<HTMLCanvasElement>;
  canvases.forEach((_canvas: HTMLCanvasElement) => {
    // Force redraw if needed - currently CSS handles sizing
  });
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
  if (state.segmentMode) {
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
  if (state.segmentMode) {
    container.style.cursor = 'none';
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
      // Selected: colored fill + colored outline
      const color = MASK_COLORS[cached.colorIndex];
      applyMaskWithOutline(maskId, maskImageCache, color.fill, color.stroke, 3);
      canvas.style.opacity = '1';
    } else if (isHovered) {
      // Hover: white/neutral fill + white outline
      applyMaskWithOutline(maskId, maskImageCache, HOVER_COLOR.fill, HOVER_COLOR.stroke, 2);
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
 */
export function triggerShimmer(
  container: HTMLElement,
  maskImageCache: Map<string, CachedMask>
): void {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  if (masks.length === 0) return;

  const shimmerCanvases: HTMLCanvasElement[] = [];

  masks.forEach((mask: HTMLElement) => {
    const maskType = mask.dataset.maskType;

    // For text regions, use CSS shimmer
    if (maskType !== 'object' && maskType !== 'manual') {
      mask.classList.add('mask-shimmer');
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

    // Load mask and animate
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';
    maskImg.onload = () => {
      const ctx = shimmerCanvas.getContext('2d')!;
      const duration = 600;
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
    };
    maskImg.src = maskUrl;
  });

  // Cleanup after animation
  setTimeout(() => {
    masks.forEach((mask: HTMLElement) => {
      const maskType = mask.dataset.maskType;
      if (maskType !== 'object' && maskType !== 'manual') {
        mask.style.borderColor = 'transparent';
        mask.style.outlineColor = 'transparent';
      }
      mask.classList.remove('mask-shimmer');
    });

    shimmerCanvases.forEach(canvas => canvas.remove());

    setTimeout(() => {
      masks.forEach((mask: HTMLElement) => {
        mask.style.removeProperty('border-color');
        mask.style.removeProperty('outline-color');
      });
    }, 200);
  }, 650);
}

/**
 * Generate circular offsets for drawing stroke outline
 */
export function getStrokeOffsets(strokeWidth: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
    const dx = Math.round(Math.cos(angle) * strokeWidth);
    const dy = Math.round(Math.sin(angle) * strokeWidth);
    if (!offsets.some(([x, y]) => x === dx && y === dy)) {
      offsets.push([dx, dy]);
    }
  }
  return offsets;
}

/**
 * Draw mask with crisp colored outline and semi-transparent fill (Meta SAM style)
 * Creates proper stroke by: dilating mask → coloring → subtracting original → adding fill
 */
export function applyMaskWithOutline(
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

  // Create temp canvas for the original mask shape
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.putImageData(alphaData, 0, 0);

  // Create stroke layer: dilated mask minus original = outline only
  const strokeCanvas = document.createElement('canvas');
  strokeCanvas.width = w;
  strokeCanvas.height = h;
  const strokeCtx = strokeCanvas.getContext('2d')!;

  // Draw dilated mask
  const offsets = getStrokeOffsets(strokeWidth);
  for (const [dx, dy] of offsets) {
    strokeCtx.drawImage(maskCanvas, dx, dy);
  }

  // Cut out the original mask to leave only the stroke
  strokeCtx.globalCompositeOperation = 'destination-out';
  strokeCtx.drawImage(maskCanvas, 0, 0);

  // Apply stroke color
  strokeCtx.globalCompositeOperation = 'source-in';
  strokeCtx.fillStyle = strokeColor;
  strokeCtx.fillRect(0, 0, w, h);

  // Create fill layer
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = w;
  fillCanvas.height = h;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.putImageData(alphaData, 0, 0);
  fillCtx.globalCompositeOperation = 'source-in';
  fillCtx.fillStyle = fillColor;
  fillCtx.fillRect(0, 0, w, h);

  // Composite final result
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(strokeCanvas, 0, 0);
  ctx.drawImage(fillCanvas, 0, 0);
}
