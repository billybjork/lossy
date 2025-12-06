/**
 * Utility Functions for MaskOverlay
 *
 * Pure utility functions for geometric calculations and data processing.
 * No state dependencies - all functions are side-effect free.
 */

/**
 * Calculate perpendicular distance from a point to a line segment
 * Used by Douglas-Peucker algorithm for line simplification
 */
export function perpendicularDistance(
  point: {x: number; y: number},
  lineStart: {x: number; y: number},
  lineEnd: {x: number; y: number}
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared
  ));

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

/**
 * Douglas-Peucker algorithm for simplifying polylines
 * Reduces the number of points while preserving shape within epsilon tolerance
 */
export function douglasPeucker(
  points: Array<{x: number; y: number}>,
  epsilon: number
): Array<{x: number; y: number}> {
  if (points.length < 3) return points;

  let maxDistance = 0;
  let maxIndex = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDistance) {
      maxDistance = dist;
      maxIndex = i;
    }
  }

  if (maxDistance > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[end]];
}

/**
 * Uniformly subsample an array to limit point count
 * Uses evenly spaced sampling to reduce array length
 */
export function uniformSubsample<T>(points: T[], maxCount: number): T[] {
  if (points.length <= maxCount) return points;
  const step = points.length / maxCount;
  return Array.from({ length: maxCount }, (_, i) =>
    points[Math.floor(i * step)]
  );
}
