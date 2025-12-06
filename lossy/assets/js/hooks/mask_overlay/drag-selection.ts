/**
 * Drag Selection Handler
 *
 * Marquee/rubber-band selection functionality for masks.
 * Handles drag-to-select with visual feedback and multi-select support.
 */

import type { MaskOverlayState, DragRect } from './types';

/**
 * Create the rubber band selection rectangle element
 */
export function createDragRect(container: HTMLElement): HTMLDivElement {
  const rect = document.createElement('div');
  rect.className = 'drag-selection-rect';
  rect.style.cssText = `
    position: absolute;
    border: 1px dashed rgba(59, 130, 246, 0.8);
    background: rgba(59, 130, 246, 0.1);
    pointer-events: none;
    display: none;
    z-index: 1000;
  `;
  container.appendChild(rect);
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

  // In segment mode, don't handle drag (brush strokes instead)
  if (state.segmentMode) return;

  const containerRect = container.getBoundingClientRect();
  state.dragStart = {
    x: event.clientX - containerRect.left,
    y: event.clientY - containerRect.top
  };
  state.dragShift = event.shiftKey;

  // Create rubber band element if needed
  if (!state.dragRect) {
    state.dragRect = createDragRect(container);
  }
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
  // In segment mode, don't handle drag
  if (state.segmentMode) return;

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
  // In segment mode, don't handle drag
  if (state.segmentMode) return;

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
  if (state.dragRect) {
    state.dragRect.style.display = 'none';
  }
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
