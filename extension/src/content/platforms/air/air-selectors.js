/**
 * Air.inc-specific DOM selectors.
 * Based on Air's player structure as of 2025.
 */
export const AirSelectors = {
  // Video element
  VIDEO: 'video',

  // Progress bar - UPDATE THESE based on Air's actual structure
  PROGRESS_BAR: [
    '[data-testid="progress-bar"]',
    '[class*="progress"]',
    '[class*="seekbar"]',
    '[class*="timeline"]',
  ],

  // Player container
  PLAYER_CONTAINER: ['[data-testid="video-player"]', '[class*="player"]'],

  // Controls container
  CONTROLS: ['[data-testid="controls"]', '[class*="controls"]'],
};
