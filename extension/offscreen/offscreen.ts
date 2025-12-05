/**
 * Offscreen document for running ONNX inference
 *
 * Service workers can't use dynamic imports, but offscreen documents can.
 * This runs text detection and object segmentation models.
 */

import {
  detectTextRegions,
  imageDataFromDataUrl,
  imageDataFromUrl,
  type DetectionResult,
} from '../lib/text-detection';
import {
  getImageEmbeddings,
  segmentAtPoints,
  type PointPrompt,
} from '../lib/object-segmentation';
import { maskToPngAsync } from '../lib/mask-utils';

// Type definitions for messages
interface DetectTextMessage {
  type: 'DETECT_TEXT';
  payload: {
    capture_mode: string;
    image_data?: string;
    image_url?: string;
  };
}

interface DetectAllMessage {
  type: 'DETECT_ALL';
  payload: {
    capture_mode: string;
    image_data?: string;
    image_url?: string;
  };
}

interface SegmentAtPointMessage {
  type: 'OFFSCREEN_SEGMENT_AT_POINT';
  payload: {
    embeddings: string; // Base64 encoded Float32Array
    point: { x: number; y: number };
    imageSize: { width: number; height: number };
  };
}

interface SegmentAtPointsMessage {
  type: 'OFFSCREEN_SEGMENT_AT_POINTS';
  payload: {
    embeddings: string; // Base64 encoded Float32Array
    points: Array<{ x: number; y: number; label: number }>;
    imageSize: { width: number; height: number };
  };
}

type Message = DetectTextMessage | DetectAllMessage | SegmentAtPointMessage | SegmentAtPointsMessage;

// Combined detection result (no automatic masks, only embeddings for click-to-segment)
export interface CombinedDetectionResult {
  text: DetectionResult | null;
  embeddings: {
    data: string; // Base64 for storing in service worker
    inferenceTimeMs: number;
    backend: 'webgpu' | 'wasm' | null;
    imageSize: { width: number; height: number };
  } | null;
}

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener(
  (message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    switch (message.type) {
      case 'DETECT_TEXT':
        handleTextDetection(message.payload)
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'DETECT_ALL':
        handleCombinedDetection(message.payload)
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'OFFSCREEN_SEGMENT_AT_POINT':
        handleSegmentAtPoint(message.payload)
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'OFFSCREEN_SEGMENT_AT_POINTS':
        handleSegmentAtPoints(message.payload)
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      default:
        return false;
    }
  }
);

/**
 * Load image data from payload
 */
async function loadImageData(payload: {
  capture_mode: string;
  image_data?: string;
  image_url?: string;
}): Promise<ImageData | null> {
  if (payload.capture_mode === 'screenshot' && payload.image_data) {
    console.log('[Lossy Offscreen] Loading image from data URL...');
    return await imageDataFromDataUrl(payload.image_data);
  } else if (payload.image_url) {
    console.log('[Lossy Offscreen] Loading image from URL:', payload.image_url);
    return await imageDataFromUrl(payload.image_url);
  }
  return null;
}

/**
 * Handle text-only detection (original behavior)
 */
async function handleTextDetection(payload: {
  capture_mode: string;
  image_data?: string;
  image_url?: string;
}): Promise<DetectionResult | null> {
  console.log('[Lossy Offscreen] Starting text detection...', {
    capture_mode: payload.capture_mode,
    has_image_data: !!payload.image_data,
    has_image_url: !!payload.image_url,
  });

  const imageData = await loadImageData(payload);
  if (!imageData) {
    console.log('[Lossy Offscreen] No image data available');
    return null;
  }

  console.log('[Lossy Offscreen] Image loaded:', imageData.width, 'x', imageData.height);
  console.log('[Lossy Offscreen] Running text inference...');

  const result = await detectTextRegions(imageData, imageData.width, imageData.height);
  console.log('[Lossy Offscreen] Text detection complete:', result.regions.length, 'regions');

  return result;
}

/**
 * Handle combined text detection + embedding extraction
 * No automatic segmentation - masks are generated on-demand via click-to-segment
 */
async function handleCombinedDetection(payload: {
  capture_mode: string;
  image_data?: string;
  image_url?: string;
}): Promise<CombinedDetectionResult> {
  console.log('[Lossy Offscreen] Starting combined detection (text + embeddings)...');

  const imageData = await loadImageData(payload);
  if (!imageData) {
    console.log('[Lossy Offscreen] No image data available');
    return { text: null, embeddings: null };
  }

  console.log('[Lossy Offscreen] Image loaded:', imageData.width, 'x', imageData.height);

  // Run text detection first, then encoder (for click-to-segment embeddings)
  // (Parallel execution causes ONNX session conflicts)
  let textResult: DetectionResult | null = null;
  let embeddingsResult: { embeddings: Float32Array; inferenceTimeMs: number; backend: 'webgpu' | 'wasm' | null } | null = null;

  try {
    textResult = await detectTextRegions(imageData, imageData.width, imageData.height);
  } catch (error) {
    console.warn('[Lossy Offscreen] Text detection failed:', error);
  }

  try {
    embeddingsResult = await getImageEmbeddings(imageData);
  } catch (error) {
    console.warn('[Lossy Offscreen] Embedding extraction failed:', error);
  }

  console.log(
    '[Lossy Offscreen] Combined detection complete:',
    textResult?.regions.length ?? 0,
    'text regions,',
    embeddingsResult ? `embeddings in ${embeddingsResult.inferenceTimeMs.toFixed(0)}ms` : 'no embeddings'
  );

  // Encode embeddings as base64 for transmission
  let embeddingsPayload = null;
  if (embeddingsResult) {
    embeddingsPayload = {
      data: float32ArrayToBase64(embeddingsResult.embeddings),
      inferenceTimeMs: embeddingsResult.inferenceTimeMs,
      backend: embeddingsResult.backend,
      imageSize: { width: imageData.width, height: imageData.height },
    };
  }

  return {
    text: textResult,
    embeddings: embeddingsPayload,
  };
}

/**
 * Handle click-to-segment request using cached embeddings (single point, backwards compatible)
 */
async function handleSegmentAtPoint(payload: {
  embeddings: string;
  point: { x: number; y: number };
  imageSize: { width: number; height: number };
}): Promise<{
  mask_png: string;
  bbox: { x: number; y: number; w: number; h: number };
  score: number;
  stabilityScore: number;
  area: number;
}> {
  // Convert single point to multi-point format
  return handleSegmentAtPoints({
    embeddings: payload.embeddings,
    points: [{ x: payload.point.x, y: payload.point.y, label: 1 }],
    imageSize: payload.imageSize,
  });
}

/**
 * Handle multi-point segmentation request using cached embeddings
 */
async function handleSegmentAtPoints(payload: {
  embeddings: string;
  points: Array<{ x: number; y: number; label: number }>;
  imageSize: { width: number; height: number };
}): Promise<{
  mask_png: string;
  bbox: { x: number; y: number; w: number; h: number };
  score: number;
  stabilityScore: number;
  area: number;
}> {
  const positiveCount = payload.points.filter(p => p.label === 1).length;
  const negativeCount = payload.points.filter(p => p.label === 0).length;
  console.log(`[Lossy Offscreen] Segment with ${positiveCount} positive, ${negativeCount} negative points`);

  // Decode embeddings from base64
  const embeddings = base64ToFloat32Array(payload.embeddings);

  // Run decoder with all points
  const mask = await segmentAtPoints(embeddings, payload.points, payload.imageSize);

  // Convert mask to PNG
  const mask_png = await maskToPngAsync(
    mask.mask,
    payload.imageSize.width,
    payload.imageSize.height
  );

  return {
    mask_png,
    bbox: mask.bbox,
    score: mask.score,
    stabilityScore: mask.stabilityScore,
    area: mask.area,
  };
}

/**
 * Convert Float32Array to base64 string
 */
function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Float32Array
 */
function base64ToFloat32Array(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

console.log('[Lossy Offscreen] Document ready (text detection + click-to-segment)');
