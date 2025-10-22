import { BasePlatformAdapter } from '../base-adapter.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';
import { createLogger } from '../../utils/logger.js';

// Smart logger that only outputs during verbose mode (side panel open or DevTools visible)
// to avoid console noise during casual browsing on non-video pages
const log = createLogger('[GenericAdapter]');

/**
 * Generic fallback adapter - works on any video site.
 * Uses pure heuristics with no platform-specific selectors.
 * This is the catch-all adapter when no platform-specific adapter matches.
 *
 * Known Compatible Platforms:
 * - Dropbox (dropbox.com) - Standard HTML5 video playback
 * - Dropbox Replay (replay.dropbox.com) - Video review platform with timeline markers
 * - Filestage (app.filestage.io) - Video review and approval platform with timeline markers
 * - Krock (krock.io) - Video review and approval platform with timeline markers
 * - ReviewStudio (reviewstudio.com) - Video review and approval platform with timeline markers
 * - Ziflow (ziflow.io) - Video review and approval platform with timeline markers
 *
 * This adapter uses:
 * - Generic video element detection (VideoDetector)
 * - Progress bar pattern matching (ProgressBarFinder)
 * - URL-based video ID generation (VideoIdGenerator)
 *
 * @see docs/sprints/SPRINT_06_platform_adapters.md for full compatibility list
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
   *
   * NOTE: This runs on ALL pages, including non-video sites during casual browsing.
   * Logging is suppressed unless verbose mode is active (side panel open or DevTools visible)
   * to avoid console noise. This is expected behavior, not an error.
   */
  async detectVideo() {
    log.debug('Detecting video...');

    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      // This is EXPECTED on non-video pages - not an error
      // Only log in verbose mode to avoid console spam during casual browsing
      log.warn('No video element found');
      return null;
    }

    log.info('Video detected:', this.videoElement);
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
      // Progress bar not found - common on some video players
      // Only log in verbose mode
      log.warn('Could not find progress bar');
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
