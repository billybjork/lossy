/**
 * iconik-specific DOM selectors.
 * Based on iconik's player structure as of 2025.
 *
 * NOTE: Iconik uses different class naming conventions:
 * - Internal views: .up_timeline__bounds_container (BEM-style)
 * - External share views: ._bounds_container_1uqxs_12 (CSS modules with hash)
 *
 * We use attribute selectors with wildcards to match both.
 */
export const IconikSelectors = {
  // Video element
  VIDEO: 'video',

  // Progress bar/timeline - target STATIC containers, not animated elements
  // Internal: .up_timeline__bounds_container (uses CSS var --timeline-progress)
  // External: ._bounds_container_XXXXX (CSS module hash)
  PROGRESS_BAR: [
    '[class*="bounds_container"]', // Matches both internal and external views
    '[class*="timeline_wrapper"]', // Fallback
  ],

  // Player container
  PLAYER_CONTAINER: ['.up_player__player', '[class*="player"]'],

  // Controls container
  CONTROLS: ['.up_controls_bar__controls_row_timeline', '[class*="controls"]'],
};
