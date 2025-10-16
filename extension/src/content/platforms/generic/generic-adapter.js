import { BasePlatformAdapter } from '../base-adapter.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * Generic fallback adapter - works on any video site.
 * Uses pure heuristics with no platform-specific selectors.
 * This is the catch-all adapter when no platform-specific adapter matches.
 */
export class GenericAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'generic';
  }

  /**
   * Always returns true - this is the fallback adapter.
   * Should be registered LAST in the adapter registry.
   */
  static canHandle() {
    return true;
  }

  constructor(options = {}) {
    super(options);
    this.detector = null;
  }

  /**
   * Detect video using generic heuristics.
   */
  async detectVideo() {
    console.log('[GenericAdapter] Detecting video...');

    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      console.warn('[GenericAdapter] No video element found');
      return null;
    }

    console.log('[GenericAdapter] Video detected:', this.videoElement);
    return this.videoElement;
  }

  /**
   * Extract video ID using URL hash.
   */
  extractVideoId(url = window.location.href) {
    return VideoIdGenerator.generate(url);
  }

  /**
   * Find progress bar using generic heuristics.
   */
  findProgressBar(videoElement) {
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (!this.progressBar) {
      console.warn('[GenericAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Watch for video changes using the detector.
   */
  watchForChanges(callback) {
    if (this.detector) {
      this.detector.watchForChanges(callback);
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
  }
}
