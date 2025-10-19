/**
 * TikTok DOM selectors.
 * TikTok uses React with dynamically generated class names (CSS-in-JS).
 * Class names include hash suffixes like: css-1lhr1ks-5e6d46e3--DivVideoSwiperControlContainer
 */
export const TikTokSelectors = {
  // Video element
  VIDEO: [
    'video', // Generic fallback - TikTok typically has one video at a time
  ],

  // Progress bar / timeline container
  // TikTok's video controls structure (as of 2025):
  // DivVideoSwiperControlContainer > DivSeekBarContainer > DivSeekBar
  PROGRESS_BAR: [
    // Try to find the actual seek bar container (highest priority)
    '[class*="DivSeekBarContainer"]',
    '[class*="SeekBarContainer"]',

    // Try to find the video control container (fallback)
    '[class*="DivVideoSwiperControlContainer"]',
    '[class*="VideoSwiperControlContainer"]',

    // Try individual seek bar elements
    '[class*="DivSeekBar"]',
    '[class*="SeekBar"]',

    // Older/alternative class names
    '[class*="DivHeaderWrapper"]',
    '[class*="ProgressBar"]',

    // Generic fallbacks
    '[role="progressbar"]',
    '[aria-label*="seek"]',
    '[aria-label*="progress"]',
  ],

  // Video container (for anchor chip positioning)
  VIDEO_CONTAINER: [
    '[class*="DivVideoContainer"]',
    '[class*="BasicPlayerWrapper"]',
    '[data-e2e="video-player"]',
    'div[style*="position"][style*="relative"]', // Generic fallback
  ],
};
