/**
 * Hit Testing Utilities
 *
 * Unified pixel-perfect hit testing for mask overlays.
 * Used by both normal mode (mask-interaction) and Smart Select mode.
 */

import type { CachedMask } from './types';

/**
 * Check if a point is over an opaque pixel of a segment mask.
 * Uses pre-computed alpha data for pixel-perfect hit testing.
 *
 * @param maskId - The mask ID to test
 * @param clientX - Client X coordinate (from MouseEvent)
 * @param clientY - Client Y coordinate (from MouseEvent)
 * @param maskElement - The mask DOM element (for bounding rect)
 * @param maskCache - Cache of mask alpha data
 * @param alphaThreshold - Minimum alpha value to consider "hit" (default: 10)
 * @returns true if the point is over an opaque pixel
 */
export function isPointOverMask(
  maskId: string,
  clientX: number,
  clientY: number,
  maskElement: HTMLElement,
  maskCache: Map<string, CachedMask>,
  alphaThreshold: number = 10
): boolean {
  const cached = maskCache.get(maskId);
  if (!cached) {
    // Cache not loaded yet - fall back to bbox detection (assume hit)
    return true;
  }

  const { alphaData } = cached;
  const rect = maskElement.getBoundingClientRect();

  // Get position relative to mask element
  const displayX = clientX - rect.left;
  const displayY = clientY - rect.top;

  // Convert from display coordinates to alpha data coordinates
  const scaleX = alphaData.width / rect.width;
  const scaleY = alphaData.height / rect.height;
  const dataX = Math.floor(displayX * scaleX);
  const dataY = Math.floor(displayY * scaleY);

  // Check bounds
  if (dataX < 0 || dataX >= alphaData.width || dataY < 0 || dataY >= alphaData.height) {
    return false;
  }

  // Get alpha value from pre-computed data
  const pixelIndex = (dataY * alphaData.width + dataX) * 4;
  const alpha = alphaData.data[pixelIndex + 3];

  return alpha > alphaThreshold;
}

/**
 * Check if a point (from MouseEvent) is over a mask.
 * Convenience wrapper that extracts clientX/clientY from event.
 */
export function isEventOverMask(
  maskId: string,
  event: MouseEvent,
  maskElement: HTMLElement,
  maskCache: Map<string, CachedMask>,
  alphaThreshold: number = 10
): boolean {
  return isPointOverMask(
    maskId,
    event.clientX,
    event.clientY,
    maskElement,
    maskCache,
    alphaThreshold
  );
}
