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
 * - Command-key Smart Select with point-based selection
 * - Local ML inference when extension is not available
 */

import type { Hook } from 'phoenix_live_view';
import { getInferenceProvider, isExtensionAvailable, type InferenceProvider } from '../../ml/inference-provider';
import type { MaskOverlayState, SegmentPoint, MaskData } from './types';
import { createSmartSelectContext } from './types';
import * as Interaction from './mask-interaction';
import * as Rendering from './mask-rendering';
import * as DragSelection from './drag-selection';
import * as SmartSelectMode from './smart-select-mode';

// ============ Smart Select Trigger Key ============
const SMART_SELECT_TRIGGER_KEY = 'Meta';

function isSmartSelectTrigger(e: KeyboardEvent): boolean {
  return e.key === SMART_SELECT_TRIGGER_KEY;
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
    this.textDetectionAttempted = false;
    this.textDetectionPromise = null;
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;
    this.dragIntersectingIds = new Set();

    // Smart Select context (centralizes selection state)
    this.smartSelectCtx = null;

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

    // Track mouse position for Smart Select
    this.container.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      // Update Smart Select context if active
      if (this.smartSelectCtx) {
        SmartSelectMode.updateCursorPosition(this.smartSelectCtx, this.lastMousePosition.x, this.lastMousePosition.y);
      }
    });
    this.container.addEventListener('mouseenter', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      if (this.smartSelectCtx) {
        SmartSelectMode.updateCursorPosition(this.smartSelectCtx, this.lastMousePosition.x, this.lastMousePosition.y);
      }
    });

    // Container click handler for Smart Select (capture phase)
    this.containerClickHandler = (e: MouseEvent) => {
      if (this.smartSelectCtx) {
        e.stopPropagation();
      }
    };
    this.container.addEventListener('click', this.containerClickHandler, true);

    // Keyboard events
    this.keydownHandler = Interaction.createKeyboardHandler(this as unknown as MaskOverlayState, {
      onInpaint: () => this.pushEvent("inpaint_selected", {}),
      onDeselect: () => {
        if (this.smartSelectCtx) {
          this.exitSmartSelectMode();
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

    // Smart Select key handlers (Command/Meta key hold)
    this.smartSelectKeydownHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (isSmartSelectTrigger(e) && !this.smartSelectCtx) {
        e.preventDefault();
        this.enterSmartSelectMode();
      }

      // Undo last point with z or Delete/Backspace while in Smart Select (with Command held)
      if (this.smartSelectCtx && e.metaKey && (e.key === 'z' || e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        e.stopPropagation();
        SmartSelectMode.undoLastPoint(this.smartSelectCtx, this.getSmartSelectHooks());
      }
    };

    this.smartSelectKeyupHandler = (e: KeyboardEvent) => {
      if (isSmartSelectTrigger(e) && this.smartSelectCtx) {
        e.preventDefault();

        if (this.smartSelectCtx.lastMaskData) {
          // Have a preview - confirm it
          this.pendingSegmentConfirm = true;
          this.previousMaskIds = new Set(
            Array.from(this.container.querySelectorAll('.mask-region'))
              .map((m: Element) => (m as HTMLElement).dataset.maskId || '')
              .filter(id => id !== '')
          );

          this.pushEvent("confirm_segment", {
            mask_png: this.smartSelectCtx.lastMaskData.mask_png,
            bbox: this.smartSelectCtx.lastMaskData.bbox
          });
          this.exitSmartSelectMode();

        } else if (
          this.smartSelectCtx.spotlightedMaskId &&
          (
            this.smartSelectCtx.spotlightHitType === 'pixel' ||
            (this.smartSelectCtx.spotlightMaskType === 'text' && this.smartSelectCtx.spotlightHitType === 'bbox')
          )
        ) {
          // Select existing mask under cursor
          const maskId = this.smartSelectCtx.spotlightedMaskId;
          this.exitSmartSelectMode();
          this.selectedMaskIds = new Set([maskId]);
          this.updateHighlight();
          this.pushEvent("select_region", { id: maskId, shift: false });

        } else {
          // Nothing to confirm (bbox-only spotlights are not trusted for selection)
          this.exitSmartSelectMode();
        }
      }
    };

    document.addEventListener('keydown', this.smartSelectKeydownHandler);
    document.addEventListener('keyup', this.smartSelectKeyupHandler);

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
      this.ensureEmbeddings();
      this.ensureTextDetection();
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
    if (this.smartSelectCtx) {
      // Ensure loops/timers are stopped and DOM is cleaned
      SmartSelectMode.exitSmartSelect(this.smartSelectCtx, this.getSmartSelectHooks());
      this.smartSelectCtx = null;
    } else {
      SmartSelectMode.forceCleanupSmartSelectElements();
    }

    if (this.resizeObserver) this.resizeObserver.disconnect();

    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keydown', this.smartSelectKeydownHandler);
    document.removeEventListener('keyup', this.smartSelectKeyupHandler);
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
    const spotlightedMaskId = SmartSelectMode.getSpotlightedMaskId(this.smartSelectCtx);
    const spotlightMaskType = this.smartSelectCtx?.spotlightMaskType ?? null;
    const isSmartSelectMode = SmartSelectMode.isSmartSelectActive(this.smartSelectCtx);
    const ctx = this.smartSelectCtx;
    const hasPreviewMask = isSmartSelectMode && Boolean(ctx?.lastMaskData);

    if (ctx && ctx.textCutoutEl && !(isSmartSelectMode && spotlightMaskType === 'text' && spotlightedMaskId)) {
      ctx.textCutoutEl.remove();
      ctx.textCutoutEl = null;
    }

    Rendering.updateHighlight(this.container, this as unknown as MaskOverlayState, () => {
      if (hasPreviewMask && this.maskCacheReady) {
        Rendering.updateSegmentMaskSpotlight(this.maskImageCache, null);
        return;
      }

      if (isSmartSelectMode && spotlightMaskType === 'text' && spotlightedMaskId) {
        this.applyTextSpotlight(spotlightedMaskId);
        return;
      }

      if (isSmartSelectMode && spotlightedMaskId && this.maskCacheReady) {
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

  applyTextSpotlight(spotlightedMaskId: string) {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    const ctx = this.smartSelectCtx;
    const jsContainer = document.getElementById('js-overlay-container');
    const img = document.getElementById('editor-image') as HTMLImageElement | null;

    masks.forEach((mask: HTMLElement) => {
      const maskType = mask.dataset.maskType;
      const isText = maskType !== 'object' && maskType !== 'manual';

      if (!isText) {
        mask.classList.remove('mask-hovered', 'mask-dimmed', 'mask-selected');
        mask.classList.add('mask-idle');
        mask.style.removeProperty('z-index');
        mask.style.removeProperty('background');
        mask.style.removeProperty('box-shadow');
        return;
      }

      const isSpotlight = mask.dataset.maskId === spotlightedMaskId;
      mask.classList.remove('mask-selected', 'mask-idle');

      if (isSpotlight) {
        mask.classList.remove('mask-dimmed');
        mask.classList.add('mask-hovered');
        mask.style.zIndex = '50';
        mask.style.background = 'rgba(255, 255, 255, 0.08)';
        mask.style.boxShadow = '0 0 4px rgba(255, 255, 255, 0.5), 0 0 12px rgba(255, 255, 255, 0.3)';
        mask.style.filter = 'drop-shadow(0 0 4px rgba(255, 255, 255, 0.5)) drop-shadow(0 0 12px rgba(255, 255, 255, 0.3))';

        if (ctx && jsContainer && img) {
          if (!ctx.textCutoutEl) {
            const cutout = document.createElement('div');
            cutout.className = 'text-spotlight-cutout';
            cutout.style.position = 'absolute';
            cutout.style.pointerEvents = 'none';
            cutout.style.zIndex = '48';
            cutout.style.borderRadius = '2px';
            jsContainer.appendChild(cutout);
            ctx.textCutoutEl = cutout;
          }

          const cutout = ctx.textCutoutEl;
          const left = mask.offsetLeft;
          const top = mask.offsetTop;
          const width = mask.offsetWidth;
          const height = mask.offsetHeight;

          const imgWidth = img.clientWidth;
          const imgHeight = img.clientHeight;

          cutout.style.left = `${left}px`;
          cutout.style.top = `${top}px`;
          cutout.style.width = `${width}px`;
          cutout.style.height = `${height}px`;
          cutout.style.backgroundImage = `url(${img.currentSrc || img.src})`;
          cutout.style.backgroundRepeat = 'no-repeat';
          cutout.style.backgroundSize = `${imgWidth}px ${imgHeight}px`;
          cutout.style.backgroundPosition = `-${left}px -${top}px`;
        }
      } else {
        mask.classList.remove('mask-hovered');
        mask.classList.add('mask-dimmed');
        mask.style.removeProperty('z-index');
        mask.style.removeProperty('background');
        mask.style.removeProperty('box-shadow');
        mask.style.removeProperty('filter');
      }
    });

    if (ctx && (!spotlightedMaskId || ctx.spotlightMaskType !== 'text')) {
      if (ctx.textCutoutEl) {
        ctx.textCutoutEl.remove();
        ctx.textCutoutEl = null;
      }
    }
  },

  renderSegmentMasks() {
    const { pendingLoads, promise } = Rendering.renderSegmentMasks(
      this.container,
      this.maskImageCache
    );

    // Track readiness of the mask cache for reliable hit testing
    if (pendingLoads > 0) {
      this.maskCacheReady = false;
      this.maskCacheReadyPromise = promise
        .then(() => {
          this.maskCacheReady = true;
          // Notify Smart Select so pixel hit testing becomes available
          if (this.smartSelectCtx) {
            SmartSelectMode.notifyMaskCacheReady(this.smartSelectCtx, this.getSmartSelectHooks());
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
    Rendering.triggerShimmer(this.container, targetMaskIds);
  },

  // ============ Mouse Handlers ============

  handleMouseDown(e: MouseEvent) {
    if (this.smartSelectCtx) {
      // Click adds a locked point in Smart Select
      SmartSelectMode.handleSmartSelectClick(this.smartSelectCtx, e, this.getSmartSelectHooks());
      return;
    }

    DragSelection.startDrag(e, this.container, this as unknown as MaskOverlayState);
  },

  handleMouseMove(e: MouseEvent) {
    if (this.smartSelectCtx) {
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
    if (this.smartSelectCtx) {
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

  // ============ Smart Select ============

  getSmartSelectHooks(): SmartSelectMode.SmartSelectHooks {
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

  enterSmartSelectMode() {
    // Create fresh context
    this.smartSelectCtx = createSmartSelectContext();

    // Initialize cursor position if we have it
    if (this.lastMousePosition) {
      SmartSelectMode.updateCursorPosition(this.smartSelectCtx, this.lastMousePosition.x, this.lastMousePosition.y);
    }

    // Clear any mask selection
    this.selectedMaskIds = new Set();
    this.hoveredMaskId = null;

    // Enter Smart Select
    SmartSelectMode.enterSmartSelect(this.smartSelectCtx, this.getSmartSelectHooks());
  },

  exitSmartSelectMode() {
    if (!this.smartSelectCtx) return;

    SmartSelectMode.exitSmartSelect(this.smartSelectCtx, this.getSmartSelectHooks());
    this.smartSelectCtx = null;
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
      if (this.smartSelectCtx) {
        SmartSelectMode.notifyEmbeddingsReady(this.smartSelectCtx, this.getSmartSelectHooks());
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

    this.embeddingsComputePromise = inferenceProvider!.computeEmbeddings(this.documentId, img)
      .then(() => {
        this.embeddingsReady = true;
        if (this.smartSelectCtx) {
          SmartSelectMode.notifyEmbeddingsReady(this.smartSelectCtx, this.getSmartSelectHooks());
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

  async ensureTextDetection() {
    if (this.textDetectionAttempted) return;
    if (this.textDetectionPromise) {
      await this.textDetectionPromise;
      return;
    }

    const hasTextMasks = Array.from(this.container.querySelectorAll('.mask-region')).some((mask: Element) => {
      const type = (mask as HTMLElement).dataset.maskType;
      return type !== 'object' && type !== 'manual';
    });

    if (hasTextMasks) {
      this.textDetectionAttempted = true;
      return;
    }

    // Ensure provider is ready
    if (!providerInitPromise) {
      providerInitPromise = getInferenceProvider();
    }

    if (!inferenceProvider) {
      try {
        inferenceProvider = await providerInitPromise;
      } catch (error) {
        console.error('[MaskOverlay] Failed to init provider for text detection:', error);
        return;
      }
    }

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    if (!img.complete) {
      if (this.imageReadyPromise) {
        await this.imageReadyPromise;
      } else {
        await new Promise<void>((resolve) => img.addEventListener('load', () => resolve(), { once: true }));
      }
    }

    this.textDetectionAttempted = true;
    this.textDetectionPromise = inferenceProvider.detectText(img)
      .then((regions) => {
        if (regions && regions.length > 0) {
          this.pushEvent("detected_text_regions", { regions });
        }
      })
      .catch((error) => {
        console.error('[MaskOverlay] Text detection error:', error);
      })
      .finally(() => {
        this.textDetectionPromise = null;
      });

    await this.textDetectionPromise;
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
    if (!this.smartSelectCtx || !this.smartSelectCtx.lastMaskData) return;

    this.pendingSegmentConfirm = true;
    const previewMaskElements = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    this.previousMaskIds = new Set(
      Array.from(previewMaskElements)
        .map(m => m.dataset.maskId || '')
        .filter(id => id !== '')
    );

    this.pushEvent("confirm_segment", {
      mask_png: this.smartSelectCtx.lastMaskData.mask_png,
      bbox: this.smartSelectCtx.lastMaskData.bbox
    });

    // Clean up Smart Select
    this.exitSmartSelectMode();
  }
};
