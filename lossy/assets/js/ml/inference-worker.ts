/**
 * ML Inference Web Worker
 *
 * Single worker managing all models (mirrors extension's offscreen document pattern):
 * - Text detection (DBNet)
 * - SAM 2 encoder (image -> embeddings + high-res features)
 * - SAM 2 decoder (embeddings + points -> masks)
 * - Embedding cache in worker memory (Map<documentId, Sam2Embeddings>)
 */

import { detectTextRegions } from './text-detection';
import { getImageEmbeddings, segmentAtPoints, type Sam2Embeddings } from './object-segmentation';
import { maskToPngAsync } from './mask-utils';
import { getBackend, isWebGPUAvailable } from './sessions';
import type {
  WorkerMessage,
  WorkerResponse,
  WorkerResponseInitComplete,
  WorkerResponseTextDetected,
  WorkerResponseEmbeddingsReady,
  WorkerResponseSegmentResult,
  WorkerResponseError,
  WorkerResponseProgress,
} from './types';

// Embedding cache: documentId -> Sam2Embeddings (includes image_embed + high_res_feats)
const embeddingCache = new Map<string, Sam2Embeddings>();

// Track initialization state
let initialized = false;

/**
 * Send a response back to the main thread
 */
function sendResponse(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * Send progress update to main thread
 */
function sendProgress(stage: string, progress: number): void {
  const response: WorkerResponseProgress = {
    type: 'PROGRESS',
    stage,
    progress,
  };
  sendResponse(response);
}

/**
 * Send error response
 */
function sendError(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const response: WorkerResponseError = {
    type: 'ERROR',
    id,
    error: message,
  };
  sendResponse(response);
}

/**
 * Handle INIT message - warm up the worker
 */
async function handleInit(id: string): Promise<void> {
  if (initialized) {
    console.log('[Worker] Already initialized');
    // Still send response so the promise resolves
    // Check actual backend if model loaded, otherwise check WebGPU availability
    const actualBackend = getBackend('textDetection') || getBackend('samEncoder');
    const backend = actualBackend || (await isWebGPUAvailable() ? 'webgpu' : 'wasm');
    sendResponse({ type: 'INIT_COMPLETE', id, backend } as WorkerResponseInitComplete & { id: string });
    return;
  }

  console.log('[Worker] Initializing ML inference worker...');
  sendProgress('initializing', 0);

  // We don't preload models here - they load lazily on first use
  // This keeps initialization fast
  initialized = true;

  // Check WebGPU availability to report the intended backend
  // Models will use WebGPU when available, falling back to WASM only if needed
  const webgpuAvailable = await isWebGPUAvailable();
  const backend = webgpuAvailable ? 'webgpu' : 'wasm';

  // Include id so the client can resolve the promise
  sendResponse({ type: 'INIT_COMPLETE', id, backend } as WorkerResponseInitComplete & { id: string });

  console.log('[Worker] Initialized');
}

/**
 * Handle DETECT_TEXT message
 */
async function handleDetectText(id: string, imageData: ImageData): Promise<void> {
  console.log(`[Worker] Detecting text in ${imageData.width}x${imageData.height} image...`);
  sendProgress('loading_text_model', 0);

  const result = await detectTextRegions(imageData, imageData.width, imageData.height);

  const response: WorkerResponseTextDetected = {
    type: 'TEXT_DETECTED',
    id,
    regions: result.regions,
    inferenceTimeMs: result.inferenceTimeMs,
    backend: result.backend,
  };
  sendResponse(response);
}

/**
 * Handle COMPUTE_EMBEDDINGS message
 */
async function handleComputeEmbeddings(
  id: string,
  documentId: string,
  imageData: ImageData
): Promise<void> {
  console.log(`[Worker] Computing SAM 2 embeddings for document ${documentId}...`);
  sendProgress('loading_encoder', 0);

  const result = await getImageEmbeddings(imageData);

  // Cache embeddings for this document (includes image_embed + high_res_feats)
  embeddingCache.set(documentId, result.embeddings);

  // Calculate total size of all embedding tensors
  const totalBytes =
    result.embeddings.imageEmbed.byteLength +
    result.embeddings.highResFeats0.byteLength +
    result.embeddings.highResFeats1.byteLength;
  console.log(`[Worker] SAM 2 embeddings cached for document ${documentId} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);

  const response: WorkerResponseEmbeddingsReady = {
    type: 'EMBEDDINGS_READY',
    id,
    documentId,
    inferenceTimeMs: result.inferenceTimeMs,
  };
  sendResponse(response);
}

/**
 * Handle SEGMENT_AT_POINTS message
 */
async function handleSegmentAtPoints(
  id: string,
  documentId: string,
  points: Array<{ x: number; y: number; label: number }>,
  imageSize: { width: number; height: number }
): Promise<void> {
  console.log(`[Worker] SAM 2 segmenting at ${points.length} points for document ${documentId}...`);

  // Get cached embeddings
  const embeddings = embeddingCache.get(documentId);
  if (!embeddings) {
    throw new Error(`No embeddings cached for document ${documentId}. Call COMPUTE_EMBEDDINGS first.`);
  }

  sendProgress('segmenting', 0);

  const result = await segmentAtPoints(embeddings, points, imageSize);

  // Convert mask to PNG
  sendProgress('encoding_mask', 0.8);
  const mask_png = await maskToPngAsync(result.mask, imageSize.width, imageSize.height);

  const response: WorkerResponseSegmentResult = {
    type: 'SEGMENT_RESULT',
    id,
    mask_png,
    bbox: result.bbox,
    score: result.score,
    area: result.area,
  };
  sendResponse(response);
}

/**
 * Handle CLEAR_EMBEDDINGS message
 */
function handleClearEmbeddings(documentId: string): void {
  if (embeddingCache.has(documentId)) {
    embeddingCache.delete(documentId);
    console.log(`[Worker] Cleared embeddings for document ${documentId}`);
  }
}

/**
 * Main message handler
 */
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'INIT':
        await handleInit(message.id);
        break;

      case 'DETECT_TEXT':
        await handleDetectText(message.id, message.imageData);
        break;

      case 'COMPUTE_EMBEDDINGS':
        await handleComputeEmbeddings(message.id, message.documentId, message.imageData);
        break;

      case 'SEGMENT_AT_POINTS':
        await handleSegmentAtPoints(
          message.id,
          message.documentId,
          message.points,
          message.imageSize
        );
        break;

      case 'CLEAR_EMBEDDINGS':
        handleClearEmbeddings(message.documentId);
        break;

      default:
        console.warn('[Worker] Unknown message type:', (message as { type: string }).type);
    }
  } catch (error) {
    console.error('[Worker] Error handling message:', error);
    // Extract ID from message if available
    const id = 'id' in message ? (message as { id: string }).id : 'unknown';
    sendError(id, error);
  }
};

// Signal that the worker is ready
console.log('[Worker] ML inference worker loaded');
