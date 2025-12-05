/**
 * Mask Processing Utilities
 *
 * Functions for converting binary masks to various formats:
 * - PNG data URLs for storage and display
 * - Polygon points for SVG rendering
 * - Bounding boxes for positioning
 */

import type { BoundingBox } from './object-segmentation';

/**
 * Convert a binary mask (Uint8Array) to a PNG data URL
 * The mask is stored as a grayscale image (white = mask, black = background)
 */
export function maskToPng(
  mask: Uint8Array,
  width: number,
  height: number
): string {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // Create ImageData from mask
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let i = 0; i < mask.length; i++) {
    const value = mask[i];
    const idx = i * 4;
    // Store as grayscale with full alpha where mask exists
    data[idx] = value; // R
    data[idx + 1] = value; // G
    data[idx + 2] = value; // B
    data[idx + 3] = value > 0 ? 255 : 0; // A (transparent where no mask)
  }

  ctx.putImageData(imageData, 0, 0);

  // Convert to PNG blob and then data URL
  // Note: In offscreen context, we need to use convertToBlob
  return canvasToDataUrl(canvas);
}

/**
 * Convert OffscreenCanvas to data URL (sync version using transferToImageBitmap)
 */
function canvasToDataUrl(canvas: OffscreenCanvas): string {
  // Create a regular canvas to get data URL
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d')!;

  // Get ImageBitmap and draw to regular canvas
  const bitmap = canvas.transferToImageBitmap();
  tempCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return tempCanvas.toDataURL('image/png');
}

/**
 * Async version of maskToPng that works in service worker context
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
 * Convert a binary mask to polygon points using marching squares algorithm
 * Returns an array of {x, y} points forming the mask outline
 */
export function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  simplifyTolerance: number = 2
): Array<{ x: number; y: number }> {
  // Find contour using simple edge detection
  const points: Array<{ x: number; y: number }> = [];

  // Trace the boundary - simple approach
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;

      // Check if this is an edge pixel (has a background neighbor)
      const isEdge =
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        mask[idx - 1] === 0 ||
        mask[idx + 1] === 0 ||
        mask[idx - width] === 0 ||
        mask[idx + width] === 0;

      if (isEdge) {
        points.push({ x, y });
      }
    }
  }

  // Simplify polygon using Douglas-Peucker algorithm
  if (points.length > 100 && simplifyTolerance > 0) {
    return simplifyPolygon(points, simplifyTolerance);
  }

  return points;
}

/**
 * Simplify a polygon using Douglas-Peucker algorithm
 */
function simplifyPolygon(
  points: Array<{ x: number; y: number }>,
  tolerance: number
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  // Find point with maximum distance from line between first and last
  let maxDist = 0;
  let maxIdx = 0;

  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  // If max distance is greater than tolerance, recursively simplify
  if (maxDist > tolerance) {
    const left = simplifyPolygon(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPolygon(points.slice(maxIdx), tolerance);

    return [...left.slice(0, -1), ...right];
  }

  // Otherwise just return endpoints
  return [first, last];
}

/**
 * Calculate perpendicular distance from point to line
 */
function perpendicularDistance(
  point: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number }
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;

  const norm = Math.sqrt(dx * dx + dy * dy);
  if (norm === 0) return 0;

  return (
    Math.abs(
      dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x
    ) / norm
  );
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
 * Dilate a mask by a given radius (simple box dilation)
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const dilated = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Check if any pixel in the neighborhood is set
      let found = false;
      for (let dy = -radius; dy <= radius && !found; dy++) {
        for (let dx = -radius; dx <= radius && !found; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            if (mask[ny * width + nx] > 0) {
              found = true;
            }
          }
        }
      }
      dilated[y * width + x] = found ? 255 : 0;
    }
  }

  return dilated;
}

/**
 * Erode mask (shrink white regions)
 * Opposite of dilation - removes boundary pixels
 */
export function erodeMask(mask: Uint8Array, width: number, height: number, radius: number = 1): Uint8Array {
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255;

      // Check neighborhood - ALL neighbors must be white for center to stay white
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            minVal = Math.min(minVal, mask[ny * width + nx]);
          }
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
 * Convert a base64 PNG to a binary mask
 */
export async function pngToMask(
  pngDataUrl: string
): Promise<{ mask: Uint8Array; width: number; height: number }> {
  // Load image
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = pngDataUrl;
  });

  const { width, height } = img;

  // Draw to canvas and extract pixels
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Convert to binary mask (use red channel or alpha)
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    // Use alpha channel if available, otherwise red channel
    const alpha = data[i * 4 + 3];
    mask[i] = alpha > 128 ? 255 : 0;
  }

  return { mask, width, height };
}
