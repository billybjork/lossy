import { BasePlatformAdapter } from '../base-adapter.js';
import { IconikSelectors } from './iconik-selectors.js';
import { VideoDetector } from '../../core/video-detector.js';
import { VideoIdGenerator } from '../../core/video-id-generator.js';

/**
 * iconik platform adapter.
 * Handles iconik's custom video player with precise timeline marker positioning.
 *
 * Similar to Vimeo, iconik's timeline has nested elements. We need to target
 * the inner timeline element (.up_timeline__timeline) rather than outer wrappers
 * to avoid positioning offsets caused by padding/margins.
 */
export class IconikAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'iconik';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('iconik.io') || hostname.includes('app.iconik.io');
  }

  async detectVideo() {
    console.log('[IconikAdapter] Detecting video...');

    // iconik typically has a single video element
    const videos = document.querySelectorAll(IconikSelectors.VIDEO);

    if (videos.length === 1) {
      this.videoElement = videos[0];
      console.log('[IconikAdapter] Found video element');
      return this.videoElement;
    }

    // Fallback to generic detection
    const detector = new VideoDetector();
    this.videoElement = await detector.detect();

    if (this.videoElement) {
      console.log('[IconikAdapter] Video detected via fallback');
    } else {
      console.warn('[IconikAdapter] No video element found');
    }

    return this.videoElement;
  }

  extractVideoId(url = window.location.href) {
    console.log('[IconikAdapter] Extracting video ID from URL:', url);

    // iconik URL patterns:
    // Internal: https://app.iconik.io/asset/ASSET_ID
    // External share: https://app.iconik.io/review/share/playlists/PLAYLIST_ID/player?...&version_id=VERSION_ID

    // Try internal asset URL
    let match = url.match(/iconik\.io\/assets?\/([^/?#]+)/);
    if (match) {
      const assetId = match[1];
      console.log('[IconikAdapter] Extracted asset ID:', assetId);
      return {
        type: 'platform',
        id: assetId,
        platform: 'iconik',
      };
    }

    // Try external share URL - prefer version_id from query params
    const urlObj = new URL(url);
    const versionId = urlObj.searchParams.get('version_id');
    if (versionId) {
      console.log('[IconikAdapter] Extracted version ID from share URL:', versionId);
      return {
        type: 'platform',
        id: versionId,
        platform: 'iconik',
      };
    }

    // Try object_id from query params as fallback
    const objectId = urlObj.searchParams.get('object_id');
    if (objectId) {
      console.log('[IconikAdapter] Extracted object ID from share URL:', objectId);
      return {
        type: 'platform',
        id: objectId,
        platform: 'iconik',
      };
    }

    // Fallback to URL hash
    console.log('[IconikAdapter] Could not extract iconik asset ID, using URL hash');
    return VideoIdGenerator.generate(url);
  }

  findProgressBar(videoElement) {
    console.log('[IconikAdapter] Finding progress bar...');

    // Try iconik-specific selectors in priority order
    // IMPORTANT: Use STATIC containers, not animated elements
    // .up_timeline__timeline animates during playback, causing markers to move!
    for (const selector of IconikSelectors.PROGRESS_BAR) {
      const element = document.querySelector(selector);
      if (element) {
        console.log('[IconikAdapter] Found progress bar via selector:', selector);
        this.progressBar = element;

        // Attempt to improve marker visibility (partial clipping still occurs)
        this.attemptMarkerVisibilityFix(element);

        return this.progressBar;
      }
    }

    console.warn('[IconikAdapter] Could not find progress bar with iconik selectors');
    return null;
  }

  /**
   * Attempt to improve timeline marker visibility.
   *
   * KNOWN LIMITATION: Markers are partially clipped on Iconik despite multiple fix attempts.
   * The issue appears to be Iconik's CSS containment hierarchy which can't be fully
   * overridden without modifying shared TimelineMarkers code (portal/overlay approach).
   * Current state: Markers are visible but may be clipped at edges.
   *
   * Attempted fixes that didn't fully work:
   * - Setting overflow-y: visible !important on progress bar and parents
   * - Disabling CSS containment
   * - Adjusting z-index and positioning
   * - Extending marker container height
   *
   * Potential future fix: Portal pattern (attach markers to document.body with fixed positioning)
   * but this would require changes to shared TimelineMarkers class.
   */
  attemptMarkerVisibilityFix(progressBar) {
    console.log(
      '[IconikAdapter] Attempting to improve marker visibility (partial clipping may occur)'
    );

    // Try to set overflow visible with !important
    progressBar.style.setProperty('overflow-y', 'visible', 'important');

    // Try on parent containers as well
    let current = progressBar.parentElement;
    let depth = 0;
    while (current && depth < 3) {
      current.style.setProperty('overflow-y', 'visible', 'important');
      current = current.parentElement;
      depth++;
    }

    console.log('[IconikAdapter] Applied overflow fixes (markers may still be partially clipped)');
  }

  /**
   * iconik uses a SPA, but we can rely on generic history API interception for now.
   */
  setupNavigationHooks(onNavigate) {
    console.log('[IconikAdapter] Setting up navigation hooks');
    // iconik uses HTML5 history API, so generic hooks should work
    return null; // Use default behavior
  }
}
