/**
 * ML Inference Public API
 *
 * Re-exports the inference provider for use in the app.
 */

export {
  getInferenceProvider,
  isExtensionAvailable,
  clearProviderCache,
  type InferenceProvider,
} from './inference-provider';

export {
  inferenceClient,
  type TextDetectionResult,
  type SegmentResult,
} from './inference-client';

export type {
  BoundingBox,
  PointPrompt,
  DetectedRegion,
  DetectionResult,
  SegmentMask,
  SegmentationResult,
} from './types';
