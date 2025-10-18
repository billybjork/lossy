import { BasePlatformAdapter } from '../base-adapter.js';
import { VideoDetector } from '../../core/video-detector.js';
import { ProgressBarFinder } from '../../core/progress-bar-finder.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';
import { YouTubeSelectors } from './youtube-selectors.js';
import { YouTubeVideoId } from './youtube-video-id.js';
import { YouTubeSpaHooks } from './youtube-spa-hooks.js';

/**
 * YouTube platform adapter.
 * Handles YouTube-specific video detection, ID extraction, and SPA navigation.
 *
 * KNOWN LIMITATIONS - YouTube Shorts:
 *
 * YouTube Shorts uses aggressive lazy-loading for video content, which prevents
 * reliable timeline marker positioning until the video starts playing.
 *
 * Technical Details:
 * - When a user navigates to a new Short (via scrolling), YouTube creates the <video>
 *   element immediately but does NOT load the video data until later.
 * - The browser keeps the video at readyState: 0 (HAVE_NOTHING).
 * - Critical metadata (duration, dimensions) remain unavailable (duration = NaN).
 * - Standard HTML5 video events (loadedmetadata, canplay, durationchange) do not fire
 *   until YouTube's JavaScript decides to load the video (typically when it's in viewport
 *   and/or the user taps to play).
 *
 * What Works on Shorts:
 * ✅ Video element detection - The <video> element is found successfully
 * ✅ Progress bar detection - YouTube Shorts have their own progress bar structure
 * ✅ Timestamp tracking - Once the video plays, currentTime tracking works
 * ✅ Note-taking functionality - Recording and note UI work normally
 * ✅ First Short on page load - Auto-plays, so metadata loads immediately
 *
 * What Doesn't Work Reliably:
 * ❌ Timeline markers - Cannot position markers without video duration
 * ❌ Duration display - Shows "NaN" or "Timecode Unavailable" until video plays
 * ❌ Pre-positioned markers - Markers on subsequent Shorts (via scrolling) won't appear
 *                             until the user plays the video
 *
 * Why Attempted Workarounds Don't Help:
 * - Polling for duration: YouTube simply hasn't loaded the data yet, no amount of
 *   polling will make it appear.
 * - Event listeners: Events don't fire because YouTube's player hasn't initiated loading.
 * - Shadow DOM inspection: The player UI exists, but the video data doesn't.
 * - Progress bar detection: We can find the UI, but positioning requires duration.
 *
 * User Experience Impact:
 * - Minimal for regular YouTube videos (works perfectly)
 * - For Shorts: Timeline markers appear after video starts playing (acceptable UX)
 * - Core functionality (recording notes, timestamps) works on all YouTube videos
 *
 * Decision:
 * We accept this limitation as it's a YouTube platform constraint, not our bug.
 * The UI will show "Timecode Unavailable" for Shorts until they start playing.
 */
export class YouTubeAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'youtube';
  }

  /**
   * Check if current page is YouTube.
   */
  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('youtube.com') || hostname.includes('youtu.be');
  }

  constructor(options = {}) {
    super(options);
    this.detector = null;
    this.spaCleanup = null;
  }

  /**
   * Detect video element.
   * Tries YouTube-specific selectors first, then falls back to generic detection.
   */
  async detectVideo() {
    console.log('[YouTubeAdapter] Detecting video...');

    // Try platform-specific selectors first
    for (const selector of YouTubeSelectors.VIDEO) {
      const video = document.querySelector(selector);
      if (video) {
        console.log('[YouTubeAdapter] Found video via selector:', selector);
        this.videoElement = video;
        return video;
      }
    }

    // Fallback to generic detection
    console.log('[YouTubeAdapter] Platform selectors failed, using generic detection');
    this.detector = new VideoDetector();
    this.videoElement = await this.detector.detect();

    if (!this.videoElement) {
      console.warn('[YouTubeAdapter] No video element found');
      return null;
    }

    console.log('[YouTubeAdapter] Video detected:', this.videoElement);
    return this.videoElement;
  }

  /**
   * Extract YouTube video ID from URL.
   */
  extractVideoId(url = window.location.href) {
    const videoId = YouTubeVideoId.extract(url);

    if (!videoId) {
      console.warn('[YouTubeAdapter] Could not extract YouTube video ID, falling back to URL hash');
      // Fallback to generic URL hash
      return VideoIdGenerator.generate(url);
    }

    return {
      type: 'platform',
      id: videoId,
      platform: 'youtube'
    };
  }

  /**
   * Find progress bar for timeline markers.
   * Tries YouTube-specific selectors first, then falls back to generic.
   */
  findProgressBar(videoElement) {
    // Try YouTube-specific selectors
    for (const selector of YouTubeSelectors.PROGRESS_BAR) {
      const el = document.querySelector(selector);
      if (el) {
        console.log('[YouTubeAdapter] Found progress bar via selector:', selector);
        this.progressBar = el;
        return el;
      }
    }

    // Fallback to generic finder
    console.log('[YouTubeAdapter] Platform selectors failed, using generic progress bar finder');
    const finder = new ProgressBarFinder(videoElement);
    this.progressBar = finder.find();

    if (!this.progressBar) {
      console.warn('[YouTubeAdapter] Could not find progress bar');
    }

    return this.progressBar;
  }

  /**
   * Set up YouTube-specific SPA navigation hooks.
   */
  setupNavigationHooks(onNavigate) {
    this.spaCleanup = YouTubeSpaHooks.setup(onNavigate);
    return this.spaCleanup;
  }

  /**
   * Watch for video changes.
   * Uses generic detection if available.
   */
  watchForChanges(callback) {
    if (this.detector) {
      this.detector.watchForChanges(callback);
    } else {
      // If we found video via platform selector, use base adapter watching
      super.watchForChanges(callback);
    }
  }

  /**
   * Cleanup.
   */
  destroy() {
    super.destroy();

    if (this.detector) {
      this.detector.destroy();
      this.detector = null;
    }

    if (this.spaCleanup) {
      this.spaCleanup();
      this.spaCleanup = null;
    }
  }
}
