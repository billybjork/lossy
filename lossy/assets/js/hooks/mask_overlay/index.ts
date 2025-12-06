/**
 * MaskOverlay Hook - Main Entry Point
 *
 * Phoenix LiveView hook for mask overlay interactions.
 * Orchestrates all mask-related functionality: rendering, selection, drag, and segmentation.
 *
 * Features:
 * - Hover/click detection on mask elements
 * - Multi-select with Shift+click
 * - Drag-to-select (marquee selection)
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z, Cmd hold for segment mode)
 * - Semi-transparent overlay rendering for object segments
 * - Cursor-based segmentation with Command key hold
 * - Local ML inference when extension is not available
 */

import type { Hook } from 'phoenix_live_view';
import { getInferenceProvider, isExtensionAvailable, type InferenceProvider } from '../../ml/inference-provider';
import type { MaskOverlayState, SegmentResponse, MaskData } from './types';
import * as Interaction from './mask-interaction';
import * as Rendering from './mask-rendering';
import * as DragSelection from './drag-selection';
import * as SegmentMode from './segment-mode';

// ============ Module-Level State ============
// Singleton state shared across all hook instances

let segmentRequestCounter = 0;
const pendingSegmentRequests = new Map<string, (result: SegmentResponse) => void>();
let inferenceProvider: InferenceProvider | null = null;
let providerInitPromise: Promise<InferenceProvider> | null = null;

// ============ Global Message Listener ============
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

// ============ Main Hook Export ============

export const MaskOverlay: Hook<MaskOverlayState, HTMLElement> = {
  mounted() {
    // Initialize state
    this.container = this.el;
    this.hoveredMaskId = null;
    this.selectedMaskIds = new Set();
    this.maskImageCache = new Map();
    this.pageLoadTime = Date.now();
    this.shimmerPlayed = false;
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;
    this.dragIntersectingIds = new Set();
    this.segmentMode = false;
    this.segmentModeViaSpacebar = false;
    this.spacebarHoverMode = false;
    this.awaitingMaskConfirmation = false;
    this.segmentPoints = [];
    this.previewMaskCanvas = null;
    this.lastMaskData = null;
    this.marchingAntsCanvas = null;
    this.marchingAntsAnimationId = null;
    this.pointMarkersContainer = null;
    this.cursorOverlay = null;
    this.segmentPending = false;
    this.documentId = this.el.dataset.documentId || '';
    this.embeddingsReady = false;
    this.brushSize = 20;
    this.currentStroke = [];
    this.strokeHistory = [];
    this.brushCanvas = null;
    this.isDrawingStroke = false;
    this.lastMousePosition = null;
    this.pendingSegmentConfirm = false;
    this.previousMaskIds = new Set();
    this.liveSegmentDebounceId = null;
    this.lastLiveSegmentRequestId = null;
    this.liveSegmentInProgress = false;
    this.lastLiveSegmentTime = 0;
    this.segmentModeCursorMoveHandler = null;
    this.segmentModeEnterHandler = null;
    this.segmentModeLeaveHandler = null;
    this.spotlightOverlay = null;
    this.spotlightedMaskId = null;

    // Get image dimensions
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
        Rendering.updateSegmentMaskSizes(this.container);
      });
      this.resizeObserver.observe(img);
    }

    // Attach event listeners to mask elements
    this.attachMaskListeners();

    // Drag selection listeners - use document to allow starting from outside image
    this.mouseDownHandler = (e: MouseEvent) => this.startDrag(e);
    this.mouseMoveHandler = (e: MouseEvent) => this.updateDrag(e);
    this.mouseUpHandler = (e: MouseEvent) => this.endDrag(e);
    document.addEventListener('mousedown', this.mouseDownHandler);
    document.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('mouseup', this.mouseUpHandler);

    // Track mouse position for immediate brush cursor display
    this.container.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    });

    // Container click handler for segment mode (capture phase)
    this.containerClickHandler = (e: MouseEvent) => this.handleContainerClick(e);
    this.container.addEventListener('click', this.containerClickHandler, true);

    // Keyboard events
    this.keydownHandler = Interaction.createKeyboardHandler(this as unknown as MaskOverlayState, {
      onInpaint: () => this.pushEvent("inpaint_selected", {}),
      onDeselect: () => {
        this.selectedMaskIds = new Set();
        this.hoveredMaskId = null;
        this.pushEvent("deselect_all", {});
        this.updateHighlight();
      },
      onDelete: () => {
        // Delete selected masks ephemerally (immediately clear from UI, server handles deletion)
        this.pushEvent("delete_selected", {});
        this.selectedMaskIds = new Set();
        this.hoveredMaskId = null;
        this.updateHighlight();
      },
      onUndo: () => this.pushEvent("undo", {}),
      onRedo: () => this.pushEvent("redo", {}),
      onToggleSegmentMode: () => this.toggleSegmentMode(),
      onRemoveLastStroke: () => this.removeLastStroke(),
      onConfirmSegment: () => this.confirmSegmentKeepPreview(),
      onAdjustBrushSize: (delta: number) => {
        this.brushSize = Math.max(5, Math.min(100, this.brushSize + delta));
        console.log(`[MaskOverlay] Brush size: ${this.brushSize}`);
      },
      updateHighlight: () => this.updateHighlight()
    });
    document.addEventListener('keydown', this.keydownHandler);

    // Command key handlers for cursor-based segment mode
    this.spaceKeydownHandler = async (e: KeyboardEvent) => {
      // Only handle if no input is focused
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      // Enter segment mode on Command key press
      if (e.key === 'Meta' && !this.segmentMode) {
        e.preventDefault();
        this.segmentModeViaSpacebar = true;
        this.spacebarHoverMode = true;
        await this.enterSegmentMode();

        // Immediately segment at current cursor position
        this.segmentAtCursorPosition();
      }
    };

    this.spaceKeyupHandler = async (e: KeyboardEvent) => {
      // On Command key release: exit hover mode but keep preview as "selected"
      // User must press Enter to confirm, or Escape to cancel
      if (e.key === 'Meta' && this.segmentMode && this.segmentModeViaSpacebar) {
        e.preventDefault();
        this.segmentModeViaSpacebar = false;
        this.spacebarHoverMode = false;

        if (this.previewMaskCanvas && this.lastMaskData) {
          // Exit segment mode UI but keep preview visible as "candidate"
          this.segmentMode = false;
          this.container.classList.remove('segment-mode');

          // Remove cursor overlay
          if (this.cursorOverlay) {
            this.cursorOverlay.remove();
            this.cursorOverlay = null;
          }

          // Keep previewMaskCanvas visible - it's now a "candidate" mask
          // User can press Enter to confirm or Escape to cancel
        } else {
          // No preview, just exit normally
          this.exitSegmentMode();
        }
      }
    };

    document.addEventListener('keydown', this.spaceKeydownHandler);
    document.addEventListener('keyup', this.spaceKeyupHandler);

    // Listen for mask updates from server
    this.handleEvent("masks_updated", ({ masks }: { masks: unknown[] }) => {
      const shouldShimmer = !this.shimmerPlayed &&
                            masks.length > 0 &&
                            (Date.now() - this.pageLoadTime) < 2500;

      if (shouldShimmer) {
        this.shimmerPlayed = true;
      }

      // Check if we're confirming a new segment
      const shouldShimmerNewSegment = this.pendingSegmentConfirm;
      if (shouldShimmerNewSegment) {
        this.pendingSegmentConfirm = false;
      }

      // If we were awaiting mask confirmation, clean up the preview now
      if (this.awaitingMaskConfirmation) {
        this.awaitingMaskConfirmation = false;
        if (this.previewMaskCanvas) {
          this.previewMaskCanvas.remove();
          this.previewMaskCanvas = null;
        }
        if (this.pointMarkersContainer) {
          this.pointMarkersContainer.innerHTML = '';
        }
      }

      // Clear local selection
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;

      // Masks are re-rendered by LiveView
      requestAnimationFrame(() => {
        this.positionMasks();
        this.renderSegmentMasks();
        this.attachMaskListeners();
        this.updateHighlight();

        if (shouldShimmer) {
          this.triggerShimmer();
        } else if (shouldShimmerNewSegment) {
          // Find the newly added mask(s)
          const currentMaskIds = new Set(
            Array.from(this.container.querySelectorAll('.mask-region'))
              .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
              .filter(id => id !== '')
          );

          const newMaskIds = new Set(
            Array.from(currentMaskIds).filter(id => !this.previousMaskIds.has(id))
          );

          if (newMaskIds.size > 0) {
            // Wait a bit for the segment mask canvas to be fully rendered
            setTimeout(() => {
              this.triggerShimmer(newMaskIds);
            }, 100);
          }
        }
      });
    });

    // Listen for explicit selection clear
    this.handleEvent("clear_selection", () => {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.updateHighlight();
    });

    // Initial highlight state
    this.updateHighlight();

    // Initialize inference provider
    this.initInferenceProvider();
  },

  async initInferenceProvider() {
    if (!providerInitPromise) {
      providerInitPromise = getInferenceProvider();
    }

    try {
      inferenceProvider = await providerInitPromise;
      console.log('[MaskOverlay] Inference provider ready:', isExtensionAvailable() ? 'extension' : 'local');

      // If using local provider, run auto text detection
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

    if (!img.complete) {
      await new Promise<void>(resolve => {
        img.addEventListener('load', () => resolve(), { once: true });
      });
    }

    // Check if regions already exist
    const existingMasks = this.container.querySelectorAll('.mask-region');
    if (existingMasks.length > 0) {
      console.log('[MaskOverlay] Skipping auto text detection - regions already exist');
      return;
    }

    console.log('[MaskOverlay] Running auto text detection...');

    try {
      const regions = await inferenceProvider!.detectText(img);
      if (regions.length > 0) {
        console.log(`[MaskOverlay] Detected ${regions.length} text regions`);
        this.pushEvent('detected_text_regions', { regions });
      } else {
        console.log('[MaskOverlay] No text regions detected');
      }
    } catch (error) {
      console.error('[MaskOverlay] Auto text detection failed:', error);
    }
  },

  updated() {
    this.positionMasks();
    this.attachMaskListeners();
    this.updateHighlight();
  },

  destroyed() {
    // IMPORTANT: Force exit segment mode if still active
    if (this.segmentMode) {
      console.warn('[MaskOverlay] Component destroying while in segment mode, forcing cleanup');
      SegmentMode.forceCleanupSegmentElements();
    }

    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.liveSegmentDebounceId) clearTimeout(this.liveSegmentDebounceId);

    // Remove all event listeners
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keydown', this.spaceKeydownHandler);
    document.removeEventListener('keyup', this.spaceKeyupHandler);
    document.removeEventListener('mousedown', this.mouseDownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);

    // Remove segment mode event listeners if they exist
    if (this.segmentModeCursorMoveHandler) {
      this.container.removeEventListener('mousemove', this.segmentModeCursorMoveHandler);
    }
    if (this.segmentModeEnterHandler) {
      this.container.removeEventListener('mouseenter', this.segmentModeEnterHandler);
    }
    if (this.segmentModeLeaveHandler) {
      this.container.removeEventListener('mouseleave', this.segmentModeLeaveHandler);
    }

    // Remove DOM elements
    if (this.dragRect) this.dragRect.remove();
    if (this.pointMarkersContainer) this.pointMarkersContainer.remove();
    if (this.previewMaskCanvas) this.previewMaskCanvas.remove();
    if (this.brushCanvas) this.brushCanvas.remove();
    if (this.cursorOverlay) this.cursorOverlay.remove();
    if (this.spotlightOverlay) this.spotlightOverlay.remove();
  },

  // ============ Delegated Methods ============

  positionMasks() {
    Interaction.positionMasks(this.container, this.imageWidth, this.imageHeight);
  },

  attachMaskListeners() {
    Interaction.attachMaskListeners(this.container, this as unknown as MaskOverlayState, this.maskImageCache, {
      onHoverChange: (_maskId: string | null) => {
        // Hover state already updated in attachMaskListeners
      },
      onSelect: (maskId: string, shift: boolean) => {
        this.pushEvent("select_region", { id: maskId, shift });
      },
      updateHighlight: () => this.updateHighlight()
    });
  },

  updateHighlight() {
    Rendering.updateHighlight(this.container, this as unknown as MaskOverlayState, () => this.updateSegmentMaskHighlight());
  },

  updateSegmentMaskHighlight() {
    Rendering.updateSegmentMaskHighlight(
      this.maskImageCache,
      this.selectedMaskIds,
      this.hoveredMaskId,
      this.dragIntersectingIds
    );
  },

  renderSegmentMasks() {
    Rendering.renderSegmentMasks(
      this.container,
      this.maskImageCache,
      this.imageWidth,
      this.imageHeight
    );
  },

  triggerShimmer(targetMaskIds?: Set<string>) {
    Rendering.triggerShimmer(this.container, this.maskImageCache, targetMaskIds);
  },

  // ============ Drag Selection ============

  startDrag(e: MouseEvent) {
    // In spacebar hover mode, don't start dragging - just update cursor position
    if (this.spacebarHoverMode) {
      return;
    }

    if (this.segmentMode) {
      this.startBrushStroke(e);
      return;
    }
    DragSelection.startDrag(e, this.container, this as unknown as MaskOverlayState);
  },

  updateDrag(e: MouseEvent) {
    // In spacebar hover mode, continuously update segmentation at cursor position
    if (this.spacebarHoverMode) {
      // Track which mask cursor is over for spotlight effect
      const maskId = this.findMaskUnderCursor(e.clientX, e.clientY);
      if (maskId !== this.spotlightedMaskId) {
        this.spotlightedMaskId = maskId;
        this.updateSpotlightHighlight();
      }

      // Update radial gradient position
      if (this.lastMousePosition) {
        SegmentMode.updateSpotlightPosition(
          this as unknown as MaskOverlayState,
          this.lastMousePosition.x,
          this.lastMousePosition.y
        );
      }

      this.segmentAtCursorPosition();
      return;
    }

    if (this.segmentMode && this.isDrawingStroke) {
      this.continueBrushStroke(e);
      return;
    }

    if (!this.segmentMode && this.dragStart) {
      DragSelection.updateDrag(e, this.container, this as unknown as MaskOverlayState, {
        getMasksInRect: (rect) => DragSelection.getMasksInRect(this.container, rect),
        previewDragSelection: (ids) => DragSelection.previewDragSelection(
          this.container,
          ids,
          this.selectedMaskIds,
          this.dragShift,
          this.dragIntersectingIds,
          () => this.updateSegmentMaskHighlight()
        )
      });
    }
  },

  endDrag(e: MouseEvent) {
    // In spacebar hover mode, don't handle drag end
    if (this.spacebarHoverMode) {
      return;
    }

    if (this.segmentMode && this.isDrawingStroke) {
      this.finishBrushStroke(e);
      return;
    }

    if (!this.segmentMode && this.dragStart) {
      DragSelection.endDrag(e, this.container, this as unknown as MaskOverlayState, {
        onDragSelect: (maskIds, shift) => {
          this.pushEvent("select_regions", { ids: maskIds, shift });
        },
        updateHighlight: () => this.updateHighlight()
      });
    }
  },

  // ============ Segment Mode ============

  async toggleSegmentMode() {
    if (this.segmentMode) {
      this.exitSegmentMode();
    } else {
      await this.enterSegmentMode();
    }
  },

  async enterSegmentMode() {
    await SegmentMode.enterSegmentMode(
      this.container,
      this as unknown as MaskOverlayState,
      () => inferenceProvider,
      isExtensionAvailable,
      {
        updateHighlight: () => this.updateHighlight(),
        pushEvent: (event, payload) => this.pushEvent(event, payload)
      }
    );
  },

  exitSegmentMode() {
    SegmentMode.exitSegmentMode(this.container, this as unknown as MaskOverlayState, {
      updateHighlight: () => this.updateHighlight(),
      pushEvent: (event, payload) => this.pushEvent(event, payload)
    });
  },

  handleContainerClick(e: MouseEvent) {
    if (this.segmentMode) {
      e.stopPropagation();
    }
  },

  startBrushStroke(e: MouseEvent) {
    SegmentMode.startBrushStroke(e, this.container, this as unknown as MaskOverlayState);
  },

  continueBrushStroke(e: MouseEvent) {
    SegmentMode.continueBrushStroke(
      e,
      this.container,
      this as unknown as MaskOverlayState,
      () => this.requestLiveSegmentFromCurrentStroke()
    );
  },

  finishBrushStroke(_e: MouseEvent) {
    SegmentMode.finishBrushStroke(this as unknown as MaskOverlayState, () => this.requestSegmentFromStrokes());
  },

  removeLastStroke() {
    SegmentMode.removeLastStroke(this as unknown as MaskOverlayState, {
      redrawAllStrokes: () => SegmentMode.redrawAllStrokes(this as unknown as MaskOverlayState),
      requestSegmentFromStrokes: () => this.requestSegmentFromStrokes()
    });
  },

  async requestSegmentFromStrokes() {
    await SegmentMode.requestSegmentFromStrokes(
      this as unknown as MaskOverlayState,
      () => inferenceProvider,
      isExtensionAvailable,
      pendingSegmentRequests,
      () => ++segmentRequestCounter
    );
  },

  async requestLiveSegmentFromCurrentStroke() {
    await SegmentMode.requestLiveSegmentFromCurrentStroke(
      this as unknown as MaskOverlayState,
      () => inferenceProvider,
      isExtensionAvailable,
      pendingSegmentRequests,
      () => ++segmentRequestCounter
    );
  },

  async confirmSegment() {
    await SegmentMode.confirmSegment(
      this as unknown as MaskOverlayState,
      () => inferenceProvider,
      isExtensionAvailable,
      pendingSegmentRequests,
      () => ++segmentRequestCounter,
      {
        pushEvent: (event, payload) => this.pushEvent(event, payload),
        exitSegmentMode: () => this.exitSegmentMode()
      }
    );
  },

  async confirmSegmentKeepPreview() {
    // Confirm segment but keep preview visible until server responds
    this.awaitingMaskConfirmation = true;
    await SegmentMode.confirmSegment(
      this as unknown as MaskOverlayState,
      () => inferenceProvider,
      isExtensionAvailable,
      pendingSegmentRequests,
      () => ++segmentRequestCounter,
      {
        pushEvent: (event, payload) => this.pushEvent(event, payload),
        // Don't exit segment mode - just clean up interaction state
        exitSegmentMode: () => {
          // Partial cleanup: remove brush UI but keep preview mask
          this.segmentMode = false;
          this.currentStroke = [];
          this.strokeHistory = [];
          this.isDrawingStroke = false;

          // Clear live segment state
          if (this.liveSegmentDebounceId !== null) {
            clearTimeout(this.liveSegmentDebounceId);
            this.liveSegmentDebounceId = null;
          }

          // Remove brush canvas and cursor
          if (this.brushCanvas) {
            this.brushCanvas.remove();
            this.brushCanvas = null;
          }
          if (this.cursorOverlay) {
            this.cursorOverlay.remove();
            this.cursorOverlay = null;
          }

          // Keep previewMaskCanvas visible!
          // It will be removed when masks_updated arrives

          this.container.classList.remove('segment-mode');
          this.pushEvent("exit_segment_mode", {});
        }
      }
    );
  },

  // Segment at current cursor position (for spacebar hover mode)
  segmentAtCursorPosition() {
    if (!this.spacebarHoverMode || !this.lastMousePosition) return;

    // Debounce segmentation requests
    if (this.liveSegmentDebounceId !== null) {
      clearTimeout(this.liveSegmentDebounceId);
    }

    this.liveSegmentDebounceId = window.setTimeout(async () => {
      this.liveSegmentDebounceId = null;

      // Convert display coordinates to image coordinates
      const coords = SegmentMode.getImageCoordinates(
        { clientX: this.lastMousePosition!.x + this.container.getBoundingClientRect().left,
          clientY: this.lastMousePosition!.y + this.container.getBoundingClientRect().top } as MouseEvent,
        this.container,
        this.imageWidth,
        this.imageHeight
      );

      if (!coords) return;

      // Create single point prompt at cursor position
      this.segmentPoints = [{
        x: coords.x,
        y: coords.y,
        label: 1
      }];

      // Request segmentation
      await this.requestSegmentFromPoints();
    }, 50); // 50ms debounce - fast response while preventing request spam
  },

  async requestSegmentFromPoints() {
    if (!this.documentId || this.segmentPoints.length === 0) return;

    // IMPORTANT: Track request ID for staleness detection
    // This prevents old requests from rendering after new ones (smooth scrubbing)
    const requestId = `seg_hover_${++segmentRequestCounter}_${Date.now()}`;
    this.lastLiveSegmentRequestId = requestId;

    try {
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      const actualWidth = img?.naturalWidth || this.imageWidth;
      const actualHeight = img?.naturalHeight || this.imageHeight;

      let response;
      const provider = inferenceProvider;

      if (provider && !isExtensionAvailable()) {
        const result = await provider.segmentAtPoints(
          this.documentId,
          this.segmentPoints as any,
          { width: actualWidth, height: actualHeight }
        );
        response = {
          success: true,
          mask_png: result.mask_png,
          bbox: result.bbox
        };
      } else {
        response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingSegmentRequests.delete(requestId);
            reject(new Error('Segment request timeout'));
          }, 5000);

          pendingSegmentRequests.set(requestId, (result: any) => {
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

      // CRITICAL: Only render if this is still the most recent request
      // Prevents flickering from old results rendering after newer ones
      if (this.lastLiveSegmentRequestId !== requestId) {
        console.log('[MaskOverlay] Discarding stale hover segment response');
        return;
      }

      if (response.success && (response.mask || response.mask_png)) {
        const maskData = response.mask || {
          mask_png: response.mask_png,
          bbox: response.bbox
        };
        SegmentMode.renderPreviewMask(maskData, this as unknown as MaskOverlayState);
      }
    } catch (error) {
      // Silent failure for hover mode - don't interrupt smooth scrubbing
      if (error.message !== 'Segment request timeout') {
        console.error('[MaskOverlay] Segment at cursor error:', error);
      }
    }
  },

  /**
   * Find which mask the cursor is currently over (for spotlight effect)
   * Uses pixel-perfect detection for segment masks, bbox for text regions
   */
  findMaskUnderCursor(clientX: number, clientY: number): string | null {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

    for (const mask of Array.from(masks)) {
      const maskId = mask.dataset.maskId || '';
      const maskType = mask.dataset.maskType;
      const rect = mask.getBoundingClientRect();

      // Check if cursor is within bounding box
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {

        // For segment masks, do pixel-perfect check
        if (maskType === 'object' || maskType === 'manual') {
          const event = { clientX, clientY } as MouseEvent;
          const isOver = Interaction.isPointOverSegmentMask(
            maskId, event, mask, this.maskImageCache
          );
          if (isOver) return maskId;
        } else {
          // Text regions: bbox collision is sufficient
          return maskId;
        }
      }
    }

    return null;
  },

  /**
   * Update spotlight highlight effects on masks during spacebar hover mode
   * Applies spotlight classes and updates segment mask canvas filters
   */
  updateSpotlightHighlight() {
    if (!this.spacebarHoverMode) return;

    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    masks.forEach((mask: HTMLElement) => {
      const maskId = mask.dataset.maskId || '';
      const isSpotlighted = maskId === this.spotlightedMaskId;

      // Remove all spotlight classes
      mask.classList.remove('mask-spotlighted', 'mask-spotlighted-idle');

      // Apply appropriate spotlight class
      if (isSpotlighted) {
        mask.classList.add('mask-spotlighted');
      } else {
        mask.classList.add('mask-spotlighted-idle');
      }
    });

    // Update segment mask canvases
    Rendering.updateSegmentMaskSpotlight(
      this.maskImageCache,
      this.spotlightedMaskId
    );
  }
};
