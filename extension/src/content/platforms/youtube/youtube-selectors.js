/**
 * YouTube-specific DOM selectors.
 * Centralized location for all YouTube selector patterns.
 */
export const YouTubeSelectors = {
  // Video element selectors
  VIDEO: [
    '#movie_player video',
    'video.html5-main-video',
    '.html5-video-player video'
  ],

  // Progress bar selectors (for timeline markers)
  PROGRESS_BAR: [
    '.ytp-progress-bar-container',
    '.ytp-progress-bar'
  ],

  // Player container selectors
  PLAYER_CONTAINER: [
    '#movie_player',
    '.html5-video-player'
  ],

  // Controls container
  CONTROLS: [
    '.ytp-chrome-bottom'
  ]
};
