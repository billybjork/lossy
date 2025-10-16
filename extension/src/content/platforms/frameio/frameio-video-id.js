/**
 * Frame.io video ID extraction.
 * Handles Frame.io URL formats:
 * - Project view: https://next.frame.io/project/{PROJECT_ID}/view/{VIDEO_ID}
 * - Reviews: https://app.frame.io/reviews/{VIDEO_ID}/...
 */
export class FrameioVideoId {
  /**
   * Extract Frame.io video ID from URL.
   * @param {string} url
   * @returns {string|null} - Video ID or null if not found
   */
  static extract(url) {
    try {
      const urlObj = new URL(url);

      // Pattern 1: https://next.frame.io/project/{PROJECT_ID}/view/{VIDEO_ID}
      const projectViewMatch = urlObj.pathname.match(/\/project\/[^/]+\/view\/([^/?]+)/);
      if (projectViewMatch) {
        return projectViewMatch[1];
      }

      // Pattern 2: https://app.frame.io/reviews/{VIDEO_ID}/...
      const reviewsMatch = urlObj.pathname.match(/\/reviews\/([^/?]+)/);
      if (reviewsMatch) {
        return reviewsMatch[1];
      }

      // Pattern 3: Any /view/{VIDEO_ID} pattern
      const viewMatch = urlObj.pathname.match(/\/view\/([^/?]+)/);
      if (viewMatch) {
        return viewMatch[1];
      }

      return null;
    } catch (e) {
      console.error('[FrameioVideoId] Error parsing URL:', e);
      return null;
    }
  }
}
