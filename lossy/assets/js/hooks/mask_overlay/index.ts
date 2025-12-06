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
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z, S for segment mode)
 * - Semi-transparent overlay rendering for object segments
 * - Click-to-segment mode with brush-based positive/negative points
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
    this.segmentPoints = [];
    this.previewMaskCanvas = null;
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

    // Drag selection listeners
    this.container.addEventListener('mousedown', (e: MouseEvent) => this.startDrag(e));
    this.mouseMoveHandler = (e: MouseEvent) => this.updateDrag(e);
    this.mouseUpHandler = (e: MouseEvent) => this.endDrag(e);
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
      onUndo: () => this.pushEvent("undo", {}),
      onRedo: () => this.pushEvent("redo", {}),
      onToggleSegmentMode: () => this.toggleSegmentMode(),
      onRemoveLastStroke: () => this.removeLastStroke(),
      onConfirmSegment: () => this.confirmSegment(),
      onAdjustBrushSize: (delta: number) => {
        this.brushSize = Math.max(5, Math.min(100, this.brushSize + delta));
        console.log(`[MaskOverlay] Brush size: ${this.brushSize}`);
      }
    });
    document.addEventListener('keydown', this.keydownHandler);

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
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.liveSegmentDebounceId) clearTimeout(this.liveSegmentDebounceId);
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.dragRect) this.dragRect.remove();
    if (this.pointMarkersContainer) this.pointMarkersContainer.remove();
    if (this.previewMaskCanvas) this.previewMaskCanvas.remove();
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
    if (this.segmentMode) {
      this.startBrushStroke(e);
      return;
    }
    DragSelection.startDrag(e, this.container, this as unknown as MaskOverlayState);
  },

  updateDrag(e: MouseEvent) {
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
  }
};
