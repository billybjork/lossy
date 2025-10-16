/**
 * Frame.io-specific DOM selectors.
 * Frame.io uses data-testid attributes for stable selectors.
 */
export const FrameioSelectors = {
  // Video element selectors
  VIDEO: [
    '[data-testid="video-player"]',
    '[data-player="main"]',
    'video'
  ],

  // Progress bar/timeline selectors
  // We need the container that holds the timeline, not the interaction layer
  PROGRESS_BAR: [
    '.sc-58e06160-9', // Timeline container wrapper
    '.sc-99e5a54f-0.fdZeju.chromatic-ignore', // Timeline visual wrapper
    '[data-testid="player-seek-bar-interaction-layer"]', // Fallback to interaction layer
  ],

  // Player container selectors
  PLAYER_CONTAINER: [
    '[data-testid="media-viewer"]',
    '[data-testid="advanced-player-controls"]'
  ],

  // Controls container
  CONTROLS: [
    '[data-testid="advanced-player-controls"]'
  ]
};
