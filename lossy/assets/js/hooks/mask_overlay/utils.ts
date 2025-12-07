/**
 * Utility Functions for MaskOverlay
 *
 * Pure utility functions for geometric calculations and data processing.
 * No state dependencies - all functions are side-effect free.
 */

/**
 * Get natural image dimensions with fallback to provided dimensions
 * Handles cases where naturalWidth/naturalHeight might not be available
 */
export function getImageNaturalDimensions(
  img: HTMLImageElement | null,
  fallbackWidth: number,
  fallbackHeight: number
): { width: number; height: number } {
  if (!img) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  return {
    width: img.naturalWidth || fallbackWidth,
    height: img.naturalHeight || fallbackHeight
  };
}
