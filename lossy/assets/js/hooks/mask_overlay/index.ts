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
import { waitForImageLoad, getEditorImage } from './image-utils';
import { setErrorHandler, validateMLEnvironment, type MLError } from '../../ml/error-handler';
import { MLCoordinator } from './ml-coordinator';
import { PendingMaskManager } from './pending-mask';

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
    const { requestId, success, mask } = event.data as {
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
    this.shimmerPlayedAt = null;
    this.textDetectionTimestamp = null;
    this.textDetectionPromise = null;
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;
    this.dragIntersectingIds = new Set();

    // Smart Select context (centralizes selection state)
    this.smartSelectCtx = null;

    // Pending mask (for new segments)
    this.pendingMask = null;
    this.pendingMaskElement = null;
    this.marchAntsOffset = 0;
    this.marchAntsLoopId = null;

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

    // Initialize coordinators (Phase 3 refactor)
    this.mlCoordinator = new MLCoordinator({
      documentId: this.documentId,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      onProgress: (stage, progress) => {
        // TODO: Update UI loading indicator
        console.log(`[ML] ${stage}: ${progress}%`);
      }
    });

    this.pendingMaskManager = new PendingMaskManager({
      container: this.el,
      onConfirm: (mask) => {
        this.pendingSegmentConfirm = true;
        this.previousMaskIds = new Set(
          (Array.from(this.container.querySelectorAll('.mask-region')) as HTMLElement[])
            .map(m => m.dataset.maskId || '')
            .filter(id => id)
        );

        this.pushEvent("confirm_segment", {
          mask_png: mask.mask_png,
          bbox: mask.bbox
        });
      },
      onCancel: () => {
        // Cleanup handled by PendingMaskManager
      }
    });

    // Set up ML error handler
    setErrorHandler({
      onError: (error: MLError) => {
        console.error('[MaskOverlay] ML Error:', error);
        // TODO: Show user-visible error notification via Phoenix event
        // this.pushEvent('ml_error', { stage: error.stage, message: error.message });
      }
    });

    // Validate ML environment upfront
    validateMLEnvironment().then((validation) => {
      if (!validation.canRunML) {
        console.error('[MaskOverlay] ML inference unavailable:', validation.issues);
        // TODO: Show user notification that ML features are unavailable
      } else if (validation.issues.length > 0) {
        console.warn('[MaskOverlay] ML environment warnings:', validation.issues);
      }
    });

    // Position masks once image is loaded
    const img = getEditorImage();
    if (img) {
      this.imageReadyPromise = waitForImageLoad(img).catch((error) => {
        console.error('[MaskOverlay] Image load failed:', error);
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
      onDeselect: () => { // Escape key
        if (this.pendingMask) {
          this.cancelPendingMask();
          return;
        }
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
        if (this.pendingMask) {
          this.cancelPendingMask();
          return;
        }
        this.pushEvent("delete_selected", {});
        this.selectedMaskIds = new Set();
        this.hoveredMaskId = null;
        this.updateHighlight();
      },
      onUndo: () => this.pushEvent("undo", {}),
      onRedo: () => this.pushEvent("redo", {}),
      onConfirmSegment: () => this.confirmSegmentFromPreview(),
      onConfirmPendingMask: () => this.confirmPendingMask(),
      updateHighlight: () => this.updateHighlight()
    });
    document.addEventListener('keydown', this.keydownHandler);

    // Smart Select key handlers (Command/Meta key hold)
    this.smartSelectKeydownHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (isSmartSelectTrigger(e) && !this.smartSelectCtx) {
        e.preventDefault();
        // If a mask is pending, cancel it before entering smart select
        if (this.pendingMask) {
          this.cancelPendingMask();
        }
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

        const newMaskData = this.smartSelectCtx.lastMaskData;

        if (newMaskData) {
          // A new mask was generated. Move to "pending" state instead of confirming.
          this.exitSmartSelectMode();
          this.pendingMask = newMaskData;
          this.createPendingMaskElement();
          this.startMarchingAntsAnimation();

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
          // Nothing to confirm or select, just exit.
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
      const shouldShimmer = this.shimmerPlayedAt === null &&
                            masks.length > 0 &&
                            (Date.now() - this.pageLoadTime) < 2500;

      if (shouldShimmer) {
        this.shimmerPlayedAt = Date.now();
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
    // 1. Stop Smart Select mode
    if (this.smartSelectCtx) {
      // Ensure loops/timers are stopped and DOM is cleaned
      SmartSelectMode.exitSmartSelect(this.smartSelectCtx, this.getSmartSelectHooks());
      this.smartSelectCtx = null;
    } else {
      SmartSelectMode.forceCleanupSmartSelectElements();
    }

    // 2. Stop marching ants animation
    if (this.marchAntsLoopId) {
      cancelAnimationFrame(this.marchAntsLoopId);
      this.marchAntsLoopId = null;
    }

    // 3. Cancel pending mask
    if (this.pendingMask) {
      this.cancelPendingMask();
    }

    // 4. Cleanup coordinators (Phase 3 refactor)
    if (this.mlCoordinator) {
      this.mlCoordinator.cleanup();
      this.mlCoordinator = null;
    }

    if (this.pendingMaskManager) {
      this.pendingMaskManager.cleanup();
      this.pendingMaskManager = null;
    }

    // 5. Clear pending mask element (legacy - handled by coordinator)
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
      this.pendingMaskElement = null;
    }

    // 6. Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // 7. Remove all event listeners
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keydown', this.smartSelectKeydownHandler);
    document.removeEventListener('keyup', this.smartSelectKeyupHandler);
    document.removeEventListener('keydown', this.shiftKeyHandler);
    document.removeEventListener('keyup', this.shiftKeyHandler);
    document.removeEventListener('mousedown', this.mouseDownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);

    if (this.containerClickHandler && this.container) {
      this.container.removeEventListener('click', this.containerClickHandler, true);
    }

    // 8. Remove drag rect
    if (this.dragRect) {
      this.dragRect.remove();
      this.dragRect = null;
    }

    // 9. Clear embeddings for this document (legacy - handled by coordinator)
    if (inferenceProvider && this.documentId) {
      inferenceProvider.clearEmbeddings(this.documentId);
    }

    // 10. Clear mask cache (free canvas memory)
    if (this.maskImageCache) {
      this.maskImageCache.forEach(cached => {
        if (cached.canvas) {
          const ctx = cached.canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, cached.canvas.width, cached.canvas.height);
          }
        }
      });
      this.maskImageCache.clear();
    }

    // 11. Clear error handler
    setErrorHandler(null);

    console.log('[MaskOverlay] Cleanup complete');
  },

  // ============ Delegated Methods ============

  positionMasks() {
    Interaction.positionMasks(this.container, this.imageWidth, this.imageHeight);
  },

  attachMaskListeners() {
    Interaction.attachMaskListeners(this.container, this as unknown as MaskOverlayState, this.maskImageCache, {
      onHoverChange: (_maskId: string | null) => {},
      onSelect: (maskId: string, shift: boolean) => {
        if (this.pendingMask) this.confirmPendingMask();
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
    if (this.pendingMask) {
      this.confirmPendingMask();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

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

  // ============ Pending Mask Handlers ============

  createPendingMaskElement() {
    const jsContainer = document.getElementById('js-overlay-container');
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!jsContainer || !this.pendingMask || !img) return;

    // Remove any existing one
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
    }

    const el = document.createElement('div');
    el.className = 'pending-mask-container';
    el.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 60;
      filter: drop-shadow(0 0 10px rgba(59, 130, 246, 0.3));
    `;

    const canvas = document.createElement('canvas');
    canvas.className = 'pending-mask-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    el.appendChild(canvas);

    // Size canvas drawing buffer to match the displayed image size
    const dpr = window.devicePixelRatio || 1;
    canvas.width = img.clientWidth * dpr;
    canvas.height = img.clientHeight * dpr;

    this.pendingMaskElement = el;
    jsContainer.appendChild(el);
  },

  startMarchingAntsAnimation() {
    this.stopMarchingAntsAnimation(); // Ensure no multiple loops
    this.marchAntsOffset = 0;
    let frameCount = 0;

    const animationLoop = () => {
      if (!this.pendingMask) {
        this.stopMarchingAntsAnimation();
        return;
      }

      frameCount++;
      if (frameCount % 3 === 0) { // Update offset every 3 frames to slow it down
        this.marchAntsOffset = (this.marchAntsOffset + 1) % 10;
        this.drawPendingMask();
      }

      this.marchAntsLoopId = requestAnimationFrame(animationLoop);
    };

    this.drawPendingMask(); // Draw immediately to prevent flicker
    this.marchAntsLoopId = requestAnimationFrame(animationLoop);
  },

  stopMarchingAntsAnimation() {
    if (this.marchAntsLoopId !== null) {
      cancelAnimationFrame(this.marchAntsLoopId);
      this.marchAntsLoopId = null;
    }
  },

  async drawPendingMask() {
    if (!this.pendingMask || !this.pendingMaskElement) return;

    const canvas = this.pendingMaskElement.querySelector('.pending-mask-canvas') as HTMLCanvasElement | null;
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maskImg = new Image();
    maskImg.onload = () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = maskImg.width;
      tempCanvas.height = maskImg.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;

      tempCtx.drawImage(maskImg, 0, 0);
      const imageData = tempCtx.getImageData(0, 0, maskImg.width, maskImg.height);
      const contours = findAllContours(imageData);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (contours.length === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const scaleX = img.clientWidth / maskImg.width;
      const scaleY = img.clientHeight / maskImg.height;
      const avgScale = Math.sqrt(scaleX * scaleY);

      ctx.save();
      ctx.scale(dpr, dpr);

      // --- Draw marquee-style selection for all disconnected regions ---
      for (const contour of contours) {
        if (contour.length < 3) continue; // Need at least 3 points for a closed shape

        const path = new Path2D();
        path.moveTo(contour[0].x * scaleX, contour[0].y * scaleY);
        for (let i = 1; i < contour.length; i++) {
          path.lineTo(contour[i].x * scaleX, contour[i].y * scaleY);
        }
        path.closePath();

        // 1. Blue fill (matches marquee)
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fill(path);

        // 2. Solid black outline for contrast (1px)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1 / avgScale; // Maintain 1px perceived width
        ctx.lineJoin = 'round';
        ctx.stroke(path);

        // 3. Blue dashed border (2px) - animated layer
        ctx.strokeStyle = 'rgb(59, 130, 246)';
        ctx.lineWidth = 2 / avgScale; // Maintain 2px perceived width
        ctx.setLineDash([6, 4]); // Dash pattern: 6px dash, 4px gap
        ctx.lineDashOffset = -this.marchAntsOffset;
        ctx.stroke(path);
      }

      ctx.restore();
    };
    maskImg.src = this.pendingMask.mask_png;
  },

  confirmPendingMask() {
    if (!this.pendingMask) return;

    this.pendingSegmentConfirm = true;
    this.previousMaskIds = new Set(
      (Array.from(this.container.querySelectorAll('.mask-region')) as HTMLElement[])
        .map(m => m.dataset.maskId || '')
        .filter(id => id)
    );

    this.pushEvent("confirm_segment", {
      mask_png: this.pendingMask.mask_png,
      bbox: this.pendingMask.bbox
    });

    this.cancelPendingMask(); // Clean up immediately
  },

  cancelPendingMask() {
    this.stopMarchingAntsAnimation();
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
      this.pendingMaskElement = null;
    }
    this.pendingMask = null;
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
    const img = getEditorImage();
    if (!img) return;
    await waitForImageLoad(img);

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
    if (this.textDetectionTimestamp !== null) return;
    if (this.textDetectionPromise) {
      await this.textDetectionPromise;
      return;
    }

    const hasTextMasks = (Array.from(this.container.querySelectorAll('.mask-region')) as HTMLElement[]).some(mask => {
      const type = mask.dataset.maskType;
      return type !== 'object' && type !== 'manual';
    });

    if (hasTextMasks) {
      this.textDetectionTimestamp = Date.now();
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

    const img = getEditorImage();
    if (!img) return;
    await waitForImageLoad(img);

    this.textDetectionTimestamp = Date.now();
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

/**
 * Finds all contours in a mask from ImageData.
 * Supports disconnected regions (e.g., separate letters).
 * Uses Moore-Neighbor tracing for each region.
 */
function findAllContours(imageData: ImageData): { x: number; y: number }[][] {
  const { data, width, height } = imageData;
  const contours: { x: number; y: number }[][] = [];
  const visited = new Set<number>();

  const isOpaque = (px: number, py: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const index = (py * width + px) * 4 + 3;
    return data[index] > 128;
  };

  const neighbors = [
    { dx: 1, dy: 0 },   // E
    { dx: 1, dy: -1 },  // NE
    { dx: 0, dy: -1 },  // N
    { dx: -1, dy: -1 }, // NW
    { dx: -1, dy: 0 },  // W
    { dx: -1, dy: 1 },  // SW
    { dx: 0, dy: 1 },   // S
    { dx: 1, dy: 1 },   // SE
  ];

  // Flood fill to mark entire region as visited
  const floodFill = (startX: number, startY: number) => {
    const stack: { x: number; y: number }[] = [{ x: startX, y: startY }];

    while (stack.length > 0) {
      const { x, y } = stack.pop()!;
      const pixelIndex = y * width + x;

      if (visited.has(pixelIndex) || !isOpaque(x, y)) continue;

      visited.add(pixelIndex);

      // Add 4-connected neighbors
      if (x > 0) stack.push({ x: x - 1, y });
      if (x < width - 1) stack.push({ x: x + 1, y });
      if (y > 0) stack.push({ x, y: y - 1 });
      if (y < height - 1) stack.push({ x, y: y + 1 });
    }
  };

  const traceContour = (startX: number, startY: number): { x: number; y: number }[] => {
    const contour: { x: number; y: number }[] = [];
    let x = startX;
    let y = startY;
    let dir = 0;
    let iterations = 0;
    const maxIterations = width * height; // Safety limit

    do {
      contour.push({ x, y });

      // Look for next pixel
      const startDir = (dir + 6) % 8;
      let foundNext = false;
      for (let i = 0; i < 8; i++) {
        const checkDir = (startDir + i) % 8;
        const neighbor = neighbors[checkDir];
        const nextX = x + neighbor.dx;
        const nextY = y + neighbor.dy;

        if (isOpaque(nextX, nextY)) {
          x = nextX;
          y = nextY;
          dir = checkDir;
          foundNext = true;
          break;
        }
      }

      if (!foundNext) break;

      iterations++;
      if (iterations > maxIterations) {
        console.warn('[MaskOverlay] Contour tracing exceeded iteration limit');
        break;
      }

    } while (x !== startX || y !== startY);

    return contour;
  };

  // Scan for all disconnected regions
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      if (!visited.has(pixelIndex) && isOpaque(x, y)) {
        const contour = traceContour(x, y);
        if (contour.length > 2) {
          contours.push(contour);
          // Mark entire region as visited to avoid re-processing
          floodFill(x, y);
        }
      }
    }
  }

  return contours;
}
