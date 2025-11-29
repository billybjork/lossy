/**
 * ONNX Runtime Session Manager
 *
 * Manages WebGPU/WASM session lifecycle with caching and fallback.
 * Uses locally bundled ONNX Runtime (MV3 doesn't allow CDN loading).
 */

import * as ort from 'onnxruntime-web';

type InferenceSession = ort.InferenceSession;

let sessionInstance: InferenceSession | null = null;
let sessionPromise: Promise<InferenceSession> | null = null;
let currentBackend: 'webgpu' | 'wasm' | null = null;

const MODEL_URL = chrome.runtime.getURL('models/det_v3.onnx');

// Configure WASM paths to use bundled files
ort.env.wasm.wasmPaths = chrome.runtime.getURL('/');

/**
 * Check if WebGPU is available
 */
async function isWebGPUAvailable(): Promise<boolean> {
  if (!navigator.gpu) {
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Get or create the ONNX inference session
 * Uses WebGPU if available, falls back to WASM
 */
export async function getSession(): Promise<InferenceSession> {
  // Return existing session if available
  if (sessionInstance) {
    return sessionInstance;
  }

  // Return existing promise if session is being created
  if (sessionPromise) {
    return sessionPromise;
  }

  // Create new session
  sessionPromise = createSession();

  try {
    sessionInstance = await sessionPromise;
    return sessionInstance;
  } finally {
    sessionPromise = null;
  }
}

async function createSession(): Promise<InferenceSession> {
  console.log('[Lossy] createSession called, loading model...');

  // Fetch the model
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Failed to load model: ${response.status}`);
  }

  const modelBuffer = await response.arrayBuffer();
  console.log(`[Lossy] Model loaded: ${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // Try WebGPU first
  const webgpuAvailable = await isWebGPUAvailable();

  if (webgpuAvailable) {
    try {
      console.log('[Lossy] Attempting WebGPU backend...');
      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all'
      });
      currentBackend = 'webgpu';
      console.log('[Lossy] WebGPU session created successfully');
      return session;
    } catch (error) {
      console.warn('[Lossy] WebGPU failed, falling back to WASM:', error);
    }
  }

  // Fall back to WASM
  console.log('[Lossy] Using WASM backend...');
  const session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  currentBackend = 'wasm';
  console.log('[Lossy] WASM session created successfully');
  return session;
}

/**
 * Get the current execution backend
 */
export function getCurrentBackend(): 'webgpu' | 'wasm' | null {
  return currentBackend;
}

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
 * Dispose of the session to free resources
 */
export async function disposeSession(): Promise<void> {
  if (sessionInstance) {
    await sessionInstance.release();
    sessionInstance = null;
    currentBackend = null;
    console.log('[Lossy] ONNX session disposed');
  }
}
