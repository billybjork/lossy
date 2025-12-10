/**
 * EditorZoom hook - Command+scroll zoom functionality for the editor.
 *
 * Enables zooming when holding Command and scrolling outside the image:
 * - Only activates when cursor is OUTSIDE the image area when Command is pressed
 * - Once in zoom mode, zooming works even if cursor moves over the image
 * - Zooms the image centered (no panning)
 * - Tracks cursor position to coordinate with Smart Select
 * - Smooth CSS transitions for polished feel
 */

import type { Hook } from 'phoenix_live_view';

interface EditorZoomState {
  zoomLevel: number;
  editorFrame: HTMLElement | null;
  imageContainer: HTMLElement | null;
  lastMouseX: number;
  lastMouseY: number;
  zoomModeActive: boolean;
}

// Global state to coordinate with MaskOverlay's Smart Select
// Smart Select should only activate when cursor is over the image AND zoom mode is not active
declare global {
  interface Window {
    __editorZoomState?: {
      isCursorOverImage: boolean;
      zoomModeActive: boolean;
      zoomLevel: number;
    };
  }
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
// Zoom factor per scroll "tick" - ~3% per scroll step for gentler zoom
const ZOOM_FACTOR = 1.03;

export const EditorZoom: Hook<EditorZoomState, HTMLElement> = {
  mounted() {
    this.zoomLevel = 1;
    this.editorFrame = this.el.querySelector('.editor-frame');
    this.imageContainer = this.el.querySelector('.image-container');
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.zoomModeActive = false;

    // Initialize global state
    window.__editorZoomState = {
      isCursorOverImage: false,
      zoomModeActive: false,
      zoomLevel: 1
    };

    // Add CSS transition for smooth zoom
    if (this.imageContainer) {
      this.imageContainer.style.transition = 'transform 0.1s ease-out';
    }

    this.wheelHandler = (e: WheelEvent) => this.handleWheel(e);
    this.mouseMoveHandler = (e: MouseEvent) => this.handleMouseMove(e);
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeydown(e);
    this.keyupHandler = (e: KeyboardEvent) => this.handleKeyup(e);

    this.el.addEventListener('wheel', this.wheelHandler, { passive: false });
    document.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('keydown', this.keydownHandler);
    document.addEventListener('keyup', this.keyupHandler);
  },

  updated() {
    // Re-query elements after LiveView updates (DOM may have been replaced or morphed)
    const newImageContainer = this.el.querySelector('.image-container') as HTMLElement | null;

    if (newImageContainer) {
      // Update reference (may be same or different element)
      this.imageContainer = newImageContainer;
      this.editorFrame = this.el.querySelector('.editor-frame');

      // Always re-apply transition and zoom transform after LiveView updates
      // LiveView's DOM morphing may have stripped inline styles
      this.imageContainer.style.transition = 'transform 0.1s ease-out';
      this.applyTransform();
    }
  },

  destroyed() {
    this.el.removeEventListener('wheel', this.wheelHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keyup', this.keyupHandler);
    window.__editorZoomState = undefined;

    // Clean up transition style
    if (this.imageContainer) {
      this.imageContainer.style.transition = '';
    }
  },

  handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Meta' && !this.zoomModeActive) {
      // When Command is pressed, check cursor position to determine mode
      // If cursor is outside image, enter zoom mode
      if (!this.isCursorOverImage()) {
        this.zoomModeActive = true;
        if (window.__editorZoomState) {
          window.__editorZoomState.zoomModeActive = true;
        }
      }
    }
  },

  handleKeyup(e: KeyboardEvent) {
    if (e.key === 'Meta') {
      // Release zoom mode when Command is released
      this.zoomModeActive = false;
      if (window.__editorZoomState) {
        window.__editorZoomState.zoomModeActive = false;
      }
    }
  },

  handleMouseMove(e: MouseEvent) {
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    // Update global state for Smart Select coordination
    if (window.__editorZoomState) {
      window.__editorZoomState.isCursorOverImage = this.isCursorOverImage();
    }
  },

  handleWheel(e: WheelEvent) {
    if (!e.metaKey) return;
    if (!this.editorFrame || !this.imageContainer) return;

    // Allow zoom if zoom mode is active (Command pressed outside image)
    // OR if cursor is currently outside the image
    if (!this.zoomModeActive && this.isCursorOverImage()) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Normalize scroll delta across browsers/devices
    // Use sign of deltaY for direction, apply consistent zoom factor
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoomLevel * factor));

    if (newZoom === this.zoomLevel) return;

    this.zoomLevel = newZoom;
    if (window.__editorZoomState) {
      window.__editorZoomState.zoomLevel = newZoom;
    }
    this.applyTransform();
  },

  isCursorOverImage(): boolean {
    if (!this.imageContainer) return false;

    const imageRect = this.imageContainer.getBoundingClientRect();
    return (
      this.lastMouseX >= imageRect.left &&
      this.lastMouseX <= imageRect.right &&
      this.lastMouseY >= imageRect.top &&
      this.lastMouseY <= imageRect.bottom
    );
  },

  applyTransform() {
    if (!this.imageContainer) return;

    // Apply centered zoom transform
    if (this.zoomLevel === 1) {
      this.imageContainer.style.transform = '';
      this.imageContainer.style.transformOrigin = '';
    } else {
      this.imageContainer.style.transformOrigin = 'center center';
      this.imageContainer.style.transform = `scale(${this.zoomLevel})`;
    }

    // Scale background dot pattern to match zoom level so dots feel pinned to the image.
    // We need to adjust both size AND position because the image zooms from its center,
    // but the background pattern tiles from top-left by default.
    const baseSize = 24;
    const scaledSize = baseSize * this.zoomLevel;
    this.el.style.backgroundSize = `${scaledSize}px ${scaledSize}px`;

    // Calculate background position offset so dots stay aligned with the zoom center.
    // The viewport center stays fixed during zoom. At zoom=1, position is 0,0.
    // As we zoom, the pattern needs to expand outward from center, which means
    // shifting the origin by half the viewport size * (1 - zoomLevel).
    const viewportWidth = this.el.clientWidth;
    const viewportHeight = this.el.clientHeight;
    const offsetX = (viewportWidth / 2) * (1 - this.zoomLevel);
    const offsetY = (viewportHeight / 2) * (1 - this.zoomLevel);
    this.el.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  }
};