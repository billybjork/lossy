/**
 * Universal video ID extractor.
 * Generates stable, unique IDs for videos on any platform.
 */
export class UniversalVideoId {
  /**
   * Extract or generate a video ID.
   * Tries platform-specific extraction first, falls back to URL hash.
   */
  static extract(url, platformHint = null) {
    console.log('[UniversalVideoId] Extracting ID for:', url);

    // Try platform-specific extraction
    if (platformHint && platformHint !== 'generic') {
      const platformId = this.extractPlatformSpecific(url, platformHint);
      if (platformId) {
        return { type: 'platform', id: platformId, platform: platformHint };
      }
    }

    // Fallback: Hash the canonical URL
    const urlId = this.hashUrl(url);
    return { type: 'url', id: urlId, platform: 'generic' };
  }

  /**
   * Detect platform from URL hostname.
   */
  static detectPlatform(url) {
    try {
      const hostname = new URL(url).hostname;

      if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
        return 'youtube';
      }
      if (hostname.includes('vimeo.com')) {
        return 'vimeo';
      }
      if (hostname.includes('air.inc')) {
        return 'air';
      }

      return 'generic';
    } catch (e) {
      return 'generic';
    }
  }

  /**
   * Platform-specific extraction (optional optimization).
   */
  static extractPlatformSpecific(url, platform) {
    const extractors = {
      youtube: this.extractYouTubeId.bind(this),
      vimeo: this.extractVimeoId.bind(this),
      air: this.extractAirId.bind(this)
    };

    const extractor = extractors[platform];
    return extractor ? extractor(url) : null;
  }

  static extractYouTubeId(url) {
    const urlObj = new URL(url);
    const vParam = urlObj.searchParams.get('v');
    if (vParam) return vParam;

    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1).split('?')[0];
    }

    const shortsMatch = urlObj.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];

    const embedMatch = urlObj.pathname.match(/^\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];

    return null;
  }

  static extractVimeoId(url) {
    const urlObj = new URL(url);
    const match = urlObj.pathname.match(/^\/(\d+)/);
    return match ? match[1] : null;
  }

  static extractAirId(url) {
    const urlObj = new URL(url);
    const match = urlObj.pathname.match(/\/([^/]+)$/);
    return match ? match[1] : null;
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
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }
}
