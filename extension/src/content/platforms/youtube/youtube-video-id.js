/**
 * YouTube video ID extraction.
 * Handles various YouTube URL formats:
 * - Standard watch URLs: youtube.com/watch?v=VIDEO_ID
 * - Short URLs: youtu.be/VIDEO_ID
 * - Shorts: youtube.com/shorts/VIDEO_ID
 * - Embeds: youtube.com/embed/VIDEO_ID
 */
export class YouTubeVideoId {
  /**
   * Extract YouTube video ID from URL.
   * @param {string} url
   * @returns {string|null} - Video ID or null if not found
   */
  static extract(url) {
    try {
      const urlObj = new URL(url);

      // Standard watch URL: ?v=VIDEO_ID
      const vParam = urlObj.searchParams.get('v');
      if (vParam) return vParam;

      // Short URL: youtu.be/VIDEO_ID
      if (urlObj.hostname === 'youtu.be') {
        return urlObj.pathname.slice(1).split('?')[0];
      }

      // Shorts: /shorts/VIDEO_ID
      const shortsMatch = urlObj.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];

      // Embed: /embed/VIDEO_ID
      const embedMatch = urlObj.pathname.match(/^\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];

      return null;
    } catch (e) {
      console.error('[YouTubeVideoId] Error parsing URL:', e);
      return null;
    }
  }
}
