/**
 * Inference Provider Abstraction
 *
 * Abstracts ML source - checks for extension first, falls back to local worker.
 * This allows the app to work with or without the extension installed.
 */

import { inferenceClient, type TextDetectionResult, type SegmentResult } from './inference-client';
import type { DetectedRegion, PointPrompt } from './types';

/**
 * Interface for inference providers
 */
export interface InferenceProvider {
  /**
   * Detect text regions in an image
   */
  detectText(imageElement: HTMLImageElement): Promise<DetectedRegion[]>;

  /**
   * Compute and cache embeddings for an image
   */
  computeEmbeddings(documentId: string, imageElement: HTMLImageElement): Promise<void>;

  /**
   * Segment at specific points using cached embeddings
   */
  segmentAtPoints(
    documentId: string,
    points: PointPrompt[],
    imageSize: { width: number; height: number }
  ): Promise<SegmentResult>;

  /**
   * Clear cached embeddings for a document
   */
  clearEmbeddings(documentId: string): void;

  /**
   * Set progress callback for loading indicators
   */
  setProgressCallback(callback: ((stage: string, progress: number) => void) | null): void;
}

/**
 * Check if the extension is available
 * Extension content script sets window.__LOSSY_EXTENSION_READY = true
 */
export function isExtensionAvailable(): boolean {
  return (window as unknown as { __LOSSY_EXTENSION_READY?: boolean }).__LOSSY_EXTENSION_READY === true;
}

/**
 * Extension-based inference provider
 * Uses existing window.postMessage pattern to communicate with extension
 */
class ExtensionProvider implements InferenceProvider {
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private requestIdCounter = 0;
  private progressCallback: ((stage: string, progress: number) => void) | null = null;

  constructor() {
    // Listen for responses from extension
    window.addEventListener('message', this.handleMessage);
  }

  private handleMessage = (event: MessageEvent) => {
    if (event.source !== window) return;

    const { type, requestId, ...data } = event.data || {};

    if (type === 'LOSSY_SEGMENT_RESPONSE' && requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data);
        }
      }
    }

    if (type === 'LOSSY_TEXT_DETECTION_RESPONSE' && requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.regions || []);
        }
      }
    }
  };

  private generateRequestId(): string {
    return `ext_${++this.requestIdCounter}_${Date.now()}`;
  }

  setProgressCallback(callback: ((stage: string, progress: number) => void) | null): void {
    this.progressCallback = callback;
  }

  async detectText(imageElement: HTMLImageElement): Promise<DetectedRegion[]> {
    // Extension handles text detection automatically on capture
    // This is mainly for consistency - the extension already does this
    return [];
  }

  async computeEmbeddings(documentId: string, imageElement: HTMLImageElement): Promise<void> {
    // Extension computes embeddings lazily when needed
    // Just signal that we're ready
    if (this.progressCallback) {
      this.progressCallback('embeddings_ready', 1);
    }
  }

  async segmentAtPoints(
    documentId: string,
    points: PointPrompt[],
    imageSize: { width: number; height: number }
  ): Promise<SegmentResult> {
    const requestId = this.generateRequestId();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      // Send request to extension via postMessage
      window.postMessage({
        type: 'LOSSY_SEGMENT_REQUEST',
        documentId,
        points,
        imageSize,
        requestId,
      }, '*');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Extension segment request timed out'));
        }
      }, 30000);
    });
  }

  clearEmbeddings(documentId: string): void {
    // Tell extension to clear embeddings
    window.postMessage({
      type: 'LOSSY_CLEAR_EMBEDDINGS',
      documentId,
    }, '*');
  }
}

/**
 * Local inference provider using Web Worker
 */
class LocalProvider implements InferenceProvider {
  setProgressCallback(callback: ((stage: string, progress: number) => void) | null): void {
    inferenceClient.setProgressCallback(callback);
  }

  async detectText(imageElement: HTMLImageElement): Promise<DetectedRegion[]> {
    const imageData = await imageElementToImageData(imageElement);
    const result = await inferenceClient.detectText(imageData);
    return result.regions;
  }

  async computeEmbeddings(documentId: string, imageElement: HTMLImageElement): Promise<void> {
    const imageData = await imageElementToImageData(imageElement);
    await inferenceClient.computeEmbeddings(documentId, imageData);
  }

  async segmentAtPoints(
    documentId: string,
    points: PointPrompt[],
    imageSize: { width: number; height: number }
  ): Promise<SegmentResult> {
    return inferenceClient.segmentAtPoints(documentId, points, imageSize);
  }

  clearEmbeddings(documentId: string): void {
    inferenceClient.clearEmbeddings(documentId);
  }
}

/**
 * Convert an HTMLImageElement to ImageData
 */
async function imageElementToImageData(img: HTMLImageElement): Promise<ImageData> {
  // Wait for image to load if not already
  if (!img.complete) {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Cached provider instance
let cachedProvider: InferenceProvider | null = null;

/**
 * Get the appropriate inference provider
 * Returns ExtensionProvider if extension is installed, otherwise LocalProvider
 */
export async function getInferenceProvider(): Promise<InferenceProvider> {
  if (cachedProvider) {
    return cachedProvider;
  }

  if (isExtensionAvailable()) {
    console.log('[InferenceProvider] Using extension for ML inference');
    cachedProvider = new ExtensionProvider();
  } else {
    console.log('[InferenceProvider] Using local Web Worker for ML inference');
    cachedProvider = new LocalProvider();
    // Initialize the worker
    await inferenceClient.init();
  }

  return cachedProvider;
}

/**
 * Clear the cached provider (useful for testing)
 */
export function clearProviderCache(): void {
  cachedProvider = null;
}
