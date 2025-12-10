/**
 * Model Loader for Phoenix Assets
 *
 * Loads ONNX models from Phoenix static files.
 * Models are served from /models/ path.
 */

export type ModelKey = 'textDetection' | 'samEncoder' | 'samDecoder';

const MODEL_PATHS: Record<ModelKey, string> = {
  textDetection: '/models/det_v3.onnx',
  samEncoder: '/models/sharpai_encoder.ort',      // SharpAI WebGPU-optimized
  samDecoder: '/models/sharpai_decoder.onnx',     // SharpAI WebGPU-optimized
};

// In-memory cache to avoid re-fetching during a session
const modelCache = new Map<ModelKey, ArrayBuffer>();

/**
 * Get model URL for a given key
 */
export function getModelUrl(key: ModelKey): string {
  return MODEL_PATHS[key];
}

/**
 * Get a model, fetching from static files if not already loaded
 */
export async function getModel(key: ModelKey): Promise<ArrayBuffer> {
  // Check in-memory cache first
  const cached = modelCache.get(key);
  if (cached) {
    console.log(`[ML] Model ${key} from memory (${(cached.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    return cached;
  }

  // Fetch from static files
  const url = getModelUrl(key);
  console.log(`[ML] Loading model ${key} from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model ${key}: ${response.status}`);
  }

  const modelBuffer = await response.arrayBuffer();
  console.log(`[ML] Model ${key} loaded (${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // Store in memory for this session
  modelCache.set(key, modelBuffer);

  return modelBuffer;
}

/**
 * Check if a model is loaded in memory
 */
export function isModelLoaded(key: ModelKey): boolean {
  return modelCache.has(key);
}

/**
 * Clear in-memory model cache
 */
export function clearModelCache(): void {
  modelCache.clear();
  console.log('[ML] Model cache cleared');
}
