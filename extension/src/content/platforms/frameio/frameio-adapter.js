import { BasePlatformAdapter } from '../base-adapter.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';
import { FrameioSelectors } from './frameio-selectors.js';
import { FrameioVideoId } from './frameio-video-id.js';

/**
 * Frame.io platform adapter.
 * Handles Frame.io-specific video detection and ID extraction.
 */
export class FrameioAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'frameio';
  }

  /**
   * Check if current page is Frame.io.
   */
  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('frame.io');
  }

  constructor(options = {}) {
    super(options);
    this.detector = null;
  }

  /**
   * Detect video element.
   * Tries Frame.io-specific selectors first, then falls back to generic detection.
   */
  async detectVideo() {
    console.log('[FrameioAdapter] Detecting video...');

    // Try platform-specific selectors first
    for (const selector of FrameioSelectors.VIDEO) {
      const video = document.querySelector(selector);
      if (video) {
        console.log('[FrameioAdapter] Found video via selector:', selector);
        this.videoElement = video;
        return video;
      }
    }

    // Fallback to generic detection
    console.log('[FrameioAdapter] Platform selectors failed, using generic detection');
    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      console.warn('[FrameioAdapter] No video element found');
      return null;
    }

    console.log('[FrameioAdapter] Video detected:', this.videoElement);
    return this.videoElement;
  }

  /**
   * Extract Frame.io video ID from URL.
   */
  extractVideoId(url = window.location.href) {
    const videoId = FrameioVideoId.extract(url);

    if (!videoId) {
      console.warn('[FrameioAdapter] Could not extract Frame.io video ID, falling back to URL hash');
      // Fallback to generic URL hash
      return VideoIdGenerator.generate(url);
    }

    return {
      type: 'platform',
      id: videoId,
      platform: 'frameio'
    };
  }

  /**
   * Find progress bar for timeline markers.
   * Tries Frame.io-specific selectors first, then falls back to generic.
   */
  findProgressBar(videoElement) {
    // Try Frame.io-specific selectors
    for (const selector of FrameioSelectors.PROGRESS_BAR) {
      const el = document.querySelector(selector);
      if (el) {
        console.log('[FrameioAdapter] Found progress bar via selector:', selector);
        this.progressBar = el;
        return el;
      }
    }

    // Frame.io-specific fallback: Find via controls container using heuristics
    const controls = document.querySelector('[data-testid="advanced-player-controls"]');
    if (controls) {
      // Look for horizontal bar elements within controls (progress bars are horizontal)
      const candidates = Array.from(controls.querySelectorAll('*')).filter(el => {
        const rect = el.getBoundingClientRect();
        // Progress bars are wide and short (width > height * 5)
        return rect.width > 100 && rect.width > rect.height * 5;
      });

      if (candidates.length > 0) {
        // Take the widest candidate (likely the main progress bar)
        const timeline = candidates.reduce((widest, current) => {
          const currentWidth = current.getBoundingClientRect().width;
          const widestWidth = widest.getBoundingClientRect().width;
          return currentWidth > widestWidth ? current : widest;
        });

        console.log('[FrameioAdapter] Found progress bar via controls container heuristics');
        this.progressBar = timeline;
        return timeline;
      }
    }

    // Fallback to generic finder
    console.log('[FrameioAdapter] Platform selectors failed, using generic progress bar finder');
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (!this.progressBar) {
      console.warn('[FrameioAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Frame.io uses SPA navigation via History API.
   * We use the generic History API interception from universal.js.
   * No platform-specific hooks needed.
   */
  setupNavigationHooks(onNavigate) {
    // No Frame.io-specific navigation hooks needed
    // Generic History API interception in universal.js will handle it
    return null;
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
   * Get container for anchor chip overlay.
   * Frame.io's video element is scaled/transformed, so we attach to the player container.
   */
  getAnchorChipContainer(videoElement) {
    // Try to find the media viewer container (stable positioning)
    const mediaViewer = document.querySelector('[data-testid="media-viewer"]');
    if (mediaViewer) {
      return mediaViewer;
    }

    // Fallback to player container
    const playerContainer = document.querySelector('[role="contentinfo"][aria-label="Media Player"]');
    if (playerContainer) {
      return playerContainer;
    }

    // Last resort: use default
    return super.getAnchorChipContainer(videoElement);
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
