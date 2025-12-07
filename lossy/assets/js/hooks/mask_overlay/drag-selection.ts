/**
 * Drag Selection Handler
 *
 * Marquee/rubber-band selection functionality for masks.
 * Handles drag-to-select with visual feedback and multi-select support.
 */

import type { MaskOverlayState, DragRect } from './types';
import { isSmartSelectActive } from './smart-select-mode';

function getMarqueeHost(container: HTMLElement): HTMLElement {
  const jsContainer = document.getElementById('js-overlay-container');
  if (jsContainer && container.contains(jsContainer)) {
    return jsContainer;
  }

  return container;
}

function ensureDragRect(container: HTMLElement, current: HTMLDivElement | null): HTMLDivElement {
  const host = getMarqueeHost(container);

  if (current && current.isConnected) {
    if (current.parentElement !== host) {
      host.appendChild(current);
    }
    return current;
  }

  return createDragRect(host);
}

/**
 * Create the rubber band selection rectangle element
 */
export function createDragRect(host: HTMLElement): HTMLDivElement {
  const rect = document.createElement('div');
  rect.className = 'drag-selection-rect';
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
 * Start drag selection on mousedown
 * Initializes drag state and creates rubber band if needed
 */
export function startDrag(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState
): void {
  if (event.button !== 0) return;  // Left click only

  // In Smart Select, don't handle drag (brush strokes instead)
  if (isSmartSelectActive(state.smartSelectCtx)) return;

  // DEFENSIVE: If Smart Select artifacts exist but the mode is off, clean them up
  // This prevents stuck state from breaking marquee
  if (!isSmartSelectActive(state.smartSelectCtx) && container.classList.contains('smart-select-mode')) {
    console.warn('[DragSelection] Detected stuck smart-select-mode class, cleaning up');
    container.classList.remove('smart-select-mode');
  }

  // Don't start drag on interactive elements (buttons, inputs, links, etc.)
  const target = event.target as HTMLElement;
  if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
      target.tagName === 'A' || target.closest('button, input, textarea, select, a')) {
    return;
  }

  // DEFENSIVE: Clean up any orphaned Smart Select DOM elements that might block interaction
  cleanupOrphanedSmartSelectElements();

  state.dragRect = ensureDragRect(container, state.dragRect);

  const containerRect = container.getBoundingClientRect();
  state.dragStart = {
    x: event.clientX - containerRect.left,
    y: event.clientY - containerRect.top
  };
  state.dragShift = event.shiftKey;
}

/**
 * Update drag selection on mousemove
 * Shows rubber band and previews which masks will be selected
 */
export function updateDrag(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState,
  callbacks: {
    getMasksInRect: (rect: DragRect) => string[],
    previewDragSelection: (ids: string[]) => void
  }
): void {
  // In Smart Select, don't handle drag
  if (isSmartSelectActive(state.smartSelectCtx)) return;

  if (!state.dragStart) return;

  const containerRect = container.getBoundingClientRect();
  const currentX = event.clientX - containerRect.left;
  const currentY = event.clientY - containerRect.top;

  // Calculate distance to check if we should start showing the rect
  const dx = currentX - state.dragStart.x;
  const dy = currentY - state.dragStart.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Minimum drag distance threshold to avoid accidental drags
  if (distance < 5 && !state.isDragging) return;

  state.isDragging = true;

  state.dragRect = ensureDragRect(container, state.dragRect);

  // Calculate rectangle bounds
  const left = Math.min(state.dragStart.x, currentX);
  const top = Math.min(state.dragStart.y, currentY);
  const width = Math.abs(currentX - state.dragStart.x);
  const height = Math.abs(currentY - state.dragStart.y);

  // Update rubber band position
  if (state.dragRect) {
    state.dragRect.style.left = `${left}px`;
    state.dragRect.style.top = `${top}px`;
    state.dragRect.style.width = `${width}px`;
    state.dragRect.style.height = `${height}px`;
    state.dragRect.style.display = 'block';
  }

  // Preview: highlight masks that intersect
  const rect: DragRect = { left, top, right: left + width, bottom: top + height };
  const intersecting = callbacks.getMasksInRect(rect);
  callbacks.previewDragSelection(intersecting);
}

/**
 * End drag selection on mouseup
 * Finalizes selection and cleans up drag state
 */
export function endDrag(
  event: MouseEvent,
  container: HTMLElement,
  state: MaskOverlayState,
  callbacks: {
    onDragSelect: (maskIds: string[], shift: boolean) => void,
    updateHighlight: () => void
  }
): void {
  // In Smart Select, don't handle drag
  if (isSmartSelectActive(state.smartSelectCtx)) return;

  if (!state.dragStart) return;

  if (state.isDragging) {
    const containerRect = container.getBoundingClientRect();
    const currentX = event.clientX - containerRect.left;
    const currentY = event.clientY - containerRect.top;

    const left = Math.min(state.dragStart.x, currentX);
    const top = Math.min(state.dragStart.y, currentY);
    const width = Math.abs(currentX - state.dragStart.x);
    const height = Math.abs(currentY - state.dragStart.y);

    const rect: DragRect = { left, top, right: left + width, bottom: top + height };
    const selected = getMasksInRect(container, rect);

    if (selected.length > 0) {
      // Update local selection
      if (state.dragShift) {
        selected.forEach((id: string) => state.selectedMaskIds.add(id));
      } else {
        state.selectedMaskIds = new Set(selected);
      }

      // Notify via callback
      callbacks.onDragSelect(selected, state.dragShift);
    }

    callbacks.updateHighlight();
  }

  // Reset drag state
  state.isDragging = false;
  state.dragStart = null;
  state.dragShift = false;
  state.dragIntersectingIds = new Set();
  state.dragRect = ensureDragRect(container, state.dragRect);
  state.dragRect.style.display = 'none';
}

/**
 * Get all masks that intersect with the drag rectangle
 */
export function getMasksInRect(
  container: HTMLElement,
  rect: DragRect
): string[] {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const containerRect = container.getBoundingClientRect();
  const result: string[] = [];

  masks.forEach((mask: HTMLElement) => {
    const maskRect = mask.getBoundingClientRect();

    // Convert to container-relative coordinates
    const maskLeft = maskRect.left - containerRect.left;
    const maskTop = maskRect.top - containerRect.top;
    const maskRight = maskLeft + maskRect.width;
    const maskBottom = maskTop + maskRect.height;

    // Check intersection (any overlap counts)
    if (!(rect.right < maskLeft || rect.left > maskRight ||
          rect.bottom < maskTop || rect.top > maskBottom)) {
      result.push(mask.dataset.maskId || '');
    }
  });

  return result;
}

/**
 * Preview drag selection by highlighting intersecting masks
 */
export function previewDragSelection(
  container: HTMLElement,
  intersectingIds: string[],
  selectedMaskIds: Set<string>,
  dragShift: boolean,
  dragIntersectingIds: Set<string>,
  updateSegmentMaskHighlightCallback: () => void
): void {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  const previewSet = new Set(intersectingIds);

  // Update drag intersecting IDs for segment mask hover effect
  dragIntersectingIds.clear();
  intersectingIds.forEach(id => dragIntersectingIds.add(id));

  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    const isIntersecting = previewSet.has(maskId);
    const isSelected = selectedMaskIds.has(maskId);

    mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

    if (isIntersecting || (dragShift && isSelected)) {
      mask.classList.add('mask-selected');
    } else {
      mask.classList.add('mask-dimmed');
    }
  });

  // Update segment mask canvas overlays
  updateSegmentMaskHighlightCallback();
}

/**
 * Clean up orphaned Smart Select DOM elements
 * This is a defensive mechanism to ensure marquee works even if Smart Select cleanup failed
 */
function cleanupOrphanedSmartSelectElements(): void {
  const jsContainer = document.getElementById('js-overlay-container');
  if (!jsContainer) return;

  // Remove any orphaned Smart Select elements (all possible artifacts)
  const orphans = jsContainer.querySelectorAll(
    '.smart-select-point-markers, .smart-select-preview-mask, .smart-select-spotlight-overlay, .smart-select-status-indicator'
  );
  if (orphans.length > 0) {
    console.warn(`[DragSelection] Cleaning up ${orphans.length} orphaned Smart Select elements`);
    orphans.forEach(el => el.remove());
  }
}

export function resetDragState(container: HTMLElement, state: MaskOverlayState): void {
  state.isDragging = false;
  state.dragStart = null;
  state.dragShift = false;
  state.dragIntersectingIds = new Set();
  state.dragRect = ensureDragRect(container, state.dragRect);
  state.dragRect.style.display = 'none';
}
