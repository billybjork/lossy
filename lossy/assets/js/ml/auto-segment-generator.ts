/**
 * Automatic Segment Generator
 *
 * Pre-computes high-confidence object segments using grid-based sampling.
 * Similar to SAM's AutomaticMaskGenerator but optimized for browser performance.
 *
 * Strategy:
 * - Sparse grid sampling (8x8 = 64 points for ~3-4 second total inference)
 * - Aggressive quality filtering (only very high confidence masks)
 * - Non-maximal suppression to remove duplicate/overlapping masks
 * - Progressive batch delivery for perceived performance
 */

import { segmentAtPoints, getImageEmbeddings, type Sam2Embeddings } from './object-segmentation';
import { maskToPngAsync } from './mask-utils';
import type { BoundingBox, PointPrompt } from './types';

/**
 * Configuration for automatic segment generation
 */
export interface AutoSegmentConfig {
  // Grid density: pointsPerSide^2 total points
  // 8x8 = 64 points is a good balance of coverage vs speed
  pointsPerSide: number;

  // Quality thresholds (stricter than interactive mode)
  predIouThresh: number;      // Minimum predicted IoU score
  stabilityScoreThresh: number; // Minimum stability score

  // Size filtering
  minMaskAreaRatio: number;   // Minimum mask area as ratio of image (e.g., 0.005 = 0.5%)
  maxMaskAreaRatio: number;   // Maximum mask area as ratio of image (e.g., 0.6 = 60%)

  // Non-maximal suppression threshold
  boxNmsThresh: number;

  // Batch processing
  pointsPerBatch: number;     // Points to process before yielding results
}

/**
 * Result from a single point's segmentation
 */
export interface AutoSegmentMask {
  mask_png: string;
  bbox: BoundingBox;
  score: number;
  stabilityScore: number;
  area: number;
  centroid: { x: number; y: number };
  pointPrompt: { x: number; y: number };  // The grid point that generated this mask
}

/**
 * Batch result for progressive delivery
 */
export interface AutoSegmentBatch {
  masks: AutoSegmentMask[];
  progress: number;           // 0-1 progress indicator
  batchIndex: number;
  totalBatches: number;
}

/**
 * Default configuration optimized for high-confidence pre-computation
 */
export const DEFAULT_AUTO_SEGMENT_CONFIG: AutoSegmentConfig = {
  pointsPerSide: 8,           // 8x8 = 64 points, ~3-4 seconds
  predIouThresh: 0.85,        // Very high confidence only
  stabilityScoreThresh: 0.92, // Very stable boundaries
  minMaskAreaRatio: 0.005,    // At least 0.5% of image
  maxMaskAreaRatio: 0.60,     // No more than 60% of image
  boxNmsThresh: 0.7,          // Standard NMS threshold
  pointsPerBatch: 8,          // Yield results every 8 points
};

/**
 * Generate a grid of point prompts
 */
export function generatePointGrid(
  imageWidth: number,
  imageHeight: number,
  pointsPerSide: number
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];

  // Calculate spacing to evenly distribute points
  const xSpacing = imageWidth / (pointsPerSide + 1);
  const ySpacing = imageHeight / (pointsPerSide + 1);

  for (let row = 1; row <= pointsPerSide; row++) {
    for (let col = 1; col <= pointsPerSide; col++) {
      points.push({
        x: col * xSpacing,
        y: row * ySpacing,
      });
    }
  }

  return points;
}

/**
 * Calculate IoU between two bounding boxes
 */
export function calculateBboxIoU(a: BoundingBox, b: BoundingBox): number {
  const xA = Math.max(a.x, b.x);
  const yA = Math.max(a.y, b.y);
  const xB = Math.min(a.x + a.w, b.x + b.w);
  const yB = Math.min(a.y + a.h, b.y + b.h);

  const interWidth = Math.max(0, xB - xA);
  const interHeight = Math.max(0, yB - yA);
  const interArea = interWidth * interHeight;

  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Non-maximal suppression to remove overlapping masks
 * Keeps higher-scoring masks when overlap exceeds threshold
 */
export function nonMaximalSuppression(
  masks: AutoSegmentMask[],
  iouThreshold: number
): AutoSegmentMask[] {
  if (masks.length === 0) return [];

  // Sort by score descending
  const sorted = [...masks].sort((a, b) => b.score - a.score);
  const keep: AutoSegmentMask[] = [];

  for (const mask of sorted) {
    let shouldKeep = true;

    for (const kept of keep) {
      const iou = calculateBboxIoU(mask.bbox, kept.bbox);
      if (iou > iouThreshold) {
        shouldKeep = false;
        break;
      }
    }

    if (shouldKeep) {
      keep.push(mask);
    }
  }

  return keep;
}

/**
 * Calculate the centroid of a mask from its bounding box
 */
function calculateCentroid(bbox: BoundingBox): { x: number; y: number } {
  return {
    x: bbox.x + bbox.w / 2,
    y: bbox.y + bbox.h / 2,
  };
}

/**
 * Filter masks based on quality and size criteria
 */
function filterMask(
  mask: { score: number; stabilityScore: number; area: number; bbox: BoundingBox },
  imageArea: number,
  config: AutoSegmentConfig
): boolean {
  // Check quality thresholds
  if (mask.score < config.predIouThresh) return false;
  if (mask.stabilityScore < config.stabilityScoreThresh) return false;

  // Check size thresholds
  const areaRatio = mask.area / imageArea;
  if (areaRatio < config.minMaskAreaRatio) return false;
  if (areaRatio > config.maxMaskAreaRatio) return false;

  return true;
}

/**
 * Run automatic segmentation on cached embeddings
 * Yields batches of results for progressive delivery
 */
export async function* generateAutoSegments(
  embeddings: Sam2Embeddings,
  imageSize: { width: number; height: number },
  config: AutoSegmentConfig = DEFAULT_AUTO_SEGMENT_CONFIG,
  onProgress?: (progress: number) => void
): AsyncGenerator<AutoSegmentBatch, void, unknown> {
  const { width, height } = imageSize;
  const imageArea = width * height;

  // Generate grid points
  const gridPoints = generatePointGrid(width, height, config.pointsPerSide);
  const totalPoints = gridPoints.length;
  const totalBatches = Math.ceil(totalPoints / config.pointsPerBatch);

  console.log(`[AutoSegment] Starting auto-segmentation with ${totalPoints} grid points`);

  let allMasks: AutoSegmentMask[] = [];
  let processedPoints = 0;

  // Process points in batches
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * config.pointsPerBatch;
    const batchEnd = Math.min(batchStart + config.pointsPerBatch, totalPoints);
    const batchPoints = gridPoints.slice(batchStart, batchEnd);

    const batchMasks: AutoSegmentMask[] = [];

    // Process each point in this batch
    for (const point of batchPoints) {
      try {
        // Create a positive point prompt
        const pointPrompt: PointPrompt = { x: point.x, y: point.y, label: 1 };

        // Run segmentation
        const result = await segmentAtPoints(embeddings, [pointPrompt], imageSize);

        processedPoints++;
        const progress = processedPoints / totalPoints;

        if (onProgress) {
          onProgress(progress);
        }

        // Filter based on quality and size
        if (!filterMask(result, imageArea, config)) {
          continue;
        }

        // Convert mask to PNG
        const mask_png = await maskToPngAsync(result.mask, width, height);

        const autoMask: AutoSegmentMask = {
          mask_png,
          bbox: result.bbox,
          score: result.score,
          stabilityScore: result.stabilityScore,
          area: result.area,
          centroid: calculateCentroid(result.bbox),
          pointPrompt: point,
        };

        batchMasks.push(autoMask);
        allMasks.push(autoMask);

      } catch (error) {
        console.warn(`[AutoSegment] Failed to segment at point (${point.x}, ${point.y}):`, error);
        processedPoints++;
      }
    }

    // Apply NMS to accumulated masks so far
    const dedupedMasks = nonMaximalSuppression(allMasks, config.boxNmsThresh);

    // Only include newly deduped masks from this batch
    const newMasks = batchMasks.filter(m => dedupedMasks.includes(m));

    // Update allMasks to the deduped set
    allMasks = dedupedMasks;

    // Yield batch results
    if (newMasks.length > 0) {
      yield {
        masks: newMasks,
        progress: processedPoints / totalPoints,
        batchIndex,
        totalBatches,
      };
    }
  }

  console.log(`[AutoSegment] Completed: ${allMasks.length} high-confidence masks from ${totalPoints} points`);
}

/**
 * Run automatic segmentation and collect all results (non-streaming version)
 */
export async function runAutoSegmentation(
  embeddings: Sam2Embeddings,
  imageSize: { width: number; height: number },
  config: AutoSegmentConfig = DEFAULT_AUTO_SEGMENT_CONFIG,
  onProgress?: (progress: number) => void
): Promise<AutoSegmentMask[]> {
  const allMasks: AutoSegmentMask[] = [];

  for await (const batch of generateAutoSegments(embeddings, imageSize, config, onProgress)) {
    allMasks.push(...batch.masks);
  }

  return allMasks;
}

/**
 * Run auto-segmentation from raw image data (computes embeddings first)
 * This is a convenience function for the full pipeline
 */
export async function autoSegmentFromImageData(
  imageData: ImageData,
  config: AutoSegmentConfig = DEFAULT_AUTO_SEGMENT_CONFIG,
  onProgress?: (stage: string, progress: number) => void
): Promise<AutoSegmentMask[]> {
  // Compute embeddings
  onProgress?.('computing_embeddings', 0);
  const { embeddings } = await getImageEmbeddings(imageData);
  onProgress?.('computing_embeddings', 1);

  // Run auto-segmentation
  const masks = await runAutoSegmentation(
    embeddings,
    { width: imageData.width, height: imageData.height },
    config,
    (progress) => onProgress?.('auto_segmenting', progress)
  );

  return masks;
}
