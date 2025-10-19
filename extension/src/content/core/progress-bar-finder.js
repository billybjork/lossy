/**
 * Universal progress bar detector - finds video controls using heuristics.
 * NO platform-specific selectors - pure generic detection.
 * Platform adapters should use their own selectors and fall back to this.
 *
 * Enhanced with:
 * - Ancestor climbing (searches up to document.body)
 * - Shadow DOM traversal (recursive search)
 * - Spatial heuristics (elementsFromPoint for overlays)
 * - Configurable search depth
 */
export class ProgressBarFinder {
  constructor(videoElement, options = {}) {
    this.videoElement = videoElement;
    this.options = {
      searchDepth: options.searchDepth || 10, // Ancestor levels to search
      enableSpatialSearch: options.enableSpatialSearch !== false,
      ...options,
    };
  }

  /**
   * Find progress bar with multi-strategy approach.
   */
  find() {
    console.log('[ProgressBarFinder] Starting enhanced search...');

    // Strategy 1: Common patterns near video
    let progressBar = this.findByPatterns();
    if (progressBar) return progressBar;

    // Strategy 2: Climb ancestors up to document.body
    progressBar = this.findInAncestors();
    if (progressBar) return progressBar;

    // Strategy 3: Search shadow DOM
    progressBar = this.findInShadowDOM();
    if (progressBar) return progressBar;

    // Strategy 4: ARIA roles
    progressBar = this.findByAriaRoles();
    if (progressBar) return progressBar;

    // Strategy 5: Spatial heuristics (elementsFromPoint)
    if (this.options.enableSpatialSearch) {
      progressBar = this.findBySpatialHeuristics();
      if (progressBar) return progressBar;
    }

    console.warn('[ProgressBarFinder] Could not find progress bar');
    return null;
  }

  findByPatterns() {
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
      '[class*="timeline"]',
    ];

    for (const pattern of patterns) {
      const elements = this.searchNearVideo(pattern);
      if (elements.length > 0) {
        console.log('[ProgressBarFinder] Found via pattern:', pattern);
        return elements[0];
      }
    }
    return null;
  }

  findInAncestors() {
    let current = this.videoElement.parentElement;
    let depth = 0;

    while (current && depth < this.options.searchDepth) {
      const candidates = Array.from(
        current.querySelectorAll('[class*="progress"], [class*="seek"], [class*="timeline"]')
      );

      // Filter to elements that look like progress bars
      const progressBars = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > rect.height * 5; // Horizontal bars
      });

      if (progressBars.length > 0) {
        console.log('[ProgressBarFinder] Found in ancestor at depth', depth);
        return progressBars[0];
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  findInShadowDOM() {
    const searchShadow = (root) => {
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot) {
          const progressBar = el.shadowRoot.querySelector(
            '[class*="progress"], [class*="seek"], [class*="timeline"]'
          );
          if (progressBar) {
            console.log('[ProgressBarFinder] Found in shadow DOM');
            return progressBar;
          }

          // Recursive search
          const nested = searchShadow(el.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    };

    let current = this.videoElement.parentElement;
    while (current) {
      const result = searchShadow(current);
      if (result) return result;
      current = current.parentElement;
    }

    return null;
  }

  findByAriaRoles() {
    const ariaElements = this.searchNearVideo('[role="slider"], [role="progressbar"]');
    if (ariaElements.length > 0) {
      console.log('[ProgressBarFinder] Found via ARIA role');
      return ariaElements[0];
    }
    return null;
  }

  /**
   * Use elementsFromPoint to find controls near bottom of video.
   */
  findBySpatialHeuristics() {
    const videoRect = this.videoElement.getBoundingClientRect();

    // Sample points along bottom edge of video
    const samplePoints = [];
    for (let i = 0.2; i <= 0.8; i += 0.2) {
      const x = videoRect.left + videoRect.width * i;
      const y = videoRect.bottom - 30; // 30px from bottom
      samplePoints.push({ x, y });
    }

    const candidates = new Set();
    for (const point of samplePoints) {
      const elements = document.elementsFromPoint(point.x, point.y);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();

        // Horizontal bar near bottom of video
        if (rect.width > rect.height * 5 && rect.bottom > videoRect.bottom - 100) {
          candidates.add(el);
        }
      }
    }

    if (candidates.size > 0) {
      console.log('[ProgressBarFinder] Found via spatial heuristics');
      return Array.from(candidates)[0];
    }

    return null;
  }

  searchNearVideo(selector) {
    const results = [];

    // Search in all ancestors up to searchDepth
    let current = this.videoElement.parentElement;
    let depth = 0;

    while (current && depth < this.options.searchDepth) {
      results.push(...current.querySelectorAll(selector));
      current = current.parentElement;
      depth++;
    }

    return Array.from(new Set(results)); // Deduplicate
  }
}
