import { BasePlatformAdapter } from '../base-adapter.js';
import { WipsterSelectors } from './wipster-selectors.js';
import { VideoDetector } from '../../core/video-detector.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * Wipster platform adapter.
 * Handles Wipster's CSS-in-JS player with heuristic-based progress bar detection.
 *
 * Wipster uses emotion/styled-components with generated class names (css-xxxxxx),
 * so we can't rely on stable selectors. Instead, we use structural heuristics.
 */
export class WipsterAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'wipster';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('wipster.io') || hostname.includes('wipapp.wipster.io');
  }

  async detectVideo() {
    console.log('[WipsterAdapter] Detecting video...');

    // Wipster typically has a single video element
    const videos = document.querySelectorAll(WipsterSelectors.VIDEO);

    if (videos.length === 1) {
      this.videoElement = videos[0];
      console.log('[WipsterAdapter] Found video element');
      return this.videoElement;
    }

    // Fallback to generic detection
    const detector = new VideoDetector();
    this.videoElement = await detector.detect();

    if (this.videoElement) {
      console.log('[WipsterAdapter] Video detected via fallback');
    } else {
      console.warn('[WipsterAdapter] No video element found');
    }

    return this.videoElement;
  }

  extractVideoId(url = window.location.href) {
    console.log('[WipsterAdapter] Extracting video ID from URL:', url);

    // Wipster URL pattern: https://wipapp.wipster.io/media/PROJECT_ID/VIDEO_ID
    const match = url.match(/wipster\.io\/media\/(\d+)\/(\d+)/);
    if (match) {
      const projectId = match[1];
      const videoId = match[2];
      console.log(
        '[WipsterAdapter] Extracted Wipster IDs - Project:',
        projectId,
        'Video:',
        videoId
      );
      return {
        type: 'platform',
        id: `${projectId}/${videoId}`,
        platform: 'wipster',
      };
    }

    // Fallback to URL hash
    console.log('[WipsterAdapter] Could not extract Wipster ID, using URL hash');
    return VideoIdGenerator.generate(url);
  }

  findProgressBar(videoElement) {
    console.log('[WipsterAdapter] Finding progress bar using heuristics...');

    // Strategy 1: Find parent container and look for horizontal bars with percentage positioning
    const progressBar = this.findProgressBarByHeuristics(videoElement);

    if (progressBar) {
      console.log('[WipsterAdapter] Found progress bar via heuristics:', progressBar);
      this.progressBar = progressBar;
      this.ensureMarkerVisibility(progressBar);
      return this.progressBar;
    }

    console.warn('[WipsterAdapter] Could not find progress bar');
    return null;
  }

  /**
   * Find progress bar using structural heuristics.
   * Wipster uses CSS-in-JS, so we look for elements with timeline-like patterns.
   */
  findProgressBarByHeuristics(videoElement) {
    // Search up the DOM tree from the video element
    let current = videoElement.parentElement;
    let depth = 0;
    const maxDepth = 10;

    while (current && depth < maxDepth) {
      // Look for horizontal bars with percentage-based positioning
      const candidates = current.querySelectorAll('div[class*="css-"]');

      for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const style = candidate.style;

        // Check if this looks like a progress bar:
        // 1. Horizontal bar (width >> height)
        // 2. Has percentage-based positioning (left/right styles)
        // 3. Is visible
        const isHorizontalBar = rect.width > rect.height * 10;
        const hasPercentageStyle =
          (style.left && style.left.includes('%')) ||
          (style.right && style.right.includes('%')) ||
          (style.width && style.width.includes('%'));
        const isVisible = rect.width > 0 && rect.height > 0;

        if (isHorizontalBar && hasPercentageStyle && isVisible) {
          console.log('[WipsterAdapter] Found candidate via heuristics:', {
            class: candidate.className,
            width: rect.width,
            height: rect.height,
            left: style.left,
            right: style.right,
          });

          // Prefer the parent container if this is a child element
          const parent = candidate.parentElement;
          if (parent && parent.children.length > 1) {
            // If parent has multiple children with percentage positioning,
            // it's likely the progress bar container
            const siblings = Array.from(parent.children);
            const siblingCount = siblings.filter((el) => {
              const s = el.style;
              return (s.left && s.left.includes('%')) || (s.right && s.right.includes('%'));
            }).length;

            if (siblingCount > 1) {
              console.log(
                '[WipsterAdapter] Using parent container with',
                siblingCount,
                'positioned children'
              );
              return parent;
            }
          }

          return candidate;
        }
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  /**
   * Ensure timeline markers are visible.
   * Wipster's timeline may have overflow:hidden or z-index issues.
   */
  ensureMarkerVisibility(progressBar) {
    console.log('[WipsterAdapter] Ensuring marker visibility...');

    // Set overflow:visible to prevent clipping
    const computed = window.getComputedStyle(progressBar);
    if (computed.overflow === 'hidden' || computed.overflowY === 'hidden') {
      console.log('[WipsterAdapter] Setting overflow:visible on progress bar');
      progressBar.style.overflow = 'visible';
    }

    // Check parent as well
    const parent = progressBar.parentElement;
    if (parent) {
      const parentComputed = window.getComputedStyle(parent);
      if (parentComputed.overflow === 'hidden' || parentComputed.overflowY === 'hidden') {
        console.log('[WipsterAdapter] Setting overflow:visible on parent');
        parent.style.overflow = 'visible';
      }
    }

    // Ensure z-index is high enough
    const currentZIndex = parseInt(computed.zIndex) || 0;
    if (currentZIndex < 100) {
      console.log('[WipsterAdapter] Increasing z-index for marker visibility');
      progressBar.style.zIndex = '100';
    }

    const rect = progressBar.getBoundingClientRect();
    console.log('[WipsterAdapter] Progress bar final state:', {
      width: rect.width,
      height: rect.height,
      overflow: progressBar.style.overflow,
      zIndex: progressBar.style.zIndex,
    });
  }
}
