/**
 * Frame.io-specific DOM selectors.
 * Frame.io uses data-testid attributes for stable selectors.
 */
export const FrameioSelectors = {
  // Video element selectors
  VIDEO: ['[data-testid="video-player"]', '[data-player="main"]', 'video'],

  // Progress bar/timeline selectors
  // We need the container that holds the timeline, not the interaction layer
  //
  // Priority order: Stable selectors first, fragile selectors as last resort
  PROGRESS_BAR: [
    // Stable selectors (try these first)
    '[data-testid="player-seek-bar-interaction-layer"]', // Most stable - uses data-testid
    '[role="slider"][aria-label*="seek" i]', // Semantic HTML - look for seek slider
    '[role="slider"]', // Any slider in player area

    // Fragile selectors (last resort - will break on Frame.io CSS updates)
    '.sc-58e06160-9', // Timeline container wrapper (FRAGILE - styled-components)
    '.sc-99e5a54f-0.fdZeju.chromatic-ignore', // Timeline visual wrapper (FRAGILE)
  ],

  // Player container selectors
  PLAYER_CONTAINER: ['[data-testid="media-viewer"]', '[data-testid="advanced-player-controls"]'],

  // Controls container
  CONTROLS: ['[data-testid="advanced-player-controls"]'],
};
