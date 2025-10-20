/**
 * SigLIP Model Loader with Capability Detection
 *
 * Sprint 08 - Task 1: Capability Detection & Model Lifecycle
 *
 * Features:
 * - WebGPU/WASM capability probe
 * - Lazy model loading with progress events
 * - Cache Storage + IndexedDB fallback
 * - Self-test for performance validation
 * - Mirrors whisper-loader.js pattern
 */

const MODEL_NAME = 'Xenova/siglip-base-patch16-224';
const MIN_MEMORY_MB = 120; // SigLIP Base minimum memory requirement

// Singleton state
let siglipModel = null;
let siglipProcessor = null;
let capabilitiesCache = null;
let isLoading = false;
let loadPromise = null;

/**
 * Detect device capabilities for local vision inference.
 *
 * Checks:
 * - WebGPU availability
 * - Available memory (heuristic)
 *
 * Note: User preference (vision mode) is passed from service worker, not checked here.
 *
 * @returns {Promise<Object>} Capabilities result
 */
export async function detectCapabilities() {
  if (capabilitiesCache) {
    return capabilitiesCache;
  }

  const capabilities = {
    webgpu: false,
    wasm: true, // Always available
    estimatedMemoryMB: 0,
    device: 'wasm',
    dtype: 'int8',
    canUseLocal: false,
  };

  // Check WebGPU
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        capabilities.webgpu = true;
        capabilities.device = 'webgpu';
        capabilities.dtype = 'fp16'; // Use FP16 for WebGPU (faster)

        console.log('[SigLIPLoader] WebGPU adapter available');
      }
    } catch (e) {
      console.warn('[SigLIPLoader] WebGPU adapter request failed:', e.message);
    }
  }

  // Estimate available memory
  if ('memory' in performance && performance.memory) {
    // Chrome-specific: performance.memory
    const usedMemoryMB = performance.memory.usedJSHeapSize / 1024 / 1024;
    const totalMemoryMB = performance.memory.jsHeapSizeLimit / 1024 / 1024;
    capabilities.estimatedMemoryMB = Math.round(totalMemoryMB - usedMemoryMB);

    console.log(
      `[SigLIPLoader] Estimated available memory: ${capabilities.estimatedMemoryMB} MB`
    );
  } else {
    // Fallback: Use user agent heuristics
    // SigLIP Base needs ~100MB for model + ~20MB for inference
    capabilities.estimatedMemoryMB = 150; // Conservative estimate
    console.log('[SigLIPLoader] Memory API unavailable, using conservative estimate');
  }

  // Determine if local vision is feasible (hardware only)
  // User preference is checked separately in offscreen.js using mode from service worker
  const hasEnoughMemory = capabilities.estimatedMemoryMB >= MIN_MEMORY_MB;

  capabilities.canUseLocal = hasEnoughMemory && (capabilities.webgpu || capabilities.wasm);

  console.log('[SigLIPLoader] Capabilities:', capabilities);

  capabilitiesCache = capabilities;
  return capabilities;
}

/**
 * Load SigLIP model with progress reporting.
 *
 * Uses Cache Storage for ONNX files, IndexedDB fallback.
 * Lazy-loads @huggingface/transformers to reduce bundle size.
 *
 * @param {Function} onProgress - Progress callback (0.0 - 1.0)
 * @returns {Promise<Object>} { model, processor }
 */
export async function loadSigLIPModel(onProgress = null) {
  // Return cached model and processor if already loaded
  if (siglipModel && siglipProcessor) {
    return { model: siglipModel, processor: siglipProcessor };
  }

  // If already loading, wait for existing promise
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  // Start new load
  isLoading = true;
  loadPromise = _loadSigLIPModelInternal(onProgress);

  try {
    const result = await loadPromise;
    siglipModel = result.model;
    siglipProcessor = result.processor;
    return result;
  } finally {
    isLoading = false;
    loadPromise = null;
  }
}

async function _loadSigLIPModelInternal(onProgress) {
  console.log('[SigLIPLoader] Loading SigLIP model:', MODEL_NAME);

  // Check capabilities first
  const capabilities = await detectCapabilities();

  if (!capabilities.canUseLocal) {
    const reason =
      capabilities.estimatedMemoryMB < MIN_MEMORY_MB
        ? 'insufficient memory'
        : 'no suitable backend';

    console.warn(`[SigLIPLoader] Cannot use local vision: ${reason}`);
    throw new Error(`Local vision unavailable: ${reason}`);
  }

  // Dynamic import of Transformers.js (lazy-load, already available from Sprint 07)
  console.log('[SigLIPLoader] Lazy-loading @huggingface/transformers...');
  const { AutoProcessor, SiglipVisionModel, RawImage, env } = await import(
    '@huggingface/transformers'
  );

  // Configure cache directory (use browser cache)
  env.allowLocalModels = false; // Only use remote models
  env.useBrowserCache = true;

  // CRITICAL: Configure ONNX Runtime to use bundled WASM files
  // Chrome MV3 extensions cannot load remotely hosted code from CDNs
  // WASM files are bundled locally via webpack CopyPlugin
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('onnx/');
  env.backends.onnx.wasm.numThreads = 1; // Required: Chrome extension bug workaround

  console.log(
    '[SigLIPLoader] ONNX Runtime configured for local WASM:',
    env.backends.onnx.wasm.wasmPaths
  );

  console.log(`[SigLIPLoader] Creating pipeline with device: ${capabilities.device}`);

  const startTime = performance.now();

  // Load processor and model separately (more control than pipeline)
  const processor = await AutoProcessor.from_pretrained(MODEL_NAME, {
    progress_callback: onProgress,
  });

  const model = await SiglipVisionModel.from_pretrained(MODEL_NAME, {
    device: capabilities.device,
    dtype: capabilities.dtype,
    progress_callback: onProgress,
  });

  const loadTime = performance.now() - startTime;
  console.log(`[SigLIPLoader] Model loaded in ${loadTime.toFixed(0)}ms`);

  return { model, processor, RawImage };
}

/**
 * Generate image embedding from ImageData or RawImage.
 *
 * @param {ImageData|RawImage} imageData - Image to process
 * @returns {Promise<Float32Array>} 768-dim embedding vector
 */
export async function generateEmbedding(imageData) {
  const { model, processor, RawImage } = await loadSigLIPModel();

  const startTime = performance.now();

  // Convert ImageData to RawImage if needed
  let rawImage;
  if (imageData instanceof ImageData) {
    // Create RawImage from ImageData
    rawImage = new RawImage(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height,
      4 // RGBA channels
    );
  } else {
    rawImage = imageData;
  }

  // Preprocess image (resize to 224x224, normalize)
  const inputs = await processor(rawImage);

  // Run inference
  const output = await model(inputs);

  // Extract pooled output (image embedding)
  const embedding = output.pooler_output.data; // Float32Array (768 dims)

  const inferenceTime = performance.now() - startTime;
  console.log(
    `[SigLIPLoader] Embedding generated in ${inferenceTime.toFixed(0)}ms (${embedding.length} dims)`
  );

  return embedding;
}

/**
 * Generate synthetic test image (1x1 black square).
 *
 * @returns {ImageData} Synthetic image
 */
export function generateSyntheticImage() {
  // Create 1x1 black image
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, 1, 1);

  return ctx.getImageData(0, 0, 1, 1);
}

/**
 * Run self-test to validate local inference performance.
 *
 * Tests with 1x1 black image. If inference takes >200ms (WebGPU) or >600ms (WASM),
 * performance is too slow and should consider fallback.
 *
 * @returns {Promise<Object>} Test results
 */
export async function runSelfTest() {
  console.log('[SigLIPLoader] Running self-test...');

  const startTime = performance.now();

  try {
    // Load model first
    await loadSigLIPModel();

    const loadTime = performance.now() - startTime;

    // Generate test image
    const testImage = generateSyntheticImage();

    // Generate embedding
    const inferenceStart = performance.now();

    const embedding = await generateEmbedding(testImage);

    const inferenceTime = performance.now() - inferenceStart;
    const totalTime = performance.now() - startTime;

    const capabilities = await detectCapabilities();

    // Performance threshold depends on device
    const threshold = capabilities.device === 'webgpu' ? 200 : 600;

    const testResults = {
      success: true,
      loadTimeMs: Math.round(loadTime),
      inferenceTimeMs: Math.round(inferenceTime),
      totalTimeMs: Math.round(totalTime),
      embeddingDims: embedding.length,
      device: capabilities.device,
      performanceOk: inferenceTime < threshold,
    };

    console.log('[SigLIPLoader] Self-test results:', testResults);

    if (!testResults.performanceOk) {
      console.warn(
        `[SigLIPLoader] Self-test too slow (${inferenceTime.toFixed(0)}ms for 1x1 image on ${capabilities.device}). Expected <${threshold}ms.`
      );
    }

    return testResults;
  } catch (error) {
    console.error('[SigLIPLoader] Self-test failed:', error);

    return {
      success: false,
      error: error.message,
      totalTimeMs: Math.round(performance.now() - startTime),
    };
  }
}

/**
 * Unload model to free memory.
 *
 * Called when offscreen document is suspended.
 */
export function unloadModel() {
  if (siglipModel || siglipProcessor) {
    console.log('[SigLIPLoader] Unloading model to free memory');

    // Transformers.js doesn't have explicit cleanup, but we can
    // release the references and let GC handle it
    siglipModel = null;
    siglipProcessor = null;
    capabilitiesCache = null;

    // Force garbage collection if available (non-standard)
    if (global.gc) {
      global.gc();
    }
  }
}

/**
 * Warm cache by preloading model in background.
 *
 * Call during extension install or idle time.
 */
export async function warmCache() {
  console.log('[SigLIPLoader] Warming cache...');

  try {
    await loadSigLIPModel();

    console.log('[SigLIPLoader] Cache warmed successfully');
  } catch (error) {
    console.error('[SigLIPLoader] Failed to warm cache:', error);
  }
}
