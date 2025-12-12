/**
 * Box Drag Core - Shared Box/Marquee Selection Logic
 *
 * Unified drag rectangle handling used by both:
 * - Normal mode marquee selection (drag-selection.ts)
 * - Smart Select box drag (smart-select-mode.ts)
 */

import { getZoomLevel } from './types';
import { getImageNaturalDimensions } from './utils';

// ============ Types ============

export interface BoxDragState {
  start: { x: number; y: number } | null;
  current: { x: number; y: number } | null;
  isDragging: boolean;
  rect: HTMLDivElement | null;
}

export interface BoxBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

// ============ Box Drag Element ============

/**
 * Create a drag rectangle element with consistent styling
 */
export function createBoxDragRect(host: HTMLElement, className: string = 'drag-selection-rect'): HTMLDivElement {
  const rect = document.createElement('div');
  rect.className = className;
  rect.style.cssText = `
    position: absolute;
    border: 2px dashed rgb(59, 130, 246);
    background: rgba(59, 130, 246, 0.15);
    pointer-events: none;
    display: none;
    z-index: 1000;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 10px rgba(59, 130, 246, 0.3);
  `;
  host.appendChild(rect);
  return rect;
}

/**
 * Update drag rectangle position and visibility
 */
export function updateBoxDragRect(
  rect: HTMLDivElement,
  bounds: BoxBounds,
  visible: boolean = true
): void {
  rect.style.left = `${bounds.left}px`;
  rect.style.top = `${bounds.top}px`;
  rect.style.width = `${bounds.width}px`;
  rect.style.height = `${bounds.height}px`;
  rect.style.display = visible ? 'block' : 'none';
}

/**
 * Hide drag rectangle
 */
export function hideBoxDragRect(rect: HTMLDivElement | null): void {
  if (rect) {
    rect.style.display = 'none';
  }
}

// ============ Coordinate Conversion ============

/**
 * Convert client coordinates to container-relative coordinates
 * Accounts for CSS zoom transforms
 */
export function clientToContainerCoords(
  clientX: number,
  clientY: number,
  container: HTMLElement,
  accountForZoom: boolean = true
): { x: number; y: number } {
  const containerRect = container.getBoundingClientRect();
  const zoom = accountForZoom ? getZoomLevel() : 1;

  return {
    x: (clientX - containerRect.left) / zoom,
    y: (clientY - containerRect.top) / zoom
  };
}

/**
 * Calculate box bounds from start and current positions
 */
export function calculateBoxBounds(
  start: { x: number; y: number },
  current: { x: number; y: number }
): BoxBounds {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const right = Math.max(start.x, current.x);
  const bottom = Math.max(start.y, current.y);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

/**
 * Calculate distance between two points
 */
export function getDistance(
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ============ Mask Finding ============

export interface MaskOverlapOptions {
  /** Minimum overlap ratio (0 = any intersection, 0.5 = 50% overlap required) */
  minOverlapRatio?: number;
  /** Whether to account for CSS zoom transforms */
  accountForZoom?: boolean;
  /** Image dimensions for coordinate conversion (for Smart Select) */
  imageWidth?: number;
  imageHeight?: number;
  /** Skip text regions */
  skipTextRegions?: boolean;
}

/**
 * Find masks that overlap with the given bounds.
 * Supports both intersection-based (normal marquee) and ratio-based (Smart Select) matching.
 */
export function findMasksInBounds(
  bounds: BoxBounds,
  container: HTMLElement,
  options: MaskOverlapOptions = {}
): string[] {
  const {
    minOverlapRatio = 0,
    accountForZoom = true,
    imageWidth,
    imageHeight,
    skipTextRegions = false
  } = options;

  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const containerRect = container.getBoundingClientRect();
  const zoom = accountForZoom ? getZoomLevel() : 1;
  const result: string[] = [];

  // If image dimensions provided, we need scale factors for dataset-based bbox
  let scaleX = 1;
  let scaleY = 1;
  if (imageWidth && imageHeight) {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      const imgRect = img.getBoundingClientRect();
      const { width: naturalWidth, height: naturalHeight } = getImageNaturalDimensions(
        img,
        imageWidth,
        imageHeight
      );
      scaleX = imgRect.width / naturalWidth;
      scaleY = imgRect.height / naturalHeight;
    }
  }

  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    if (!maskId) return;

    // Skip text regions if requested
    if (skipTextRegions) {
      const maskType = mask.dataset.maskType || 'manual';
      if (maskType === 'text') return;
    }

    let maskLeft: number, maskTop: number, maskRight: number, maskBottom: number;

    if (imageWidth && imageHeight) {
      // Use dataset bbox (image coordinates) converted to container coords
      const bboxX = parseFloat(mask.dataset.bboxX || '0');
      const bboxY = parseFloat(mask.dataset.bboxY || '0');
      const bboxW = parseFloat(mask.dataset.bboxW || '0');
      const bboxH = parseFloat(mask.dataset.bboxH || '0');

      if (bboxW <= 0 || bboxH <= 0) return;

      maskLeft = bboxX * scaleX;
      maskTop = bboxY * scaleY;
      maskRight = (bboxX + bboxW) * scaleX;
      maskBottom = (bboxY + bboxH) * scaleY;
    } else {
      // Use bounding client rect (for normal marquee)
      const maskRect = mask.getBoundingClientRect();
      maskLeft = (maskRect.left - containerRect.left) / zoom;
      maskTop = (maskRect.top - containerRect.top) / zoom;
      maskRight = maskLeft + maskRect.width / zoom;
      maskBottom = maskTop + maskRect.height / zoom;
    }

    // Check intersection
    const intersectLeft = Math.max(bounds.left, maskLeft);
    const intersectTop = Math.max(bounds.top, maskTop);
    const intersectRight = Math.min(bounds.right, maskRight);
    const intersectBottom = Math.min(bounds.bottom, maskBottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      // No intersection
      return;
    }

    if (minOverlapRatio > 0) {
      // Calculate overlap ratio
      const intersectArea = (intersectRight - intersectLeft) * (intersectBottom - intersectTop);
      const maskArea = (maskRight - maskLeft) * (maskBottom - maskTop);
      const overlapRatio = intersectArea / maskArea;

      if (overlapRatio >= minOverlapRatio) {
        result.push(maskId);
      }
    } else {
      // Any intersection counts
      result.push(maskId);
    }
  });

  return result;
}

// ============ Drag Threshold ============

/** Minimum distance to start box drag */
export const BOX_DRAG_THRESHOLD = 5;

/**
 * Check if drag distance exceeds threshold
 */
export function isDragThresholdMet(
  start: { x: number; y: number },
  current: { x: number; y: number }
): boolean {
  return getDistance(start, current) >= BOX_DRAG_THRESHOLD;
}
