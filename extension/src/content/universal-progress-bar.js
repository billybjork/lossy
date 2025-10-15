/**
 * Universal progress bar detector - finds video controls using heuristics.
 * No platform-specific selectors.
 */
export class UniversalProgressBar {
  constructor(videoElement) {
    this.videoElement = videoElement;
  }

  /**
   * Find the progress bar container for this video.
   * Uses multiple strategies in order of reliability.
   */
  find() {
    console.log('[UniversalProgressBar] Searching for progress bar...');

    // Strategy 1: Platform-specific selectors (most reliable)
    const platformSelectors = [
      '.ytp-progress-bar-container', // YouTube
      '.ytp-progress-bar',           // YouTube (alternative)
      '.vp-progress',                // Vimeo
      '.player-progress',            // Generic
    ];

    for (const selector of platformSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        console.log('[UniversalProgressBar] Found via platform selector:', selector);
        return element;
      }
    }

    // Strategy 2: Common class/ID patterns
    const patterns = [
      '.progress-bar',
      '.progressbar',
      '.seek-bar',
      '.seekbar',
      '.scrubber',
      '.timeline',
      '.video-progress',
      '[class*="progress"]',
      '[class*="seek"]',
      '[class*="timeline"]'
    ];

    for (const pattern of patterns) {
      const elements = this.findNearVideo(pattern);
      if (elements.length > 0) {
        console.log('[UniversalProgressBar] Found via pattern:', pattern);
        return elements[0];
      }
    }

    // Strategy 3: ARIA roles
    const ariaElements = this.findNearVideo('[role="slider"], [role="progressbar"]');
    if (ariaElements.length > 0) {
      console.log('[UniversalProgressBar] Found via ARIA role');
      return ariaElements[0];
    }

    // Strategy 4: Input range sliders
    const rangeInputs = this.findNearVideo('input[type="range"]');
    if (rangeInputs.length > 0) {
      console.log('[UniversalProgressBar] Found via range input');
      return rangeInputs[0].parentElement;
    }

    // Strategy 5: Visual heuristics (horizontal bars near bottom of video)
    const candidate = this.findByVisualHeuristics();
    if (candidate) {
      console.log('[UniversalProgressBar] Found via visual heuristics');
      return candidate;
    }

    console.warn('[UniversalProgressBar] Could not find progress bar');
    return null;
  }

  /**
   * Find elements near the video (same container or siblings).
   */
  findNearVideo(selector) {
    const container = this.videoElement.parentElement;
    if (!container) return [];

    const inContainer = Array.from(container.querySelectorAll(selector));
    const siblings = Array.from(container.children).filter(el =>
      el !== this.videoElement && el.matches(selector)
    );

    return [...inContainer, ...siblings].filter(Boolean);
  }

  /**
   * Find elements that look like horizontal progress bars.
   */
  findByVisualHeuristics() {
    const container = this.videoElement.parentElement;
    if (!container) return null;

    const allElements = Array.from(container.querySelectorAll('*'));

    const candidates = allElements.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      // Wide and short (aspect ratio > 5:1)
      const isHorizontal = rect.width > rect.height * 5;
      // Near bottom of video
      const isNearBottom = rect.bottom > this.videoElement.getBoundingClientRect().bottom - 100;
      // Has background color
      const hasBackground = style.backgroundColor !== 'rgba(0, 0, 0, 0)';

      return isHorizontal && isNearBottom && hasBackground && rect.width > 100;
    });

    return candidates[0] || null;
  }
}
