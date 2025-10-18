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
  //
  // ⚠️ WARNING: Styled-component class names (.sc-*) are FRAGILE and will change
  // when Frame.io updates their CSS. These selectors may break on Frame.io updates.
  // The adapter has fallback strategies (controls container search + generic finder)
  // to handle this, but timeline markers may not appear until fallback succeeds.
  PROGRESS_BAR: [
    '.sc-58e06160-9', // Timeline container wrapper (FRAGILE - styled-components)
    '.sc-99e5a54f-0.fdZeju.chromatic-ignore', // Timeline visual wrapper (FRAGILE)
    '[data-testid="player-seek-bar-interaction-layer"]', // Stable selector (preferred)
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
