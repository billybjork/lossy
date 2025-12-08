/**
 * Mask Processing Utilities
 *
 * Functions for converting binary masks to various formats:
 * - PNG data URLs for storage and display
 * - Polygon points for SVG rendering
 * - Bounding boxes for positioning
 *
 * NOTE: This module runs in a Web Worker context.
 * Uses OffscreenCanvas for all canvas operations.
 */

import type { BoundingBox } from './types';

/**
 * Async version of maskToPng that works in Web Worker context
 * (where document.createElement is not available)
 */
export async function maskToPngAsync(
  mask: Uint8Array,
  width: number,
  height: number
): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // Create ImageData from mask
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let i = 0; i < mask.length; i++) {
    const value = mask[i];
    const idx = i * 4;
    data[idx] = value; // R
    data[idx + 1] = value; // G
    data[idx + 2] = value; // B
    data[idx + 3] = value > 0 ? 255 : 0; // A
  }

  ctx.putImageData(imageData, 0, 0);

  // Convert to blob then data URL
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Compute tight bounding box from a binary mask
 */
export function maskToBbox(
  mask: Uint8Array,
  width: number,
  height: number
): BoundingBox {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Handle empty mask
  if (minX > maxX || minY > maxY) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

/**
 * Calculate the area (pixel count) of a mask
 */
export function maskArea(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) count++;
  }
  return count;
}

/**
 * Combine multiple masks using OR operation
 */
export function combineMasks(
  masks: Uint8Array[],
  width: number,
  height: number
): Uint8Array {
  const combined = new Uint8Array(width * height);

  for (const mask of masks) {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0) {
        combined[i] = 255;
      }
    }
  }

  return combined;
}

/**
 * Invert a mask
 */
export function invertMask(mask: Uint8Array): Uint8Array {
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    inverted[i] = mask[i] > 0 ? 0 : 255;
  }
  return inverted;
}

/**
 * Dilate a mask by a given radius using separable passes (O(n*r) instead of O(n*r^2))
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const size = width * height;
  const temp = new Uint8Array(size);
  const result = new Uint8Array(size);

  // Horizontal pass: dilate along rows
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let count = 0; // Count of white pixels in window

    // Initialize window
    for (let x = 0; x <= radius && x < width; x++) {
      if (mask[rowStart + x] > 0) count++;
    }

    for (let x = 0; x < width; x++) {
      temp[rowStart + x] = count > 0 ? 255 : 0;

      // Slide window: add right, remove left
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < width && mask[rowStart + addX] > 0) count++;
      if (removeX >= 0 && mask[rowStart + removeX] > 0) count--;
    }
  }

  // Vertical pass: dilate along columns
  for (let x = 0; x < width; x++) {
    let count = 0;

    // Initialize window
    for (let y = 0; y <= radius && y < height; y++) {
      if (temp[y * width + x] > 0) count++;
    }

    for (let y = 0; y < height; y++) {
      result[y * width + x] = count > 0 ? 255 : 0;

      // Slide window
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < height && temp[addY * width + x] > 0) count++;
      if (removeY >= 0 && temp[removeY * width + x] > 0) count--;
    }
  }

  return result;
}

/**
 * Erode mask using separable passes (O(n*r) instead of O(n*r^2))
 */
export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number = 1
): Uint8Array {
  const size = width * height;
  const temp = new Uint8Array(size);
  const result = new Uint8Array(size);

  // Horizontal pass: erode along rows
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;

    for (let x = 0; x < width; x++) {
      // Recompute allWhite for current window [x-radius, x+radius]
      const winLeft = Math.max(0, x - radius);
      const winRight = Math.min(width - 1, x + radius);

      // Simple approach: check if minimum in window is > 0
      let minVal = 255;
      for (let wx = winLeft; wx <= winRight; wx++) {
        if (mask[rowStart + wx] === 0) {
          minVal = 0;
          break;
        }
      }
      temp[rowStart + x] = minVal;
    }
  }

  // Vertical pass: erode along columns
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const winTop = Math.max(0, y - radius);
      const winBottom = Math.min(height - 1, y + radius);

      let minVal = 255;
      for (let wy = winTop; wy <= winBottom; wy++) {
        if (temp[wy * width + x] === 0) {
          minVal = 0;
          break;
        }
      }
      result[y * width + x] = minVal;
    }
  }

  return result;
}

/**
 * Morphological closing: dilate then erode
 * Removes small holes, connects nearby regions, smooths boundaries
 */
export function closeMask(mask: Uint8Array, width: number, height: number, radius: number = 2): Uint8Array {
  // First dilate to close gaps
  let result = dilateMask(mask, width, height, radius);
  // Then erode to restore original size
  result = erodeMask(result, width, height, radius);
  return result;
}

/**
 * Snap a large mask to the image edges when it already hugs the frame.
 * This cleans up noisy perimeters (e.g., backgrounds) by trusting the border.
 */
export function snapMaskToImageEdges(
  mask: Uint8Array,
  width: number,
  height: number,
  options: {
    edgeMarginPx?: number;
    coverageThreshold?: number;
    minAreaRatio?: number;
  } = {}
): Uint8Array {
  const areaRatio = maskArea(mask) / (width * height);
  const minAreaRatio = options.minAreaRatio ?? 0.45; // Only snap for large, frame-spanning masks
  if (areaRatio < minAreaRatio) return mask;

  const edgeMargin =
    options.edgeMarginPx ?? Math.max(3, Math.round(Math.min(width, height) * 0.02));
  const coverageThreshold = options.coverageThreshold ?? 0.65;

  const rectCoverage = (x0: number, y0: number, w: number, h: number): number => {
    const clampedW = Math.max(0, Math.min(w, width - x0));
    const clampedH = Math.max(0, Math.min(h, height - y0));
    if (clampedW === 0 || clampedH === 0) return 0;

    let count = 0;
    for (let y = y0; y < y0 + clampedH; y++) {
      const row = y * width;
      for (let x = x0; x < x0 + clampedW; x++) {
        if (mask[row + x] > 0) count++;
      }
    }
    return count / (clampedW * clampedH);
  };

  const topH = Math.min(edgeMargin, height);
  const bottomY = Math.max(0, height - edgeMargin);
  const leftW = Math.min(edgeMargin, width);
  const rightX = Math.max(0, width - edgeMargin);

  const bbox = maskToBbox(mask, width, height);

  const sides = [
    {
      name: 'top',
      coverage: rectCoverage(0, 0, width, topH),
      touchesEdge: bbox.y <= edgeMargin,
      fill: (dst: Uint8Array) => fillRect(dst, 0, 0, width, topH, width),
    },
    {
      name: 'bottom',
      coverage: rectCoverage(0, bottomY, width, height - bottomY),
      touchesEdge: bbox.y + bbox.h >= height - edgeMargin,
      fill: (dst: Uint8Array) => fillRect(dst, 0, bottomY, width, height - bottomY, width),
    },
    {
      name: 'left',
      coverage: rectCoverage(0, 0, leftW, height),
      touchesEdge: bbox.x <= edgeMargin,
      fill: (dst: Uint8Array) => fillRect(dst, 0, 0, leftW, height, width),
    },
    {
      name: 'right',
      coverage: rectCoverage(rightX, 0, width - rightX, height),
      touchesEdge: bbox.x + bbox.w >= width - edgeMargin,
      fill: (dst: Uint8Array) => fillRect(dst, rightX, 0, width - rightX, height, width),
    },
  ];

  const eligible = sides.filter(
    (side) =>
      side.coverage >= coverageThreshold ||
      (areaRatio >= 0.7 && side.coverage >= coverageThreshold * 0.75) ||
      (side.touchesEdge && side.coverage >= 0.4)
  );

  const averageCoverage = sides.reduce((sum, s) => sum + s.coverage, 0) / sides.length;
  const shouldSnap =
    eligible.length >= 3 ||
    (eligible.length >= 2 && areaRatio >= 0.65) ||
    (averageCoverage >= coverageThreshold && areaRatio >= minAreaRatio);

  if (!shouldSnap) return mask;

  const snapped = new Uint8Array(mask);
  for (const side of eligible) {
    side.fill(snapped);
  }

  // Light closing to soften the snapped strip boundaries
  return closeMask(snapped, width, height, 1);
}

function fillRect(dst: Uint8Array, x0: number, y0: number, w: number, h: number, rowWidth: number): void {
  if (w <= 0 || h <= 0) return;
  for (let y = y0; y < y0 + h; y++) {
    const row = y * rowWidth;
    for (let x = x0; x < x0 + w; x++) {
      dst[row + x] = 255;
    }
  }
}

/**
 * Remove small connected components (artifact "crumbs")
 * Uses flood fill to identify components, removes those smaller than minArea
 */
export function removeSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number = 50
): Uint8Array {
  const result = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);

  // Flood fill to find connected components
  const floodFill = (startX: number, startY: number): number => {
    const stack: [number, number][] = [[startX, startY]];
    let area = 0;
    const pixels: number[] = [];

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const idx = y * width + x;

      if (visited[idx] || mask[idx] === 0) continue;

      visited[idx] = 1;
      pixels.push(idx);
      area++;

      // Check 4 neighbors (up, down, left, right)
      if (x > 0) stack.push([x - 1, y]);
      if (x < width - 1) stack.push([x + 1, y]);
      if (y > 0) stack.push([x, y - 1]);
      if (y < height - 1) stack.push([x, y + 1]);
    }

    // If component is too small, erase it
    if (area < minArea) {
      pixels.forEach((idx) => (result[idx] = 0));
    }

    return area;
  };

  // Find and filter all components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!visited[y * width + x] && mask[y * width + x] > 0) {
        floodFill(x, y);
      }
    }
  }

  return result;
}

/**
 * Morphological opening: erode then dilate
 * Removes small exterior artifacts (specks, protrusions) without affecting interior
 */
export function openMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number = 2
): Uint8Array {
  // First erode to remove small protrusions
  let result = erodeMask(mask, width, height, radius);
  // Then dilate to restore original size
  result = dilateMask(result, width, height, radius);
  return result;
}

/**
 * Get largest connected component share (ratio of largest component to total mask area)
 * Used to detect fragmented masks - a high share (≥0.9) indicates a solid single object
 */
export function getLargestComponentShare(
  mask: Uint8Array,
  width: number,
  height: number
): number {
  const visited = new Uint8Array(mask.length);
  let totalArea = 0;
  let largestArea = 0;

  // Flood fill to find connected components
  const floodFill = (startX: number, startY: number): number => {
    const stack: [number, number][] = [[startX, startY]];
    let area = 0;

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const idx = y * width + x;

      if (visited[idx] || mask[idx] === 0) continue;

      visited[idx] = 1;
      area++;

      if (x > 0) stack.push([x - 1, y]);
      if (x < width - 1) stack.push([x + 1, y]);
      if (y > 0) stack.push([x, y - 1]);
      if (y < height - 1) stack.push([x, y + 1]);
    }

    return area;
  };

  // Find all components and track the largest
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!visited[y * width + x] && mask[y * width + x] > 0) {
        const componentArea = floodFill(x, y);
        totalArea += componentArea;
        if (componentArea > largestArea) {
          largestArea = componentArea;
        }
      }
    }
  }

  return totalArea > 0 ? largestArea / totalArea : 0;
}

/**
 * Apply Gaussian blur to a Float32Array (logits) at a given resolution.
 * Used to soften edges in logit space before upsampling/thresholding.
 * This significantly reduces stair-stepping artifacts.
 *
 * @param logits - The logit values (can be negative)
 * @param width - Width of the logit array
 * @param height - Height of the logit array
 * @param sigma - Standard deviation of Gaussian kernel (default: 1.5)
 */
export function gaussianBlurLogits(
  logits: Float32Array,
  width: number,
  height: number,
  sigma: number = 1.5
): Float32Array {
  // Compute kernel size (3*sigma in each direction, must be odd)
  const kernelRadius = Math.ceil(sigma * 3);
  const kernelSize = kernelRadius * 2 + 1;

  // Precompute Gaussian kernel
  const kernel = new Float32Array(kernelSize);
  let kernelSum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = i - kernelRadius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernelSum += kernel[i];
  }
  // Normalize kernel
  for (let i = 0; i < kernelSize; i++) {
    kernel[i] /= kernelSum;
  }

  // Separable convolution: horizontal pass
  const temp = new Float32Array(logits.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kernelSize; k++) {
        const srcX = Math.min(Math.max(x + k - kernelRadius, 0), width - 1);
        sum += logits[y * width + srcX] * kernel[k];
      }
      temp[y * width + x] = sum;
    }
  }

  // Separable convolution: vertical pass
  const result = new Float32Array(logits.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kernelSize; k++) {
        const srcY = Math.min(Math.max(y + k - kernelRadius, 0), height - 1);
        sum += temp[srcY * width + x] * kernel[k];
      }
      result[y * width + x] = sum;
    }
  }

  return result;
}

/**
 * Guided filter implementation for edge-aware mask refinement.
 * Uses the original image as a guide to snap mask edges to real image boundaries.
 * Based on Kaiming He's paper: "Guided Image Filtering" (ECCV 2010).
 *
 * This is the key technique for achieving Photoshop-like "Refine Edge" results.
 *
 * @param mask - Binary mask to refine (Uint8Array, 0 or 255)
 * @param guide - Grayscale guide image (from original image)
 * @param width - Image width
 * @param height - Image height
 * @param radius - Filter radius (default: 8)
 * @param eps - Regularization parameter (default: 0.01, higher = more smoothing)
 */
export function guidedFilter(
  mask: Uint8Array,
  guide: Uint8Array,
  width: number,
  height: number,
  radius: number = 8,
  eps: number = 0.01
): Uint8Array {
  const size = width * height;

  // Normalize inputs to [0, 1]
  const p = new Float32Array(size);
  const I = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    p[i] = mask[i] / 255;
    I[i] = guide[i] / 255;
  }

  // Box filter helper (separable for efficiency)
  const boxFilter = (src: Float32Array, r: number): Float32Array => {
    const result = new Float32Array(size);
    const temp = new Float32Array(size);

    // Horizontal pass with running sum
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const row = y * width;
      // Initialize sum for first pixel
      for (let x = 0; x <= r && x < width; x++) {
        sum += src[row + x];
      }
      for (let x = 0; x < width; x++) {
        // Add right, remove left
        if (x + r + 1 < width) sum += src[row + x + r + 1];
        if (x - r - 1 >= 0) sum -= src[row + x - r - 1];
        const left = Math.max(0, x - r);
        const right = Math.min(width - 1, x + r);
        temp[row + x] = sum / (right - left + 1);
      }
    }

    // Vertical pass with running sum
    for (let x = 0; x < width; x++) {
      let sum = 0;
      // Initialize sum for first pixel
      for (let y = 0; y <= r && y < height; y++) {
        sum += temp[y * width + x];
      }
      for (let y = 0; y < height; y++) {
        // Add bottom, remove top
        if (y + r + 1 < height) sum += temp[(y + r + 1) * width + x];
        if (y - r - 1 >= 0) sum -= temp[(y - r - 1) * width + x];
        const top = Math.max(0, y - r);
        const bottom = Math.min(height - 1, y + r);
        result[y * width + x] = sum / (bottom - top + 1);
      }
    }

    return result;
  };

  // Step 1: Compute local means
  const meanI = boxFilter(I, radius);
  const meanP = boxFilter(p, radius);

  // Step 2: Compute correlations
  const II = new Float32Array(size);
  const IP = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    II[i] = I[i] * I[i];
    IP[i] = I[i] * p[i];
  }
  const corrI = boxFilter(II, radius);
  const corrIP = boxFilter(IP, radius);

  // Step 3: Compute variance and covariance
  const varI = new Float32Array(size);
  const covIP = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    varI[i] = corrI[i] - meanI[i] * meanI[i];
    covIP[i] = corrIP[i] - meanI[i] * meanP[i];
  }

  // Step 4: Compute linear coefficients a, b
  const a = new Float32Array(size);
  const b = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    a[i] = covIP[i] / (varI[i] + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  // Step 5: Compute mean of coefficients
  const meanA = boxFilter(a, radius);
  const meanB = boxFilter(b, radius);

  // Step 6: Compute output
  const q = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    q[i] = meanA[i] * I[i] + meanB[i];
  }

  // Convert back to Uint8Array with clamping
  const result = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    result[i] = Math.round(Math.max(0, Math.min(255, q[i] * 255)));
  }

  return result;
}

/**
 * Extract grayscale guide from RGBA image data.
 * Uses luminance formula for perceptually accurate grayscale.
 */
export function extractGrayscaleGuide(imageData: ImageData): Uint8Array {
  const { width, height, data } = imageData;
  const guide = new Uint8Array(width * height);

  for (let i = 0; i < guide.length; i++) {
    const idx = i * 4;
    // Standard luminance formula
    guide[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
  }

  return guide;
}

/**
 * Keep only the connected component(s) that contain the given point(s).
 * If no point is inside any component, falls back to keeping the largest component.
 *
 * This ensures clicking on an object only selects that contiguous region,
 * eliminating floating islands and debris automatically.
 *
 * @param mask - Binary mask (0 or 255)
 * @param width - Mask width
 * @param height - Mask height
 * @param points - Array of {x, y} points (typically the positive click points)
 * @returns Mask with only the relevant component(s)
 */
export function keepComponentsContainingPoints(
  mask: Uint8Array,
  width: number,
  height: number,
  points: Array<{ x: number; y: number }>
): Uint8Array {
  const size = width * height;
  const componentId = new Int32Array(size); // -1 = unvisited, 0+ = component ID
  componentId.fill(-1);

  const components: Array<{ id: number; pixels: number[]; area: number }> = [];

  // Flood fill to identify all connected components
  const floodFill = (startX: number, startY: number, id: number): number[] => {
    const stack: [number, number][] = [[startX, startY]];
    const pixels: number[] = [];

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const idx = y * width + x;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (componentId[idx] !== -1 || mask[idx] === 0) continue;

      componentId[idx] = id;
      pixels.push(idx);

      stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
    }

    return pixels;
  };

  // Find all components
  let nextId = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] > 0 && componentId[idx] === -1) {
        const pixels = floodFill(x, y, nextId);
        if (pixels.length > 0) {
          components.push({ id: nextId, pixels, area: pixels.length });
          nextId++;
        }
      }
    }
  }

  if (components.length === 0) {
    return mask; // No components, return as-is
  }

  if (components.length === 1) {
    return mask; // Only one component, nothing to filter
  }

  // Find which components contain any of the given points
  const componentIdsToKeep = new Set<number>();

  for (const point of points) {
    const px = Math.round(point.x);
    const py = Math.round(point.y);

    if (px >= 0 && px < width && py >= 0 && py < height) {
      const idx = py * width + px;
      const id = componentId[idx];
      if (id >= 0) {
        componentIdsToKeep.add(id);
      }
    }
  }

  // If no points are inside any component, keep the largest one
  if (componentIdsToKeep.size === 0) {
    const largest = components.reduce((a, b) => a.area > b.area ? a : b);
    componentIdsToKeep.add(largest.id);
  }

  // Create result mask with only the kept components
  const result = new Uint8Array(size);
  for (const comp of components) {
    if (componentIdsToKeep.has(comp.id)) {
      for (const idx of comp.pixels) {
        result[idx] = 255;
      }
    }
  }

  return result;
}

/**
 * Comprehensive mask smoothing pipeline
 * Applies aggressive cleanup to produce clean, solid masks:
 * 1. Remove small exterior components (specks)
 * 2. Fill small interior holes (by removing small components on inverted mask)
 * 3. Morphological closing to smooth boundaries and seal gaps
 * 4. Optional erosion to counteract any growth from closing
 */
export function smoothMask(
  mask: Uint8Array,
  width: number,
  height: number,
  options: {
    minComponentArea?: number; // Min area for exterior components (default: scale-aware)
    minHoleArea?: number; // Min area for interior holes to fill (default: scale-aware)
    closingRadius?: number; // Radius for morphological closing (default: 3)
    erodeAfterClose?: number; // Erosion radius after closing to prevent growth (default: 1)
  } = {}
): Uint8Array {
  const imageArea = width * height;

  // Scale-aware defaults: larger images need larger thresholds
  const scaleFactor = Math.sqrt(imageArea) / 1000;
  const minComponentArea = options.minComponentArea ?? Math.max(50, Math.floor(200 * scaleFactor));
  const minHoleArea = options.minHoleArea ?? Math.max(30, Math.floor(100 * scaleFactor));
  const closingRadius = options.closingRadius ?? 3;
  const erodeAfterClose = options.erodeAfterClose ?? 1;

  let result = mask;

  // 1. Remove small exterior components (floating specks)
  result = removeSmallComponents(result, width, height, minComponentArea);

  // 2. Fill small interior holes by removing small components on inverted mask
  let inverted = invertMask(result);
  inverted = removeSmallComponents(inverted, width, height, minHoleArea);
  result = invertMask(inverted);

  // 3. Morphological closing to smooth edges and seal small gaps
  if (closingRadius > 0) {
    result = closeMask(result, width, height, closingRadius);
  }

  // 4. Light erosion to counteract any growth from closing
  if (erodeAfterClose > 0) {
    result = erodeMask(result, width, height, erodeAfterClose);
  }

  return result;
}
