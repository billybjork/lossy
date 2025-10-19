/**
 * TikTok video ID extraction.
 * Handles both standard TikTok URLs and short links.
 */
export class TikTokVideoId {
  /**
   * Extract TikTok video ID from URL.
   * @param {string} url
   * @returns {string|null}
   *
   * Supported formats:
   * - https://www.tiktok.com/@username/video/1234567890123456789
   * - https://vm.tiktok.com/ZMabcdef/ (short link - no ID extraction)
   * - https://www.tiktok.com/t/ZTabcdef/ (short link - no ID extraction)
   */
  static extract(url) {
    // Standard video URL: /video/ID
    const videoMatch = url.match(/\/video\/(\d+)/);
    if (videoMatch) {
      return videoMatch[1];
    }

    // Short links don't contain video IDs
    // Return null to fall back to URL hash
    if (url.includes('vm.tiktok.com') || url.includes('/t/')) {
      return null;
    }

    return null;
  }
}
