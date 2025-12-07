/**
 * Mask Interaction Handler
 *
 * Core mask interaction functionality: positioning, hover detection, selection,
 * and keyboard shortcuts.
 */

import type { MaskOverlayState, CachedMask } from './types';

/**
 * Position all mask elements based on image dimensions
 * Scales mask positions from natural image size to display size
 */
export function positionMasks(
  container: HTMLElement,
  imageWidth: number,
  imageHeight: number
): void {
  const img = document.getElementById('editor-image') as HTMLImageElement | null;
  if (!img) return;

  const displayWidth = img.clientWidth;
  const displayHeight = img.clientHeight;
  const naturalWidth = img.naturalWidth || imageWidth || displayWidth;
  const naturalHeight = img.naturalHeight || imageHeight || displayHeight;

  // Scale factor from original image to displayed size
  const scaleX = displayWidth / naturalWidth;
  const scaleY = displayHeight / naturalHeight;

  // Position each mask element
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
  masks.forEach((mask: HTMLElement) => {
    const x = parseFloat(mask.dataset.bboxX || '0') || 0;
    const y = parseFloat(mask.dataset.bboxY || '0') || 0;
    const w = parseFloat(mask.dataset.bboxW || '0') || 0;
    const h = parseFloat(mask.dataset.bboxH || '0') || 0;

    // Scale to display coordinates
    mask.style.left = `${x * scaleX}px`;
    mask.style.top = `${y * scaleY}px`;
    mask.style.width = `${w * scaleX}px`;
    mask.style.height = `${h * scaleY}px`;
  });
}

/**
 * Attach hover and click event listeners to all mask elements
 */
export function attachMaskListeners(
  container: HTMLElement,
  state: MaskOverlayState,
  maskImageCache: Map<string, CachedMask>,
  callbacks: {
    onHoverChange: (maskId: string | null) => void,
    onSelect: (maskId: string, shift: boolean) => void,
    updateHighlight: () => void
  }
): void {
  const masks = container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

  masks.forEach((mask: HTMLElement) => {
    const maskId = mask.dataset.maskId || '';
    const maskType = mask.dataset.maskType;
    const isSegment = maskType === 'object' || maskType === 'manual';

    // Remove old listeners (in case of re-render)
    mask.onmouseenter = null;
    mask.onmouseleave = null;
    mask.onmousemove = null;
    mask.onclick = null;

    if (isSegment) {
      // For segments, check if cursor is over actual mask pixels
      mask.onmousemove = (e: MouseEvent) => {
        if (state.segmentMode) return;
        const isOverMask = isPointOverSegmentMask(maskId, e, mask, maskImageCache);
        if (isOverMask && state.hoveredMaskId !== maskId) {
          state.hoveredMaskId = maskId;
          callbacks.onHoverChange(maskId);
          callbacks.updateHighlight();
        } else if (!isOverMask && state.hoveredMaskId === maskId) {
          state.hoveredMaskId = null;
          callbacks.onHoverChange(null);
          callbacks.updateHighlight();
        }
      };

      mask.onmouseleave = () => {
        if (state.segmentMode) return;
        if (state.hoveredMaskId === maskId) {
          state.hoveredMaskId = null;
          callbacks.onHoverChange(null);
          callbacks.updateHighlight();
        }
      };
    } else {
      // For text regions, use simple bounding box hover
      mask.onmouseenter = () => {
        if (state.segmentMode) return;
        state.hoveredMaskId = maskId;
        callbacks.onHoverChange(maskId);
        callbacks.updateHighlight();
      };

      mask.onmouseleave = () => {
        if (state.segmentMode) return;
        if (state.hoveredMaskId === maskId) {
          state.hoveredMaskId = null;
          callbacks.onHoverChange(null);
          callbacks.updateHighlight();
        }
      };
    }

    // Click handler - for segments, also check mask pixels
    mask.onclick = (e: MouseEvent) => {
      if (state.segmentMode) return;

      // For segments, only register click if over actual mask
      if (isSegment && !isPointOverSegmentMask(maskId, e, mask, maskImageCache)) {
        return; // Don't stop propagation - let click pass through
      }

      e.stopPropagation();
      const shift = e.shiftKey;

      // Update local selection state
      if (shift) {
        // Shift+click: toggle mask in/out of selection
        if (state.selectedMaskIds.has(maskId)) {
          state.selectedMaskIds.delete(maskId);
        } else {
          state.selectedMaskIds.add(maskId);
        }
      } else {
        // Regular click: toggle if already the only selected, otherwise select exclusively
        if (state.selectedMaskIds.size === 1 && state.selectedMaskIds.has(maskId)) {
          state.selectedMaskIds = new Set(); // Deselect
        } else {
          state.selectedMaskIds = new Set([maskId]); // Select exclusively
        }
      }

      // Notify via callback
      callbacks.onSelect(maskId, shift);
      callbacks.updateHighlight();
    };
  });
}

/**
 * Check if a point is over an opaque pixel of a segment mask
 * Uses pre-computed alpha data for pixel-perfect hit testing
 */
export function isPointOverSegmentMask(
  maskId: string,
  event: MouseEvent,
  maskElement: HTMLElement,
  maskImageCache: Map<string, CachedMask>
): boolean {
  const cached = maskImageCache.get(maskId);
  if (!cached) {
    // Cache not loaded yet - fall back to bbox detection
    return true;
  }

  const { alphaData } = cached;

  // Get mouse position relative to the mask element
  const rect = maskElement.getBoundingClientRect();
  const displayX = event.clientX - rect.left;
  const displayY = event.clientY - rect.top;

  // Convert from display coordinates to alpha data coordinates
  const scaleX = alphaData.width / rect.width;
  const scaleY = alphaData.height / rect.height;
  const dataX = Math.floor(displayX * scaleX);
  const dataY = Math.floor(displayY * scaleY);

  // Check bounds
  if (dataX < 0 || dataX >= alphaData.width || dataY < 0 || dataY >= alphaData.height) {
    return false;
  }

  // Get alpha value from pre-computed data
  const pixelIndex = (dataY * alphaData.width + dataX) * 4;
  const alpha = alphaData.data[pixelIndex + 3];

  // Consider "over mask" if alpha is above threshold
  return alpha > 10;
}

/**
 * Create keyboard event handler with configurable callbacks
 * Handles shortcuts: Enter, Escape, Cmd+Z, Cmd+Shift+Z, Backspace, Delete
 */
export function createKeyboardHandler(
  state: MaskOverlayState,
  callbacks: {
    onInpaint: () => void,
    onDeselect: () => void,
    onUndo: () => void,
    onRedo: () => void,
    onConfirmSegment: () => void,
    onDelete: () => void,
    updateHighlight: () => void
  }
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Only handle if no input is focused
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    // If there's a preview canvas (candidate mask), handle Enter/Escape
    if (state.previewMaskCanvas && !state.segmentMode) {
      if (e.key === 'Enter') {
        e.preventDefault();
        callbacks.onConfirmSegment();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        // Cancel the candidate mask - remove preview
        if (state.previewMaskCanvas) {
          state.previewMaskCanvas.remove();
          state.previewMaskCanvas = null;
        }
        state.lastMaskData = null;
        callbacks.updateHighlight();
        return;
      }
    }

    // In segment mode, only Escape exits (Command key release handles confirm)
    if (state.segmentMode) {
      // Escape exits segment mode without confirming
      if (e.key === 'Escape') {
        e.preventDefault();
        callbacks.onDeselect(); // This will trigger exitSegmentMode via the hook
        return;
      }

      return; // Don't process other keys in segment mode
    }

    // Enter = inpaint selected
    if (e.key === 'Enter' && state.selectedMaskIds.size > 0) {
      e.preventDefault();
      callbacks.onInpaint();
    }

    // Escape = deselect all
    if (e.key === 'Escape') {
      e.preventDefault();
      callbacks.onDeselect();
    }

    // Delete or Backspace = remove selected masks
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedMaskIds.size > 0) {
      e.preventDefault();
      callbacks.onDelete();
    }

    // Cmd+Z (Mac) or Ctrl+Z (Win) = undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      callbacks.onUndo();
    }

    // Cmd+Shift+Z (Mac) or Ctrl+Shift+Z (Win) = redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      callbacks.onRedo();
    }
  };
}
