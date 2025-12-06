/**
 * Object Segmentation using SAM 2 (Segment Anything Model 2)
 *
 * Implements click-to-segment using cached embeddings.
 *
 * SAM 2 specs:
 * - Encoder: 1x3x1024x1024 input -> image_embed [1,256,64,64] + high_res_feats
 * - Decoder: embeddings + high_res_feats + points -> masks
 *
 * Preprocessing (direct resize):
 * - Resize directly to 1024x1024 (no aspect ratio preservation)
 * - Apply ImageNet normalization
 */

import {
  getSamEncoderSession,
  getSamDecoderSession,
  getBackend,
  createFloat32Tensor,
} from './sessions';

import type { Tensor } from 'onnxruntime-web';
import type { BoundingBox, PointPrompt, SegmentMask } from './types';

/**
 * Debug logging helper - only logs when DEBUG_LOSSY flag is set
 * Enable via: localStorage.setItem('DEBUG_LOSSY', 'true')
 */
function debugLog(message: string, ...args: unknown[]): void {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_LOSSY') === 'true') {
    console.log(message, ...args);
  }
}

// SAM 2 input size (fixed)
const SAM_INPUT_SIZE = 1024;

// SAM 2 ImageNet normalization (0-1 normalized values)
// Equivalent to pixel values: [123.675, 116.28, 103.53] / [58.395, 57.12, 57.375]
const PIXEL_MEAN = [0.485, 0.456, 0.406];
const PIXEL_STD = [0.229, 0.224, 0.225];

// Mask quality thresholds for aggressive filtering (ensures clean, solid objects)
// These thresholds filter out speckled, fragmented, or low-confidence masks
const MIN_IOU = 0.65;         // Minimum IoU score (high confidence only)
const MIN_STABILITY = 0.88;   // Minimum stability score (very coherent boundaries)
const MIN_COMPACTNESS = 0.85; // Minimum compactness (solid interior, no islands/speckles)

// Resize info to track transformation
interface ResizeInfo {
  originalWidth: number;
  originalHeight: number;
  scaleX: number;  // Independent x scale: 1024 / originalWidth
  scaleY: number;  // Independent y scale: 1024 / originalHeight
}

// SAM 2 encoder outputs (all 3 must be cached together)
export interface Sam2Embeddings {
  imageEmbed: Float32Array;      // [1, 256, 64, 64]
  highResFeats0: Float32Array;   // [1, 32, 256, 256]
  highResFeats1: Float32Array;   // [1, 64, 128, 128]
}

/**
 * Preprocess image for SAM 2 encoder using direct resize
 * - Resize directly to 1024x1024 (stretches image)
 * - Apply ImageNet normalization
 */
function preprocessImage(imageData: ImageData): {
  tensor: Float32Array;
  resizeInfo: ResizeInfo;
} {
  const { width, height } = imageData;

  // Calculate independent scale factors for x and y
  const scaleX = SAM_INPUT_SIZE / width;
  const scaleY = SAM_INPUT_SIZE / height;

  // Create canvas and resize directly to 1024x1024
  const tempCanvas = new OffscreenCanvas(width, height);
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);

  const resizedCanvas = new OffscreenCanvas(SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  const resizedCtx = resizedCanvas.getContext('2d')!;

  // Direct resize (stretches to 1024x1024)
  resizedCtx.drawImage(tempCanvas, 0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);

  const resizedData = resizedCtx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);

  // Convert to CHW format with ImageNet normalization
  const tensor = new Float32Array(3 * SAM_INPUT_SIZE * SAM_INPUT_SIZE);
  const pixels = resizedData.data;

  for (let i = 0; i < SAM_INPUT_SIZE * SAM_INPUT_SIZE; i++) {
    // Normalize to 0-1 range, then apply ImageNet normalization
    const r = pixels[i * 4] / 255.0;
    const g = pixels[i * 4 + 1] / 255.0;
    const b = pixels[i * 4 + 2] / 255.0;

    // Apply ImageNet normalization: (pixel - mean) / std
    tensor[i] = (r - PIXEL_MEAN[0]) / PIXEL_STD[0];
    tensor[SAM_INPUT_SIZE * SAM_INPUT_SIZE + i] = (g - PIXEL_MEAN[1]) / PIXEL_STD[1];
    tensor[2 * SAM_INPUT_SIZE * SAM_INPUT_SIZE + i] = (b - PIXEL_MEAN[2]) / PIXEL_STD[2];
  }

  const resizeInfo: ResizeInfo = {
    originalWidth: width,
    originalHeight: height,
    scaleX,
    scaleY,
  };

  return { tensor, resizeInfo };
}

/**
 * Run SAM 2 encoder to get image embeddings and high-res features
 */
async function runEncoder(imageData: ImageData): Promise<{
  embeddings: Sam2Embeddings;
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

  // Extract all 3 outputs
  let imageEmbed: Float32Array | null = null;
  let highResFeats0: Float32Array | null = null;
  let highResFeats1: Float32Array | null = null;

  debugLog(`[ML] Encoder output names: ${session.outputNames.join(', ')}`);
  for (const name of session.outputNames) {
    const output = results[name];
    const dims = output.dims as number[];
    debugLog(`[ML] Encoder output '${name}': dims=${JSON.stringify(dims)}, size=${(output.data as Float32Array).length}`);

    if (name === 'image_embed') {
      imageEmbed = new Float32Array(output.data as Float32Array);
    } else if (name === 'high_res_feats_0') {
      highResFeats0 = new Float32Array(output.data as Float32Array);
    } else if (name === 'high_res_feats_1') {
      highResFeats1 = new Float32Array(output.data as Float32Array);
    }
  }

  if (!imageEmbed || !highResFeats0 || !highResFeats1) {
    throw new Error('Missing encoder outputs. Expected: image_embed, high_res_feats_0, high_res_feats_1');
  }

  return {
    embeddings: { imageEmbed, highResFeats0, highResFeats1 },
    resizeInfo,
  };
}

/**
 * Transform point coordinates from original image space to model input space
 * SAM 2 uses independent x/y scaling (direct resize, not letterbox)
 */
function transformCoords(
  point: { x: number; y: number },
  resizeInfo: ResizeInfo
): { x: number; y: number } {
  return {
    x: point.x * resizeInfo.scaleX,
    y: point.y * resizeInfo.scaleY,
  };
}

/**
 * Run SAM 2 decoder with multiple point prompts
 */
async function runDecoder(
  embeddings: Sam2Embeddings,
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
    debugLog(`[ML] Point ${i}: original (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}) -> transformed (${transformed.x.toFixed(1)}, ${transformed.y.toFixed(1)}), label=${pt.label}`);
  });
  debugLog(`[ML] ResizeInfo: original ${resizeInfo.originalWidth}x${resizeInfo.originalHeight}, scaleX=${resizeInfo.scaleX.toFixed(4)}, scaleY=${resizeInfo.scaleY.toFixed(4)}`);

  // Prepare inputs for SAM 2 decoder
  // SAM 2 expects:
  // - image_embed: [1, 256, 64, 64]
  // - high_res_feats_0: [1, 32, 256, 256]
  // - high_res_feats_1: [1, 64, 128, 128]
  // - point_coords: [num_labels, num_points, 2]
  // - point_labels: [num_labels, num_points]
  // - mask_input: [num_labels, 1, 256, 256]
  // - has_mask_input: [num_labels]

  const imageEmbedTensor = createFloat32Tensor(embeddings.imageEmbed, [1, 256, 64, 64]);
  const highRes0Tensor = createFloat32Tensor(embeddings.highResFeats0, [1, 32, 256, 256]);
  const highRes1Tensor = createFloat32Tensor(embeddings.highResFeats1, [1, 64, 128, 128]);

  // Point coords: [1, numPoints, 2] (treating as single label/object)
  const pointCoords = createFloat32Tensor(coordsData, [1, numPoints, 2]);
  const pointLabels = createFloat32Tensor(labelsData, [1, numPoints]);

  // Mask input: zeros for initial prediction (no prior mask)
  const maskInput = createFloat32Tensor(new Float32Array(1 * 1 * 256 * 256), [1, 1, 256, 256]);
  const hasMaskInput = createFloat32Tensor(new Float32Array([0]), [1]);

  const feeds: Record<string, Tensor> = {
    image_embed: imageEmbedTensor,
    high_res_feats_0: highRes0Tensor,
    high_res_feats_1: highRes1Tensor,
    point_coords: pointCoords,
    point_labels: pointLabels,
    mask_input: maskInput,
    has_mask_input: hasMaskInput,
  };

  const results = await session.run(feeds);

  // Get mask and score outputs
  // SAM 2 outputs: masks [1, 3, H, W] and iou_predictions [1, 3]
  let allMasks: Float32Array | null = null;
  let maskDims = { width: 0, height: 0 };
  let scores: Float32Array | null = null;
  let numMasks = 3;

  for (const name of session.outputNames) {
    const output = results[name];
    const dims = output.dims as number[];
    debugLog(`[ML] Decoder output '${name}': dims=${JSON.stringify(dims)}`);
    if (name === 'masks') {
      allMasks = new Float32Array(output.data as Float32Array);
      // Shape is [1, num_masks, H, W]
      if (dims.length >= 4) {
        numMasks = dims[1];
        maskDims = { height: dims[2], width: dims[3] };
      }
    } else if (name === 'iou_predictions') {
      scores = new Float32Array(output.data as Float32Array);
    }
  }

  if (!allMasks || !scores) {
    throw new Error('Missing decoder outputs (masks or iou_predictions)');
  }

  // Calculate quality metrics for each candidate mask
  // AGGRESSIVE high-confidence segmentation: only accept clean, solid objects
  const maskSize = maskDims.width * maskDims.height;
  const candidates = [];

  for (let i = 0; i < numMasks; i++) {
    const offset = i * maskSize;
    const maskData = allMasks.slice(offset, offset + maskSize);

    // Calculate stability score (measures coherence - penalizes fragmentation)
    const stability = calculateStabilityScore(maskData);

    // Calculate compactness: measure how solid the interior is
    // Count transitions (row-wise and column-wise flips = fragmentation)
    let transitions = 0;
    const width = maskDims.width;
    const height = maskDims.height;

    // Row-wise transitions (horizontal fragmentation)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width; x++) {
        const prev = maskData[y * width + (x - 1)] > 0;
        const curr = maskData[y * width + x] > 0;
        if (prev !== curr) transitions++;
      }
    }

    // Column-wise transitions (vertical fragmentation)
    for (let x = 0; x < width; x++) {
      for (let y = 1; y < height; y++) {
        const prev = maskData[(y - 1) * width + x] > 0;
        const curr = maskData[y * width + x] > 0;
        if (prev !== curr) transitions++;
      }
    }

    // Calculate mask coverage and compactness
    let positivePixels = 0;
    for (let j = 0; j < maskSize; j++) {
      if (maskData[j] > 0) positivePixels++;
    }
    const coverage = positivePixels / maskSize;

    // Compactness: fewer transitions per positive pixel = more solid
    // Normalize by positive pixels to avoid penalizing larger masks
    const compactness = positivePixels > 0 ? 1 - Math.min(1, transitions / (positivePixels * 4)) : 0;

    // Combined quality score: heavily weight IoU, boost by stability AND compactness
    const iouScore = scores[i];
    const qualityScore = iouScore * (1 + stability * 0.4 + compactness * 0.4) * (coverage > 0.001 ? 1 : 0.5);

    candidates.push({
      index: i,
      iouScore,
      stability,
      compactness,
      coverage,
      qualityScore,
      maskData
    });
  }

  // Sort by quality score descending
  candidates.sort((a, b) => b.qualityScore - a.qualityScore);

  // Apply aggressive filtering using file-level threshold constants
  const bestCandidate = candidates.find(c =>
    c.iouScore >= MIN_IOU &&
    c.stability >= MIN_STABILITY &&
    c.compactness >= MIN_COMPACTNESS
  ) || candidates[0];

  const mask = bestCandidate.maskData;

  debugLog(`[ML] Candidates: ${candidates.map(c =>
    `[${c.index}] IoU=${c.iouScore.toFixed(3)} stab=${c.stability.toFixed(3)} comp=${c.compactness.toFixed(3)} cov=${(c.coverage * 100).toFixed(1)}% Q=${c.qualityScore.toFixed(3)}`
  ).join(' ')}`);
  debugLog(`[ML] Selected mask ${bestCandidate.index} (IoU=${bestCandidate.iouScore.toFixed(3)}, stability=${bestCandidate.stability.toFixed(3)}, compactness=${bestCandidate.compactness.toFixed(3)})`);

  return { mask, score: bestCandidate.iouScore, maskDims };
}

/**
 * Bilinear interpolation for smooth upsampling
 */
function bilinearInterpolate(
  data: Float32Array,
  x: number,
  y: number,
  stride: number,
  maxX: number,
  maxY: number
): number {
  const x0 = Math.floor(x);
  const x1 = Math.min(x0 + 1, maxX - 1);
  const y0 = Math.floor(y);
  const y1 = Math.min(y0 + 1, maxY - 1);

  const fx = x - x0;
  const fy = y - y0;

  const v00 = data[y0 * stride + x0];
  const v10 = data[y0 * stride + x1];
  const v01 = data[y1 * stride + x0];
  const v11 = data[y1 * stride + x1];

  const v0 = v00 * (1 - fx) + v10 * fx;
  const v1 = v01 * (1 - fx) + v11 * fx;
  return v0 * (1 - fy) + v1 * fy;
}

/**
 * Convert decoder mask output to binary mask at original resolution
 * Uses independent x/y scaling for SAM 2's direct resize approach
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
  const { originalWidth, originalHeight } = resizeInfo;

  // Mask output dimensions
  const maskW = maskDims.width || 256;
  const maskH = maskDims.height || 256;

  // Create binary mask at original resolution
  const mask = new Uint8Array(originalWidth * originalHeight);

  let minX = originalWidth;
  let minY = originalHeight;
  let maxX = 0;
  let maxY = 0;
  let area = 0;

  // Upsample mask from 256x256 to original resolution using bilinear interpolation
  // in logit space, then apply binary threshold. This matches g-ronimo's approach
  // and produces crisp edges (vs sigmoid which creates jagged/scattered artifacts).
  for (let y = 0; y < originalHeight; y++) {
    for (let x = 0; x < originalWidth; x++) {
      // Map original image coords to 256x256 mask coords (proportional scaling)
      const srcX = (x / originalWidth) * maskW;
      const srcY = (y / originalHeight) * maskH;

      const logit = bilinearInterpolate(maskData, srcX, srcY, maskW, maskW, maskH);

      // Binary threshold at logit > 0 (NOT sigmoid - see comment above)
      const alpha = logit > 0 ? 255 : 0;
      mask[y * originalWidth + x] = alpha;

      if (logit > 0) {
        area++;

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
  embeddings: Sam2Embeddings,
  points: PointPrompt[],
  imageSize: { width: number; height: number }
): Promise<SegmentMask> {
  const startTime = performance.now();

  if (points.length === 0) {
    throw new Error('At least one point is required for segmentation');
  }

  // Reconstruct resizeInfo from imageSize
  const resizeInfo: ResizeInfo = {
    originalWidth: imageSize.width,
    originalHeight: imageSize.height,
    scaleX: SAM_INPUT_SIZE / imageSize.width,
    scaleY: SAM_INPUT_SIZE / imageSize.height,
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
  debugLog(`[ML] SAM 2 click-to-segment with ${positiveCount} positive, ${negativeCount} negative points: score=${score.toFixed(3)}, stability=${stabilityScore.toFixed(3)}, area=${area} in ${(performance.now() - startTime).toFixed(0)}ms`);

  return { mask, bbox, score, stabilityScore, area };
}

/**
 * Run only the encoder to get embeddings (for later click-to-segment)
 */
export async function getImageEmbeddings(imageData: ImageData): Promise<{
  embeddings: Sam2Embeddings;
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
