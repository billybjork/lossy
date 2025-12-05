/**
 * Shared type definitions for ML inference
 */

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PointPrompt {
  x: number;
  y: number;
  label: number; // 1 = foreground (positive), 0 = background (negative)
}

export interface DetectedRegion {
  bbox: BoundingBox;
  polygon: Array<{ x: number; y: number }>;
  confidence: number;
}

export interface DetectionResult {
  regions: DetectedRegion[];
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}

export interface SegmentMask {
  mask: Uint8Array; // Binary mask at original resolution
  bbox: BoundingBox;
  score: number; // Predicted IoU score
  stabilityScore: number; // Mask stability under threshold changes
  area: number;
}

export interface SegmentationResult {
  masks: SegmentMask[];
  embeddings: Float32Array; // For click-to-segment
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}

// Worker message types
export type WorkerMessageType =
  | 'INIT'
  | 'DETECT_TEXT'
  | 'COMPUTE_EMBEDDINGS'
  | 'SEGMENT_AT_POINTS'
  | 'CLEAR_EMBEDDINGS';

export interface WorkerMessageInit {
  type: 'INIT';
  id: string;
}

export interface WorkerMessageDetectText {
  type: 'DETECT_TEXT';
  id: string;
  imageData: ImageData;
}

export interface WorkerMessageComputeEmbeddings {
  type: 'COMPUTE_EMBEDDINGS';
  id: string;
  documentId: string;
  imageData: ImageData;
}

export interface WorkerMessageSegmentAtPoints {
  type: 'SEGMENT_AT_POINTS';
  id: string;
  documentId: string;
  points: PointPrompt[];
  imageSize: { width: number; height: number };
}

export interface WorkerMessageClearEmbeddings {
  type: 'CLEAR_EMBEDDINGS';
  documentId: string;
}

export type WorkerMessage =
  | WorkerMessageInit
  | WorkerMessageDetectText
  | WorkerMessageComputeEmbeddings
  | WorkerMessageSegmentAtPoints
  | WorkerMessageClearEmbeddings;

// Worker response types
export interface WorkerResponseInitComplete {
  type: 'INIT_COMPLETE';
  backend: 'webgpu' | 'wasm';
}

export interface WorkerResponseTextDetected {
  type: 'TEXT_DETECTED';
  id: string;
  regions: DetectedRegion[];
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}

export interface WorkerResponseEmbeddingsReady {
  type: 'EMBEDDINGS_READY';
  id: string;
  documentId: string;
  inferenceTimeMs: number;
}

export interface WorkerResponseSegmentResult {
  type: 'SEGMENT_RESULT';
  id: string;
  mask_png: string;
  bbox: BoundingBox;
  score: number;
  area: number;
}

export interface WorkerResponseError {
  type: 'ERROR';
  id: string;
  error: string;
}

export interface WorkerResponseProgress {
  type: 'PROGRESS';
  stage: string;
  progress: number;
}

export type WorkerResponse =
  | WorkerResponseInitComplete
  | WorkerResponseTextDetected
  | WorkerResponseEmbeddingsReady
  | WorkerResponseSegmentResult
  | WorkerResponseError
  | WorkerResponseProgress;
