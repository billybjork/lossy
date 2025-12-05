/**
 * Object Segmentation using EdgeSAM
 *
 * Implements automatic segmentation using a grid of points,
 * and click-to-segment using cached embeddings.
 *
 * EdgeSAM specs:
 * - Encoder: 1×3×1024×1024 input → 1×256×64×64 embeddings
 * - Decoder: embeddings + points → binary masks
 *
 * Preprocessing (letterbox resize):
 * - Resize longest side to 1024, preserving aspect ratio
 * - Pad to 1024×1024 (right/bottom padding)
 * - Apply ImageNet normalization
 */

import {
  getSamEncoderSession,
  getSamDecoderSession,
  getBackend,
  createFloat32Tensor,
} from './onnx-session';

import { removeSmallComponents, closeMask } from './mask-utils';

import type { Tensor } from 'onnxruntime-web';

// EdgeSAM input size (fixed)
const SAM_INPUT_SIZE = 1024;

// Automatic segmentation parameters
const GRID_SIZE = 8; // 8×8 = 64 points (reduced from 16×16 for speed)
// EdgeSAM has ~10% lower accuracy than SAM with point prompts, so use lower thresholds
const CONFIDENCE_THRESHOLD = 0.85; // Predicted IoU threshold (SAM default: 0.88)
const STABILITY_THRESHOLD = 0.75; // Stability threshold (SAM default: 0.95, lower for EdgeSAM)
const IOU_THRESHOLD = 0.7; // NMS threshold (SAM default: 0.7)
const MAX_AREA_RATIO = 0.50; // Reject masks covering >50% of image
const MAX_MASKS = 10;

// SAM ImageNet normalization (pixel values after resize)
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];

// Resize info to track letterbox transformation
interface ResizeInfo {
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;  // After resize, before padding
  resizedHeight: number; // After resize, before padding
  scale: number;         // Scale factor applied (longest side → 1024)
}

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PointPrompt {
  x: number;
  y: number;
  label: number; // 1 = foreground (positive), 0 = background (negative)
}

export interface SegmentMask {
  mask: Uint8Array; // Binary mask at original resolution
  bbox: BoundingBox;
  score: number; // Predicted IoU score
  stabilityScore: number; // Mask stability under threshold changes
  area: number;
}

export interface SegmentationResult {
  masks: SegmentMask[];
  embeddings: Float32Array; // For click-to-segment
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}

/**
 * Calculate resize dimensions preserving aspect ratio (longest side = target)
 */
function getPreprocessShape(oldH: number, oldW: number, longestEdge: number): { newH: number; newW: number } {
  const scale = longestEdge / Math.max(oldH, oldW);
  const newH = Math.round(oldH * scale);
  const newW = Math.round(oldW * scale);
  return { newH, newW };
}

/**
 * Preprocess image for EdgeSAM encoder using letterbox resize
 * - Resize longest side to 1024 (preserve aspect ratio)
 * - Pad to 1024×1024 (right/bottom padding)
 * - Apply ImageNet normalization
 */
function preprocessImage(imageData: ImageData): {
  tensor: Float32Array;
  resizeInfo: ResizeInfo;
} {
  const { width, height } = imageData;

  // Calculate resize dimensions (longest side = 1024)
  const { newH, newW } = getPreprocessShape(height, width, SAM_INPUT_SIZE);
  const scale = SAM_INPUT_SIZE / Math.max(height, width);

  // Create canvas for resized image
  const resizeCanvas = new OffscreenCanvas(newW, newH);
  const resizeCtx = resizeCanvas.getContext('2d')!;

  // Draw original image to temp canvas first
  const tempCanvas = new OffscreenCanvas(width, height);
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);

  // Resize to new dimensions (preserving aspect ratio)
  resizeCtx.drawImage(tempCanvas, 0, 0, newW, newH);

  // Create 1024×1024 canvas with padding
  const paddedCanvas = new OffscreenCanvas(SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  const paddedCtx = paddedCanvas.getContext('2d')!;

  // Fill with black (padding color - will be normalized to ~-2.1 which is fine)
  paddedCtx.fillStyle = '#000';
  paddedCtx.fillRect(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);

  // Draw resized image at top-left (padding goes to right/bottom)
  paddedCtx.drawImage(resizeCanvas, 0, 0);

  const paddedData = paddedCtx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);

  // Convert to CHW format with ImageNet normalization
  const tensor = new Float32Array(3 * SAM_INPUT_SIZE * SAM_INPUT_SIZE);
  const pixels = paddedData.data;

  for (let i = 0; i < SAM_INPUT_SIZE * SAM_INPUT_SIZE; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];

    // Apply ImageNet normalization: (pixel - mean) / std
    tensor[i] = (r - PIXEL_MEAN[0]) / PIXEL_STD[0];
    tensor[SAM_INPUT_SIZE * SAM_INPUT_SIZE + i] = (g - PIXEL_MEAN[1]) / PIXEL_STD[1];
    tensor[2 * SAM_INPUT_SIZE * SAM_INPUT_SIZE + i] = (b - PIXEL_MEAN[2]) / PIXEL_STD[2];
  }

  const resizeInfo: ResizeInfo = {
    originalWidth: width,
    originalHeight: height,
    resizedWidth: newW,
    resizedHeight: newH,
    scale,
  };

  return { tensor, resizeInfo };
}

/**
 * Run EdgeSAM encoder to get image embeddings
 */
async function runEncoder(imageData: ImageData): Promise<{
  embeddings: Float32Array;
  resizeInfo: ResizeInfo;
}> {
  const session = await getSamEncoderSession();

  const { tensor, resizeInfo } = preprocessImage(imageData);

  // Create input tensor [1, 3, 1024, 1024]
  const inputTensor = createFloat32Tensor(tensor, [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]);

  // Run encoder
  const feeds: Record<string, Tensor> = {};
  feeds[session.inputNames[0]] = inputTensor;

  const results = await session.run(feeds);
  const outputTensor = results[session.outputNames[0]];

  // Copy embeddings (they're owned by the session)
  const embeddings = new Float32Array(outputTensor.data as Float32Array);

  return { embeddings, resizeInfo };
}

/**
 * Transform point coordinates from original image space to model input space
 * Uses the same formula as SAM's apply_coords: coord * scale
 */
function transformCoords(
  point: { x: number; y: number },
  resizeInfo: ResizeInfo
): { x: number; y: number } {
  // Scale coordinates by the resize factor
  // Since padding is added to right/bottom, no offset is needed
  return {
    x: point.x * resizeInfo.scale,
    y: point.y * resizeInfo.scale,
  };
}

/**
 * Run EdgeSAM decoder with multiple point prompts
 */
async function runDecoder(
  embeddings: Float32Array,
  points: PointPrompt[],
  resizeInfo: ResizeInfo
): Promise<{
  mask: Float32Array;
  score: number;
  maskDims: { width: number; height: number };
}> {
  const session = await getSamDecoderSession();

  // Transform all points from original image coords to model input coords
  const numPoints = points.length;
  const coordsData = new Float32Array(numPoints * 2);
  const labelsData = new Float32Array(numPoints);

  points.forEach((pt, i) => {
    const transformed = transformCoords(pt, resizeInfo);
    coordsData[i * 2] = transformed.x;
    coordsData[i * 2 + 1] = transformed.y;
    labelsData[i] = pt.label;
  });

  // Prepare inputs
  // EdgeSAM decoder expects:
  // - image_embeddings: [1, 256, 64, 64]
  // - point_coords: [1, N, 2] - (x, y) format in 1024×1024 space
  // - point_labels: [1, N]

  const embeddingsTensor = createFloat32Tensor(embeddings, [1, 256, 64, 64]);
  const pointCoords = createFloat32Tensor(coordsData, [1, numPoints, 2]);
  const pointLabels = createFloat32Tensor(labelsData, [1, numPoints]);

  const feeds: Record<string, Tensor> = {};

  // Map input names (EdgeSAM decoder only needs 3 inputs)
  for (const name of session.inputNames) {
    if (name.includes('image') || name.includes('embed')) {
      feeds[name] = embeddingsTensor;
    } else if (name.includes('coord')) {
      feeds[name] = pointCoords;
    } else if (name.includes('label')) {
      feeds[name] = pointLabels;
    }
  }

  const results = await session.run(feeds);

  // Get mask and score outputs
  let mask: Float32Array | null = null;
  let maskDims = { width: 0, height: 0 };
  let score = 0;

  for (const name of session.outputNames) {
    const output = results[name];
    if (name.includes('mask') && !name.includes('score')) {
      mask = new Float32Array(output.data as Float32Array);
      // Get actual mask dimensions from tensor shape
      // Shape is typically [1, num_masks, H, W] - we want H and W
      const dims = output.dims as number[];
      if (dims.length >= 4) {
        maskDims = { height: dims[2], width: dims[3] };
      } else if (dims.length >= 2) {
        // Fallback for 2D output
        maskDims = { height: dims[0], width: dims[1] };
      }
    } else if (name.includes('score') || name.includes('iou')) {
      const scores = output.data as Float32Array;
      score = Math.max(...scores);
    }
  }

  if (!mask) {
    throw new Error('No mask output from decoder');
  }

  return { mask, score, maskDims };
}

/**
 * Convert decoder mask output to binary mask at original resolution
 *
 * The decoder outputs masks at some resolution (e.g., 256×256 or 1024×1024).
 * This mask corresponds to the 1024×1024 padded input, so we need to:
 * 1. Crop out the padding area (keep only resizedWidth × resizedHeight portion)
 * 2. Resize from the cropped area to original image dimensions
 */
/**
 * Bilinear interpolation for smooth upsampling
 * Samples from Float32Array at subpixel coordinates
 * @param data - flat array of mask values
 * @param x - x coordinate to sample (in crop space)
 * @param y - y coordinate to sample (in crop space)
 * @param stride - array width for indexing (full mask width)
 * @param cropW - max valid x coordinate (crop width)
 * @param cropH - max valid y coordinate (crop height)
 */
function bilinearInterpolate(
  data: Float32Array,
  x: number,
  y: number,
  stride: number,
  cropW: number,
  cropH: number
): number {
  // Get 4 surrounding pixels, bounded by crop dimensions
  const x0 = Math.floor(x);
  const x1 = Math.min(x0 + 1, cropW - 1);
  const y0 = Math.floor(y);
  const y1 = Math.min(y0 + 1, cropH - 1);

  // Get fractional parts
  const fx = x - x0;
  const fy = y - y0;

  // Get 4 pixel values using stride for array indexing
  const v00 = data[y0 * stride + x0];
  const v10 = data[y0 * stride + x1];
  const v01 = data[y1 * stride + x0];
  const v11 = data[y1 * stride + x1];

  // Bilinear interpolation formula
  const v0 = v00 * (1 - fx) + v10 * fx;
  const v1 = v01 * (1 - fx) + v11 * fx;
  return v0 * (1 - fy) + v1 * fy;
}

/**
 * Sigmoid function for soft alpha conversion
 * Maps logits (-inf, +inf) to alpha values (0, 255)
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function postprocessMask(
  maskData: Float32Array,
  maskDims: { width: number; height: number },
  resizeInfo: ResizeInfo
): {
  mask: Uint8Array;
  bbox: BoundingBox;
  area: number;
} {
  const { originalWidth, originalHeight, resizedWidth, resizedHeight } = resizeInfo;

  // Determine the mask output size
  // The mask is at maskDims resolution, corresponding to 1024×1024 input
  const maskW = maskDims.width || 256;  // Default to 256 if not provided
  const maskH = maskDims.height || 256;

  // Calculate how much of the mask corresponds to actual image (not padding)
  // The image occupies resizedWidth×resizedHeight of the 1024×1024 input
  // So in mask space, it occupies (resizedWidth/1024)*maskW × (resizedHeight/1024)*maskH
  const cropW = Math.round((resizedWidth / SAM_INPUT_SIZE) * maskW);
  const cropH = Math.round((resizedHeight / SAM_INPUT_SIZE) * maskH);

  // Create binary mask at original resolution
  const mask = new Uint8Array(originalWidth * originalHeight);

  let minX = originalWidth;
  let minY = originalHeight;
  let maxX = 0;
  let maxY = 0;
  let area = 0;

  // For each pixel in the original image, find the corresponding mask pixel
  for (let y = 0; y < originalHeight; y++) {
    for (let x = 0; x < originalWidth; x++) {
      // Map from original coords to cropped mask coords with subpixel precision
      // This gives us floating-point coordinates for bilinear interpolation
      const srcX = (x / originalWidth) * cropW;
      const srcY = (y / originalHeight) * cropH;

      // Bilinear interpolation in logit space (BEFORE thresholding)
      // This is critical: interpolating logits gives smooth gradients
      const logit = bilinearInterpolate(maskData, srcX, srcY, maskW, cropW, cropH);

      // Convert logit to soft alpha (0-255) using sigmoid
      // This creates smooth edges instead of hard binary masks
      const alpha = Math.round(sigmoid(logit) * 255);
      mask[y * originalWidth + x] = alpha;

      // For bbox and area calculation, still use binary threshold
      if (logit > 0) {
        area++;

        // Update bounding box
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bbox: BoundingBox = {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };

  return { mask, bbox, area };
}

/**
 * Calculate Intersection over Union between two masks
 */
function calculateIoU(mask1: Uint8Array, mask2: Uint8Array): number {
  let intersection = 0;
  let union = 0;

  for (let i = 0; i < mask1.length; i++) {
    const a = mask1[i] > 0;
    const b = mask2[i] > 0;

    if (a && b) intersection++;
    if (a || b) union++;
  }

  return union > 0 ? intersection / union : 0;
}

/**
 * Calculate stability score for a mask.
 *
 * The stability score is the IoU between binary masks obtained by thresholding
 * the predicted mask logits at high (+offset) and low (-offset) values.
 * A stable mask will have similar results at both thresholds.
 *
 * This is more robust than predicted IoU for filtering unreliable masks.
 */
function calculateStabilityScore(
  maskLogits: Float32Array,
  offset: number = 1.0
): number {
  let highCount = 0;
  let lowCount = 0;
  let intersection = 0;

  for (let i = 0; i < maskLogits.length; i++) {
    const logit = maskLogits[i];
    const high = logit > offset;
    const low = logit > -offset;

    if (high) highCount++;
    if (low) lowCount++;
    if (high && low) intersection++;
  }

  const union = highCount + lowCount - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Generate grid of points for automatic segmentation
 */
function generateGridPoints(
  width: number,
  height: number,
  gridSize: number = GRID_SIZE
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];

  const stepX = width / (gridSize + 1);
  const stepY = height / (gridSize + 1);

  for (let row = 1; row <= gridSize; row++) {
    for (let col = 1; col <= gridSize; col++) {
      points.push({
        x: col * stepX,
        y: row * stepY,
      });
    }
  }

  return points;
}

/**
 * Automatically segment an image using a grid of points
 * Returns the top masks filtered by confidence and deduplicated by IoU
 */
export async function segmentImage(
  imageData: ImageData,
  maxMasks: number = MAX_MASKS
): Promise<SegmentationResult> {
  const startTime = performance.now();
  const { width, height } = imageData;

  console.log(`[Lossy] Starting auto-segmentation for ${width}×${height} image`);

  // Run encoder (with letterbox preprocessing)
  const encoderStart = performance.now();
  const { embeddings, resizeInfo } = await runEncoder(imageData);
  console.log(`[Lossy] Encoder completed in ${(performance.now() - encoderStart).toFixed(0)}ms`);
  console.log(`[Lossy] Resize info: ${resizeInfo.originalWidth}×${resizeInfo.originalHeight} → ${resizeInfo.resizedWidth}×${resizeInfo.resizedHeight} (scale=${resizeInfo.scale.toFixed(3)})`);

  // Generate grid points in original image coordinates
  const points = generateGridPoints(width, height);
  console.log(`[Lossy] Processing ${points.length} grid points`);

  // Run decoder for each point and collect candidate masks
  const candidates: SegmentMask[] = [];
  const decoderStart = performance.now();

  let lowConfidenceCount = 0;
  let lowStabilityCount = 0;
  let tinyMaskCount = 0;
  let oversizedCount = 0;
  let maxScore = 0;
  let maxStability = 0;
  let allScores: number[] = [];
  let allStabilities: number[] = [];

  const minArea = width * height * 0.01;
  const maxArea = width * height * MAX_AREA_RATIO;

  for (const point of points) {
    try {
      const { mask: maskData, score, maskDims } = await runDecoder(
        embeddings,
        [{ x: point.x, y: point.y, label: 1 }], // Convert to PointPrompt array
        resizeInfo
      );

      maxScore = Math.max(maxScore, score);
      allScores.push(score);

      // Calculate stability score from raw logits (before binarization)
      const stabilityScore = calculateStabilityScore(maskData);
      maxStability = Math.max(maxStability, stabilityScore);
      allStabilities.push(stabilityScore);

      // Skip low confidence (predicted IoU)
      if (score < CONFIDENCE_THRESHOLD) {
        lowConfidenceCount++;
        continue;
      }

      // Skip unstable masks
      if (stabilityScore < STABILITY_THRESHOLD) {
        lowStabilityCount++;
        continue;
      }

      let { mask, bbox, area } = postprocessMask(maskData, maskDims, resizeInfo);

      // NOTE: Morphological operations disabled - they corrupt soft alpha gradients
      // The bilinear interpolation + sigmoid already provides smooth edges
      // mask = removeSmallComponents(mask, resizeInfo.originalWidth, resizeInfo.originalHeight, 50);
      // mask = closeMask(mask, resizeInfo.originalWidth, resizeInfo.originalHeight, 2);

      // Skip tiny masks (less than 1% of image)
      if (area < minArea) {
        tinyMaskCount++;
        continue;
      }

      // Skip oversized masks (likely background or failed segmentation)
      if (area > maxArea) {
        oversizedCount++;
        continue;
      }

      candidates.push({ mask, bbox, score, stabilityScore, area });
    } catch (error) {
      console.warn(`[Lossy] Decoder failed for point (${point.x}, ${point.y}):`, error);
    }
  }

  // Calculate score distribution for debugging
  const sortedScores = [...allScores].sort((a, b) => b - a);
  const sortedStabilities = [...allStabilities].sort((a, b) => b - a);
  const medianScore = sortedScores[Math.floor(sortedScores.length / 2)] || 0;
  const medianStability = sortedStabilities[Math.floor(sortedStabilities.length / 2)] || 0;
  const p90Score = sortedScores[Math.floor(sortedScores.length * 0.1)] || 0;
  const p90Stability = sortedStabilities[Math.floor(sortedStabilities.length * 0.1)] || 0;

  console.log(`[Lossy] Segmentation stats: ${lowConfidenceCount} low confidence, ${lowStabilityCount} unstable, ${tinyMaskCount} tiny, ${oversizedCount} oversized`);
  console.log(`[Lossy] Score distribution: max=${maxScore.toFixed(3)}, p90=${p90Score.toFixed(3)}, median=${medianScore.toFixed(3)}`);
  console.log(`[Lossy] Stability distribution: max=${maxStability.toFixed(3)}, p90=${p90Stability.toFixed(3)}, median=${medianStability.toFixed(3)}`);

  console.log(`[Lossy] Decoder completed in ${(performance.now() - decoderStart).toFixed(0)}ms, ${candidates.length} candidates`);

  // Sort by score × stabilityScore (prefer confident, stable masks)
  candidates.sort((a, b) => b.score * b.stabilityScore - a.score * a.stabilityScore);

  // Deduplicate by IoU (non-maximum suppression)
  const masks: SegmentMask[] = [];

  for (const candidate of candidates) {
    // Check IoU with existing masks
    let isDuplicate = false;

    for (const existing of masks) {
      const iou = calculateIoU(candidate.mask, existing.mask);
      if (iou > IOU_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      masks.push(candidate);

      if (masks.length >= maxMasks) {
        break;
      }
    }
  }

  const inferenceTimeMs = performance.now() - startTime;
  console.log(`[Lossy] Auto-segmentation complete: ${masks.length} masks in ${inferenceTimeMs.toFixed(0)}ms`);

  return {
    masks,
    embeddings,
    inferenceTimeMs,
    backend: getBackend('samEncoder'),
  };
}

/**
 * Segment at a specific point using cached embeddings
 * Used for click-to-segment interactivity (single point, backwards compatible)
 */
export async function segmentAtPoint(
  embeddings: Float32Array,
  point: { x: number; y: number },
  imageSize: { width: number; height: number }
): Promise<SegmentMask> {
  return segmentAtPoints(embeddings, [{ x: point.x, y: point.y, label: 1 }], imageSize);
}

/**
 * Segment using multiple point prompts with labels
 * Used for click-to-segment with refinement (positive + negative points)
 */
export async function segmentAtPoints(
  embeddings: Float32Array,
  points: PointPrompt[],
  imageSize: { width: number; height: number }
): Promise<SegmentMask> {
  const startTime = performance.now();

  if (points.length === 0) {
    throw new Error('At least one point is required for segmentation');
  }

  // Reconstruct resizeInfo from imageSize
  const { newH, newW } = getPreprocessShape(imageSize.height, imageSize.width, SAM_INPUT_SIZE);
  const resizeInfo: ResizeInfo = {
    originalWidth: imageSize.width,
    originalHeight: imageSize.height,
    resizedWidth: newW,
    resizedHeight: newH,
    scale: SAM_INPUT_SIZE / Math.max(imageSize.height, imageSize.width),
  };

  const { mask: maskData, score, maskDims } = await runDecoder(
    embeddings,
    points,
    resizeInfo
  );

  const stabilityScore = calculateStabilityScore(maskData);
  let { mask, bbox, area } = postprocessMask(maskData, maskDims, resizeInfo);

  // NOTE: Morphological operations disabled - they corrupt soft alpha gradients
  // mask = removeSmallComponents(mask, resizeInfo.originalWidth, resizeInfo.originalHeight, 50);
  // mask = closeMask(mask, resizeInfo.originalWidth, resizeInfo.originalHeight, 2);

  const positiveCount = points.filter(p => p.label === 1).length;
  const negativeCount = points.filter(p => p.label === 0).length;
  console.log(`[Lossy] Click-to-segment with ${positiveCount} positive, ${negativeCount} negative points: score=${score.toFixed(3)}, stability=${stabilityScore.toFixed(3)}, area=${area} in ${(performance.now() - startTime).toFixed(0)}ms`);

  return { mask, bbox, score, stabilityScore, area };
}

/**
 * Run only the encoder to get embeddings (for later click-to-segment)
 */
export async function getImageEmbeddings(imageData: ImageData): Promise<{
  embeddings: Float32Array;
  inferenceTimeMs: number;
  backend: 'webgpu' | 'wasm' | null;
}> {
  const startTime = performance.now();

  const { embeddings } = await runEncoder(imageData);

  return {
    embeddings,
    inferenceTimeMs: performance.now() - startTime,
    backend: getBackend('samEncoder'),
  };
}
