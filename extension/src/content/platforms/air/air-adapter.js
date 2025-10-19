import { BasePlatformAdapter } from '../base-adapter.js';
import { AirSelectors } from './air-selectors.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * Air.inc platform adapter.
 * Handles Air's video player with special timeline marker positioning
 * to prevent clipping by thin progress bar containers.
 */
export class AirAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'air';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    // TODO: Verify Air.inc domain pattern
    return hostname.includes('air.inc') || hostname.includes('air.com');
  }

  async detectVideo() {
    console.log('[AirAdapter] Detecting video...');

    // Air typically has a single video element
    const videos = document.querySelectorAll(AirSelectors.VIDEO);

    if (videos.length === 1) {
      this.videoElement = videos[0];
      console.log('[AirAdapter] Found video element');
      return this.videoElement;
    }

    // Fallback to generic detection
    const detector = new VideoDetector();
    this.videoElement = await detector.detect();

    if (this.videoElement) {
      console.log('[AirAdapter] Video detected via fallback');
    } else {
      console.warn('[AirAdapter] No video element found');
    }

    return this.videoElement;
  }

  extractVideoId(url = window.location.href) {
    console.log('[AirAdapter] Extracting video ID from URL:', url);

    // TODO: Implement Air-specific video ID extraction
    // Air URL patterns: (provide examples to implement)
    // For now, use URL hash fallback
    return VideoIdGenerator.generate(url);
  }

  findProgressBar(videoElement) {
    console.log('[AirAdapter] Finding progress bar...');

    // Try Air-specific selectors first
    for (const selector of AirSelectors.PROGRESS_BAR) {
      const element = document.querySelector(selector);
      if (element) {
        console.log('[AirAdapter] Found progress bar via selector:', selector);
        this.progressBar = element;

        // FIX for marker clipping: Ensure overflow is visible
        // Air's progress bar is thin, and markers would be clipped without this
        this.ensureMarkerVisibility(element);

        return this.progressBar;
      }
    }

    // Fallback to generic finder
    console.log('[AirAdapter] Platform selectors failed, using generic progress bar finder');
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (this.progressBar) {
      this.ensureMarkerVisibility(this.progressBar);
    } else {
      console.warn('[AirAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Ensure timeline markers are visible by setting overflow:visible on progress bar.
   * This prevents thin progress bars from clipping the circular markers.
   * @param {HTMLElement} progressBar
   */
  ensureMarkerVisibility(progressBar) {
    // Get computed styles to check current overflow
    const computed = window.getComputedStyle(progressBar);
    const currentOverflow = computed.overflow || computed.overflowY;

    console.log('[AirAdapter] Progress bar overflow:', currentOverflow);

    // If overflow is hidden, we need to find a better container or modify styles
    if (currentOverflow === 'hidden') {
      console.log('[AirAdapter] Progress bar has overflow:hidden, setting to visible for markers');
      progressBar.style.overflow = 'visible';
    }

    // Also check parent container
    const parent = progressBar.parentElement;
    if (parent) {
      const parentOverflow =
        window.getComputedStyle(parent).overflow || window.getComputedStyle(parent).overflowY;
      if (parentOverflow === 'hidden') {
        console.log('[AirAdapter] Parent container has overflow:hidden, setting to visible');
        parent.style.overflow = 'visible';
      }
    }

    // Log dimensions for debugging
    const rect = progressBar.getBoundingClientRect();
    console.log('[AirAdapter] Progress bar dimensions:', {
      width: rect.width,
      height: rect.height,
      overflow: progressBar.style.overflow,
    });

    // If height is very small (< 20px), markers will still be partially clipped
    // even with overflow:visible due to z-index stacking contexts
    if (rect.height < 20) {
      console.warn(
        '[AirAdapter] Progress bar is very thin (' +
          rect.height +
          'px), markers may extend beyond bounds'
      );
    }
  }
}
