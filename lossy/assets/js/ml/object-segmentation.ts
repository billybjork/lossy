/**
 * Object Segmentation using EdgeSAM
 *
 * Implements click-to-segment using cached embeddings.
 *
 * EdgeSAM specs:
 * - Encoder: 1x3x1024x1024 input -> 1x256x64x64 embeddings
 * - Decoder: embeddings + points -> binary masks
 *
 * Preprocessing (letterbox resize):
 * - Resize longest side to 1024, preserving aspect ratio
 * - Pad to 1024x1024 (right/bottom padding)
 * - Apply ImageNet normalization
 */

import {
  getSamEncoderSession,
  getSamDecoderSession,
  getBackend,
  createFloat32Tensor,
} from './sessions';

import type { Tensor } from 'onnxruntime-web';
import type { BoundingBox, PointPrompt, SegmentMask, SegmentationResult } from './types';

// EdgeSAM input size (fixed)
const SAM_INPUT_SIZE = 1024;

// SAM ImageNet normalization (pixel values after resize)
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];

// Resize info to track letterbox transformation
interface ResizeInfo {
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;  // After resize, before padding
  resizedHeight: number; // After resize, before padding
  scale: number;         // Scale factor applied (longest side -> 1024)
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
 * - Pad to 1024x1024 (right/bottom padding)
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

  // Create 1024x1024 canvas with padding
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
  // - point_coords: [1, N, 2] - (x, y) format in 1024x1024 space
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
 * Bilinear interpolation for smooth upsampling
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
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Convert decoder mask output to binary mask at original resolution
 */
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
  const maskW = maskDims.width || 256;
  const maskH = maskDims.height || 256;

  // Calculate how much of the mask corresponds to actual image (not padding)
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
      const srcX = (x / originalWidth) * cropW;
      const srcY = (y / originalHeight) * cropH;

      // Bilinear interpolation in logit space (BEFORE thresholding)
      const logit = bilinearInterpolate(maskData, srcX, srcY, maskW, cropW, cropH);

      // Convert logit to soft alpha (0-255) using sigmoid
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
 * Calculate stability score for a mask.
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
  const { mask, bbox, area } = postprocessMask(maskData, maskDims, resizeInfo);

  const positiveCount = points.filter(p => p.label === 1).length;
  const negativeCount = points.filter(p => p.label === 0).length;
  console.log(`[ML] Click-to-segment with ${positiveCount} positive, ${negativeCount} negative points: score=${score.toFixed(3)}, stability=${stabilityScore.toFixed(3)}, area=${area} in ${(performance.now() - startTime).toFixed(0)}ms`);

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
