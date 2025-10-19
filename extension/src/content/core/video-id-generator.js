/**
 * Universal video ID generator.
 * Generates stable, unique IDs for videos using URL hashing.
 * NO platform-specific extraction - platform adapters handle that.
 */
export class VideoIdGenerator {
  /**
   * Generate a stable ID from a URL.
   * Uses URL hash (removes query params for stability).
   * @param {string} url
   * @returns {Object} - { type: 'url', id: string, platform: 'generic' }
   */
  static generate(url) {
    console.log('[VideoIdGenerator] Generating ID for URL:', url);

    const urlId = this.hashUrl(url);
    return {
      type: 'url',
      id: urlId,
      platform: 'generic',
    };
  }

  /**
   * Hash a URL to create a stable ID (removes query params).
   */
  static hashUrl(url) {
    try {
      const urlObj = new URL(url);
      const canonical = `${urlObj.hostname}${urlObj.pathname}`;
      return this.simpleHash(canonical);
    } catch (e) {
      return this.simpleHash(url);
    }
  }

  /**
   * Simple string hash (DJB2 algorithm).
   */
  static simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }
}
