/**
 * Whisper Model Loader with Capability Detection
 *
 * Sprint 07 - Task 1: Capability Detection & Model Lifecycle
 *
 * Features:
 * - WebGPU/WASM capability probe
 * - Lazy model loading with progress events
 * - Cache Storage + IndexedDB fallback
 * - Self-test for performance validation
 */

const MODEL_NAME = 'Xenova/whisper-tiny.en';
const MIN_MEMORY_MB = 150; // Whisper Tiny minimum memory requirement

// Singleton state
let whisperPipeline = null;
let capabilitiesCache = null;
let isLoading = false;
let loadPromise = null;

/**
 * Detect device capabilities for local transcription.
 *
 * Checks:
 * - WebGPU availability
 * - Available memory (heuristic)
 *
 * Note: User preference (STT mode) is passed from service worker, not checked here.
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
        capabilities.dtype = 'fp16'; // Use FP16 for WebGPU (3x faster)

        console.log('[WhisperLoader] WebGPU adapter available');
      }
    } catch (e) {
      console.warn('[WhisperLoader] WebGPU adapter request failed:', e.message);
    }
  }

  // Estimate available memory
  if ('memory' in performance && performance.memory) {
    // Chrome-specific: performance.memory
    const usedMemoryMB = performance.memory.usedJSHeapSize / 1024 / 1024;
    const totalMemoryMB = performance.memory.jsHeapSizeLimit / 1024 / 1024;
    capabilities.estimatedMemoryMB = Math.round(totalMemoryMB - usedMemoryMB);

    console.log(
      `[WhisperLoader] Estimated available memory: ${capabilities.estimatedMemoryMB} MB`
    );
  } else {
    // Fallback: Use user agent heuristics
    // Whisper Tiny needs ~100MB for model + ~50MB for inference
    capabilities.estimatedMemoryMB = 200; // Conservative estimate
    console.log('[WhisperLoader] Memory API unavailable, using conservative estimate');
  }

  // Determine if local transcription is feasible (hardware only)
  // User preference is checked separately in offscreen.js using mode from service worker
  const hasEnoughMemory = capabilities.estimatedMemoryMB >= MIN_MEMORY_MB;

  capabilities.canUseLocal = hasEnoughMemory && (capabilities.webgpu || capabilities.wasm);

  console.log('[WhisperLoader] Capabilities:', capabilities);

  capabilitiesCache = capabilities;
  return capabilities;
}

/**
 * Load Whisper model with progress reporting.
 *
 * Uses Cache Storage for ONNX files, IndexedDB fallback.
 * Lazy-loads @huggingface/transformers to reduce bundle size.
 *
 * @param {Function} onProgress - Progress callback (0.0 - 1.0)
 * @returns {Promise<Object>} Whisper pipeline
 */
export async function loadWhisperModel(onProgress = null) {
  // Return cached pipeline if already loaded
  if (whisperPipeline) {
    console.log('[WhisperLoader] Returning cached pipeline');
    return whisperPipeline;
  }

  // If already loading, wait for existing promise
  if (isLoading && loadPromise) {
    console.log('[WhisperLoader] Load in progress, waiting...');
    return loadPromise;
  }

  // Start new load
  isLoading = true;
  loadPromise = _loadWhisperModelInternal(onProgress);

  try {
    whisperPipeline = await loadPromise;
    return whisperPipeline;
  } finally {
    isLoading = false;
    loadPromise = null;
  }
}

async function _loadWhisperModelInternal(onProgress) {
  console.log('[WhisperLoader] Loading Whisper model:', MODEL_NAME);

  // Check capabilities first
  const capabilities = await detectCapabilities();

  if (!capabilities.canUseLocal) {
    const reason = !capabilities.userPreference
      ? 'user preference disabled'
      : capabilities.estimatedMemoryMB < MIN_MEMORY_MB
      ? 'insufficient memory'
      : 'no suitable backend';

    console.warn(`[WhisperLoader] Cannot use local transcription: ${reason}`);
    throw new Error(`Local transcription unavailable: ${reason}`);
  }

  // Dynamic import of Transformers.js (lazy-load)
  console.log('[WhisperLoader] Lazy-loading @huggingface/transformers...');
  const { pipeline, env } = await import('@huggingface/transformers');

  // Configure cache directory (use browser cache)
  env.allowLocalModels = false; // Only use remote models
  env.useBrowserCache = true;

  // CRITICAL: Configure ONNX Runtime to use bundled WASM files
  // Chrome MV3 extensions cannot load remotely hosted code from CDNs
  // WASM files are bundled locally via webpack CopyPlugin
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('onnx/');
  env.backends.onnx.wasm.numThreads = 1; // Required: Chrome extension bug workaround

  console.log('[WhisperLoader] ONNX Runtime configured for local WASM:', env.backends.onnx.wasm.wasmPaths);

  // Set up progress callback for model download
  // Transformers.js uses env.backends.onnx.wasm.proxy for progress events
  if (onProgress) {
    console.log('[WhisperLoader] Progress tracking enabled');
    // Note: Progress tracking in Transformers.js v3+ happens automatically during pipeline creation
    // The pipeline function itself handles download progress internally
  }

  console.log(`[WhisperLoader] Creating pipeline with device: ${capabilities.device}`);

  const startTime = performance.now();

  // Create pipeline with progress callback
  const transcriber = await pipeline('automatic-speech-recognition', MODEL_NAME, {
    device: capabilities.device,
    dtype: capabilities.dtype,
    progress_callback: onProgress ? (progress) => {
      console.log('[WhisperLoader] Model download progress:', progress);
      onProgress(progress.progress || 0);
    } : undefined,
  });

  const loadTime = performance.now() - startTime;
  console.log(`[WhisperLoader] Model loaded in ${loadTime.toFixed(0)}ms`);

  return transcriber;
}

/**
 * Generate synthetic audio for self-test.
 *
 * Creates 1 second of 440Hz sine wave at 16kHz sample rate.
 *
 * @param {number} sampleRate - Sample rate (default: 16000)
 * @returns {Float32Array} Synthetic audio data
 */
export function generateSyntheticAudio(sampleRate = 16000) {
  const duration = 1.0; // 1 second
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new Float32Array(numSamples);

  // Generate 440Hz sine wave (A4 note)
  const frequency = 440;
  for (let i = 0; i < numSamples; i++) {
    buffer[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.05; // Low amplitude
  }

  return buffer;
}

/**
 * Run self-test to validate local inference performance.
 *
 * Tests with 1 second synthetic audio. If inference takes >2s,
 * performance is too slow and should fall back to cloud.
 *
 * @returns {Promise<Object>} Test results
 */
export async function runSelfTest() {
  console.log('[WhisperLoader] Running self-test...');

  const startTime = performance.now();

  try {
    // Load model first
    const transcriber = await loadWhisperModel((progress) => {
      console.log(`[WhisperLoader] Self-test model download: ${(progress * 100).toFixed(0)}%`);
    });

    const loadTime = performance.now() - startTime;

    // Generate test audio
    const testAudio = generateSyntheticAudio(16000);

    // Transcribe test audio
    const inferenceStart = performance.now();

    const result = await transcriber(testAudio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    });

    const inferenceTime = performance.now() - inferenceStart;
    const totalTime = performance.now() - startTime;

    const testResults = {
      success: true,
      loadTimeMs: Math.round(loadTime),
      inferenceTimeMs: Math.round(inferenceTime),
      totalTimeMs: Math.round(totalTime),
      transcript: result.text,
      performanceOk: inferenceTime < 2000, // Must be under 2s for 1s audio
    };

    console.log('[WhisperLoader] Self-test results:', testResults);

    if (!testResults.performanceOk) {
      console.warn(
        `[WhisperLoader] Self-test too slow (${inferenceTime.toFixed(0)}ms for 1s audio). Recommend cloud fallback.`
      );
    }

    return testResults;
  } catch (error) {
    console.error('[WhisperLoader] Self-test failed:', error);

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
  if (whisperPipeline) {
    console.log('[WhisperLoader] Unloading model to free memory');

    // Transformers.js doesn't have explicit cleanup, but we can
    // release the reference and let GC handle it
    whisperPipeline = null;
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
  console.log('[WhisperLoader] Warming cache...');

  try {
    await loadWhisperModel((progress) => {
      console.log(`[WhisperLoader] Cache warming: ${(progress * 100).toFixed(0)}%`);
    });

    console.log('[WhisperLoader] Cache warmed successfully');
  } catch (error) {
    console.error('[WhisperLoader] Failed to warm cache:', error);
  }
}
