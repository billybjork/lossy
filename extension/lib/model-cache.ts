/**
 * Model Loader
 *
 * Loads ONNX models bundled with the extension.
 * Models are fetched directly from extension resources (no caching needed
 * since they're already local files).
 *
 * Note: Cache API doesn't support chrome-extension:// URLs, so we skip caching.
 */

export type ModelKey = 'textDetection' | 'samEncoder' | 'samDecoder';

const MODEL_PATHS: Record<ModelKey, string> = {
  textDetection: 'models/det_v3.onnx',
  samEncoder: 'models/edge_sam_3x_encoder.onnx',
  samDecoder: 'models/edge_sam_3x_decoder.onnx',
};

// In-memory cache to avoid re-fetching during a session
const modelCache = new Map<ModelKey, ArrayBuffer>();

/**
 * Get model URL for a given key
 */
export function getModelUrl(key: ModelKey): string {
  return chrome.runtime.getURL(MODEL_PATHS[key]);
}

/**
 * Get a model, fetching from extension resources if not already loaded
 */
export async function getModel(key: ModelKey): Promise<ArrayBuffer> {
  // Check in-memory cache first
  const cached = modelCache.get(key);
  if (cached) {
    console.log(`[Lossy] Model ${key} from memory (${(cached.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    return cached;
  }

  // Fetch from extension resources
  const url = getModelUrl(key);
  console.log(`[Lossy] Loading model ${key} from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model ${key}: ${response.status}`);
  }

  const modelBuffer = await response.arrayBuffer();
  console.log(`[Lossy] Model ${key} loaded (${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // Store in memory for this session
  modelCache.set(key, modelBuffer);

  return modelBuffer;
}

/**
 * Preload all models into memory
 * Call this on extension install or first use
 */
export async function preloadAllModels(): Promise<void> {
  const keys: ModelKey[] = ['textDetection', 'samEncoder', 'samDecoder'];

  console.log('[Lossy] Preloading all models...');
  const startTime = performance.now();

  // Load sequentially to avoid overwhelming the system
  for (const key of keys) {
    await getModel(key);
  }

  const elapsed = performance.now() - startTime;
  console.log(`[Lossy] All models preloaded in ${elapsed.toFixed(0)}ms`);
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
  console.log('[Lossy] Model cache cleared');
}
