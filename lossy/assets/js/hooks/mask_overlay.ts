/**
 * MaskOverlay Hook - Bounding Box and Segment Mask Selection
 *
 * Positions bounding box overlays on detected regions.
 * Renders segment masks (type: 'object') as semi-transparent colored overlays.
 *
 * Features:
 * - Hover/click detection on mask elements
 * - Multi-select with Shift+click
 * - Drag-to-select (marquee selection)
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z, S for segment mode)
 * - Semi-transparent overlay rendering for object segments
 * - Click-to-segment mode with positive/negative points
 * - Local ML inference when extension is not available
 */

import type { Hook } from 'phoenix_live_view';
import { getInferenceProvider, isExtensionAvailable, type InferenceProvider } from '../ml/inference-provider';
import type { PointPrompt, BoundingBox } from '../ml/types';

// Module-level state
let segmentRequestCounter = 0;
const pendingSegmentRequests = new Map<string, (result: SegmentResponse) => void>();
let inferenceProvider: InferenceProvider | null = null;
let providerInitPromise: Promise<InferenceProvider> | null = null;

interface SegmentResponse {
  success: boolean;
  mask?: MaskData;
  mask_png?: string;
  bbox?: BoundingBox;
  error?: string;
}

interface MaskData {
  mask_png: string;
  bbox: BoundingBox;
}

interface DragStart {
  x: number;
  y: number;
}

interface DragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface SegmentPoint {
  x: number;
  y: number;
  label: number;
}

interface MaskOverlayState {
  container: HTMLElement;
  hoveredMaskId: string | null;
  selectedMaskIds: Set<string>;
  maskImageCache: Map<string, HTMLCanvasElement>;
  pageLoadTime: number;
  shimmerPlayed: boolean;
  isDragging: boolean;
  dragStart: DragStart | null;
  dragRect: HTMLDivElement | null;
  dragShift: boolean;
  segmentMode: boolean;
  segmentPoints: SegmentPoint[];
  previewMaskCanvas: HTMLCanvasElement | null;
  pointMarkersContainer: HTMLDivElement | null;
  cursorOverlay: HTMLDivElement | null;
  segmentPending: boolean;
  documentId: string;
  embeddingsReady: boolean;
  imageWidth: number;
  imageHeight: number;
  resizeObserver: ResizeObserver | null;
  mouseMoveHandler: (e: MouseEvent) => void;
  mouseUpHandler: (e: MouseEvent) => void;
  containerClickHandler: (e: MouseEvent) => void;
  keydownHandler: (e: KeyboardEvent) => void;
}

// Listen for responses from the extension bridge
window.addEventListener('message', (event: MessageEvent) => {
  if (event.data.type === 'LOSSY_SEGMENT_RESPONSE') {
    const { requestId, success, mask, error } = event.data as {
      requestId: string;
      success: boolean;
      mask?: MaskData;
      error?: string;
    };
    const resolve = pendingSegmentRequests.get(requestId);
    if (resolve) {
      pendingSegmentRequests.delete(requestId);
      resolve({ success, mask, error });
    }
  }
});

export const MaskOverlay: Hook<MaskOverlayState, HTMLElement> = {
  mounted() {
    this.container = this.el;
    this.hoveredMaskId = null;
    this.selectedMaskIds = new Set();

    // Cache for loaded segment mask images
    this.maskImageCache = new Map();

    // Shimmer effect state
    this.pageLoadTime = Date.now();
    this.shimmerPlayed = false;

    // Drag selection state
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;  // Track if shift was held at drag start

    // Click-to-segment state
    this.segmentMode = false;
    this.segmentPoints = [];  // Array of { x, y, label } in image coordinates
    this.previewMaskCanvas = null;
    this.pointMarkersContainer = null;
    this.cursorOverlay = null;
    this.segmentPending = false;
    this.documentId = this.el.dataset.documentId || '';
    this.embeddingsReady = false;  // Whether SAM embeddings are computed for current image

    // Get image dimensions from data attributes
    this.imageWidth = parseInt(this.el.dataset.imageWidth || '0') || 0;
    this.imageHeight = parseInt(this.el.dataset.imageHeight || '0') || 0;

    // Initialize resize observer
    this.resizeObserver = null;

    // Position masks once image is loaded
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      if (img.complete) {
        this.positionMasks();
        this.renderSegmentMasks();
      } else {
        img.addEventListener('load', () => {
          this.positionMasks();
          this.renderSegmentMasks();
        });
      }

      // Reposition on resize
      this.resizeObserver = new ResizeObserver(() => {
        this.positionMasks();
        this.updateSegmentMaskSizes();
      });
      this.resizeObserver.observe(img);
    }

    // Attach event listeners to mask elements
    this.attachMaskListeners();

    // Drag selection listeners
    this.container.addEventListener('mousedown', (e: MouseEvent) => this.startDrag(e));
    this.mouseMoveHandler = (e: MouseEvent) => this.updateDrag(e);
    this.mouseUpHandler = (e: MouseEvent) => this.endDrag(e);
    document.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('mouseup', this.mouseUpHandler);

    // Container click handler for segment mode (capture phase fires BEFORE children)
    this.containerClickHandler = (e: MouseEvent) => this.handleContainerClick(e);
    this.container.addEventListener('click', this.containerClickHandler, true);

    // Keyboard events for shortcuts
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeydown(e);
    document.addEventListener('keydown', this.keydownHandler);

    // Listen for mask updates from server (e.g., after undo or inpainting)
    this.handleEvent("masks_updated", ({ masks }: { masks: unknown[] }) => {
      // Check shimmer eligibility before DOM updates
      const shouldShimmer = !this.shimmerPlayed &&
                            masks.length > 0 &&
                            (Date.now() - this.pageLoadTime) < 2500;

      if (shouldShimmer) {
        this.shimmerPlayed = true;
      }

      // Clear local selection to stay in sync with server state
      // Server clears selection on undo/inpaint completion
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;

      // Masks are re-rendered by LiveView, just reposition and reattach
      requestAnimationFrame(() => {
        this.positionMasks();
        this.renderSegmentMasks();
        this.attachMaskListeners();
        this.updateHighlight();

        // Trigger shimmer after masks are positioned
        if (shouldShimmer) {
          this.triggerShimmer();
        }
      });
    });

    // Listen for explicit selection clear from server
    this.handleEvent("clear_selection", () => {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.updateHighlight();
    });

    // Initial highlight state
    this.updateHighlight();

    // Initialize inference provider (extension or local)
    this.initInferenceProvider();
  },

  async initInferenceProvider() {
    // Only initialize once across all instances
    if (!providerInitPromise) {
      providerInitPromise = getInferenceProvider();
    }

    try {
      inferenceProvider = await providerInitPromise;
      console.log('[MaskOverlay] Inference provider ready:', isExtensionAvailable() ? 'extension' : 'local');

      // If using local provider (no extension), run auto text detection
      if (!isExtensionAvailable()) {
        this.runAutoTextDetection();
      }
    } catch (error) {
      console.error('[MaskOverlay] Failed to initialize inference provider:', error);
    }
  },

  async runAutoTextDetection() {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    // Wait for image to load
    if (!img.complete) {
      await new Promise<void>(resolve => {
        img.addEventListener('load', () => resolve(), { once: true });
      });
    }

    // Check if we already have detected regions (avoid re-running)
    const existingMasks = this.container.querySelectorAll('.mask-region');
    if (existingMasks.length > 0) {
      console.log('[MaskOverlay] Skipping auto text detection - regions already exist');
      return;
    }

    console.log('[MaskOverlay] Running auto text detection...');

    try {
      const regions = await inferenceProvider!.detectText(img);
      if (regions.length > 0) {
        console.log(`[MaskOverlay] Detected ${regions.length} text regions, sending to server`);
        this.pushEvent('detected_text_regions', { regions });
      } else {
        console.log('[MaskOverlay] No text regions detected');
      }
    } catch (error) {
      console.error('[MaskOverlay] Auto text detection failed:', error);
    }
  },

  updated() {
    // LiveView DOM patching may replace mask elements, losing event listeners.
    // Re-attach listeners and reposition after any server-triggered re-render.
    this.positionMasks();
    this.attachMaskListeners();
    this.updateHighlight();
  },

  destroyed() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.dragRect) this.dragRect.remove();
    if (this.pointMarkersContainer) this.pointMarkersContainer.remove();
    if (this.previewMaskCanvas) this.previewMaskCanvas.remove();
  },

  positionMasks() {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth || this.imageWidth || displayWidth;
    const naturalHeight = img.naturalHeight || this.imageHeight || displayHeight;

    // Scale factor from original image to displayed size
    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;

    // Position each mask element
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
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
  },

  attachMaskListeners() {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    masks.forEach((mask: HTMLElement) => {
      const maskId = mask.dataset.maskId || '';

      // Remove old listeners (in case of re-render)
      mask.onmouseenter = null;
      mask.onmouseleave = null;
      mask.onclick = null;

      // Hover handlers (guard for segment mode in case CSS fails)
      mask.onmouseenter = () => {
        if (this.segmentMode) return;
        this.hoveredMaskId = maskId;
        this.updateHighlight();
      };

      mask.onmouseleave = () => {
        if (this.segmentMode) return;
        if (this.hoveredMaskId === maskId) {
          this.hoveredMaskId = null;
          this.updateHighlight();
        }
      };

      // Click handler (guard for segment mode in case CSS fails)
      mask.onclick = (e: MouseEvent) => {
        if (this.segmentMode) return;
        e.stopPropagation();
        const shift = e.shiftKey;

        // Update local selection state
        if (shift) {
          if (this.selectedMaskIds.has(maskId)) {
            this.selectedMaskIds.delete(maskId);
          } else {
            this.selectedMaskIds.add(maskId);
          }
        } else {
          this.selectedMaskIds = new Set([maskId]);
        }

        // Push event to server
        this.pushEvent("select_region", { id: maskId, shift: shift });
        this.updateHighlight();
      };
    });
  },

  handleKeydown(e: KeyboardEvent) {
    // Only handle if no input is focused
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    // S = toggle segment mode
    if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      this.toggleSegmentMode();
      return;
    }

    // In segment mode, Enter confirms, Escape cancels, Backspace removes last point
    if (this.segmentMode) {
      if (e.key === 'Enter' && this.segmentPoints.length > 0) {
        e.preventDefault();
        this.confirmSegment();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this.exitSegmentMode();
        return;
      }

      if (e.key === 'Backspace' && this.segmentPoints.length > 0) {
        e.preventDefault();
        this.removeLastPoint();
        return;
      }

      return; // Don't process other keys in segment mode
    }

    // Enter = inpaint selected
    if (e.key === 'Enter' && this.selectedMaskIds.size > 0) {
      e.preventDefault();
      this.pushEvent("inpaint_selected", {});
    }

    // Escape = deselect all
    if (e.key === 'Escape') {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.pushEvent("deselect_all", {});
      this.updateHighlight();
    }

    // Cmd+Z (Mac) or Ctrl+Z (Win) = undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.pushEvent("undo", {});
    }

    // Cmd+Shift+Z (Mac) or Ctrl+Shift+Z (Win) = redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      this.pushEvent("redo", {});
    }
  },

  updateHighlight() {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    const hasSelection = this.selectedMaskIds.size > 0;
    const hasHover = this.hoveredMaskId !== null;

    // Don't update mask states in segment mode - they should stay dimmed
    if (!this.segmentMode) {
      masks.forEach((mask: HTMLElement) => {
        const maskId = mask.dataset.maskId || '';
        const isHovered = maskId === this.hoveredMaskId;
        const isSelected = this.selectedMaskIds.has(maskId);

        // Remove all state classes
        mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

        // Apply appropriate class
        if (isSelected) {
          mask.classList.add('mask-selected');
        } else if (isHovered) {
          mask.classList.add('mask-hovered');
        } else if (hasSelection || hasHover) {
          mask.classList.add('mask-dimmed');
        } else {
          mask.classList.add('mask-idle');
        }
      });
    }

    // Update cursor on container (always crosshair in segment mode)
    if (this.segmentMode) {
      this.container.style.cursor = 'crosshair';
    } else {
      this.container.style.cursor = hasHover ? 'pointer' : 'crosshair';
    }

    // Also update segment mask overlays
    this.updateSegmentMaskHighlight();
  },

  triggerShimmer() {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    if (masks.length === 0) return;

    // Add shimmer class to all masks
    masks.forEach((mask: HTMLElement) => mask.classList.add('mask-shimmer'));

    // Remove after animation completes
    setTimeout(() => {
      masks.forEach((mask: HTMLElement) => mask.classList.remove('mask-shimmer'));
    }, 650);
  },

  // Drag selection methods
  createDragRect(): HTMLDivElement {
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
    this.container.appendChild(rect);
    return rect;
  },

  startDrag(e: MouseEvent) {
    // Only start drag on container background, not on masks
    const target = e.target as HTMLElement;
    if (target.classList.contains('mask-region')) return;
    if (e.button !== 0) return;  // Left click only

    const containerRect = this.container.getBoundingClientRect();
    this.dragStart = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top
    };
    this.dragShift = e.shiftKey;

    // Create rubber band element if needed
    if (!this.dragRect) {
      this.dragRect = this.createDragRect();
    }
  },

  updateDrag(e: MouseEvent) {
    if (!this.dragStart) return;

    const containerRect = this.container.getBoundingClientRect();
    const currentX = e.clientX - containerRect.left;
    const currentY = e.clientY - containerRect.top;

    // Calculate distance to check if we should start showing the rect
    const dx = currentX - this.dragStart.x;
    const dy = currentY - this.dragStart.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Minimum drag distance threshold to avoid accidental drags
    if (distance < 5 && !this.isDragging) return;

    this.isDragging = true;

    // Calculate rectangle bounds
    const left = Math.min(this.dragStart.x, currentX);
    const top = Math.min(this.dragStart.y, currentY);
    const width = Math.abs(currentX - this.dragStart.x);
    const height = Math.abs(currentY - this.dragStart.y);

    // Update rubber band position
    if (this.dragRect) {
      this.dragRect.style.left = `${left}px`;
      this.dragRect.style.top = `${top}px`;
      this.dragRect.style.width = `${width}px`;
      this.dragRect.style.height = `${height}px`;
      this.dragRect.style.display = 'block';
    }

    // Preview: highlight masks that intersect
    const rect: DragRect = { left, top, right: left + width, bottom: top + height };
    const intersecting = this.getMasksInRect(rect);
    this.previewDragSelection(intersecting);
  },

  endDrag(e: MouseEvent) {
    if (!this.dragStart) return;

    if (this.isDragging) {
      const containerRect = this.container.getBoundingClientRect();
      const currentX = e.clientX - containerRect.left;
      const currentY = e.clientY - containerRect.top;

      const left = Math.min(this.dragStart.x, currentX);
      const top = Math.min(this.dragStart.y, currentY);
      const width = Math.abs(currentX - this.dragStart.x);
      const height = Math.abs(currentY - this.dragStart.y);

      const rect: DragRect = { left, top, right: left + width, bottom: top + height };
      const selected = this.getMasksInRect(rect);

      if (selected.length > 0) {
        // Update local selection
        if (this.dragShift) {
          selected.forEach((id: string) => this.selectedMaskIds.add(id));
        } else {
          this.selectedMaskIds = new Set(selected);
        }

        // Push to server
        this.pushEvent("select_regions", {
          ids: selected,
          shift: this.dragShift
        });
      }

      this.updateHighlight();
    }

    // Reset drag state
    this.isDragging = false;
    this.dragStart = null;
    this.dragShift = false;
    if (this.dragRect) {
      this.dragRect.style.display = 'none';
    }
  },

  getMasksInRect(rect: DragRect): string[] {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    const containerRect = this.container.getBoundingClientRect();
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
  },

  previewDragSelection(intersectingIds: string[]) {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    const previewSet = new Set(intersectingIds);

    masks.forEach((mask: HTMLElement) => {
      const maskId = mask.dataset.maskId || '';
      const isIntersecting = previewSet.has(maskId);
      const isSelected = this.selectedMaskIds.has(maskId);

      mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

      if (isIntersecting || (this.dragShift && isSelected)) {
        mask.classList.add('mask-selected');
      } else {
        mask.classList.add('mask-dimmed');
      }
    });
  },

  // Render segment masks (type: 'object') as semi-transparent overlays
  renderSegmentMasks() {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

    masks.forEach((mask: HTMLElement) => {
      const maskType = mask.dataset.maskType;
      const maskUrl = mask.dataset.maskUrl;
      const maskId = mask.dataset.maskId || '';

      // Only render canvas overlays for object segments with mask URLs
      if (maskType !== 'object' || !maskUrl) return;

      // Check if already rendered
      if (this.maskImageCache.has(maskId)) return;

      // Get bbox coordinates (mask PNG is full-image-resolution, we need to extract bbox portion)
      const bboxX = parseFloat(mask.dataset.bboxX || '0') || 0;
      const bboxY = parseFloat(mask.dataset.bboxY || '0') || 0;
      const bboxW = parseFloat(mask.dataset.bboxW || '0') || 0;
      const bboxH = parseFloat(mask.dataset.bboxH || '0') || 0;

      // Skip if bbox is invalid
      if (bboxW <= 0 || bboxH <= 0) return;

      // Load the mask image
      const maskImg = new Image();
      maskImg.crossOrigin = 'anonymous';

      maskImg.onload = () => {
        // Create canvas sized to the bbox (not full image)
        const canvas = document.createElement('canvas');
        canvas.className = 'segment-mask-canvas';
        canvas.dataset.maskId = maskId;
        canvas.width = bboxW;
        canvas.height = bboxH;

        // Draw only the bbox portion of the mask
        // drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)
        // This extracts the bbox region from the full-resolution mask
        const ctx = canvas.getContext('2d')!;

        // Enable high-quality image smoothing for soft edges
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(maskImg, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);

        // Use the mask as alpha channel and fill with color
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = 'rgba(59, 130, 246, 0.4)'; // Blue overlay
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Style the canvas
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = '0';
        canvas.style.transition = 'opacity 0.15s';
        canvas.style.filter = 'blur(0.5px)';  // Subtle blur for visual antialiasing

        // Position to fill the mask-region (which is already positioned at bbox)
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        // Insert canvas inside the mask div
        mask.appendChild(canvas);

        // Cache the canvas reference
        this.maskImageCache.set(maskId, canvas);
      };

      maskImg.onerror = () => {
        console.warn('Failed to load mask image:', maskUrl);
      };

      maskImg.src = maskUrl;
    });
  },

  // Update segment mask canvas sizes on resize
  updateSegmentMaskSizes() {
    // Canvases use 100% width/height of parent, so they auto-resize
    // This method exists for any additional resize logic if needed
    const canvases = this.container.querySelectorAll('.segment-mask-canvas') as NodeListOf<HTMLCanvasElement>;
    canvases.forEach((_canvas: HTMLCanvasElement) => {
      // Force redraw if needed - currently CSS handles sizing
    });
  },

  // Update highlight to include segment mask visibility
  updateSegmentMaskHighlight() {
    const hasSelection = this.selectedMaskIds.size > 0;
    const hasHover = this.hoveredMaskId !== null;

    this.maskImageCache.forEach((canvas: HTMLCanvasElement, maskId: string) => {
      const isHovered = maskId === this.hoveredMaskId;
      const isSelected = this.selectedMaskIds.has(maskId);

      if (isSelected) {
        canvas.style.opacity = '1';
        canvas.style.filter = 'brightness(1.2)';
      } else if (isHovered) {
        canvas.style.opacity = '1';
        canvas.style.filter = 'none';
      } else if (hasSelection || hasHover) {
        canvas.style.opacity = '0.3';
        canvas.style.filter = 'none';
      } else {
        canvas.style.opacity = '0';
        canvas.style.filter = 'none';
      }
    });
  },

  // ============ Click-to-Segment Methods ============

  toggleSegmentMode() {
    if (this.segmentMode) {
      this.exitSegmentMode();
    } else {
      this.enterSegmentMode();
    }
  },

  async enterSegmentMode() {
    this.segmentMode = true;
    this.segmentPoints = [];
    this.segmentPending = false;

    // Clear any mask selection
    this.selectedMaskIds = new Set();
    this.hoveredMaskId = null;

    // Update visual state
    this.container.classList.add('segment-mode');
    this.container.style.cursor = 'crosshair';

    // Dim existing masks
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    masks.forEach((mask: HTMLElement) => {
      mask.classList.add('mask-dimmed');
    });

    // Get the protected container that LiveView won't touch
    const jsContainer = document.getElementById('js-overlay-container');

    // Create point markers container
    if (!this.pointMarkersContainer && jsContainer) {
      this.pointMarkersContainer = document.createElement('div');
      this.pointMarkersContainer.className = 'segment-point-markers';
      this.pointMarkersContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 100;';
      jsContainer.appendChild(this.pointMarkersContainer);
    }

    // Create cursor overlay to force crosshair cursor in segment mode
    if (!this.cursorOverlay && jsContainer) {
      this.cursorOverlay = document.createElement('div');
      this.cursorOverlay.className = 'segment-cursor-overlay';
      this.cursorOverlay.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair !important; z-index: 150;';
      jsContainer.appendChild(this.cursorOverlay);
    }

    // Notify server
    this.pushEvent("enter_segment_mode", {});

    console.log('[MaskOverlay] Entered segment mode');

    // Pre-compute embeddings if using local provider and not already computed
    // Wait for provider to be ready if it's still initializing
    if (!inferenceProvider && providerInitPromise) {
      console.log('[MaskOverlay] Waiting for inference provider to initialize...');
      try {
        inferenceProvider = await providerInitPromise;
      } catch (error) {
        console.error('[MaskOverlay] Provider initialization failed:', error);
      }
    }

    if (inferenceProvider && !isExtensionAvailable() && !this.embeddingsReady) {
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      if (img && img.complete) {
        console.log('[MaskOverlay] Computing embeddings for segment mode...');
        try {
          await inferenceProvider.computeEmbeddings(this.documentId, img);
          this.embeddingsReady = true;
          console.log('[MaskOverlay] Embeddings ready');
        } catch (error) {
          console.error('[MaskOverlay] Failed to compute embeddings:', error);
        }
      }
    }
  },

  exitSegmentMode() {
    this.segmentMode = false;
    this.segmentPoints = [];
    this.segmentPending = false;

    // Update visual state (CSS restores pointer-events/cursor when .segment-mode is removed)
    this.container.classList.remove('segment-mode');

    // Clear point markers
    if (this.pointMarkersContainer) {
      this.pointMarkersContainer.innerHTML = '';
    }

    // Remove preview mask
    if (this.previewMaskCanvas) {
      this.previewMaskCanvas.remove();
      this.previewMaskCanvas = null;
    }

    // Remove cursor overlay
    if (this.cursorOverlay) {
      this.cursorOverlay.remove();
      this.cursorOverlay = null;
    }

    // Restore highlight state
    this.updateHighlight();

    // Notify server
    this.pushEvent("exit_segment_mode", {});

    console.log('[MaskOverlay] Exited segment mode');
  },

  handleContainerClick(e: MouseEvent) {
    // Only handle clicks in segment mode
    if (!this.segmentMode) return;

    // In segment mode, stop propagation so masks don't receive the click
    e.stopPropagation();

    // Don't place points if we were just dragging
    if (this.isDragging) return;

    // Get click coordinates relative to image
    const point = this.getImageCoordinates(e);
    if (!point) return;

    // Determine point label: Shift = negative (0), normal = positive (1)
    const label = e.shiftKey ? 0 : 1;

    this.addSegmentPoint(point.x, point.y, label);
  },

  getImageCoordinates(e: MouseEvent): { x: number; y: number } | null {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return null;

    const containerRect = this.container.getBoundingClientRect();
    const displayX = e.clientX - containerRect.left;
    const displayY = e.clientY - containerRect.top;

    // Convert from display coordinates to image coordinates
    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth || this.imageWidth;
    const naturalHeight = img.naturalHeight || this.imageHeight;

    const x = (displayX / displayWidth) * naturalWidth;
    const y = (displayY / displayHeight) * naturalHeight;

    return { x, y };
  },

  addSegmentPoint(x: number, y: number, label: number) {
    this.segmentPoints.push({ x, y, label });
    this.renderPointMarkers();

    // Request segmentation from extension
    this.requestSegment();
  },

  removeLastPoint() {
    if (this.segmentPoints.length === 0) return;

    this.segmentPoints.pop();
    this.renderPointMarkers();

    if (this.segmentPoints.length > 0) {
      this.requestSegment();
    } else {
      // No points left, clear preview
      if (this.previewMaskCanvas) {
        this.previewMaskCanvas.remove();
        this.previewMaskCanvas = null;
      }
    }
  },

  renderPointMarkers() {
    if (!this.pointMarkersContainer) return;

    // Clear existing markers
    this.pointMarkersContainer.innerHTML = '';

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth || this.imageWidth;
    const naturalHeight = img.naturalHeight || this.imageHeight;

    this.segmentPoints.forEach((pt: SegmentPoint) => {
      // Convert image coordinates to display coordinates
      const displayX = (pt.x / naturalWidth) * displayWidth;
      const displayY = (pt.y / naturalHeight) * displayHeight;

      const marker = document.createElement('div');
      marker.className = `segment-point-marker ${pt.label === 1 ? 'positive' : 'negative'}`;
      marker.style.cssText = `
        position: absolute;
        left: ${displayX}px;
        top: ${displayY}px;
        width: 16px;
        height: 16px;
        margin-left: -8px;
        margin-top: -8px;
        border-radius: 50%;
        border: 2px solid white;
        background: ${pt.label === 1 ? '#22c55e' : '#ef4444'};
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: bold;
        color: white;
        pointer-events: none;
      `;
      marker.textContent = pt.label === 1 ? '+' : '-';

      this.pointMarkersContainer!.appendChild(marker);
    });
  },

  async requestSegment() {
    if (this.segmentPoints.length === 0) return;
    if (!this.documentId) {
      console.warn('[MaskOverlay] No document ID for segmentation');
      return;
    }

    this.segmentPending = true;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    const actualWidth = img?.naturalWidth || this.imageWidth;
    const actualHeight = img?.naturalHeight || this.imageHeight;

    try {
      let response: SegmentResponse;

      // Use inference provider if available
      if (inferenceProvider && !isExtensionAvailable()) {
        const result = await inferenceProvider.segmentAtPoints(
          this.documentId,
          this.segmentPoints as PointPrompt[],
          { width: actualWidth, height: actualHeight }
        );
        response = {
          success: true,
          mask_png: result.mask_png,
          bbox: result.bbox
        };
      } else {
        // Fall back to extension via postMessage
        const requestId = `seg_${++segmentRequestCounter}`;
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
            documentId: this.documentId,
            points: this.segmentPoints,
            imageSize: { width: actualWidth, height: actualHeight },
            requestId
          }, '*');
        });
      }

      if (response.success && (response.mask || response.mask_png)) {
        // Normalize response format (provider returns mask_png directly, extension wraps in mask)
        const maskData: MaskData = response.mask || {
          mask_png: response.mask_png!,
          bbox: response.bbox!
        };
        this.renderPreviewMask(maskData);
      } else {
        console.warn('[MaskOverlay] Segment request failed:', response.error);
      }
    } catch (error) {
      console.error('[MaskOverlay] Segment request error:', error);
    } finally {
      this.segmentPending = false;
    }
  },

  renderPreviewMask(maskData: MaskData) {
    // Remove old preview
    if (this.previewMaskCanvas) {
      this.previewMaskCanvas.remove();
    }

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    // Create canvas for preview mask
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

    // Canvas size matches display size (will be stretched to fit)
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;

    const ctx = canvas.getContext('2d')!;

    // Load the mask PNG
    const maskImg = new Image();
    maskImg.onload = () => {
      // Check if we're still in segment mode (async load may complete after exit)
      if (!this.segmentMode) {
        return;
      }

      // Draw mask scaled to canvas size
      ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);

      // Apply blue tint using composite operation
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.5)'; // Blue with transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Insert before point markers if it's still in the DOM, otherwise just append
      if (this.pointMarkersContainer && this.pointMarkersContainer.parentNode === this.container) {
        this.container.insertBefore(canvas, this.pointMarkersContainer);
      } else {
        this.container.appendChild(canvas);
      }
      this.previewMaskCanvas = canvas;
    };

    maskImg.onerror = () => {
      console.warn('[MaskOverlay] Failed to load preview mask');
    };

    // mask_png is a data URL
    maskImg.src = maskData.mask_png;
  },

  async confirmSegment() {
    if (this.segmentPoints.length === 0) return;
    if (!this.documentId) {
      console.warn('[MaskOverlay] No document ID for segment confirmation');
      return;
    }

    this.segmentPending = true;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    const actualWidth = img?.naturalWidth || this.imageWidth;
    const actualHeight = img?.naturalHeight || this.imageHeight;

    try {
      let response: SegmentResponse;

      // Use inference provider if available
      if (inferenceProvider && !isExtensionAvailable()) {
        const result = await inferenceProvider.segmentAtPoints(
          this.documentId,
          this.segmentPoints as PointPrompt[],
          { width: actualWidth, height: actualHeight }
        );
        response = {
          success: true,
          mask_png: result.mask_png,
          bbox: result.bbox
        };
      } else {
        // Fall back to extension via postMessage
        const requestId = `seg_confirm_${++segmentRequestCounter}`;
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
            documentId: this.documentId,
            points: this.segmentPoints,
            imageSize: { width: actualWidth, height: actualHeight },
            requestId
          }, '*');
        });
      }

      // Normalize response format
      const maskPng = response.mask?.mask_png || response.mask_png;
      const bbox = response.mask?.bbox || response.bbox;
      if (response.success && maskPng) {
        // Send the mask PNG and bbox to the server to save
        this.pushEvent("confirm_segment", {
          mask_png: maskPng,
          bbox: bbox
        });

        console.log('[MaskOverlay] Segment confirmed and sent to server');
      } else {
        console.error('[MaskOverlay] Failed to get final mask:', response.error);
      }
    } catch (error) {
      console.error('[MaskOverlay] Confirm segment error:', error);
    } finally {
      this.segmentPending = false;
      // Exit segment mode
      this.exitSegmentMode();
    }
  }
};
