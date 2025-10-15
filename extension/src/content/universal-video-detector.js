/**
 * Universal video detector - works on any website with <video> elements.
 * Uses heuristics to find and select the "primary" video on the page.
 */
export class UniversalVideoDetector {
  constructor() {
    this.videoElements = [];
    this.primaryVideo = null;
    this.observer = null;
  }

  /**
   * Detect all video elements on page and select the primary one.
   */
  async detect() {
    console.log('[UniversalVideoDetector] Starting detection...');

    this.videoElements = Array.from(document.querySelectorAll('video'));

    if (this.videoElements.length === 0) {
      console.log('[UniversalVideoDetector] No video elements found, waiting...');
      return this.waitForVideo();
    }

    this.primaryVideo = this.selectPrimaryVideo(this.videoElements);
    console.log('[UniversalVideoDetector] Primary video selected:', this.primaryVideo);

    return this.primaryVideo;
  }

  /**
   * Wait for video element to appear (handles lazy loading, SPAs).
   */
  async waitForVideo(timeout = 10000) {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
          observer.disconnect();
          this.videoElements = Array.from(videos);
          this.primaryVideo = this.selectPrimaryVideo(this.videoElements);
          resolve(this.primaryVideo);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /**
   * Select the "primary" video from multiple candidates using heuristics.
   */
  selectPrimaryVideo(videos) {
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];

    console.log('[UniversalVideoDetector] Multiple videos found:', videos.length);

    const scored = videos.map(video => ({
      video,
      score: this.scoreVideo(video)
    }));

    scored.sort((a, b) => b.score - a.score);
    console.log('[UniversalVideoDetector] Video scores:', scored.map(s => s.score));

    return scored[0].video;
  }

  /**
   * Score a video element based on heuristics.
   * Higher score = more likely to be the "main" video.
   */
  scoreVideo(video) {
    let score = 0;

    // Currently playing (+50 points)
    if (!video.paused && !video.ended) {
      score += 50;
    }

    // Has meaningful duration (+30 points if > 10 seconds)
    if (video.duration && video.duration > 10) {
      score += 30;
    }

    // Size (larger = higher score)
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    score += Math.min(area / 10000, 50); // Cap at 50 points

    // Visibility (+20 if visible, -100 if hidden)
    if (rect.width > 100 && rect.height > 100) {
      score += 20;
    }
    if (rect.width === 0 || rect.height === 0) {
      score -= 100;
    }
    if (video.style.display === 'none' || video.style.visibility === 'hidden') {
      score -= 100;
    }

    // Has controls (+10)
    if (video.controls) {
      score += 10;
    }

    // Autoplay videos are often ads (-20 penalty)
    if (video.autoplay && video.muted) {
      score -= 20;
    }

    return score;
  }

  /**
   * Watch for video element changes (SPA navigation, etc).
   * Watches both DOM changes and video element attribute changes.
   */
  watchForChanges(callback) {
    this.observer = new MutationObserver((mutations) => {
      const currentVideos = Array.from(document.querySelectorAll('video'));

      // Check if primary video element was removed
      if (!currentVideos.includes(this.primaryVideo)) {
        console.log('[UniversalVideoDetector] Primary video removed, re-detecting...');
        this.videoElements = currentVideos;
        this.primaryVideo = this.selectPrimaryVideo(currentVideos);
        callback(this.primaryVideo);
        return;
      }

      // Check if video src changed (YouTube sometimes changes src without changing element)
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target === this.primaryVideo) {
          if (mutation.attributeName === 'src' || mutation.attributeName === 'currentSrc') {
            console.log('[UniversalVideoDetector] Video src changed, notifying...');
            callback(this.primaryVideo);
            return;
          }
        }
      }
    });

    // Watch for both childList changes and attribute changes on video elements
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'currentSrc'],
      attributeOldValue: true
    });

    console.log('[UniversalVideoDetector] Watching for video changes (DOM + attributes)');
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
  }
}
