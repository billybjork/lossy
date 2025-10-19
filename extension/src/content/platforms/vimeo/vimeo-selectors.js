/**
 * Vimeo-specific DOM selectors.
 * Based on Vimeo's player structure as of 2025.
 */
export const VimeoSelectors = {
  // Video element
  VIDEO: 'video',

  // Progress bar (data-progress-bar attribute is reliable)
  PROGRESS_BAR: ['[data-progress-bar="true"]', '.vp-progress', '[class*="ProgressBar"]'],

  // Played bar (for debugging/verification)
  PLAYED_BAR: '[data-progress-bar-played="true"]',

  // Loaded bar
  LOADED_BAR: '[data-progress-bar-loaded="true"]',

  // Player container
  PLAYER_CONTAINER: ['[data-player-container]', '.vp-video-wrapper'],

  // Controls container
  CONTROLS: ['[data-control-bar="true"]', '.vp-controls'],
};
