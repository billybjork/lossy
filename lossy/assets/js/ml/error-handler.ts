/**
 * ML Error Handling System
 *
 * Provides centralized error reporting and environment validation.
 * Enables user-visible feedback for ML failures (no more silent errors).
 */

export type ErrorSeverity = 'warning' | 'error' | 'fatal';

export interface MLError {
  stage: string;
  message: string;
  severity: ErrorSeverity;
  cause?: Error;
}

export interface ErrorFeedbackHandler {
  onError: (error: MLError) => void;
}

let errorHandler: ErrorFeedbackHandler | null = null;

/**
 * Set the global error handler
 * Called by UI layer to receive error notifications
 */
export function setErrorHandler(handler: ErrorFeedbackHandler | null): void {
  errorHandler = handler;
}

/**
 * Report an ML error
 * Logs to console and notifies the registered error handler
 */
export function reportError(error: MLError): void {
  console.error(`[ML Error] ${error.stage}: ${error.message}`, error.cause);
  errorHandler?.onError(error);
}

/**
 * Environment validation result
 */
export interface MLEnvironmentValidation {
  webgpuAvailable: boolean;
  wasmAvailable: boolean;
  canRunML: boolean;
  issues: string[];
}

/**
 * Validate ML environment upfront
 * Checks WebGPU, WebAssembly, and SharedArrayBuffer availability
 */
export async function validateMLEnvironment(): Promise<MLEnvironmentValidation> {
  const issues: string[] = [];

  // Check WebGPU
  const webgpuAvailable = !!navigator.gpu;
  if (!webgpuAvailable) {
    issues.push('WebGPU not supported (will use WASM fallback)');
  }

  // Check WASM
  const wasmAvailable = typeof WebAssembly !== 'undefined';
  if (!wasmAvailable) {
    issues.push('WebAssembly not supported - ML inference unavailable');
  }

  // Check SharedArrayBuffer for multi-threading
  const sharedArrayBufferAvailable = typeof SharedArrayBuffer !== 'undefined';
  if (!sharedArrayBufferAvailable) {
    issues.push('SharedArrayBuffer unavailable - WASM will run single-threaded (slower)');
  }

  // Check if Worker is available
  const workerAvailable = typeof Worker !== 'undefined';
  if (!workerAvailable) {
    issues.push('Web Workers not supported - ML inference unavailable');
  }

  const canRunML = wasmAvailable && workerAvailable;

  console.log('[ML Environment]', {
    webgpu: webgpuAvailable,
    wasm: wasmAvailable,
    sharedArrayBuffer: sharedArrayBufferAvailable,
    worker: workerAvailable,
    canRunML,
  });

  return {
    webgpuAvailable,
    wasmAvailable,
    canRunML,
    issues,
  };
}

/**
 * Helper to wrap async operations with error reporting
 */
export async function withErrorReporting<T>(
  stage: string,
  operation: () => Promise<T>,
  severity: ErrorSeverity = 'error'
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    reportError({
      stage,
      message: error instanceof Error ? error.message : String(error),
      severity,
      cause: error instanceof Error ? error : undefined,
    });
    throw error;
  }
}
