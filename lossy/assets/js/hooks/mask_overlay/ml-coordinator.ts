/**
 * ML Coordinator
 *
 * Manages all ML inference operations for the MaskOverlay hook:
 * - Provider initialization and caching
 * - Embeddings computation and tracking
 * - Text detection
 * - Point-based segmentation
 * - Auto-segmentation
 *
 * Extracted from MaskOverlay to reduce complexity and improve testability.
 */

import type { InferenceProvider } from '../../ml/inference-provider';
import { getInferenceProvider } from '../../ml/inference-provider';
import { waitForImageLoad, getEditorImage } from './image-utils';
import type { DetectedRegion, PointPrompt, AutoSegmentConfig } from '../../ml/types';
import type { SegmentResult, AutoSegmentBatchResult, AutoSegmentCompleteResult } from '../../ml/inference-client';

export interface MLCoordinatorConfig {
  documentId: string;
  imageWidth: number;
  imageHeight: number;
  onProgress?: (stage: string, progress: number) => void;
}

/**
 * Coordinates all ML inference operations
 */
export class MLCoordinator {
  private provider: InferenceProvider | null = null;
  private providerPromise: Promise<InferenceProvider> | null = null;
  private embeddingsReady = false;
  private embeddingsPromise: Promise<void> | null = null;
  private textDetectionTimestamp: number | null = null;
  private textDetectionPromise: Promise<DetectedRegion[]> | null = null;

  constructor(private config: MLCoordinatorConfig) {}

  /**
   * Get or initialize the inference provider
   * Returns cached provider if already initialized
   */
  async getProvider(): Promise<InferenceProvider> {
    if (this.provider) return this.provider;
    if (this.providerPromise) return this.providerPromise;

    this.providerPromise = getInferenceProvider();
    this.provider = await this.providerPromise;

    if (this.config.onProgress) {
      this.provider.setProgressCallback(this.config.onProgress);
    }

    return this.provider;
  }

  /**
   * Check if embeddings are ready
   */
  areEmbeddingsReady(): boolean {
    return this.embeddingsReady;
  }

  /**
   * Ensure embeddings are computed for the current document
   * Waits for image to load if necessary
   */
  async ensureEmbeddings(): Promise<void> {
    if (this.embeddingsReady) return;
    if (this.embeddingsPromise) return this.embeddingsPromise;

    const img = getEditorImage();
    if (!img) throw new Error('Editor image not found');

    this.embeddingsPromise = (async () => {
      await waitForImageLoad(img);
      const provider = await this.getProvider();
      await provider.computeEmbeddings(this.config.documentId, img);
      this.embeddingsReady = true;
    })();

    return this.embeddingsPromise;
  }

  /**
   * Run text detection on the current image
   * Returns cached results if already attempted
   */
  async detectText(): Promise<DetectedRegion[]> {
    if (this.textDetectionPromise) return this.textDetectionPromise;
    if (this.textDetectionTimestamp !== null) return [];

    this.textDetectionTimestamp = Date.now();
    const img = getEditorImage();
    if (!img) return [];

    this.textDetectionPromise = (async () => {
      await waitForImageLoad(img);
      const provider = await this.getProvider();
      return await provider.detectText(img);
    })();

    return this.textDetectionPromise;
  }

  /**
   * Check if text detection has been attempted
   */
  hasAttemptedTextDetection(): boolean {
    return this.textDetectionTimestamp !== null;
  }

  /**
   * Get the timestamp when text detection was attempted
   * Returns null if not yet attempted
   */
  getTextDetectionTimestamp(): number | null {
    return this.textDetectionTimestamp;
  }

  /**
   * Segment at specific points using cached embeddings
   * Automatically ensures embeddings are computed first
   */
  async segmentAtPoints(points: PointPrompt[]): Promise<SegmentResult> {
    await this.ensureEmbeddings();
    const provider = await this.getProvider();

    return provider.segmentAtPoints(
      this.config.documentId,
      points,
      { width: this.config.imageWidth, height: this.config.imageHeight }
    );
  }

  /**
   * Run automatic segmentation with streaming batch results
   */
  async autoSegment(
    callbacks: {
      onBatch: (batch: AutoSegmentBatchResult) => void;
      onComplete: (result: AutoSegmentCompleteResult) => void;
    },
    config?: Partial<AutoSegmentConfig>
  ): Promise<void> {
    const img = getEditorImage();
    if (!img) throw new Error('Editor image not found');

    await waitForImageLoad(img);
    const provider = await this.getProvider();

    return provider.autoSegment(this.config.documentId, img, callbacks, config);
  }

  /**
   * Clear embeddings and reset state
   */
  cleanup(): void {
    if (this.provider && this.config.documentId) {
      this.provider.clearEmbeddings(this.config.documentId);
    }
    this.embeddingsReady = false;
    this.embeddingsPromise = null;
    this.textDetectionTimestamp = null;
    this.textDetectionPromise = null;
  }
}
