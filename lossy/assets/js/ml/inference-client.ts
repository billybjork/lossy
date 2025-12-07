/**
 * ML Inference Client
 *
 * Main thread Promise-based API over postMessage to communicate with the
 * inference worker.
 */

import type {
  WorkerMessage,
  WorkerResponse,
  DetectedRegion,
  PointPrompt,
  BoundingBox,
  AutoSegmentConfig,
  AutoSegmentMaskResult,
} from './types';

export interface TextDetectionResult {
  regions: DetectedRegion[];
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}

export interface SegmentResult {
  success: boolean;
  mask_png: string;
  bbox: BoundingBox;
  score: number;
  area: number;
}

export interface AutoSegmentBatchResult {
  masks: AutoSegmentMaskResult[];
  progress: number;
  batchIndex: number;
  totalBatches: number;
}

export interface AutoSegmentCompleteResult {
  totalMasks: number;
  inferenceTimeMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface PendingAutoSegment {
  onBatch: (batch: AutoSegmentBatchResult) => void;
  onComplete: (result: AutoSegmentCompleteResult) => void;
  onError: (error: Error) => void;
}

/**
 * Client for communicating with the ML inference worker
 */
class InferenceClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private pendingAutoSegments = new Map<string, PendingAutoSegment>();
  private initPromise: Promise<void> | null = null;
  private messageIdCounter = 0;
  private onProgress: ((stage: string, progress: number) => void) | null = null;

  /**
   * Generate a unique message ID
   */
  private generateId(): string {
    return `msg_${++this.messageIdCounter}_${Date.now()}`;
  }

  /**
   * Send a message to the worker and wait for response
   */
  private sendMessage<T>(message: WorkerMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = 'id' in message ? message.id : this.generateId();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(message);
    });
  }

  /**
   * Handle messages from the worker
   */
  private handleMessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;

    // Handle progress updates (no ID, just broadcast)
    if (response.type === 'PROGRESS') {
      if (this.onProgress) {
        this.onProgress(response.stage, response.progress);
      }
      return;
    }

    // Handle INIT_COMPLETE specially (has id field)
    if (response.type === 'INIT_COMPLETE') {
      const id = 'id' in response ? (response as { id: string }).id : null;
      if (id) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.resolve(response);
        }
      }
      console.log('[InferenceClient] Worker initialized with backend:', response.backend);
      return;
    }

    // Handle AUTO_SEGMENT_BATCH (streaming response)
    if (response.type === 'AUTO_SEGMENT_BATCH') {
      const pendingAutoSeg = this.pendingAutoSegments.get(response.id);
      if (pendingAutoSeg) {
        pendingAutoSeg.onBatch({
          masks: response.masks,
          progress: response.progress,
          batchIndex: response.batchIndex,
          totalBatches: response.totalBatches,
        });
      }
      return;
    }

    // Handle AUTO_SEGMENT_COMPLETE (final response for streaming)
    if (response.type === 'AUTO_SEGMENT_COMPLETE') {
      const pendingAutoSeg = this.pendingAutoSegments.get(response.id);
      if (pendingAutoSeg) {
        this.pendingAutoSegments.delete(response.id);
        pendingAutoSeg.onComplete({
          totalMasks: response.totalMasks,
          inferenceTimeMs: response.inferenceTimeMs,
        });
      }
      return;
    }

    // Extract ID from response
    const id = 'id' in response ? response.id : null;
    if (!id) {
      console.warn('[InferenceClient] Received message without ID:', response);
      return;
    }

    // Check if this is an error for an auto-segment request
    if (response.type === 'ERROR') {
      const pendingAutoSeg = this.pendingAutoSegments.get(id);
      if (pendingAutoSeg) {
        this.pendingAutoSegments.delete(id);
        pendingAutoSeg.onError(new Error(response.error));
        return;
      }
    }

    const pending = this.pending.get(id);
    if (!pending) {
      console.warn('[InferenceClient] Received response for unknown request:', id);
      return;
    }

    this.pending.delete(id);

    if (response.type === 'ERROR') {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response);
    }
  };

  /**
   * Handle worker errors
   */
  private handleError = (event: ErrorEvent) => {
    console.error('[InferenceClient] Worker error:', event);
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`Worker error: ${event.message}`));
      this.pending.delete(id);
    }
  };

  /**
   * Set progress callback
   */
  setProgressCallback(callback: ((stage: string, progress: number) => void) | null): void {
    this.onProgress = callback;
  }

  /**
   * Initialize the worker
   */
  async init(): Promise<void> {
    // Return existing promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.worker) {
      return;
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    console.log('[InferenceClient] Creating inference worker...');

    // Create worker from the bundled worker file
    // The worker is bundled separately by esbuild (lossy_worker config)
    this.worker = new Worker('/assets/js/inference-worker.js', { type: 'module' });

    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = this.handleError;

    // Send init message
    const id = this.generateId();
    const message: WorkerMessage = { type: 'INIT', id };
    await this.sendMessage(message);

    console.log('[InferenceClient] Worker initialized');
  }

  /**
   * Detect text regions in an image
   */
  async detectText(imageData: ImageData): Promise<TextDetectionResult> {
    await this.init();

    const id = this.generateId();
    const message: WorkerMessage = {
      type: 'DETECT_TEXT',
      id,
      imageData,
    };

    const response = await this.sendMessage<{
      type: 'TEXT_DETECTED';
      id: string;
      regions: DetectedRegion[];
      inferenceTimeMs: number;
      backend: 'webgpu' | 'wasm' | null;
    }>(message);

    return {
      regions: response.regions,
      inferenceTimeMs: response.inferenceTimeMs,
      backend: response.backend,
    };
  }

  /**
   * Compute and cache embeddings for an image
   */
  async computeEmbeddings(documentId: string, imageData: ImageData): Promise<void> {
    await this.init();

    const id = this.generateId();
    const message: WorkerMessage = {
      type: 'COMPUTE_EMBEDDINGS',
      id,
      documentId,
      imageData,
    };

    await this.sendMessage(message);
  }

  /**
   * Segment at specific points using cached embeddings
   */
  async segmentAtPoints(
    documentId: string,
    points: PointPrompt[],
    imageSize: { width: number; height: number }
  ): Promise<SegmentResult> {
    await this.init();

    const id = this.generateId();
    const message: WorkerMessage = {
      type: 'SEGMENT_AT_POINTS',
      id,
      documentId,
      points,
      imageSize,
    };

    const response = await this.sendMessage<{
      type: 'SEGMENT_RESULT';
      id: string;
      mask_png: string;
      bbox: BoundingBox;
      score: number;
      area: number;
    }>(message);

    return {
      success: true,
      mask_png: response.mask_png,
      bbox: response.bbox,
      score: response.score,
      area: response.area,
    };
  }

  /**
   * Run automatic segmentation with streaming batch results
   * Computes embeddings if not already cached, then runs grid-based segmentation
   */
  async autoSegment(
    documentId: string,
    imageData: ImageData,
    callbacks: {
      onBatch: (batch: AutoSegmentBatchResult) => void;
      onComplete: (result: AutoSegmentCompleteResult) => void;
    },
    config?: Partial<AutoSegmentConfig>
  ): Promise<void> {
    await this.init();

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = this.generateId();

    return new Promise((resolve, reject) => {
      // Register streaming callbacks
      this.pendingAutoSegments.set(id, {
        onBatch: callbacks.onBatch,
        onComplete: (result) => {
          callbacks.onComplete(result);
          resolve();
        },
        onError: reject,
      });

      // Send message to worker
      const message: WorkerMessage = {
        type: 'AUTO_SEGMENT',
        id,
        documentId,
        imageData,
        config,
      };
      this.worker!.postMessage(message);
    });
  }

  /**
   * Clear cached embeddings for a document
   */
  clearEmbeddings(documentId: string): void {
    if (this.worker) {
      const message: WorkerMessage = {
        type: 'CLEAR_EMBEDDINGS',
        documentId,
      };
      this.worker.postMessage(message);
    }
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.initPromise = null;
      this.pending.clear();
      this.pendingAutoSegments.clear();
      console.log('[InferenceClient] Worker terminated');
    }
  }
}

// Re-export types for convenience
export type { AutoSegmentConfig, AutoSegmentMaskResult } from './types';

// Export singleton instance
export const inferenceClient = new InferenceClient();
