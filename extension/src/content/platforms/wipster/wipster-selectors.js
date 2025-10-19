/**
 * Wipster-specific DOM selectors.
 * Wipster uses CSS-in-JS with generated class names, so we rely on
 * structural patterns and heuristics rather than stable class names.
 */
export const WipsterSelectors = {
  // Video element
  VIDEO: 'video',

  // Progress bar - Wipster uses CSS-in-JS (css-xxxxx classes)
  // These are heuristic-based selectors that look for timeline structure
  PROGRESS_BAR_PATTERNS: [
    // Look for containers with timeline-like children
    'div[class*="css-"] > div[class*="css-"][style*="left"][style*="right"]',
    // Elements with percentage positioning (common in progress bars)
    'div[style*="left: 0%"]',
    'div[style*="right:"][style*="%"]',
  ],

  // Player container
  PLAYER_CONTAINER: ['[class*="player"]', '[class*="video"]'],
};
