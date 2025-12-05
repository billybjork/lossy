/**
 * ONNX Runtime Session Manager
 *
 * Manages WebGPU/WASM session lifecycle with caching and fallback.
 * Supports multiple model types: text detection, SAM encoder, SAM decoder.
 * Uses locally served ONNX Runtime from /wasm/ path.
 *
 * Uses the bundled ONNX Runtime build (ort.webgpu.bundle.min.mjs) which
 * doesn't use dynamic imports - required for Web Worker compatibility.
 */

// Use the bundled WebGPU version - no dynamic imports, works in Web Workers
// See: https://github.com/microsoft/onnxruntime/pull/20898
import * as ort from 'onnxruntime-web/webgpu';
import { getModel, type ModelKey } from './model-cache';

type InferenceSession = ort.InferenceSession;

export type SessionType = 'textDetection' | 'samEncoder' | 'samDecoder';

interface SessionState {
  instance: InferenceSession | null;
  promise: Promise<InferenceSession> | null;
  backend: 'webgpu' | 'wasm' | null;
}

// Session states for each model type
const sessions: Record<SessionType, SessionState> = {
  textDetection: { instance: null, promise: null, backend: null },
  samEncoder: { instance: null, promise: null, backend: null },
  samDecoder: { instance: null, promise: null, backend: null },
};

// Map session types to model keys
const SESSION_TO_MODEL: Record<SessionType, ModelKey> = {
  textDetection: 'textDetection',
  samEncoder: 'samEncoder',
  samDecoder: 'samDecoder',
};

// Cached WebGPU availability check
let webgpuAvailable: boolean | null = null;

// Configure WASM paths with explicit file paths for Worker compatibility.
// Using object form bypasses import.meta.url resolution which fails in bundled Workers
// because esbuild sets import_meta = {} (empty object).
ort.env.wasm.wasmPaths = {
  mjs: '/wasm/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/wasm/ort-wasm-simd-threaded.asyncify.wasm',
};

// Enable multi-threading if available
ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

/**
 * Check if WebGPU is available (cached)
 */
async function isWebGPUAvailable(): Promise<boolean> {
  if (webgpuAvailable !== null) {
    return webgpuAvailable;
  }

  if (!navigator.gpu) {
    console.log('[ML] WebGPU not available: navigator.gpu is undefined');
    webgpuAvailable = false;
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    webgpuAvailable = adapter !== null;
    console.log(`[ML] WebGPU adapter ${webgpuAvailable ? 'available' : 'not available'}`);
    return webgpuAvailable;
  } catch (error) {
    console.log('[ML] WebGPU not available:', error);
    webgpuAvailable = false;
    return false;
  }
}

/**
 * Create an ONNX session for a specific model
 */
async function createSession(type: SessionType): Promise<InferenceSession> {
  const modelKey = SESSION_TO_MODEL[type];
  console.log(`[ML] Creating ${type} session...`);

  // Get model from cache or fetch
  const modelBuffer = await getModel(modelKey);
  console.log(`[ML] Model ${type} loaded: ${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // Try WebGPU first if available
  const useWebGPU = await isWebGPUAvailable();

  if (useWebGPU) {
    try {
      console.log(`[ML] Attempting WebGPU backend for ${type}...`);
      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      sessions[type].backend = 'webgpu';
      console.log(`[ML] ${type} WebGPU session created successfully`);
      return session;
    } catch (error) {
      console.warn(`[ML] WebGPU failed for ${type}, falling back to WASM:`, error);
    }
  }

  // Fall back to WASM
  console.log(`[ML] Using WASM backend for ${type}...`);
  const session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  sessions[type].backend = 'wasm';
  console.log(`[ML] ${type} WASM session created successfully`);
  return session;
}

/**
 * Get or create a session for a specific model type
 */
async function getSessionByType(type: SessionType): Promise<InferenceSession> {
  const state = sessions[type];

  // Return existing session if available
  if (state.instance) {
    return state.instance;
  }

  // Return existing promise if session is being created
  if (state.promise) {
    return state.promise;
  }

  // Create new session
  state.promise = createSession(type);

  try {
    state.instance = await state.promise;
    return state.instance;
  } finally {
    state.promise = null;
  }
}

// ============================================================================
// Public API - Text Detection
// ============================================================================

/**
 * Get or create the text detection ONNX session
 */
export async function getSession(): Promise<InferenceSession> {
  return getTextDetectionSession();
}

/**
 * Get the text detection session
 */
export async function getTextDetectionSession(): Promise<InferenceSession> {
  return getSessionByType('textDetection');
}

/**
 * Get the current execution backend for text detection
 */
export function getCurrentBackend(): 'webgpu' | 'wasm' | null {
  return sessions.textDetection.backend;
}

// ============================================================================
// Public API - SAM Sessions
// ============================================================================

/**
 * Get the SAM encoder session
 */
export async function getSamEncoderSession(): Promise<InferenceSession> {
  return getSessionByType('samEncoder');
}

/**
 * Get the SAM decoder session
 */
export async function getSamDecoderSession(): Promise<InferenceSession> {
  return getSessionByType('samDecoder');
}

/**
 * Get the backend for a specific session type
 */
export function getBackend(type: SessionType): 'webgpu' | 'wasm' | null {
  return sessions[type].backend;
}

/**
 * Check if a session is loaded
 */
export function isSessionLoaded(type: SessionType): boolean {
  return sessions[type].instance !== null;
}

// ============================================================================
// Tensor Utilities
// ============================================================================

/**
 * Create an ONNX Tensor
 */
export async function createTensor(
  type: 'float32',
  data: Float32Array,
  dims: readonly number[]
): Promise<ort.Tensor> {
  return new ort.Tensor(type, data, dims);
}

/**
 * Create a tensor from Int32Array
 */
export function createInt32Tensor(data: Int32Array, dims: readonly number[]): ort.Tensor {
  return new ort.Tensor('int32', data, dims);
}

/**
 * Create a tensor from Float32Array
 */
export function createFloat32Tensor(data: Float32Array, dims: readonly number[]): ort.Tensor {
  return new ort.Tensor('float32', data, dims);
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Dispose of a specific session type to free resources
 */
export async function disposeSessionByType(type: SessionType): Promise<void> {
  const state = sessions[type];
  if (state.instance) {
    await state.instance.release();
    state.instance = null;
    state.backend = null;
    console.log(`[ML] ${type} session disposed`);
  }
}

/**
 * Dispose of the text detection session
 */
export async function disposeSession(): Promise<void> {
  await disposeSessionByType('textDetection');
}

/**
 * Dispose all sessions to free resources
 */
export async function disposeAllSessions(): Promise<void> {
  const types: SessionType[] = ['textDetection', 'samEncoder', 'samDecoder'];
  await Promise.all(types.map((type) => disposeSessionByType(type)));
  console.log('[ML] All ONNX sessions disposed');
}

/**
 * Preload all sessions (useful for eager loading)
 */
export async function preloadAllSessions(): Promise<void> {
  console.log('[ML] Preloading all ONNX sessions...');
  const startTime = performance.now();

  await Promise.all([
    getTextDetectionSession(),
    getSamEncoderSession(),
    getSamDecoderSession(),
  ]);

  const elapsed = performance.now() - startTime;
  console.log(`[ML] All sessions preloaded in ${elapsed.toFixed(0)}ms`);
}
