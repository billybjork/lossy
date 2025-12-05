/**
 * Text Detection using PP-OCRv3 DBNet model
 *
 * Pipeline overview:
 * 1. Preprocessing: Resize to multiple of 32 (max 960px), normalize with ImageNet stats
 * 2. Model inference: DBNet outputs a probability map (same resolution as input)
 * 3. Postprocessing: Threshold, find connected components, extract bounding boxes
 *
 * Coordinate transformation (IMPORTANT - do not modify without understanding):
 * - The image is resized (potentially with aspect ratio change due to rounding to 32)
 * - Model outputs coordinates in resized space
 * - We scale coordinates back to original image space using:
 *     scaleX = originalWidth / resizedWidth
 *     scaleY = originalHeight / resizedHeight
 * - Box expansion uses PaddleOCR's Vatti clipping formula for uniform expansion:
 *     expandDistance = (area * UNCLIP_RATIO) / perimeter
 *   This gives equal expansion on all sides regardless of box aspect ratio.
 *
 * NOTE: This module is designed to run in a Web Worker context.
 * It uses OffscreenCanvas instead of document.createElement('canvas').
 */

import { getSession, getCurrentBackend, createTensor } from './sessions';
import type { DetectedRegion, DetectionResult } from './types';

// ImageNet normalization parameters for DBNet
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Detection parameters
const DETECTION_THRESHOLD = 0.3;  // Probability threshold for text regions
const MIN_BOX_SIZE = 5;           // Minimum box size in pixels
const UNCLIP_RATIO = 1.5;         // Ratio to expand detected boxes

/**
 * Detect text regions in an image
 */
export async function detectTextRegions(
  imageData: ImageData,
  originalWidth: number,
  originalHeight: number
): Promise<DetectionResult> {
  const startTime = performance.now();

  // Get ONNX session
  const session = await getSession();

  // Preprocess image
  const { tensor, resizedWidth, resizedHeight } = await preprocessImage(imageData);

  // Run inference
  const feeds = {
    [session.inputNames[0]]: tensor
  };

  const results = await session.run(feeds);
  const outputTensor = results[session.outputNames[0]];

  // Postprocess to get bounding boxes
  const regions = postprocessOutput(
    outputTensor.data as Float32Array,
    resizedWidth,
    resizedHeight,
    originalWidth,
    originalHeight
  );

  const inferenceTimeMs = performance.now() - startTime;

  console.log(`[ML] Text detection completed in ${inferenceTimeMs.toFixed(0)}ms, found ${regions.length} regions`);

  return {
    regions,
    inferenceTimeMs,
    backend: getCurrentBackend()
  };
}

/**
 * Create a canvas - uses OffscreenCanvas in Web Worker
 */
function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

/**
 * Preprocess image for DBNet model
 * - Resize to multiple of 32 (max 960)
 * - Normalize with ImageNet mean/std
 * - Convert to NCHW format
 */
async function preprocessImage(imageData: ImageData): Promise<{
  tensor: import('onnxruntime-web').Tensor;
  resizedWidth: number;
  resizedHeight: number;
}> {
  const { width, height } = imageData;

  // Calculate target size (multiple of 32, max 960)
  const maxSize = 960;
  const scale = Math.min(maxSize / Math.max(width, height), 1);
  let resizedWidth = Math.round(width * scale);
  let resizedHeight = Math.round(height * scale);

  // Round to multiple of 32
  resizedWidth = Math.ceil(resizedWidth / 32) * 32;
  resizedHeight = Math.ceil(resizedHeight / 32) * 32;

  // Create canvas for resizing (OffscreenCanvas in Web Worker)
  const canvas = createCanvas(resizedWidth, resizedHeight);
  const ctx = canvas.getContext('2d')!;

  // Create temporary canvas with original image
  const tempCanvas = createCanvas(width, height);
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);

  // Draw resized image
  ctx.drawImage(tempCanvas, 0, 0, resizedWidth, resizedHeight);
  const resizedData = ctx.getImageData(0, 0, resizedWidth, resizedHeight);

  // Convert to normalized NCHW float32 array
  const numPixels = resizedWidth * resizedHeight;
  const floatData = new Float32Array(3 * numPixels);

  for (let i = 0; i < numPixels; i++) {
    const r = resizedData.data[i * 4] / 255;
    const g = resizedData.data[i * 4 + 1] / 255;
    const b = resizedData.data[i * 4 + 2] / 255;

    // Normalize with ImageNet stats (RGB order)
    floatData[i] = (r - MEAN[0]) / STD[0];                    // R channel
    floatData[numPixels + i] = (g - MEAN[1]) / STD[1];        // G channel
    floatData[2 * numPixels + i] = (b - MEAN[2]) / STD[2];    // B channel
  }

  const tensor = await createTensor('float32', floatData, [1, 3, resizedHeight, resizedWidth]);

  return { tensor, resizedWidth, resizedHeight };
}

/**
 * Postprocess DBNet output to extract bounding boxes
 * The model outputs a probability map where each pixel indicates text probability
 */
function postprocessOutput(
  probMap: Float32Array,
  resizedWidth: number,
  resizedHeight: number,
  originalWidth: number,
  originalHeight: number
): DetectedRegion[] {
  const regions: DetectedRegion[] = [];

  // Create binary mask from probability map
  const binaryMask = new Uint8Array(probMap.length);
  for (let i = 0; i < probMap.length; i++) {
    binaryMask[i] = probMap[i] > DETECTION_THRESHOLD ? 255 : 0;
  }

  // Find connected components using flood fill
  const visited = new Set<number>();

  // Scale factors to convert from resized (model) space to original image space
  // IMPORTANT: Model outputs coordinates in resized space, must scale back to original
  const scaleX = originalWidth / resizedWidth;
  const scaleY = originalHeight / resizedHeight;

  for (let y = 0; y < resizedHeight; y++) {
    for (let x = 0; x < resizedWidth; x++) {
      const idx = y * resizedWidth + x;

      if (binaryMask[idx] === 0 || visited.has(idx)) {
        continue;
      }

      // Found a new region, flood fill to find boundaries
      const component = floodFill(binaryMask, resizedWidth, resizedHeight, x, y, visited);

      if (component.pixels.length < MIN_BOX_SIZE * MIN_BOX_SIZE) {
        continue;
      }

      // Calculate bounding box and confidence
      const bbox = component.bbox;
      const confidence = calculateRegionConfidence(probMap, resizedWidth, bbox);

      if (confidence < DETECTION_THRESHOLD) {
        continue;
      }

      // First scale bbox to original coordinates
      const scaledX = bbox.x * scaleX;
      const scaledY = bbox.y * scaleY;
      const scaledW = bbox.w * scaleX;
      const scaledH = bbox.h * scaleY;

      // Apply unclip expansion using PaddleOCR's area/perimeter formula
      // This gives uniform expansion on all sides: distance = area * ratio / perimeter
      const area = scaledW * scaledH;
      const perimeter = 2 * (scaledW + scaledH);
      const expandDistance = (area * UNCLIP_RATIO) / perimeter;

      // Clamp expanded bbox to image bounds
      const expandedBbox = {
        x: Math.max(0, scaledX - expandDistance),
        y: Math.max(0, scaledY - expandDistance),
        w: Math.min(originalWidth - Math.max(0, scaledX - expandDistance), scaledW + 2 * expandDistance),
        h: Math.min(originalHeight - Math.max(0, scaledY - expandDistance), scaledH + 2 * expandDistance)
      };

      // Create polygon from bbox corners
      const polygon = [
        { x: expandedBbox.x, y: expandedBbox.y },
        { x: expandedBbox.x + expandedBbox.w, y: expandedBbox.y },
        { x: expandedBbox.x + expandedBbox.w, y: expandedBbox.y + expandedBbox.h },
        { x: expandedBbox.x, y: expandedBbox.y + expandedBbox.h }
      ];

      regions.push({
        bbox: expandedBbox,
        polygon,
        confidence
      });
    }
  }

  // Sort by y position, then x position
  regions.sort((a, b) => {
    const yDiff = a.bbox.y - b.bbox.y;
    if (Math.abs(yDiff) > 10) return yDiff;
    return a.bbox.x - b.bbox.x;
  });

  return regions;
}

interface FloodFillResult {
  pixels: number[];
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Flood fill to find connected component
 */
function floodFill(
  mask: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  visited: Set<number>
): FloodFillResult {
  const pixels: number[] = [];
  const stack: Array<[number, number]> = [[startX, startY]];

  let minX = startX, maxX = startX;
  let minY = startY, maxY = startY;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const idx = y * width + x;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited.has(idx) || mask[idx] === 0) continue;

    visited.add(idx);
    pixels.push(idx);

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);

    // 4-connectivity
    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }

  return {
    pixels,
    bbox: {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1
    }
  };
}

/**
 * Calculate average confidence for a region
 */
function calculateRegionConfidence(
  probMap: Float32Array,
  width: number,
  bbox: { x: number; y: number; w: number; h: number }
): number {
  let sum = 0;
  let count = 0;

  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * width + x;
      sum += probMap[idx];
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Convert captured image (data URL or ImageData) to ImageData for detection
 * Works in Web Worker context using fetch + createImageBitmap
 */
export async function imageDataFromDataUrl(dataUrl: string): Promise<ImageData> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Fetch image from URL and convert to ImageData
 * Works in Web Worker context using fetch + createImageBitmap
 */
export async function imageDataFromUrl(url: string): Promise<ImageData> {
  const response = await fetch(url);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
