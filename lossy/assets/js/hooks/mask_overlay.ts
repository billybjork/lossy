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

// Color palette for unique per-mask colors (Meta SAM style)
// Each mask gets assigned a color from this palette for visual distinction
const MASK_COLORS = [
  { fill: 'rgba(251, 146, 60, 0.4)', stroke: 'rgb(251, 146, 60)' },   // Orange
  { fill: 'rgba(59, 130, 246, 0.4)', stroke: 'rgb(59, 130, 246)' },   // Blue
  { fill: 'rgba(34, 197, 94, 0.4)', stroke: 'rgb(34, 197, 94)' },     // Green
  { fill: 'rgba(168, 85, 247, 0.4)', stroke: 'rgb(168, 85, 247)' },   // Purple
  { fill: 'rgba(236, 72, 153, 0.4)', stroke: 'rgb(236, 72, 153)' },   // Pink
  { fill: 'rgba(6, 182, 212, 0.4)', stroke: 'rgb(6, 182, 212)' },     // Cyan
  { fill: 'rgba(245, 158, 11, 0.4)', stroke: 'rgb(245, 158, 11)' },   // Amber
  { fill: 'rgba(99, 102, 241, 0.4)', stroke: 'rgb(99, 102, 241)' },   // Indigo
];

// Hover state uses white/neutral overlay
const HOVER_COLOR = { fill: 'rgba(255, 255, 255, 0.25)', stroke: 'rgb(255, 255, 255)' };

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

interface BrushStroke {
  id: string;
  rawPoints: Array<{x: number; y: number}>;
  sampledPoints: SegmentPoint[];
  label: number;  // 1 = positive, 0 = negative
  brushSize: number;
}

interface CachedMask {
  canvas: HTMLCanvasElement;
  alphaData: ImageData;
  colorIndex: number;
}

interface MaskOverlayState {
  container: HTMLElement;
  hoveredMaskId: string | null;
  selectedMaskIds: Set<string>;
  maskImageCache: Map<string, CachedMask>;
  pageLoadTime: number;
  shimmerPlayed: boolean;
  isDragging: boolean;
  dragStart: DragStart | null;
  dragRect: HTMLDivElement | null;
  dragShift: boolean;
  dragIntersectingIds: Set<string>;
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
  // Brush mode state
  brushSize: number;
  currentStroke: Array<{x: number; y: number; label: number}>;
  strokeHistory: BrushStroke[];
  brushCanvas: HTMLCanvasElement | null;
  isDrawingStroke: boolean;
  // Track mouse position for immediate cursor display
  lastMousePosition: { x: number; y: number } | null;
}

// Douglas-Peucker algorithm for simplifying brush strokes
function perpendicularDistance(
  point: {x: number; y: number},
  lineStart: {x: number; y: number},
  lineEnd: {x: number; y: number}
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared
  ));

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function douglasPeucker(
  points: Array<{x: number; y: number}>,
  epsilon: number
): Array<{x: number; y: number}> {
  if (points.length < 3) return points;

  let maxDistance = 0;
  let maxIndex = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDistance) {
      maxDistance = dist;
      maxIndex = i;
    }
  }

  if (maxDistance > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[end]];
}

// Uniform subsample to limit point count
function uniformSubsample<T>(points: T[], maxCount: number): T[] {
  if (points.length <= maxCount) return points;
  const step = points.length / maxCount;
  return Array.from({ length: maxCount }, (_, i) =>
    points[Math.floor(i * step)]
  );
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
    this.dragIntersectingIds = new Set();

    // Click-to-segment state
    this.segmentMode = false;
    this.segmentPoints = [];  // Array of { x, y, label } in image coordinates
    this.previewMaskCanvas = null;
    this.pointMarkersContainer = null;
    this.cursorOverlay = null;
    this.segmentPending = false;
    this.documentId = this.el.dataset.documentId || '';
    this.embeddingsReady = false;  // Whether SAM embeddings are computed for current image

    // Brush mode state
    this.brushSize = 20;  // Default brush size in image coordinates
    this.currentStroke = [];
    this.strokeHistory = [];
    this.brushCanvas = null;
    this.isDrawingStroke = false;
    this.lastMousePosition = null;

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

    // Track mouse position for immediate brush cursor display
    this.container.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.lastMousePosition = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    });

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
          if (this.segmentMode) return;
          const isOverMask = this.isPointOverSegmentMask(maskId, e, mask);
          if (isOverMask && this.hoveredMaskId !== maskId) {
            this.hoveredMaskId = maskId;
            this.updateHighlight();
          } else if (!isOverMask && this.hoveredMaskId === maskId) {
            this.hoveredMaskId = null;
            this.updateHighlight();
          }
        };

        mask.onmouseleave = () => {
          if (this.segmentMode) return;
          if (this.hoveredMaskId === maskId) {
            this.hoveredMaskId = null;
            this.updateHighlight();
          }
        };
      } else {
        // For text regions, use simple bounding box hover
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
      }

      // Click handler - for segments, also check mask pixels
      mask.onclick = (e: MouseEvent) => {
        if (this.segmentMode) return;

        // For segments, only register click if over actual mask
        if (isSegment && !this.isPointOverSegmentMask(maskId, e, mask)) {
          return; // Don't stop propagation - let click pass through
        }

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

  // Check if a point is over an opaque pixel of a segment mask using pre-computed alpha data
  isPointOverSegmentMask(maskId: string, e: MouseEvent, maskElement: HTMLElement): boolean {
    const cached = this.maskImageCache.get(maskId);
    if (!cached) {
      // Cache not loaded yet - fall back to bbox detection
      return true;
    }

    const { alphaData } = cached;

    // Get mouse position relative to the mask element
    const rect = maskElement.getBoundingClientRect();
    const displayX = e.clientX - rect.left;
    const displayY = e.clientY - rect.top;

    // Convert from display coordinates to alpha data coordinates
    const scaleX = alphaData.width / rect.width;
    const scaleY = alphaData.height / rect.height;
    const dataX = Math.floor(displayX * scaleX);
    const dataY = Math.floor(displayY * scaleY);

    // Check bounds
    if (dataX < 0 || dataX >= alphaData.width || dataY < 0 || dataY >= alphaData.height) {
      return false;
    }

    // Get alpha value from pre-computed data (RGBA, so alpha is every 4th byte starting at index 3)
    const pixelIndex = (dataY * alphaData.width + dataX) * 4;
    const alpha = alphaData.data[pixelIndex + 3];

    // Consider "over mask" if alpha is above a threshold
    return alpha > 10;
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

    // In segment mode, Enter confirms, Escape cancels, Backspace removes last stroke
    if (this.segmentMode) {
      if (e.key === 'Enter' && this.strokeHistory.length > 0) {
        e.preventDefault();
        this.confirmSegment();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this.exitSegmentMode();
        return;
      }

      // Backspace removes last stroke
      if (e.key === 'Backspace' && this.strokeHistory.length > 0) {
        e.preventDefault();
        this.removeLastStroke();
        return;
      }

      // [ decreases brush size
      if (e.key === '[') {
        e.preventDefault();
        this.brushSize = Math.max(5, this.brushSize - 5);
        console.log(`[MaskOverlay] Brush size: ${this.brushSize}`);
        return;
      }

      // ] increases brush size
      if (e.key === ']') {
        e.preventDefault();
        this.brushSize = Math.min(100, this.brushSize + 5);
        console.log(`[MaskOverlay] Brush size: ${this.brushSize}`);
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
    const hasHover = this.hoveredMaskId !== null;

    // In segment mode, disable pointer events on all masks
    if (this.segmentMode) {
      masks.forEach((mask: HTMLElement) => {
        mask.style.pointerEvents = 'none';
      });
    } else {
      masks.forEach((mask: HTMLElement) => {
        const maskId = mask.dataset.maskId || '';
        const isHovered = maskId === this.hoveredMaskId;
        const isSelected = this.selectedMaskIds.has(maskId);

        // Restore pointer events
        mask.style.pointerEvents = '';

        // Remove all state classes
        mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

        // Apply appropriate class (no dimming - other masks stay idle)
        if (isSelected) {
          mask.classList.add('mask-selected');
        } else if (isHovered) {
          mask.classList.add('mask-hovered');
        } else {
          mask.classList.add('mask-idle');
        }
      });
    }

    // Update cursor on container (hide in segment mode for brush cursor)
    if (this.segmentMode) {
      this.container.style.cursor = 'none';
    } else {
      this.container.style.cursor = hasHover ? 'pointer' : 'crosshair';
    }

    // Also update segment mask overlays
    this.updateSegmentMaskHighlight();
  },

  triggerShimmer() {
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    if (masks.length === 0) return;

    const shimmerCanvases: HTMLCanvasElement[] = [];

    masks.forEach((mask: HTMLElement) => {
      const maskType = mask.dataset.maskType;

      // For text regions, use CSS shimmer
      if (maskType !== 'object' && maskType !== 'manual') {
        mask.classList.add('mask-shimmer');
        return;
      }

      // For object/manual segments, create canvas-based shimmer with sweeping gradient
      const maskUrl = mask.dataset.maskUrl;
      if (!maskUrl) return;

      const bboxX = parseFloat(mask.dataset.bboxX || '0') || 0;
      const bboxY = parseFloat(mask.dataset.bboxY || '0') || 0;
      const bboxW = parseFloat(mask.dataset.bboxW || '0') || 0;
      const bboxH = parseFloat(mask.dataset.bboxH || '0') || 0;
      if (bboxW <= 0 || bboxH <= 0) return;

      // Create shimmer canvas
      const shimmerCanvas = document.createElement('canvas');
      shimmerCanvas.className = 'segment-shimmer-canvas';
      shimmerCanvas.width = bboxW;
      shimmerCanvas.height = bboxH;
      shimmerCanvas.style.cssText = `
        position: absolute;
        left: 0; top: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 10;
      `;
      mask.appendChild(shimmerCanvas);
      shimmerCanvases.push(shimmerCanvas);

      // Load mask and animate the sweeping gradient
      const maskImg = new Image();
      maskImg.crossOrigin = 'anonymous';
      maskImg.onload = () => {
        const ctx = shimmerCanvas.getContext('2d')!;
        const duration = 600;
        const startTime = performance.now();

        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);

          // Clear canvas
          ctx.clearRect(0, 0, bboxW, bboxH);

          // Draw the mask first (extracts bbox portion from full mask)
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(maskImg, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);

          // Use mask as clip, then draw gradient
          ctx.globalCompositeOperation = 'source-in';

          // Animated gradient position: starts at left (-100%), sweeps to right (200%)
          // CSS background-position 200%→-100% with 200% size visually sweeps left to right
          const gradientPos = -1 + (progress * 3); // -1 -> 2
          const centerX = gradientPos * bboxW;

          // Create gradient matching CSS 110deg angle
          // CSS: 0deg = up, clockwise. For canvas coordinates, use 110 - 90 = 20deg
          const angle = ((110 - 90) * Math.PI) / 180;
          const length = Math.max(bboxW, bboxH) * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          const gradient = ctx.createLinearGradient(
            centerX - cos * length / 2,
            -sin * length / 2,
            centerX + cos * length / 2,
            sin * length / 2
          );
          gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
          gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, bboxW, bboxH);

          // Fade out in last 25% (matching CSS animation)
          if (progress > 0.75) {
            shimmerCanvas.style.opacity = String(1 - ((progress - 0.75) / 0.25));
          }

          if (progress < 1) {
            requestAnimationFrame(animate);
          }
        };

        requestAnimationFrame(animate);
      };
      maskImg.src = maskUrl;
    });

    // Remove text shimmer and cleanup segment shimmer canvases after animation
    setTimeout(() => {
      masks.forEach((mask: HTMLElement) => {
        const maskType = mask.dataset.maskType;
        if (maskType !== 'object' && maskType !== 'manual') {
          mask.style.borderColor = 'transparent';
          mask.style.outlineColor = 'transparent';
        }
        mask.classList.remove('mask-shimmer');
      });

      // Remove shimmer canvases
      shimmerCanvases.forEach(canvas => canvas.remove());

      // Clean up inline styles after fade-out transition completes
      setTimeout(() => {
        masks.forEach((mask: HTMLElement) => {
          mask.style.removeProperty('border-color');
          mask.style.removeProperty('outline-color');
        });
      }, 200);
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
    if (e.button !== 0) return;  // Left click only

    // In segment mode, start a brush stroke (ignore mask regions)
    if (this.segmentMode) {
      this.startBrushStroke(e);
      return;
    }

    // Allow marquee to start from anywhere, including over mask regions.
    // The 5px drag threshold in updateDrag distinguishes between clicks and drags.
    // If user clicks without dragging, endDrag does nothing and the mask's
    // click handler fires to select that individual mask.

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
    // In segment mode, update brush stroke
    if (this.segmentMode && this.isDrawingStroke) {
      this.continueBrushStroke(e);
      return;
    }

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
    // In segment mode, finish brush stroke
    if (this.segmentMode && this.isDrawingStroke) {
      this.finishBrushStroke(e);
      return;
    }

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
    this.dragIntersectingIds = new Set();
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

    // Track intersecting IDs for segment mask hover effect
    this.dragIntersectingIds = previewSet;

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

    // Update segment mask canvas overlays to show hover effect for intersecting masks
    this.updateSegmentMaskHighlight();
  },

  // Render segment masks (type: 'object') as semi-transparent overlays
  renderSegmentMasks() {
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;

    // Track color index assignment for new masks
    let nextColorIndex = this.maskImageCache.size;

    masks.forEach((mask: HTMLElement) => {
      const maskType = mask.dataset.maskType;
      const maskUrl = mask.dataset.maskUrl;
      const maskId = mask.dataset.maskId || '';

      // Render canvas overlays for object/manual segments with mask URLs
      // - 'object': automatic segmentation
      // - 'manual': user click-to-segment
      if ((maskType !== 'object' && maskType !== 'manual') || !maskUrl) return;

      // Check if already rendered
      if (this.maskImageCache.has(maskId)) return;

      // Assign a color index for this mask
      const colorIndex = nextColorIndex % MASK_COLORS.length;
      nextColorIndex++;

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

        // Extract alpha data before applying any fill (for dynamic recoloring)
        const alphaData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Style the canvas
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = '0';
        canvas.style.transition = 'opacity 0.15s';

        // Position to fill the mask-region (which is already positioned at bbox)
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        // Insert canvas inside the mask div
        mask.appendChild(canvas);

        // Cache canvas, alpha data, and color assignment
        this.maskImageCache.set(maskId, { canvas, alphaData, colorIndex });
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

  // Generate circular offsets for drawing stroke outline
  getStrokeOffsets(strokeWidth: number): Array<[number, number]> {
    const offsets: Array<[number, number]> = [];
    // Create circular offset pattern for smooth outline
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const dx = Math.round(Math.cos(angle) * strokeWidth);
      const dy = Math.round(Math.sin(angle) * strokeWidth);
      // Avoid duplicates
      if (!offsets.some(([x, y]) => x === dx && y === dy)) {
        offsets.push([dx, dy]);
      }
    }
    return offsets;
  },

  // Draw mask with crisp colored outline and semi-transparent fill (Meta SAM style)
  // Creates a proper stroke by: dilating mask -> coloring -> subtracting original -> adding fill
  applyMaskWithOutline(
    maskId: string,
    fillColor: string,
    strokeColor: string,
    strokeWidth: number = 3
  ) {
    const cached = this.maskImageCache.get(maskId);
    if (!cached) return;

    const { canvas, alphaData } = cached;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Create temp canvas for the original mask shape
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const maskCtx = maskCanvas.getContext('2d')!;
    maskCtx.putImageData(alphaData, 0, 0);

    // Create stroke layer: dilated mask minus original = outline only
    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = w;
    strokeCanvas.height = h;
    const strokeCtx = strokeCanvas.getContext('2d')!;

    // Draw dilated mask (multiple offset copies)
    const offsets = this.getStrokeOffsets(strokeWidth);
    for (const [dx, dy] of offsets) {
      strokeCtx.drawImage(maskCanvas, dx, dy);
    }

    // Cut out the original mask to leave only the stroke outline
    strokeCtx.globalCompositeOperation = 'destination-out';
    strokeCtx.drawImage(maskCanvas, 0, 0);

    // Apply stroke color to the outline
    strokeCtx.globalCompositeOperation = 'source-in';
    strokeCtx.fillStyle = strokeColor;
    strokeCtx.fillRect(0, 0, w, h);

    // Create fill layer: original mask with fill color
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = w;
    fillCanvas.height = h;
    const fillCtx = fillCanvas.getContext('2d')!;
    fillCtx.putImageData(alphaData, 0, 0);
    fillCtx.globalCompositeOperation = 'source-in';
    fillCtx.fillStyle = fillColor;
    fillCtx.fillRect(0, 0, w, h);

    // Composite final result: stroke outline + fill
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(strokeCanvas, 0, 0);  // Stroke outline first
    ctx.drawImage(fillCanvas, 0, 0);    // Fill on top
  },

  // Update segment mask visibility and styling
  // Uses canvas-based crisp outlines with unique per-mask colors
  updateSegmentMaskHighlight() {
    this.maskImageCache.forEach((cached: CachedMask, maskId: string) => {
      const canvas = cached.canvas;
      const isHovered = maskId === this.hoveredMaskId || this.dragIntersectingIds.has(maskId);
      const isSelected = this.selectedMaskIds.has(maskId);

      if (isSelected) {
        // Selected: colored fill + colored outline using mask's assigned color
        const color = MASK_COLORS[cached.colorIndex];
        this.applyMaskWithOutline(maskId, color.fill, color.stroke, 3);
        canvas.style.opacity = '1';
      } else if (isHovered) {
        // Hover: white/neutral fill + white outline
        this.applyMaskWithOutline(maskId, HOVER_COLOR.fill, HOVER_COLOR.stroke, 2);
        canvas.style.opacity = '1';
      } else {
        // Idle: hidden
        canvas.style.opacity = '0';
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

    // Dim existing masks and disable pointer events
    const masks = this.container.querySelectorAll('.mask-region') as NodeListOf<HTMLElement>;
    masks.forEach((mask: HTMLElement) => {
      mask.classList.add('mask-dimmed');
    });
    this.updateHighlight();

    // Get the protected container that LiveView won't touch
    const jsContainer = document.getElementById('js-overlay-container');

    // Create point markers container
    if (!this.pointMarkersContainer && jsContainer) {
      this.pointMarkersContainer = document.createElement('div');
      this.pointMarkersContainer.className = 'segment-point-markers';
      this.pointMarkersContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 100;';
      jsContainer.appendChild(this.pointMarkersContainer);
    }

    // Create brush cursor overlay (circular indicator that follows mouse)
    if (!this.cursorOverlay && jsContainer) {
      this.cursorOverlay = document.createElement('div');
      this.cursorOverlay.className = 'brush-cursor';
      this.cursorOverlay.style.cssText = `
        position: absolute;
        pointer-events: none;
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
        z-index: 200;
        display: none;
        transform: translate(-50%, -50%);
      `;
      jsContainer.appendChild(this.cursorOverlay);

      // Add mousemove listener for brush cursor
      this.container.addEventListener('mousemove', (e: MouseEvent) => {
        if (!this.segmentMode || !this.cursorOverlay) return;
        this.updateBrushCursor(e);
      });

      // Show/hide cursor on enter/leave
      this.container.addEventListener('mouseenter', () => {
        if (this.segmentMode && this.cursorOverlay) {
          this.cursorOverlay.style.display = 'block';
        }
      });
      this.container.addEventListener('mouseleave', () => {
        if (this.cursorOverlay) {
          this.cursorOverlay.style.display = 'none';
        }
      });
    }

    // Immediately show brush cursor at last known position
    if (this.cursorOverlay && this.lastMousePosition) {
      const img = document.getElementById('editor-image') as HTMLImageElement | null;
      if (img) {
        const displayWidth = img.clientWidth;
        const naturalWidth = img.naturalWidth || this.imageWidth;
        const displayBrushSize = (this.brushSize / naturalWidth) * displayWidth;

        this.cursorOverlay.style.left = `${this.lastMousePosition.x}px`;
        this.cursorOverlay.style.top = `${this.lastMousePosition.y}px`;
        this.cursorOverlay.style.width = `${displayBrushSize}px`;
        this.cursorOverlay.style.height = `${displayBrushSize}px`;
        this.cursorOverlay.style.display = 'block';
      }
    }

    // Hide default cursor in segment mode
    this.container.style.cursor = 'none';

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

    // Clear brush state
    this.currentStroke = [];
    this.strokeHistory = [];
    this.isDrawingStroke = false;

    // Update visual state
    this.container.classList.remove('segment-mode');

    // Clear point markers
    if (this.pointMarkersContainer) {
      this.pointMarkersContainer.innerHTML = '';
    }

    // Remove brush canvas
    if (this.brushCanvas) {
      this.brushCanvas.remove();
      this.brushCanvas = null;
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
    // In segment mode, brush strokes handle interaction via mousedown/move/up
    // Just stop propagation so masks don't receive clicks
    if (this.segmentMode) {
      e.stopPropagation();
      return;
    }
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

    // Check if embeddings are ready when using local inference
    if (inferenceProvider && !isExtensionAvailable() && !this.embeddingsReady) {
      console.warn('[MaskOverlay] Embeddings not ready yet, skipping segment request');
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

  // ============ Brush Stroke Methods ============

  updateBrushCursor(e: MouseEvent) {
    if (!this.cursorOverlay) return;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const containerRect = this.container.getBoundingClientRect();
    const displayX = e.clientX - containerRect.left;
    const displayY = e.clientY - containerRect.top;

    // Calculate brush size in display coordinates
    const displayWidth = img.clientWidth;
    const naturalWidth = img.naturalWidth || this.imageWidth;
    const displayBrushSize = (this.brushSize / naturalWidth) * displayWidth;

    // Update cursor position and size
    this.cursorOverlay.style.left = `${displayX}px`;
    this.cursorOverlay.style.top = `${displayY}px`;
    this.cursorOverlay.style.width = `${displayBrushSize}px`;
    this.cursorOverlay.style.height = `${displayBrushSize}px`;
    this.cursorOverlay.style.display = 'block';
  },

  startBrushStroke(e: MouseEvent) {
    const point = this.getImageCoordinates(e);
    if (!point) return;

    const label = e.shiftKey ? 0 : 1;  // Shift = negative, normal = positive

    this.isDrawingStroke = true;
    this.currentStroke = [{ x: point.x, y: point.y, label }];

    // Create brush canvas if needed
    if (!this.brushCanvas) {
      this.createBrushCanvas();
    }

    // Start drawing the stroke visual
    this.drawBrushPoint(point.x, point.y, label);
  },

  continueBrushStroke(e: MouseEvent) {
    if (!this.isDrawingStroke || this.currentStroke.length === 0) return;

    const point = this.getImageCoordinates(e);
    if (!point) return;

    const label = this.currentStroke[0].label;
    this.currentStroke.push({ x: point.x, y: point.y, label });

    // Draw the stroke visual
    this.drawBrushPoint(point.x, point.y, label);
  },

  finishBrushStroke(_e: MouseEvent) {
    if (!this.isDrawingStroke || this.currentStroke.length === 0) {
      this.isDrawingStroke = false;
      return;
    }

    this.isDrawingStroke = false;

    // Create stroke object
    const stroke: BrushStroke = {
      id: `stroke_${Date.now()}`,
      rawPoints: this.currentStroke.map((p: {x: number; y: number; label: number}) => ({ x: p.x, y: p.y })),
      sampledPoints: [],
      label: this.currentStroke[0].label,
      brushSize: this.brushSize
    };

    // Sample points from stroke using Douglas-Peucker
    stroke.sampledPoints = this.sampleStrokePoints(stroke);

    // Add to history
    this.strokeHistory.push(stroke);
    this.currentStroke = [];

    // Trigger segmentation with all strokes
    this.requestSegmentFromStrokes();
  },

  sampleStrokePoints(stroke: BrushStroke): SegmentPoint[] {
    // For single clicks (< 3 points), just use the first point
    if (stroke.rawPoints.length < 3) {
      return [{
        x: stroke.rawPoints[0].x,
        y: stroke.rawPoints[0].y,
        label: stroke.label
      }];
    }

    // Simplify with Douglas-Peucker (epsilon based on brush size)
    const epsilon = Math.max(5, stroke.brushSize / 4);
    const simplified = douglasPeucker(stroke.rawPoints, epsilon);

    // Limit to max 5 points per stroke
    const maxPointsPerStroke = 5;
    const sampled = uniformSubsample(simplified, maxPointsPerStroke);

    // Convert to SegmentPoint format
    return sampled.map(p => ({ x: p.x, y: p.y, label: stroke.label }));
  },

  getAllSampledPoints(): SegmentPoint[] {
    // Combine all strokes
    const allPoints = this.strokeHistory.flatMap((s: BrushStroke) => s.sampledPoints);

    // Limit total to 10 points for SAM
    return uniformSubsample(allPoints, 10);
  },

  removeLastStroke() {
    if (this.strokeHistory.length === 0) return;

    this.strokeHistory.pop();

    // Redraw stroke visuals
    this.redrawAllStrokes();

    // Update segment points for compatibility
    this.segmentPoints = this.getAllSampledPoints();

    if (this.strokeHistory.length > 0) {
      // Re-run segmentation with remaining strokes
      this.requestSegmentFromStrokes();
    } else {
      // No strokes left, clear preview
      if (this.previewMaskCanvas) {
        this.previewMaskCanvas.remove();
        this.previewMaskCanvas = null;
      }
    }

    console.log(`[MaskOverlay] Removed stroke, ${this.strokeHistory.length} strokes remaining`);
  },

  createBrushCanvas() {
    const jsContainer = document.getElementById('js-overlay-container');
    if (!jsContainer) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'brush-stroke-canvas';
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 60;
    `;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (img) {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;
    }

    jsContainer.appendChild(canvas);
    this.brushCanvas = canvas;
  },

  drawBrushPoint(imgX: number, imgY: number, label: number) {
    if (!this.brushCanvas) return;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!img) return;

    const ctx = this.brushCanvas.getContext('2d');
    if (!ctx) return;

    // Convert image coordinates to display coordinates
    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth || this.imageWidth;
    const naturalHeight = img.naturalHeight || this.imageHeight;

    const displayX = (imgX / naturalWidth) * displayWidth;
    const displayY = (imgY / naturalHeight) * displayHeight;
    const displayRadius = (this.brushSize / naturalWidth) * displayWidth;

    // Draw filled circle with stroke color
    ctx.beginPath();
    ctx.arc(displayX, displayY, Math.max(2, displayRadius / 2), 0, Math.PI * 2);
    ctx.fillStyle = label === 1 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
    ctx.fill();
  },

  redrawAllStrokes() {
    if (!this.brushCanvas) return;

    const ctx = this.brushCanvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, this.brushCanvas.width, this.brushCanvas.height);

    // Redraw all strokes from history
    for (const stroke of this.strokeHistory) {
      for (const point of stroke.rawPoints) {
        this.drawBrushPoint(point.x, point.y, stroke.label);
      }
    }
  },

  async requestSegmentFromStrokes() {
    if (this.strokeHistory.length === 0) return;
    if (!this.documentId) {
      console.warn('[MaskOverlay] No document ID for segmentation');
      return;
    }

    // Check if embeddings are ready when using local inference
    if (inferenceProvider && !isExtensionAvailable() && !this.embeddingsReady) {
      console.warn('[MaskOverlay] Embeddings not ready yet, skipping segment request');
      return;
    }

    this.segmentPending = true;

    // Get sampled points from all strokes
    const sampledPoints = this.getAllSampledPoints();

    // Also update legacy segmentPoints for compatibility
    this.segmentPoints = sampledPoints;

    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    const actualWidth = img?.naturalWidth || this.imageWidth;
    const actualHeight = img?.naturalHeight || this.imageHeight;

    console.log(`[MaskOverlay] Requesting segment with ${sampledPoints.length} points from ${this.strokeHistory.length} strokes`);

    try {
      let response: SegmentResponse;

      // Use inference provider if available
      if (inferenceProvider && !isExtensionAvailable()) {
        const result = await inferenceProvider.segmentAtPoints(
          this.documentId,
          sampledPoints as PointPrompt[],
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
            points: sampledPoints,
            imageSize: { width: actualWidth, height: actualHeight },
            requestId
          }, '*');
        });
      }

      if (response.success && (response.mask || response.mask_png)) {
        // Normalize response format
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

  async confirmSegment() {
    if (this.segmentPoints.length === 0 && this.strokeHistory.length === 0) return;
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
