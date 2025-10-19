/**
 * YouTube-specific DOM selectors.
 * Centralized location for all YouTube selector patterns.
 */
export const YouTubeSelectors = {
  // Video element selectors
  // Stable YouTube-specific selectors with generic fallback
  VIDEO: [
    '#movie_player video', // Primary - YouTube player container
    'video.html5-main-video', // YouTube's main video class
    '.html5-video-player video', // Player wrapper
    'video[src*="googlevideo.com"]', // YouTube video CDN domain
    'video', // Generic fallback
  ],

  // Progress bar selectors (for timeline markers)
  // YouTube's .ytp-* classes are stable (used for 8+ years), but we add
  // semantic fallbacks for defense-in-depth
  PROGRESS_BAR: [
    '.ytp-progress-bar-container', // Primary - stable YouTube class
    '.ytp-progress-bar', // Fallback - stable YouTube class
    '[role="slider"][aria-label*="seek" i]', // Semantic - accessibility attribute
    '[role="slider"][aria-label*="progress" i]', // Semantic - progress slider
  ],

  // Player container selectors
  PLAYER_CONTAINER: ['#movie_player', '.html5-video-player'],

  // Controls container
  CONTROLS: ['.ytp-chrome-bottom'],
};
