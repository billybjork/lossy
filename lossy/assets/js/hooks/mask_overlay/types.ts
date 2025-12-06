/**
 * Type Definitions for MaskOverlay Hook
 *
 * Centralized type definitions, interfaces, and constants for the mask overlay system.
 * Includes state management, mask data structures, and visual styling constants.
 */

import type { BoundingBox } from '../../ml/types';

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

export interface BrushStroke {
  id: string;
  rawPoints: Array<{x: number; y: number}>;
  sampledPoints: SegmentPoint[];
  label: number;  // 1 = positive, 0 = negative
  brushSize: number;
}

// ============ Rendering Types ============

export interface CachedMask {
  canvas: HTMLCanvasElement;
  alphaData: ImageData;
  colorIndex: number;
}

// ============ Hook State ============

export interface MaskOverlayState {
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
  commandKeySegmentMode: boolean;
  commandKeySpotlightMode: boolean;
  awaitingMaskConfirmation: boolean;
  segmentPoints: SegmentPoint[];
  previewMaskCanvas: HTMLCanvasElement | null;
  lastMaskData: MaskData | null;
  marchingAntsCanvas: HTMLCanvasElement | null;
  marchingAntsAnimationId: number | null;
  pointMarkersContainer: HTMLDivElement | null;
  cursorOverlay: HTMLDivElement | null;
  segmentPending: boolean;
  // Spotlight effect state (for Command key spotlight mode)
  spotlightOverlay: HTMLDivElement | null;
  spotlightedMaskId: string | null;
  spotlightDebounceId: number | null;
  documentId: string;
  embeddingsReady: boolean;
  imageWidth: number;
  imageHeight: number;
  resizeObserver: ResizeObserver | null;
  mouseDownHandler: (e: MouseEvent) => void;
  mouseMoveHandler: (e: MouseEvent) => void;
  mouseUpHandler: (e: MouseEvent) => void;
  containerClickHandler: (e: MouseEvent) => void;
  keydownHandler: (e: KeyboardEvent) => void;
  spaceKeydownHandler: (e: KeyboardEvent) => void;
  spaceKeyupHandler: (e: KeyboardEvent) => void;
  // Brush mode state
  brushSize: number;
  currentStroke: Array<{x: number; y: number; label: number}>;
  strokeHistory: BrushStroke[];
  brushCanvas: HTMLCanvasElement | null;
  isDrawingStroke: boolean;
  // Track mouse position for immediate cursor display
  lastMousePosition: { x: number; y: number } | null;
  // Track when we're confirming a new segment to shimmer it
  pendingSegmentConfirm: boolean;
  previousMaskIds: Set<string>;
  // Live segmentation state (for continuous inference during brush strokes)
  liveSegmentDebounceId: number | null;
  lastLiveSegmentRequestId: string | null;
  liveSegmentInProgress: boolean;
  lastLiveSegmentTime: number;
  // Segment mode event listener tracking for proper cleanup
  segmentModeCursorMoveHandler: ((e: MouseEvent) => void) | null;
  segmentModeEnterHandler: (() => void) | null;
  segmentModeLeaveHandler: (() => void) | null;
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
