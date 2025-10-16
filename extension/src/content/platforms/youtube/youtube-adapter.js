import { BasePlatformAdapter } from '../base-adapter.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';
import { YouTubeSelectors } from './youtube-selectors.js';
import { YouTubeVideoId } from './youtube-video-id.js';
import { YouTubeSpaHooks } from './youtube-spa-hooks.js';

/**
 * YouTube platform adapter.
 * Handles YouTube-specific video detection, ID extraction, and SPA navigation.
 */
export class YouTubeAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'youtube';
  }

  /**
   * Check if current page is YouTube.
   */
  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('youtube.com') || hostname.includes('youtu.be');
  }

  constructor(options = {}) {
    super(options);
    this.detector = null;
    this.spaCleanup = null;
  }

  /**
   * Detect video element.
   * Tries YouTube-specific selectors first, then falls back to generic detection.
   */
  async detectVideo() {
    console.log('[YouTubeAdapter] Detecting video...');

    // Try platform-specific selectors first
    for (const selector of YouTubeSelectors.VIDEO) {
      const video = document.querySelector(selector);
      if (video) {
        console.log('[YouTubeAdapter] Found video via selector:', selector);
        this.videoElement = video;
        return video;
      }
    }

    // Fallback to generic detection
    console.log('[YouTubeAdapter] Platform selectors failed, using generic detection');
    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      console.warn('[YouTubeAdapter] No video element found');
      return null;
    }

    console.log('[YouTubeAdapter] Video detected:', this.videoElement);
    return this.videoElement;
  }

  /**
   * Extract YouTube video ID from URL.
   */
  extractVideoId(url = window.location.href) {
    const videoId = YouTubeVideoId.extract(url);

    if (!videoId) {
      console.warn('[YouTubeAdapter] Could not extract YouTube video ID, falling back to URL hash');
      // Fallback to generic URL hash
      return VideoIdGenerator.generate(url);
    }

    return {
      type: 'platform',
      id: videoId,
      platform: 'youtube'
    };
  }

  /**
   * Find progress bar for timeline markers.
   * Tries YouTube-specific selectors first, then falls back to generic.
   */
  findProgressBar(videoElement) {
    // Try YouTube-specific selectors
    for (const selector of YouTubeSelectors.PROGRESS_BAR) {
      const el = document.querySelector(selector);
      if (el) {
        console.log('[YouTubeAdapter] Found progress bar via selector:', selector);
        this.progressBar = el;
        return el;
      }
    }

    // Fallback to generic finder
    console.log('[YouTubeAdapter] Platform selectors failed, using generic progress bar finder');
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (!this.progressBar) {
      console.warn('[YouTubeAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Set up YouTube-specific SPA navigation hooks.
   */
  setupNavigationHooks(onNavigate) {
    this.spaCleanup = YouTubeSpaHooks.setup(onNavigate);
    return this.spaCleanup;
  }

  /**
   * Watch for video changes.
   * Uses generic detection if available.
   */
  watchForChanges(callback) {
    if (this.detector) {
      this.detector.watchForChanges(callback);
    } else {
      // If we found video via platform selector, use base adapter watching
      super.watchForChanges(callback);
    }
  }

  /**
   * Cleanup.
   */
  destroy() {
    super.destroy();

    if (this.detector) {
      this.detector.destroy();
      this.detector = null;
    }

    if (this.spaCleanup) {
      this.spaCleanup();
      this.spaCleanup = null;
    }
  }
}
