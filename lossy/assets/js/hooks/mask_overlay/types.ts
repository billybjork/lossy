/**
 * Type Definitions for MaskOverlay Hook
 *
 * Centralized type definitions, interfaces, and constants for the mask overlay system.
 * Includes state management, mask data structures, and visual styling constants.
 */

import type { BoundingBox, AutoSegmentMaskResult } from '../../ml/types';

// ============ Response Types ============

export interface SegmentResponse {
  success: boolean;
  mask?: MaskData;
  mask_png?: string;
  bbox?: BoundingBox;
  error?: string;
}

export interface MaskData {
  mask_png: string;
  bbox: BoundingBox;
}

// ============ Drag Selection Types ============

export interface DragStart {
  x: number;
  y: number;
}

export interface DragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ============ Segment Mode Types ============

export interface SegmentPoint {
  x: number;
  y: number;
  label: number;
}

// ============ Rendering Types ============

export interface CachedMask {
  canvas: HTMLCanvasElement;
  alphaData: ImageData;
  colorIndex: number;
  // Bounding box in image coordinates (for spotlight cutout)
  bbox: { x: number; y: number; w: number; h: number };
}

// ============ Hook State ============

export interface MaskOverlayState {
  container: HTMLElement;
  hoveredMaskId: string | null;
  selectedMaskIds: Set<string>;
  maskImageCache: Map<string, CachedMask>;
  maskCacheReady: boolean;
  maskCacheReadyPromise: Promise<void> | null;
  pageLoadTime: number;
  shimmerPlayed: boolean;
  isDragging: boolean;
  dragStart: DragStart | null;
  dragRect: HTMLDivElement | null;
  dragShift: boolean;
  dragIntersectingIds: Set<string>;
  // Segment mode: true when Command key is held
  segmentMode: boolean;
  previewMaskCanvas: HTMLCanvasElement | null;
  lastMaskData: MaskData | null;
  pointMarkersContainer: HTMLDivElement | null;
  segmentPending: boolean;
  // Spotlight overlay (dark background)
  spotlightOverlay: HTMLDivElement | null;
  // Status badge for segment mode feedback
  segmentStatusEl: HTMLDivElement | null;
  // Currently spotlighted existing mask (if any)
  spotlightedMaskId: string | null;
  spotlightedMaskHit?: 'pixel' | 'bbox';
  documentId: string;
  embeddingsReady: boolean;
  imageWidth: number;
  imageHeight: number;
  imageReadyPromise: Promise<void> | null;
  resizeObserver: ResizeObserver | null;
  mouseDownHandler: (e: MouseEvent) => void;
  mouseMoveHandler: (e: MouseEvent) => void;
  mouseUpHandler: (e: MouseEvent) => void;
  containerClickHandler: (e: MouseEvent) => void;
  keydownHandler: (e: KeyboardEvent) => void;
  segmentModeKeydownHandler: (e: KeyboardEvent) => void;
  segmentModeKeyupHandler: (e: KeyboardEvent) => void;
  shiftKeyHandler: (e: KeyboardEvent) => void;
  // Track mouse position for segment mode
  lastMousePosition: { x: number; y: number } | null;
  // Track when we're confirming a new segment to shimmer it
  pendingSegmentConfirm: boolean;
  previousMaskIds: Set<string>;
  // Live segmentation debounce and staleness detection
  liveSegmentDebounceId: number | null;
  lastLiveSegmentRequestId: string | null;
  // Auto-segmentation state
  autoSegmentInProgress: boolean;
  autoSegmentProgress: number;
  precomputedSegments: AutoSegmentMaskResult[];
  // Multi-point segment mode: locked/committed points from clicks
  lockedSegmentPoints: SegmentPoint[];
  // Track if Shift key is held (for negative point preview)
  shiftKeyHeld: boolean;
  // Retry handle for delayed spotlight checks
  atCursorRetryId: number | null;
  // Continuous reassessment loop during segment mode
  segmentUpdateIntervalId: number | null;
}

// ============ Color Constants ============

// Color palette for unique per-mask colors (Meta SAM style)
// Each mask gets assigned a color from this palette for visual distinction
// Bold, vibrant, high-contrast colors for utilitarian clarity
export const MASK_COLORS = [
  { fill: 'rgba(251, 146, 60, 0.5)', stroke: 'rgb(251, 146, 60)' },   // Orange
  { fill: 'rgba(59, 130, 246, 0.5)', stroke: 'rgb(59, 130, 246)' },   // Blue
  { fill: 'rgba(34, 197, 94, 0.5)', stroke: 'rgb(34, 197, 94)' },     // Green
  { fill: 'rgba(168, 85, 247, 0.5)', stroke: 'rgb(168, 85, 247)' },   // Purple
  { fill: 'rgba(236, 72, 153, 0.5)', stroke: 'rgb(236, 72, 153)' },   // Pink
  { fill: 'rgba(6, 182, 212, 0.5)', stroke: 'rgb(6, 182, 212)' },     // Cyan
  { fill: 'rgba(245, 158, 11, 0.5)', stroke: 'rgb(245, 158, 11)' },   // Amber
  { fill: 'rgba(99, 102, 241, 0.5)', stroke: 'rgb(99, 102, 241)' },   // Indigo
];

// Hover state uses intense fill overlay without borders for high visibility
export const HOVER_COLOR = { fill: 'rgba(255, 255, 255, 0.5)', stroke: 'rgb(255, 255, 255)' };
