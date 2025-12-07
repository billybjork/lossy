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
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z)
 * - Semi-transparent overlay rendering for object segments
 * - Command-key segment mode with point-based selection
 * - Local ML inference when extension is not available
 */

import type { Hook } from 'phoenix_live_view';
import { getInferenceProvider, isExtensionAvailable, type InferenceProvider } from '../../ml/inference-provider';
import type { MaskOverlayState, SegmentResponse, MaskData } from './types';
import * as Interaction from './mask-interaction';
import * as Rendering from './mask-rendering';
import * as DragSelection from './drag-selection';
import * as SegmentMode from './segment-mode';
import { debugLog } from './utils';

// ============ Segment Mode Trigger Key ============
const SEGMENT_MODE_TRIGGER_KEY = 'Meta';

function isSegmentModeTrigger(e: KeyboardEvent): boolean {
  return e.key === SEGMENT_MODE_TRIGGER_KEY;
}

// ============ Module-Level State ============
let segmentRequestCounter = 0;
const pendingSegmentRequests = new Map<string, (result: SegmentResponse) => void>();
let inferenceProvider: InferenceProvider | null = null;
let providerInitPromise: Promise<InferenceProvider> | null = null;

// ============ Global Message Listener ============
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
    this.awaitingMaskConfirmation = false;
    this.segmentPoints = [];
    this.previewMaskCanvas = null;
    this.lastMaskData = null;
    this.pointMarkersContainer = null;
    this.segmentPending = false;
    this.spotlightOverlay = null;
    this.spotlightedMaskId = null;
    this.documentId = this.el.dataset.documentId || '';
    this.embeddingsReady = false;
    this.lastMousePosition = null;
    this.pendingSegmentConfirm = false;
    this.previousMaskIds = new Set();
    this.liveSegmentDebounceId = null;
    this.lastLiveSegmentRequestId = null;
    this.autoSegmentInProgress = false;
    this.autoSegmentProgress = 0;
    this.precomputedSegments = [];
    this.lockedSegmentPoints = [];
    this.shiftKeyHeld = false;

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
      });
      this.resizeObserver.observe(img);
    }

    // Attach event listeners to mask elements
    this.attachMaskListeners();

    // Drag selection listeners
    this.mouseDownHandler = (e: MouseEvent) => this.handleMouseDown(e);
    this.mouseMoveHandler = (e: MouseEvent) => this.handleMouseMove(e);
    this.mouseUpHandler = (e: MouseEvent) => this.handleMouseUp(e);
    document.addEventListener('mousedown', this.mouseDownHandler);
    document.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('mouseup', this.mouseUpHandler);

    // Track mouse position for segment mode
    this.container.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    });

    // Container click handler for segment mode (capture phase)
    this.containerClickHandler = (e: MouseEvent) => {
      if (this.segmentMode) {
        e.stopPropagation();
      }
    };
    this.container.addEventListener('click', this.containerClickHandler, true);

    // Keyboard events
    this.keydownHandler = Interaction.createKeyboardHandler(this as unknown as MaskOverlayState, {
      onInpaint: () => this.pushEvent("inpaint_selected", {}),
      onDeselect: () => {
        if (this.segmentMode) {
          this.exitSegmentMode();
        } else {
          this.selectedMaskIds = new Set();
          this.hoveredMaskId = null;
          this.pushEvent("deselect_all", {});
          this.updateHighlight();
        }
      },
      onDelete: () => {
        this.pushEvent("delete_selected", {});
        this.selectedMaskIds = new Set();
        this.hoveredMaskId = null;
        this.updateHighlight();
      },
      onUndo: () => this.pushEvent("undo", {}),
      onRedo: () => this.pushEvent("redo", {}),
      onConfirmSegment: () => this.confirmSegmentFromPreview(),
      updateHighlight: () => this.updateHighlight()
    });
    document.addEventListener('keydown', this.keydownHandler);

    // Segment mode key handlers (Command/Meta key hold)
    this.segmentModeKeydownHandler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (isSegmentModeTrigger(e) && !this.segmentMode) {
        e.preventDefault();
        await this.enterSegmentMode();

        // Immediately update at cursor position
        requestAnimationFrame(() => {
          if (this.segmentMode && this.lastMousePosition) {
            this.updateAtCursor();
          }
        });
      }
    };

    this.segmentModeKeyupHandler = async (e: KeyboardEvent) => {
      if (isSegmentModeTrigger(e) && this.segmentMode) {
        e.preventDefault();

        // Confirm if we have a preview, locked points, or spotlighted existing mask
        const hasPreview = this.previewMaskCanvas && this.lastMaskData;
        const hasLockedPoints = this.lockedSegmentPoints.length > 0;
        const hasSpotlightedMask = this.spotlightedMaskId !== null;

        if (hasPreview || hasLockedPoints) {
          // New mask from segmentation
          this.pendingSegmentConfirm = true;
          this.previousMaskIds = new Set(
            Array.from(this.container.querySelectorAll('.mask-region'))
              .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
              .filter(id => id !== '')
          );

          // Use locked points for final confirm
          if (hasLockedPoints) {
            this.segmentPoints = [...this.lockedSegmentPoints];
          }

          await this.confirmSegment();
        } else if (hasSpotlightedMask) {
          // Select the existing spotlighted mask
          const maskId = this.spotlightedMaskId!;
          debugLog('[MaskOverlay] Selecting spotlighted mask:', maskId);

          this.exitSegmentMode();

          // Select the mask
          this.selectedMaskIds = new Set([maskId]);
          this.updateHighlight();
          this.pushEvent("select_region", { id: maskId, shift: false });
        } else {
          this.exitSegmentMode();
        }
      }
    };

    document.addEventListener('keydown', this.segmentModeKeydownHandler);
    document.addEventListener('keyup', this.segmentModeKeyupHandler);

    // Track Shift key for negative point preview
    this.shiftKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && this.segmentMode) {
        const wasShiftHeld = this.shiftKeyHeld;
        this.shiftKeyHeld = e.type === 'keydown';

        if (wasShiftHeld !== this.shiftKeyHeld && this.lockedSegmentPoints.length === 0) {
          this.updateAtCursor();
        }
      }
    };
    document.addEventListener('keydown', this.shiftKeyHandler);
    document.addEventListener('keyup', this.shiftKeyHandler);

    // Listen for mask updates from server
    this.handleEvent("masks_updated", ({ masks }: { masks: unknown[] }) => {
      const shouldShimmer = !this.shimmerPlayed &&
                            masks.length > 0 &&
                            (Date.now() - this.pageLoadTime) < 2500;

      if (shouldShimmer) {
        this.shimmerPlayed = true;
      }

      const shouldShimmerNewSegment = this.pendingSegmentConfirm;
      if (shouldShimmerNewSegment) {
        this.pendingSegmentConfirm = false;
      }

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

      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;

      requestAnimationFrame(() => {
        this.positionMasks();
        this.renderSegmentMasks();
        this.attachMaskListeners();
        this.updateHighlight();

        if (shouldShimmer) {
          this.triggerShimmer();
        } else if (shouldShimmerNewSegment) {
          const currentMaskIds = new Set(
            Array.from(this.container.querySelectorAll('.mask-region'))
              .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
              .filter(id => id !== '')
          );

          const newMaskIds = new Set(
            Array.from(currentMaskIds).filter(id => !this.previousMaskIds.has(id))
          );

          if (newMaskIds.size > 0) {
            setTimeout(() => {
              this.triggerShimmer(newMaskIds);
              this.selectedMaskIds = newMaskIds;
              this.updateHighlight();

              const firstNewMaskId = Array.from(newMaskIds)[0];
              if (firstNewMaskId) {
                this.pushEvent("select_region", { id: firstNewMaskId, shift: false });
              }
            }, 100);
          }
        }
      });
    });

    this.handleEvent("clear_selection", () => {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.updateHighlight();
    });

    this.updateHighlight();
    this.initInferenceProvider();
  },

  async initInferenceProvider() {
    if (!providerInitPromise) {
      providerInitPromise = getInferenceProvider();
    }

    try {
      inferenceProvider = await providerInitPromise;
      debugLog('[MaskOverlay] Inference provider ready:', isExtensionAvailable() ? 'extension' : 'local');

      if (!isExtensionAvailable()) {
        await this.runAutoTextDetection();
        this.runAutoSegmentation();
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

    const existingMasks = this.container.querySelectorAll('.mask-region');
    if (existingMasks.length > 0) {
      debugLog('[MaskOverlay] Skipping auto text detection - regions already exist');
      return;
    }

    debugLog('[MaskOverlay] Running auto text detection...');

    try {
      const regions = await inferenceProvider!.detectText(img);
      if (regions.length > 0) {
        debugLog(`[MaskOverlay] Detected ${regions.length} text regions`);
        this.pushEvent('detected_text_regions', { regions });
      }
    } catch (error) {
      console.error('[MaskOverlay] Auto text detection failed:', error);
    }
  },

  async runAutoSegmentation() {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img || !inferenceProvider) return;

    if (!img.complete) {
      await new Promise<void>(resolve => {
        img.addEventListener('load', () => resolve(), { once: true });
      });
    }

    const existingObjectMasks = this.container.querySelectorAll('.mask-region[data-mask-type="object"]');
    if (existingObjectMasks.length > 0) {
      debugLog('[MaskOverlay] Skipping auto-segmentation - object segments already exist');
      return;
    }

    debugLog('[MaskOverlay] Starting auto-segmentation...');
    this.autoSegmentInProgress = true;
    this.autoSegmentProgress = 0;
    this.precomputedSegments = [];

    try {
      await inferenceProvider.autoSegment(
        this.documentId,
        img,
        {
          onBatch: (batch) => {
            this.autoSegmentProgress = batch.progress;
            this.precomputedSegments.push(...batch.masks);

            // Embeddings are ready once we start getting batches
            // (needed to prevent race condition with segment mode)
            if (!this.embeddingsReady) {
              this.embeddingsReady = true;
              debugLog('[MaskOverlay] Embeddings ready (from auto-segmentation batch)');
            }

            if (batch.masks.length > 0) {
              this.pushEvent('auto_segment_batch', {
                masks: batch.masks.map(m => ({
                  mask_png: m.mask_png,
                  bbox: m.bbox,
                  score: m.score,
                  stability_score: m.stabilityScore,
                  area: m.area,
                  centroid: m.centroid,
                })),
                progress: batch.progress,
                batch_index: batch.batchIndex,
                total_batches: batch.totalBatches,
              });
            }
          },
          onComplete: (result) => {
            debugLog(`[MaskOverlay] Auto-segmentation complete: ${result.totalMasks} masks`);
            this.autoSegmentInProgress = false;
            this.autoSegmentProgress = 1;

            this.pushEvent('auto_segment_complete', {
              total_masks: result.totalMasks,
              inference_time_ms: result.inferenceTimeMs,
            });

            this.embeddingsReady = true;
          },
        }
      );
    } catch (error) {
      console.error('[MaskOverlay] Auto-segmentation failed:', error);
      this.autoSegmentInProgress = false;
    }
  },

  updated() {
    this.positionMasks();
    this.attachMaskListeners();
    this.updateHighlight();
  },

  destroyed() {
    if (this.segmentMode) {
      SegmentMode.forceCleanupSegmentElements(this as unknown as MaskOverlayState);
    }

    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.liveSegmentDebounceId) clearTimeout(this.liveSegmentDebounceId);

    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keydown', this.segmentModeKeydownHandler);
    document.removeEventListener('keyup', this.segmentModeKeyupHandler);
    document.removeEventListener('keydown', this.shiftKeyHandler);
    document.removeEventListener('keyup', this.shiftKeyHandler);
    document.removeEventListener('mousedown', this.mouseDownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);

    if (this.dragRect) this.dragRect.remove();
    if (this.pointMarkersContainer) this.pointMarkersContainer.remove();
    if (this.previewMaskCanvas) this.previewMaskCanvas.remove();
    if (this.spotlightOverlay) this.spotlightOverlay.remove();
  },

  // ============ Delegated Methods ============

  positionMasks() {
    Interaction.positionMasks(this.container, this.imageWidth, this.imageHeight);
  },

  attachMaskListeners() {
    Interaction.attachMaskListeners(this.container, this as unknown as MaskOverlayState, this.maskImageCache, {
      onHoverChange: (_maskId: string | null) => {},
      onSelect: (maskId: string, shift: boolean) => {
        this.pushEvent("select_region", { id: maskId, shift });
      },
      updateHighlight: () => this.updateHighlight()
    });
  },

  updateHighlight() {
    Rendering.updateHighlight(this.container, this as unknown as MaskOverlayState, () => {
      if (this.segmentMode && this.spotlightedMaskId) {
        Rendering.updateSegmentMaskSpotlight(this.maskImageCache, this.spotlightedMaskId);
      } else {
        this.updateSegmentMaskHighlight();
      }
    });
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

  // ============ Mouse Handlers ============

  handleMouseDown(e: MouseEvent) {
    if (this.segmentMode) {
      // Click adds a locked point
      const coords = SegmentMode.getImageCoordinates(
        e,
        this.container,
        this.imageWidth,
        this.imageHeight
      );
      if (coords) {
        const point = { x: coords.x, y: coords.y, label: e.shiftKey ? 0 : 1 };
        this.lockedSegmentPoints.push(point);
        SegmentMode.renderPointMarkers(this.lockedSegmentPoints, this as unknown as MaskOverlayState);
        this.segmentWithAllPoints();
      }
      return;
    }

    DragSelection.startDrag(e, this.container, this as unknown as MaskOverlayState);
  },

  handleMouseMove(e: MouseEvent) {
    if (this.segmentMode) {
      this.shiftKeyHeld = e.shiftKey;
      this.updateAtCursor();
      return;
    }

    if (this.dragStart) {
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

  handleMouseUp(e: MouseEvent) {
    if (this.segmentMode) {
      return;
    }

    if (this.dragStart) {
      DragSelection.endDrag(e, this.container, this as unknown as MaskOverlayState, {
        onDragSelect: (maskIds, shift) => {
          this.pushEvent("select_regions", { ids: maskIds, shift });
        },
        updateHighlight: () => this.updateHighlight()
      });
    }
  },

  // ============ Segment Mode ============

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

  // Update spotlight/segment at current cursor position
  updateAtCursor() {
    if (!this.segmentMode) {
      debugLog('[MaskOverlay] updateAtCursor: not in segment mode');
      return;
    }
    if (!this.lastMousePosition) {
      debugLog('[MaskOverlay] updateAtCursor: no lastMousePosition');
      return;
    }

    const cursorX = this.lastMousePosition.x + this.container.getBoundingClientRect().left;
    const cursorY = this.lastMousePosition.y + this.container.getBoundingClientRect().top;

    debugLog('[MaskOverlay] updateAtCursor: cursor at', cursorX, cursorY);

    // Check if cursor is over an existing mask (doesn't require embeddings)
    if (this.lockedSegmentPoints.length === 0) {
      const existingMaskId = this.findMaskUnderCursor(cursorX, cursorY);
      debugLog('[MaskOverlay] findMaskUnderCursor returned:', existingMaskId);
      if (existingMaskId !== this.spotlightedMaskId) {
        debugLog('[MaskOverlay] Setting spotlightedMaskId to:', existingMaskId);
        this.spotlightedMaskId = existingMaskId;
        this.updateHighlight();
      }

      if (existingMaskId) {
        // Clear preview when over existing mask
        if (this.previewMaskCanvas) {
          this.previewMaskCanvas.remove();
          this.previewMaskCanvas = null;
        }
        return;
      }
    }

    // Live segmentation requires embeddings
    if (!this.embeddingsReady) return;

    // Debounce segmentation requests
    if (this.liveSegmentDebounceId !== null) {
      clearTimeout(this.liveSegmentDebounceId);
    }

    this.liveSegmentDebounceId = window.setTimeout(async () => {
      this.liveSegmentDebounceId = null;

      // Segment at cursor (with locked points if any)
      const coords = SegmentMode.getImageCoordinates(
        { clientX: cursorX, clientY: cursorY } as MouseEvent,
        this.container,
        this.imageWidth,
        this.imageHeight
      );

      if (!coords) return;

      const cursorLabel = this.shiftKeyHeld ? 0 : 1;
      const cursorPoint = { x: coords.x, y: coords.y, label: cursorLabel };
      this.segmentPoints = [...this.lockedSegmentPoints, cursorPoint];

      await this.requestSegmentFromPoints();
    }, 50);
  },

  // Segment using all locked points (immediate, no debounce)
  segmentWithAllPoints() {
    if (!this.segmentMode || this.lockedSegmentPoints.length === 0) return;
    if (!this.embeddingsReady) return;

    if (this.liveSegmentDebounceId !== null) {
      clearTimeout(this.liveSegmentDebounceId);
      this.liveSegmentDebounceId = null;
    }

    this.spotlightedMaskId = null;
    this.segmentPoints = [...this.lockedSegmentPoints];
    this.requestSegmentFromPoints();
  },

  async requestSegmentFromPoints() {
    if (!this.documentId || this.segmentPoints.length === 0) return;

    const requestId = `seg_hover_${++segmentRequestCounter}_${Date.now()}`;
    this.lastLiveSegmentRequestId = requestId;

    try {
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      const actualWidth = img?.naturalWidth || this.imageWidth;
      const actualHeight = img?.naturalHeight || this.imageHeight;

      let response: SegmentResponse;
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
        response = await new Promise<SegmentResponse>((resolve, reject) => {
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

      // Check staleness
      if (this.lastLiveSegmentRequestId !== requestId) {
        return;
      }

      if (response.success && (response.mask || (response.mask_png && response.bbox))) {
        const maskData: MaskData = response.mask || {
          mask_png: response.mask_png!,
          bbox: response.bbox!
        };
        SegmentMode.renderPreviewMask(maskData, this as unknown as MaskOverlayState);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage !== 'Segment request timeout') {
        console.error('[MaskOverlay] Segment error:', error);
      }
    }
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

  async confirmSegmentFromPreview() {
    if (!this.previewMaskCanvas || !this.lastMaskData) return;

    this.awaitingMaskConfirmation = true;
    this.pendingSegmentConfirm = true;
    const previewMaskElements = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    this.previousMaskIds = new Set(
      Array.from(previewMaskElements)
        .map(m => m.dataset.maskId || '')
        .filter(id => id !== '')
    );

    this.pushEvent("confirm_segment", {
      mask_png: this.lastMaskData.mask_png,
      bbox: this.lastMaskData.bbox
    });
  },

  findMaskUnderCursor(clientX: number, clientY: number): string | null {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    debugLog('[MaskOverlay] findMaskUnderCursor: checking', masks.length, 'masks');

    for (const mask of Array.from(masks)) {
      const maskId = mask.dataset.maskId || '';
      const maskType = mask.dataset.maskType;
      const rect = mask.getBoundingClientRect();

      const inBbox = clientX >= rect.left && clientX <= rect.right &&
                     clientY >= rect.top && clientY <= rect.bottom;

      if (inBbox) {
        debugLog('[MaskOverlay] Cursor in bbox of mask:', maskId, 'type:', maskType);

        if (maskType === 'object' || maskType === 'manual') {
          const inCache = this.maskImageCache.has(maskId);
          debugLog('[MaskOverlay] Mask in cache:', inCache);

          if (!inCache) {
            // If not in cache yet, use bbox-level hit testing
            debugLog('[MaskOverlay] Using bbox hit (not in cache yet)');
            return maskId;
          }

          const event = { clientX, clientY } as MouseEvent;
          const isOver = Interaction.isPointOverSegmentMask(
            maskId, event, mask, this.maskImageCache
          );
          debugLog('[MaskOverlay] Pixel hit test result:', isOver);
          if (isOver) return maskId;
        } else {
          return maskId;
        }
      }
    }

    return null;
  }
};
