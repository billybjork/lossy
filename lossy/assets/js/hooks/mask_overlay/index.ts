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
import type { MaskOverlayState, SegmentModeContext, SegmentPoint, MaskData } from './types';
import { createSegmentContext } from './types';
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
const pendingSegmentRequests = new Map<string, (result: { success: boolean; maskData?: MaskData }) => void>();
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
      resolve({ success, maskData: mask });
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
    this.maskCacheReady = false;
    this.maskCacheReadyPromise = null;
    this.pageLoadTime = Date.now();
    this.shimmerPlayed = false;
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;
    this.dragIntersectingIds = new Set();

    // Segment mode context (replaces scattered segment mode state)
    this.segmentCtx = null;

    // Core data
    this.documentId = this.el.dataset.documentId || '';
    this.embeddingsReady = false;
    this.embeddingsComputePromise = null;
    this.imageWidth = parseInt(this.el.dataset.imageWidth || '0') || 0;
    this.imageHeight = parseInt(this.el.dataset.imageHeight || '0') || 0;

    // Mouse position tracking
    this.lastMousePosition = null;
    this.shiftKeyHeld = false;

    // Segment confirmation tracking
    this.pendingSegmentConfirm = false;
    this.previousMaskIds = new Set();

    // Resize observer
    this.resizeObserver = null;
    this.imageReadyPromise = null;

    // Position masks once image is loaded
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      this.imageReadyPromise = img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
          });

      if (img.complete) {
        this.positionMasks();
        this.renderSegmentMasks();
      } else {
        img.addEventListener('load', () => {
          this.positionMasks();
          this.renderSegmentMasks();
        }, { once: true });
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
      // Update segment mode context if active
      if (this.segmentCtx) {
        SegmentMode.updateCursorPosition(this.segmentCtx, this.lastMousePosition.x, this.lastMousePosition.y);
      }
    });
    this.container.addEventListener('mouseenter', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      if (this.segmentCtx) {
        SegmentMode.updateCursorPosition(this.segmentCtx, this.lastMousePosition.x, this.lastMousePosition.y);
      }
    });

    // Container click handler for segment mode (capture phase)
    this.containerClickHandler = (e: MouseEvent) => {
      if (this.segmentCtx) {
        e.stopPropagation();
      }
    };
    this.container.addEventListener('click', this.containerClickHandler, true);

    // Keyboard events
    this.keydownHandler = Interaction.createKeyboardHandler(this as unknown as MaskOverlayState, {
      onInpaint: () => this.pushEvent("inpaint_selected", {}),
      onDeselect: () => {
        if (this.segmentCtx) {
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
    this.segmentModeKeydownHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (isSegmentModeTrigger(e) && !this.segmentCtx) {
        e.preventDefault();
        this.enterSegmentMode();
      }

      // Undo last point with z or Delete/Backspace while in segment mode (with Command held)
      if (this.segmentCtx && e.metaKey && (e.key === 'z' || e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        e.stopPropagation();
        SegmentMode.undoLastPoint(this.segmentCtx, this.getSegmentHooks());
      }
    };

    this.segmentModeKeyupHandler = (e: KeyboardEvent) => {
      if (isSegmentModeTrigger(e) && this.segmentCtx) {
        e.preventDefault();

        if (this.segmentCtx.lastMaskData) {
          // Have a preview - confirm it
          debugLog('[MaskOverlay] Confirming preview mask');
          this.pendingSegmentConfirm = true;
          this.previousMaskIds = new Set(
            Array.from(this.container.querySelectorAll('.mask-region'))
              .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
              .filter(id => id !== '')
          );

          this.pushEvent("confirm_segment", {
            mask_png: this.segmentCtx.lastMaskData.mask_png,
            bbox: this.segmentCtx.lastMaskData.bbox
          });
          this.exitSegmentMode();

        } else if (this.segmentCtx.spotlightedMaskId && this.segmentCtx.spotlightHitType === 'pixel') {
          // Select existing mask under cursor (only if pixel-confirmed, not bbox-only)
          const maskId = this.segmentCtx.spotlightedMaskId;
          debugLog('[MaskOverlay] Selecting pixel-confirmed spotlighted mask:', maskId);
          this.exitSegmentMode();
          this.selectedMaskIds = new Set([maskId]);
          this.updateHighlight();
          this.pushEvent("select_region", { id: maskId, shift: false });

        } else {
          // Nothing to confirm (bbox-only spotlights are not trusted for selection)
          debugLog('[MaskOverlay] Exiting segment mode (no confirmed selection)');
          this.exitSegmentMode();
        }
      }
    };

    document.addEventListener('keydown', this.segmentModeKeydownHandler);
    document.addEventListener('keyup', this.segmentModeKeyupHandler);

    // Track Shift key for negative point preview
    this.shiftKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        this.shiftKeyHeld = e.type === 'keydown';
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

      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;

      requestAnimationFrame(() => {
        // Reset marquee artifacts after LiveView updates so the drag rect can't be removed by patches
        DragSelection.resetDragState(this.container, this as unknown as MaskOverlayState);

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
      this.ensureEmbeddings();
    } catch (error) {
      console.error('[MaskOverlay] Failed to initialize inference provider:', error);
    }
  },

  updated() {
    this.positionMasks();
    this.attachMaskListeners();
    this.updateHighlight();
  },

  destroyed() {
    if (this.segmentCtx) {
      // Ensure loops/timers are stopped and DOM is cleaned
      SegmentMode.exitSegmentMode(this.segmentCtx, this.getSegmentHooks());
      this.segmentCtx = null;
    } else {
      SegmentMode.forceCleanupSegmentElements();
    }

    if (this.resizeObserver) this.resizeObserver.disconnect();

    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keydown', this.segmentModeKeydownHandler);
    document.removeEventListener('keyup', this.segmentModeKeyupHandler);
    document.removeEventListener('keydown', this.shiftKeyHandler);
    document.removeEventListener('keyup', this.shiftKeyHandler);
    document.removeEventListener('mousedown', this.mouseDownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);

    if (this.dragRect) {
      this.dragRect.remove();
      this.dragRect = null;
    }
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
    const spotlightedMaskId = SegmentMode.getSpotlightedMaskId(this.segmentCtx);
    const isSegmentMode = SegmentMode.isSegmentModeActive(this.segmentCtx);

    Rendering.updateHighlight(this.container, this as unknown as MaskOverlayState, () => {
      if (isSegmentMode && spotlightedMaskId && this.maskCacheReady) {
        Rendering.updateSegmentMaskSpotlight(this.maskImageCache, spotlightedMaskId);
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
    const { pendingLoads, promise } = Rendering.renderSegmentMasks(
      this.container,
      this.maskImageCache,
      this.imageWidth,
      this.imageHeight
    );

    // Track readiness of the mask cache for reliable hit testing
    if (pendingLoads > 0) {
      this.maskCacheReady = false;
      this.maskCacheReadyPromise = promise
        .then(() => {
          this.maskCacheReady = true;
          debugLog('[MaskOverlay] Mask cache ready');
          // Notify segment mode so pixel hit testing becomes available
          if (this.segmentCtx) {
            SegmentMode.notifyMaskCacheReady(this.segmentCtx, this.getSegmentHooks());
          }
        })
        .catch(() => {
          this.maskCacheReady = true;
        });
    } else {
      this.maskCacheReady = true;
      this.maskCacheReadyPromise = Promise.resolve();
    }

    return this.maskCacheReadyPromise;
  },

  triggerShimmer(targetMaskIds?: Set<string>) {
    Rendering.triggerShimmer(this.container, this.maskImageCache, targetMaskIds);
  },

  // ============ Mouse Handlers ============

  handleMouseDown(e: MouseEvent) {
    if (this.segmentCtx) {
      // Click adds a locked point in segment mode
      SegmentMode.handleSegmentClick(this.segmentCtx, e, this.getSegmentHooks());
      return;
    }

    DragSelection.startDrag(e, this.container, this as unknown as MaskOverlayState);
  },

  handleMouseMove(e: MouseEvent) {
    if (this.segmentCtx) {
      // Cursor position is updated via container mousemove listener
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
    if (this.segmentCtx) {
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

  getSegmentHooks(): SegmentMode.SegmentModeHooks {
    return {
      container: this.container,
      jsContainer: document.getElementById('js-overlay-container'),
      maskCache: this.maskImageCache,
      maskCacheReady: () => this.maskCacheReady,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      embeddingsReady: () => this.embeddingsReady,
      shiftHeld: () => this.shiftKeyHeld,
      segment: (points: SegmentPoint[]) => this.requestSegmentFromPoints(points),
      updateHighlight: () => this.updateHighlight(),
      pushEvent: (event: string, payload: unknown) => this.pushEvent(event, payload),
      ensureEmbeddings: () => this.ensureEmbeddings(),
    };
  },

  enterSegmentMode() {
    // Create fresh context
    this.segmentCtx = createSegmentContext();

    // Initialize cursor position if we have it
    if (this.lastMousePosition) {
      SegmentMode.updateCursorPosition(this.segmentCtx, this.lastMousePosition.x, this.lastMousePosition.y);
    }

    // Clear any mask selection
    this.selectedMaskIds = new Set();
    this.hoveredMaskId = null;

    // Enter segment mode
    SegmentMode.enterSegmentMode(this.segmentCtx, this.getSegmentHooks());
  },

  exitSegmentMode() {
    if (!this.segmentCtx) return;

    SegmentMode.exitSegmentMode(this.segmentCtx, this.getSegmentHooks());
    this.segmentCtx = null;
  },

  async ensureEmbeddings() {
    if (this.embeddingsReady) return;

    // Always ensure provider init is kicked off
    if (!providerInitPromise) {
      providerInitPromise = getInferenceProvider();
    }

    // Wait for provider to be ready
    if (!inferenceProvider) {
      try {
        inferenceProvider = await providerInitPromise;
      } catch (error) {
        console.error('[MaskOverlay] Failed to init provider for embeddings:', error);
        return;
      }
    }

    const extensionAvailable = isExtensionAvailable();
    if (extensionAvailable) {
      // Extension path marks embeddings immediately
      this.embeddingsReady = true;
      debugLog('[MaskOverlay] Extension available, embeddings ready');
      if (this.segmentCtx) {
        SegmentMode.notifyEmbeddingsReady(this.segmentCtx, this.getSegmentHooks());
      }
      return;
    }

    if (this.embeddingsComputePromise) {
      await this.embeddingsComputePromise;
      return;
    }

    // Wait for image to be ready before computing
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;
    if (!img.complete) {
      if (this.imageReadyPromise) {
        await this.imageReadyPromise;
      } else {
        await new Promise<void>((resolve) => img.addEventListener('load', () => resolve(), { once: true }));
      }
    }

    debugLog('[MaskOverlay] Computing embeddings...');
    this.embeddingsComputePromise = inferenceProvider!.computeEmbeddings(this.documentId, img)
      .then(() => {
        this.embeddingsReady = true;
        debugLog('[MaskOverlay] Embeddings ready');
        if (this.segmentCtx) {
          SegmentMode.notifyEmbeddingsReady(this.segmentCtx, this.getSegmentHooks());
        }
      })
      .catch((error) => {
        console.error('[MaskOverlay] Failed to compute embeddings:', error);
      })
      .finally(() => {
        this.embeddingsComputePromise = null;
      });

    await this.embeddingsComputePromise;
  },

  async requestSegmentFromPoints(points: SegmentPoint[]): Promise<{ success: boolean; maskData?: MaskData }> {
    if (!this.documentId || points.length === 0) {
      return { success: false };
    }

    const requestId = `seg_${++segmentRequestCounter}_${Date.now()}`;

    try {
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      const actualWidth = img?.naturalWidth || this.imageWidth;
      const actualHeight = img?.naturalHeight || this.imageHeight;

      const provider = inferenceProvider;

      if (provider && !isExtensionAvailable()) {
        const result = await provider.segmentAtPoints(
          this.documentId,
          points as any,
          { width: actualWidth, height: actualHeight }
        );
        return {
          success: true,
          maskData: {
            mask_png: result.mask_png,
            bbox: result.bbox
          }
        };
      } else {
        // Extension-based segmentation
        return new Promise<{ success: boolean; maskData?: MaskData }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingSegmentRequests.delete(requestId);
            reject(new Error('Segment request timeout'));
          }, 5000);

          pendingSegmentRequests.set(requestId, (result) => {
            clearTimeout(timeout);
            resolve(result);
          });

          window.postMessage({
            type: 'LOSSY_SEGMENT_REQUEST',
            documentId: this.documentId,
            points: points,
            imageSize: { width: actualWidth, height: actualHeight },
            requestId
          }, '*');
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage !== 'Segment request timeout') {
        console.error('[MaskOverlay] Segment error:', error);
      }
      return { success: false };
    }
  },

  confirmSegmentFromPreview() {
    if (!this.segmentCtx || !this.segmentCtx.lastMaskData) return;

    this.pendingSegmentConfirm = true;
    const previewMaskElements = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    this.previousMaskIds = new Set(
      Array.from(previewMaskElements)
        .map(m => m.dataset.maskId || '')
        .filter(id => id !== '')
    );

    this.pushEvent("confirm_segment", {
      mask_png: this.segmentCtx.lastMaskData.mask_png,
      bbox: this.segmentCtx.lastMaskData.bbox
    });

    // Clean up segment mode
    this.exitSegmentMode();
  }
};
