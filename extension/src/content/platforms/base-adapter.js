import { VideoController } from '../video-controller.js';

/**
 * Base adapter class - all platform adapters extend this.
 * Defines the interface for platform-specific video detection and control.
 */
export class BasePlatformAdapter {
  /**
   * Platform identifier (e.g., 'youtube', 'vimeo', 'frameio', 'air', 'generic')
   * @returns {string}
   */
  static get platformId() {
    throw new Error('Must implement platformId');
  }

  /**
   * Check if this adapter can handle the current page.
   * @returns {boolean}
   */
  static canHandle() {
    throw new Error('Must implement canHandle()');
  }

  /**
   * Initialize the adapter.
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = options;
    this.videoElement = null;
    this.progressBar = null;
  }

  /**
   * Detect video element on the page.
   * Platform adapters should try their platform-specific selectors first,
   * then fall back to generic detection.
   * @returns {Promise<HTMLVideoElement|null>}
   */
  async detectVideo() {
    throw new Error('Must implement detectVideo()');
  }

  /**
   * Extract video ID from URL.
   * @param {string} url - Video URL (defaults to current page URL)
   * @returns {Object} - { type: 'platform'|'url', id: string, platform: string }
   */
  extractVideoId(url = window.location.href) {
    throw new Error('Must implement extractVideoId()');
  }

  /**
   * Find progress bar element for timeline markers.
   * @param {HTMLVideoElement} videoElement
   * @returns {HTMLElement|null}
   */
  findProgressBar(videoElement) {
    throw new Error('Must implement findProgressBar()');
  }

  /**
   * Find timeline container for injecting markers.
   * Default: use progress bar as container.
   * Override if platform needs special container.
   * @param {HTMLElement} progressBar
   * @returns {HTMLElement|null}
   */
  findTimelineContainer(progressBar) {
    return progressBar;
  }

  /**
   * Set up platform-specific SPA navigation hooks.
   * @param {Function} onNavigate - Callback to invoke on navigation
   * @returns {Function|null} - Cleanup function, or null
   */
  setupNavigationHooks(onNavigate) {
    // Default: no platform-specific navigation hooks
    return null;
  }

  /**
   * Create video controller for this platform.
   * Override if platform needs custom video control logic.
   * @param {HTMLVideoElement} videoElement
   * @returns {VideoController}
   */
  createVideoController(videoElement) {
    return new VideoController(videoElement);
  }

  /**
   * Get container for anchor chip overlay.
   * Override if platform needs custom positioning.
   * Default: video's parent element.
   * @param {HTMLVideoElement} videoElement
   * @returns {HTMLElement|null}
   */
  getAnchorChipContainer(videoElement) {
    return videoElement.parentElement;
  }

  /**
   * Watch for video element changes.
   * Default: use MutationObserver on video src changes.
   * @param {Function} callback - Called when video changes
   */
  watchForChanges(callback) {
    // Default implementation: watch for video element removal or src changes
    if (!this.videoElement) return;

    const observer = new MutationObserver((mutations) => {
      const currentVideos = Array.from(document.querySelectorAll('video'));

      // Check if video element was removed
      if (!currentVideos.includes(this.videoElement)) {
        console.log('[BasePlatformAdapter] Video element removed');
        callback(null);
        return;
      }

      // Check if video src changed
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target === this.videoElement) {
          if (mutation.attributeName === 'src' || mutation.attributeName === 'currentSrc') {
            console.log('[BasePlatformAdapter] Video src changed');
            callback(this.videoElement);
            return;
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'currentSrc'],
      attributeOldValue: true
    });

    this._changeObserver = observer;
  }

  /**
   * Cleanup adapter resources.
   */
  destroy() {
    if (this._changeObserver) {
      this._changeObserver.disconnect();
      this._changeObserver = null;
    }
  }
}
