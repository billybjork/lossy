/**
 * Universal video detector - works on any website with <video> elements.
 * Uses heuristics to find and select the "primary" video on the page.
 * This is the CORE implementation with NO platform-specific selectors.
 *
 * Enhanced with:
 * - Multi-strategy detection (immediate, lazy-loaded, iframes)
 * - Shadow DOM support
 * - Continuous monitoring (polling watchdog + IntersectionObserver)
 * - Proper cleanup tracking
 */
export class VideoDetector {
  constructor(options = {}) {
    this.videoElements = [];
    this.primaryVideo = null;
    this.observers = []; // Track all observers for cleanup
    this.pollingInterval = null;
    this.intersectionObserver = null;
    this.options = {
      pollInterval: options.pollInterval || 2000,
      enableIntersectionObserver: options.enableIntersectionObserver !== false,
      enablePollingWatchdog: options.enablePollingWatchdog !== false,
      signal: options.signal, // AbortSignal for cleanup
      ...options
    };

    // Setup AbortSignal listener if provided
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        console.log('[VideoDetector] AbortSignal received, destroying...');
        this.destroy();
      });
    }
  }

  /**
   * Detect video with multi-strategy approach.
   */
  async detect() {
    console.log('[VideoDetector] Starting enhanced detection...');

    // Strategy 1: Immediate DOM query
    this.videoElements = this.findAllVideos();
    if (this.videoElements.length > 0) {
      this.primaryVideo = this.selectPrimaryVideo(this.videoElements);
      this.startContinuousMonitoring();
      return this.primaryVideo;
    }

    // Strategy 2: Wait for MutationObserver (lazy-loaded videos)
    const mutationVideo = await this.waitForVideo(5000);
    if (mutationVideo) {
      this.startContinuousMonitoring();
      return mutationVideo;
    }

    // Strategy 3: Check iframes
    const iframeVideo = await this.detectInIframes();
    if (iframeVideo) {
      this.startContinuousMonitoring();
      return iframeVideo;
    }

    return null;
  }

  /**
   * Find all video elements including those in shadow DOM.
   */
  findAllVideos() {
    const videos = [];

    // Regular DOM
    videos.push(...document.querySelectorAll('video'));

    // Shadow DOM (recursive)
    const searchShadowRoots = (root) => {
      const elements = root.querySelectorAll('*');
      elements.forEach(el => {
        if (el.shadowRoot) {
          videos.push(...el.shadowRoot.querySelectorAll('video'));
          searchShadowRoots(el.shadowRoot);
        }
      });
    };
    searchShadowRoots(document.body);

    return Array.from(videos);
  }

  /**
   * Start continuous monitoring (polling watchdog + IntersectionObserver).
   */
  startContinuousMonitoring() {
    if (!this.primaryVideo) return;

    // Polling watchdog: Re-score videos every 2s
    if (this.options.enablePollingWatchdog) {
      this.pollingInterval = setInterval(() => {
        this.revalidatePrimaryVideo();
      }, this.options.pollInterval);

      this.observers.push(() => {
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
      });
    }

    // IntersectionObserver: Track visibility changes
    if (this.options.enableIntersectionObserver) {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.target === this.primaryVideo) {
            if (!entry.isIntersecting) {
              console.log('[VideoDetector] Primary video left viewport, re-scoring...');
              this.revalidatePrimaryVideo();
            }
          }
        });
      }, { threshold: 0.5 });

      this.intersectionObserver.observe(this.primaryVideo);

      this.observers.push(() => {
        if (this.intersectionObserver) {
          this.intersectionObserver.disconnect();
          this.intersectionObserver = null;
        }
      });
    }

    console.log('[VideoDetector] Continuous monitoring started');
  }

  /**
   * Re-score all videos and swap primary if better match found.
   */
  revalidatePrimaryVideo() {
    const currentScore = this.scoreVideo(this.primaryVideo);

    // Check if primary video is still valid
    if (!document.contains(this.primaryVideo) || currentScore < -50) {
      console.log('[VideoDetector] Primary video invalid, re-selecting...');
      this.videoElements = this.findAllVideos();
      const newPrimary = this.selectPrimaryVideo(this.videoElements);

      if (newPrimary !== this.primaryVideo) {
        console.log('[VideoDetector] Primary video changed');
        this.primaryVideo = newPrimary;
        this.onVideoChanged?.(this.primaryVideo);
      }
      return;
    }

    // Check for better candidates
    this.videoElements = this.findAllVideos();
    const allScored = this.videoElements.map(v => ({
      video: v,
      score: this.scoreVideo(v)
    })).sort((a, b) => b.score - a.score);

    if (allScored.length > 0 && allScored[0].video !== this.primaryVideo) {
      // Only swap if new candidate is significantly better
      if (allScored[0].score > currentScore + 30) {
        console.log('[VideoDetector] Found better video candidate, swapping...');
        this.primaryVideo = allScored[0].video;
        this.onVideoChanged?.(this.primaryVideo);
      }
    }
  }

  /**
   * Detect videos in iframes (cross-origin safe).
   */
  async detectInIframes() {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        // Only works for same-origin iframes
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          const videos = iframeDoc.querySelectorAll('video');
          if (videos.length > 0) {
            console.log('[VideoDetector] Found video in iframe');
            return this.selectPrimaryVideo(Array.from(videos));
          }
        }
      } catch (err) {
        // Cross-origin iframe, skip
      }
    }
    return null;
  }

  /**
   * Enhanced video scoring with better heuristics.
   */
  scoreVideo(video) {
    if (!video || !document.contains(video)) return -1000;

    let score = 0;

    // Playing state (+50)
    if (!video.paused && !video.ended) {
      score += 50;
    }

    // Duration (+30 if >10s, +10 if >3s)
    if (video.duration && !isNaN(video.duration)) {
      if (video.duration > 10) score += 30;
      else if (video.duration > 3) score += 10;
    }

    // Size (larger = higher score, max +50)
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    score += Math.min(area / 10000, 50);

    // Viewport visibility (IntersectionObserver-style check)
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const visibleRatio = (visibleHeight * visibleWidth) / area;

    if (visibleRatio > 0.7) score += 30; // Mostly visible
    else if (visibleRatio > 0.3) score += 10; // Partially visible
    else score -= 50; // Mostly off-screen

    // Completely hidden (-100)
    if (rect.width === 0 || rect.height === 0) score -= 100;
    if (video.style.display === 'none' || video.style.visibility === 'hidden') score -= 100;

    // Has controls (+10)
    if (video.controls) score += 10;

    // Autoplay + muted (likely ad, -20)
    if (video.autoplay && video.muted) score -= 20;

    // Z-index (higher = more likely to be main video)
    const zIndex = parseInt(window.getComputedStyle(video).zIndex) || 0;
    if (zIndex > 0) score += Math.min(zIndex / 10, 20);

    return score;
  }

  selectPrimaryVideo(videos) {
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];

    const scored = videos.map(v => ({ video: v, score: this.scoreVideo(v) }))
      .sort((a, b) => b.score - a.score);

    console.log('[VideoDetector] Scored videos:', scored.map(s => s.score));
    return scored[0].video;
  }

  waitForVideo(timeout = 10000) {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const videos = this.findAllVideos();
        if (videos.length > 0) {
          observer.disconnect();
          this.videoElements = videos;
          this.primaryVideo = this.selectPrimaryVideo(videos);
          resolve(this.primaryVideo);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      this.observers.push(() => observer.disconnect());

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  watchForChanges(callback) {
    this.onVideoChanged = callback;
  }

  destroy() {
    console.log('[VideoDetector] Destroying, cleaning up', this.observers.length, 'observers');
    this.observers.forEach(cleanup => {
      try {
        cleanup();
      } catch (err) {
        console.warn('[VideoDetector] Cleanup error:', err);
      }
    });
    this.observers = [];
    this.primaryVideo = null;
  }
}
