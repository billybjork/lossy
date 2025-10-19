import { BasePlatformAdapter } from '../base-adapter.js';
import { VimeoSelectors } from './vimeo-selectors.js';
import { VideoDetector } from '../../core/video-detector.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * Vimeo platform adapter.
 * Handles Vimeo's custom video player and progress bar structure.
 */
export class VimeoAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'vimeo';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('vimeo.com');
  }

  async detectVideo() {
    console.log('[VimeoAdapter] Detecting video...');

    // Vimeo typically has a single video element
    const videos = document.querySelectorAll(VimeoSelectors.VIDEO);

    if (videos.length === 1) {
      this.videoElement = videos[0];
      console.log('[VimeoAdapter] Found video element');
      return this.videoElement;
    }

    // Fallback to generic detection
    const detector = new VideoDetector();
    this.videoElement = await detector.detect();

    if (this.videoElement) {
      console.log('[VimeoAdapter] Video detected via fallback');
    } else {
      console.warn('[VimeoAdapter] No video element found');
    }

    return this.videoElement;
  }

  extractVideoId(url = window.location.href) {
    console.log('[VimeoAdapter] Extracting video ID from URL:', url);

    // Vimeo URL patterns:
    // https://vimeo.com/123456789
    // https://vimeo.com/showcase/123456/video/789
    // https://player.vimeo.com/video/123456789

    // Pattern 1: /video/ID or just /ID
    const match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (match) {
      const id = match[1];
      console.log('[VimeoAdapter] Extracted video ID:', id);
      return {
        type: 'platform',
        id: id,
        platform: 'vimeo',
      };
    }

    // Fallback to URL hash
    console.log('[VimeoAdapter] Could not extract Vimeo ID, using URL hash');
    return VideoIdGenerator.generate(url);
  }

  findProgressBar(videoElement) {
    console.log('[VimeoAdapter] Finding progress bar...');

    // Try Vimeo-specific selectors first
    for (const selector of VimeoSelectors.PROGRESS_BAR) {
      const element = document.querySelector(selector);
      if (element) {
        console.log('[VimeoAdapter] Found progress bar via selector:', selector);
        this.progressBar = element;
        return this.progressBar;
      }
    }

    console.warn('[VimeoAdapter] Could not find progress bar with Vimeo selectors');
    return null;
  }

  /**
   * Vimeo uses SPAs, but we can rely on generic history API interception for now.
   * Override if Vimeo has specific navigation events.
   */
  setupNavigationHooks(onNavigate) {
    console.log('[VimeoAdapter] Setting up navigation hooks');

    // Vimeo uses HTML5 history API, so generic hooks should work
    // If we need Vimeo-specific events, we can add them here
    return null; // Use default behavior
  }
}
