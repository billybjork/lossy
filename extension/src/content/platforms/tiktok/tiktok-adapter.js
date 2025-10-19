import { BasePlatformAdapter } from '../base-adapter.js';
import { TikTokSelectors } from './tiktok-selectors.js';
import { TikTokVideoId } from './tiktok-video-id.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * TikTok platform adapter.
 *
 * KNOWN CHALLENGES:
 *
 * 1. Timeline Marker Z-Index Issues:
 *    - TikTok's UI uses complex CSS-in-JS with dynamic class names
 *    - Video player controls have multiple stacking contexts
 *    - Timeline markers can appear below/behind other UI elements
 *    - Fix: Aggressive z-index boosting and overflow management
 *
 * 2. Dynamic Video Elements:
 *    - TikTok frequently replaces video elements during scrolling (feed navigation)
 *    - Video elements can become invalid/detached during navigation
 *    - Fix: Robust video element monitoring and redetection
 *
 * 3. CSS Containment:
 *    - TikTok uses overflow:hidden on multiple parent containers
 *    - Markers can be clipped at edges
 *    - Fix: Walk up DOM tree to fix overflow on parent containers
 */
export class TikTokAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'tiktok';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('tiktok.com');
  }

  constructor(options = {}) {
    super(options);
    this.detector = null;
  }

  async detectVideo() {
    // TikTok typically has one video element at a time
    const videos = document.querySelectorAll('video');

    if (videos.length === 1) {
      this.videoElement = videos[0];
      return this.videoElement;
    }

    if (videos.length > 1) {
      // Use heuristics to find the active/playing video
      for (const video of videos) {
        if (!video.paused || video.autoplay) {
          this.videoElement = video;
          return this.videoElement;
        }
      }

      // If no video is playing, pick the largest one
      const sortedVideos = Array.from(videos).sort((a, b) => {
        const aSize = a.videoWidth * a.videoHeight;
        const bSize = b.videoWidth * b.videoHeight;
        return bSize - aSize;
      });

      this.videoElement = sortedVideos[0];
      return this.videoElement;
    }

    // Fallback to generic detection
    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      console.warn('[TikTokAdapter] No video element found');
    }

    return this.videoElement;
  }

  extractVideoId(url = window.location.href) {
    const videoId = TikTokVideoId.extract(url);

    if (!videoId) {
      return VideoIdGenerator.generate(url);
    }

    return {
      type: 'platform',
      id: videoId,
      platform: 'tiktok',
    };
  }

  findProgressBar(videoElement) {
    // Try TikTok-specific selectors first
    for (const selector of TikTokSelectors.PROGRESS_BAR) {
      const element = document.querySelector(selector);
      if (element) {
        this.progressBar = element;

        // Apply visibility and z-index fixes
        this.fixTimelineMarkerVisibility(element);

        // Watch for marker container to be added and apply fixes
        this.watchForMarkerContainer(element);

        return this.progressBar;
      }
    }

    // Fallback to generic finder
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (this.progressBar) {
      this.fixTimelineMarkerVisibility(this.progressBar);
      this.watchForMarkerContainer(this.progressBar);
    } else {
      console.warn('[TikTokAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Watch for the timeline marker container to be added and apply aggressive styling.
   * The TimelineMarkers class creates a container div that gets appended to the progress bar.
   * We need to boost this container's z-index to ensure markers appear above TikTok's UI.
   *
   * @param {HTMLElement} progressBar
   */
  watchForMarkerContainer(progressBar) {
    // Check if container already exists
    const existingContainer = progressBar.querySelector('#lossy-timeline-markers');
    if (existingContainer) {
      this.boostMarkerContainerVisibility(existingContainer);
      return;
    }

    // Watch for container to be added
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.id === 'lossy-timeline-markers') {
              this.boostMarkerContainerVisibility(node);
              observer.disconnect();
              return;
            }
          }
        }
      }
    });

    observer.observe(progressBar, {
      childList: true,
      subtree: false,
    });

    this._markerContainerObserver = observer;

    // Timeout fallback - disconnect after 10 seconds
    setTimeout(() => {
      if (this._markerContainerObserver) {
        this._markerContainerObserver.disconnect();
        this._markerContainerObserver = null;
      }
    }, 10000);
  }

  /**
   * Apply aggressive visibility fixes to the marker container.
   * @param {HTMLElement} container - The #lossy-timeline-markers container
   */
  boostMarkerContainerVisibility(container) {
    // Get current styles
    const computed = window.getComputedStyle(container);

    // Apply ultra-high z-index
    container.style.setProperty('z-index', '999999', 'important');

    // Ensure positioning is not static
    if (computed.position === 'static') {
      container.style.setProperty('position', 'absolute', 'important');
    }

    // Ensure it's not hidden
    container.style.setProperty('visibility', 'visible', 'important');
    container.style.setProperty('opacity', '1', 'important');
    container.style.setProperty('display', 'block', 'important');

    // Disable any transforms that might hide it
    container.style.setProperty('transform', 'none', 'important');

    // Ensure overflow is visible
    container.style.setProperty('overflow', 'visible', 'important');

    // Ensure pointer events work
    container.style.setProperty('pointer-events', 'none', 'important');

    // Apply aggressive styles to shadow DOM markers
    if (container.shadowRoot) {
      let styleEl = container.shadowRoot.querySelector('#tiktok-marker-fixes');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'tiktok-marker-fixes';
        styleEl.textContent = `
          .marker {
            z-index: 999999 !important;
            pointer-events: auto !important;
          }
          #markers-container {
            z-index: 999999 !important;
          }
        `;
        container.shadowRoot.appendChild(styleEl);
      }
    }
  }

  /**
   * Apply aggressive fixes for timeline marker visibility on TikTok.
   *
   * This method addresses two main issues:
   * 1. Z-Index stacking: Markers appearing below/behind timeline
   * 2. CSS containment: Markers being clipped by overflow:hidden
   *
   * @param {HTMLElement} progressBar
   */
  fixTimelineMarkerVisibility(progressBar) {
    // Ensure overflow is visible on progress bar
    const computed = window.getComputedStyle(progressBar);
    const currentOverflow = computed.overflow || computed.overflowY;

    if (currentOverflow === 'hidden' || currentOverflow === 'clip') {
      progressBar.style.setProperty('overflow', 'visible', 'important');
      progressBar.style.setProperty('overflow-y', 'visible', 'important');
    }

    // Walk up the DOM tree and fix overflow on parent containers
    let current = progressBar.parentElement;
    let depth = 0;
    const maxDepth = 5;

    while (current && depth < maxDepth) {
      const parentComputed = window.getComputedStyle(current);
      const parentOverflow = parentComputed.overflow || parentComputed.overflowY;

      if (parentOverflow === 'hidden' || parentOverflow === 'clip') {
        current.style.setProperty('overflow-y', 'visible', 'important');
      }

      // Boost z-index on parent containers
      const parentZIndex = parentComputed.zIndex;
      if (parentZIndex && parentZIndex !== 'auto' && parseInt(parentZIndex) < 100) {
        current.style.setProperty('z-index', '9999', 'important');
      }

      current = current.parentElement;
      depth++;
    }

    // Ensure the progress bar itself has high z-index
    const progressZIndex = computed.zIndex;
    if (!progressZIndex || progressZIndex === 'auto' || parseInt(progressZIndex) < 100) {
      progressBar.style.setProperty('z-index', '9999', 'important');
    }

    // Ensure position is not static (required for z-index to work)
    const position = computed.position;
    if (position === 'static') {
      progressBar.style.setProperty('position', 'relative', 'important');
    }

    // Disable CSS containment if present (can clip markers)
    const contain = computed.contain;
    if (contain && contain !== 'none') {
      progressBar.style.setProperty('contain', 'none', 'important');
    }
  }

  /**
   * Override timeline container to use the progress bar directly.
   * We've already applied all necessary fixes to the progress bar.
   */
  findTimelineContainer(progressBar) {
    return progressBar;
  }

  /**
   * TikTok uses pushState for navigation in feed.
   * We rely on generic history API interception.
   */
  setupNavigationHooks(onNavigate) {
    // TikTok uses HTML5 history API, generic hooks should work
    return null;
  }

  /**
   * Watch for video element changes.
   * TikTok frequently replaces video elements during feed scrolling.
   */
  watchForChanges(callback) {
    if (this.detector) {
      // Use VideoDetector's built-in watching
      this.detector.watchForChanges(callback);
    } else {
      // Use base adapter watching
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

    if (this._markerContainerObserver) {
      this._markerContainerObserver.disconnect();
      this._markerContainerObserver = null;
    }
  }
}
