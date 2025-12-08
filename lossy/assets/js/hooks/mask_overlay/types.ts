/**
 * Type Definitions for MaskOverlay Hook
 *
 * Centralized type definitions, interfaces, and constants for the mask overlay system.
 * Includes state management, mask data structures, and visual styling constants.
 */

import type { BoundingBox } from '../../ml/types';
import type { MLCoordinator } from './ml-coordinator';
import type { PendingMaskManager } from './pending-mask';

// ============ Smart Select State ============

/**
 * Smart Select context - simplified state for Smart Select.
 * Uses simple boolean flags instead of complex state machine.
 */
export interface SmartSelectContext {
  // Simple on/off (replaces complex state machine)
  active: boolean;
  // Current cursor position in container coordinates
  lastMouse: { x: number; y: number } | null;
  // Locked points from clicks (for multi-point segmentation)
  lockedPoints: SegmentPoint[];
  // Currently spotlighted existing mask (if any)
  spotlightedMaskId: string | null;
  spotlightHitType: 'pixel' | 'bbox' | null;
  spotlightMaskType: 'text' | 'object' | 'manual' | null;
  textCutoutEl: HTMLDivElement | null;
  // Preview mask data ready for confirmation
  lastMaskData: MaskData | null;
  // Is a segmentation request currently running?
  inFlight: boolean;
  // Should we segment when inFlight clears?
  needsSegment: boolean;
  // Timer handle for update loop
  loopIntervalId: number | null;
  // DOM refs
  spotlightOverlay: HTMLDivElement | null;
  pointMarkersContainer: HTMLDivElement | null;
  previewCanvas: HTMLCanvasElement | null;
  statusEl: HTMLDivElement | null;
}

/**
 * Create a fresh Smart Select context
 */
export function createSmartSelectContext(): SmartSelectContext {
  return {
    active: false,
    lastMouse: null,
    lockedPoints: [],
    spotlightedMaskId: null,
    spotlightHitType: null,
    spotlightMaskType: null,
    textCutoutEl: null,
    lastMaskData: null,
    inFlight: false,
    needsSegment: false,
    loopIntervalId: null,
    spotlightOverlay: null,
    pointMarkersContainer: null,
    previewCanvas: null,
    statusEl: null,
  };
}

// ============ Response Types ============

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

// ============ Segment Types ============

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

/**
 * MaskOverlay hook state.
 * Smart Select state is consolidated in SmartSelectContext.
 */
export interface MaskOverlayState {
  container: HTMLElement;
  hoveredMaskId: string | null;
  selectedMaskIds: Set<string>;
  maskImageCache: Map<string, CachedMask>;
  maskCacheReady: boolean;
  maskCacheReadyPromise: Promise<void> | null;
  pageLoadTime: number;
  shimmerPlayedAt: number | null;
  textDetectionTimestamp: number | null;
  textDetectionPromise: Promise<void> | null;

  // Coordinators (Phase 3 refactor)
  mlCoordinator: MLCoordinator | null;
  pendingMaskManager: PendingMaskManager | null;

  // Drag selection
  isDragging: boolean;
  dragStart: DragStart | null;
  dragRect: HTMLDivElement | null;
  dragShift: boolean;
  dragIntersectingIds: Set<string>;

  // Smart Select context
  smartSelectCtx: SmartSelectContext | null;

  // Core document data
  documentId: string;
  embeddingsReady: boolean;
  embeddingsComputePromise: Promise<void> | null;
  imageWidth: number;
  imageHeight: number;
  imageReadyPromise: Promise<void> | null;

  // Mouse position tracking (for Smart Select)
  lastMousePosition: { x: number; y: number } | null;
  shiftKeyHeld: boolean;

  // Segment confirmation tracking
  pendingSegmentConfirm: boolean;
  previousMaskIds: Set<string>;

  // Pending mask state (for new segments awaiting confirmation)
  pendingMask: MaskData | null;
  pendingMaskElement: HTMLDivElement | null;
  marchAntsOffset: number;
  marchAntsLoopId: number | null;

  // DOM/event handlers
  resizeObserver: ResizeObserver | null;
  mouseDownHandler: (e: MouseEvent) => void;
  mouseMoveHandler: (e: MouseEvent) => void;
  mouseUpHandler: (e: MouseEvent) => void;
  containerClickHandler: (e: MouseEvent) => void;
  keydownHandler: (e: KeyboardEvent) => void;
  smartSelectKeydownHandler: (e: KeyboardEvent) => void;
  smartSelectKeyupHandler: (e: KeyboardEvent) => void;
  shiftKeyHandler: (e: KeyboardEvent) => void;
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
