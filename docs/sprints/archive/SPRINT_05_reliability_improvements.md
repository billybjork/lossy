# Sprint 05: Core Reliability Improvements

**Status:** ✅ Complete
**Actual Duration:** 6 days (2025-10-10 to 2025-10-16)
**Priority:** Critical
**Dependencies:** Sprint 06 (Platform Adapters) must be complete

---

## Completion Summary

### What Was Accomplished

**All 6 Phases Completed:**
1. ✅ **Phase 1**: Video Detection Resilience - Enhanced VideoDetector with multi-strategy detection, continuous monitoring, and self-healing
2. ✅ **Phase 2**: Note Loading Consolidation - Implemented NoteLoader with retry logic and request deduplication
3. ✅ **Phase 3**: Timeline Marker Resilience - Enhanced TimelineMarkers with reflow, reattachment, and lazy metadata handling
4. ✅ **Phase 4**: Timecode Accuracy - Removed polling, implemented push-based updates via `timeupdate` events
5. ✅ **Phase 5**: State Management & Multi-Tab - Implemented MessageRouter for per-tab message routing
6. ✅ **Phase 6**: Performance & Cleanup - Added AbortController cleanup pattern across all components

**Critical Bugs Fixed:**
- ✅ VideoLifecycleManager immediate detection path not firing `video_detected` event (side panel showing "--:--")
- ✅ False error alerts in Chrome extension manager from normal self-healing operations
- ✅ Health check logging reduced to 10% to minimize console noise

**Key Achievements:**
- 🎯 Self-healing architecture handles video element replacement (Vimeo, YouTube lazy loading)
- 🎯 AbortController pattern prevents memory leaks during SPA navigation
- 🎯 Platform adapters (Vimeo, YouTube, Universal) provide extensible detection
- 🎯 Clean console logging with no false error alerts
- 🎯 Extension confirmed working on Vimeo and other platforms

### Files Modified

**Core Components Created/Enhanced:**
- `extension/src/content/core/video-lifecycle-manager.js` - New state machine for video detection lifecycle
- `extension/src/content/core/video-detector.js` - Enhanced with AbortController cleanup
- `extension/src/content/shared/timeline-markers.js` - Enhanced with AbortController cleanup
- `extension/src/content/universal.js` - Added AbortController coordination

**Architecture Updates:**
- `docs/02_ARCHITECTURE.md` - Added detailed Content Script architecture section documenting Sprint 05 improvements
- `docs/sprints/README.md` - Marked Sprint 05 as complete
- `docs/sprints/SPRINT_05_reliability_improvements.md` - Updated status to complete

**Git Commits:**
- `226c9a5` - Phase 6: AbortController-Based Cleanup
- `c560430` - Fix VideoLifecycleManager immediate detection event firing
- `07889e3` - Improve health check logging to prevent false error alerts

### User Feedback

> "This is working very well!" - User confirmation after critical bug fixes

---

## Goal

Harden the video detection, timeline overlay, note persistence, and state management systems to achieve 95%+ reliability across all supported platforms. Eliminate the "refresh until it works" failure mode and ensure robust behavior during tab switches, SPA navigation, and async element loading.

---

## Problem Analysis

### Current Reliability Issues

Based on field observations and code analysis, the extension suffers from:

1. **Video Detection Fragility**
   - ❌ Single-shot detection on page load with no recovery
   - ❌ No revalidation of video element after initial selection
   - ❌ Missing IntersectionObserver for lazy-loaded videos
   - ❌ No support for iframe-embedded or non-HTML5 players
   - ❌ ProgressBarFinder only searches immediate parent (misses theater mode, overlays)

2. **Race Conditions in Note Loading**
   - ❌ Three overlapping retry systems (watchdog, exponential backoff, manual retry)
   - ❌ No request deduplication (same notes fetched multiple times)
   - ❌ Cross-tab pollution (notes for tab A shown in tab B)
   - ❌ No session tracking (in-flight requests not cancelled on navigation)

3. **Timeline Marker Brittleness**
   - ❌ Assumes video duration available within 5s (fails on lazy metadata loading)
   - ❌ No reflow when controls re-render (stale marker positions)
   - ❌ Fullscreen/PiP not handled per-platform
   - ❌ Shadow DOM not reattached after progress bar replacement

4. **Timecode Inaccuracy**
   - ❌ 500ms polling from side panel (performance overhead)
   - ❌ requestVideoFrameCallback doesn't fire when paused (stale timestamps)
   - ❌ Service worker polls tab[0] regardless of actual active tab
   - ❌ No push-based updates from video element

5. **Performance Issues**
   - ❌ Duplicate detector implementations (universal-video-detector.js vs core/video-detector.js)
   - ❌ MutationObserver on entire document.body without throttling
   - ❌ No cleanup mechanism (observers leak on reinitialization)
   - ❌ History API interception never cleaned up

6. **State Management Gaps**
   - ❌ TabManager.clearVideoContext deletes state before new detection completes
   - ❌ No cached notes in chrome.storage.local (blank panel on reload)
   - ❌ No content script ready-state check before sending messages

7. **Message Listener Stacking (CRITICAL)**
   - ❌ listenForEvents() called on every init() without removal in cleanup()
   - ❌ Repeated SPA navigations stack multiple chrome.runtime.onMessage listeners
   - ❌ Results in duplicate pause/seek operations (video pauses twice, seeks to wrong position)
   - ❌ No singleton guard to prevent multiple listener registrations

---

## Architecture Overview

### Proposed System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Content Script Layer                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  VideoLifecycleManager (NEW)                           │ │
│  │  - Health checks (video validity, adapter health)      │ │
│  │  - Persistent detection (retry until found)            │ │
│  │  - State machine (idle → detecting → ready → error)    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  EnhancedVideoDetector (REFACTORED)                    │ │
│  │  - Polling watchdog (continuous revalidation)          │ │
│  │  - IntersectionObserver (lazy-loaded videos)           │ │
│  │  - Iframe support (postMessage bridge)                 │ │
│  │  - Platform API fallback (non-HTML5 players)           │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  EnhancedProgressBarFinder (REFACTORED)                │ │
│  │  - Ancestor climbing (up to document.body)             │ │
│  │  - ShadowRoot traversal                                │ │
│  │  - Spatial heuristics (elementsFromPoint)              │ │
│  │  - Continuous monitoring (ResizeObserver + polling)    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  ResilientTimelineMarkers (REFACTORED)                 │ │
│  │  - Lazy metadata handling (loadedmetadata + polling)   │ │
│  │  - Reflow on resize/mutation (auto-reattach)           │ │
│  │  - Platform fullscreen hooks (adapter-driven)          │ │
│  │  - Data-first rendering (markers as state)             │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  NoteLoader (NEW)                                      │ │
│  │  - Single state machine (idle → loading → loaded)      │ │
│  │  - Request deduplication (per videoDbId)               │ │
│  │  - Session tracking (cancel on navigation)             │ │
│  │  - Retry with exponential backoff (consolidated)       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Service Worker Layer                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  EnhancedTabManager (REFACTORED)                       │ │
│  │  - Persistent state (chrome.storage.session)           │ │
│  │  - Ready-state tracking (per-tab)                      │ │
│  │  - Context retention (don't delete until replaced)     │ │
│  │  - Note cache (chrome.storage.local)                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  MessageRouter (NEW)                                   │ │
│  │  - Per-tab channels (panel subscription)               │ │
│  │  - Session tagging (prevent cross-tab pollution)       │ │
│  │  - Ready-state verification (before sending messages)  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     Side Panel Layer                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  EnhancedSidePanel (REFACTORED)                        │ │
│  │  - Push-based timecode updates (no polling)            │ │
│  │  - Session-aware note filtering (ignore mismatches)    │ │
│  │  - Cached note display (immediate load)                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Video Detection Resilience (2 days)

#### Task 1.1: Deduplicate Video Detector

**Problem**: `universal-video-detector.js` and `core/video-detector.js` are nearly identical (duplication).

**Solution**: Consolidate into single `core/video-detector.js` with enhanced capabilities.

**Files to modify**:
- Delete `extension/src/content/universal-video-detector.js`
- Enhance `extension/src/content/core/video-detector.js`
- Update imports in adapters

**Implementation**:
```javascript
// extension/src/content/core/video-detector.js
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
      ...options
    };
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
```

**Testing**:
- ✅ Video detection on YouTube (standard, theater, fullscreen)
- ✅ Lazy-loaded videos (scroll-triggered)
- ✅ Video in Shadow DOM
- ✅ Video in same-origin iframe
- ✅ Multiple videos (ad + main video)
- ✅ Cleanup doesn't leak observers

---

#### Task 1.2: Enhanced Progress Bar Finder

**Problem**: ProgressBarFinder only searches immediate parent, missing controls in ancestors or shadow DOM.

**Files to modify**:
- `extension/src/content/core/progress-bar-finder.js`

**Implementation**:
```javascript
// extension/src/content/core/progress-bar-finder.js (REFACTORED)
export class ProgressBarFinder {
  constructor(videoElement, options = {}) {
    this.videoElement = videoElement;
    this.options = {
      searchDepth: options.searchDepth || 10, // Ancestor levels to search
      enableSpatialSearch: options.enableSpatialSearch !== false,
      ...options
    };
  }

  /**
   * Find progress bar with multi-strategy approach.
   */
  find() {
    console.log('[ProgressBarFinder] Starting enhanced search...');

    // Strategy 1: Common patterns near video
    let progressBar = this.findByPatterns();
    if (progressBar) return progressBar;

    // Strategy 2: Climb ancestors up to document.body
    progressBar = this.findInAncestors();
    if (progressBar) return progressBar;

    // Strategy 3: Search shadow DOM
    progressBar = this.findInShadowDOM();
    if (progressBar) return progressBar;

    // Strategy 4: ARIA roles
    progressBar = this.findByAriaRoles();
    if (progressBar) return progressBar;

    // Strategy 5: Spatial heuristics (elementsFromPoint)
    if (this.options.enableSpatialSearch) {
      progressBar = this.findBySpatialHeuristics();
      if (progressBar) return progressBar;
    }

    console.warn('[ProgressBarFinder] Could not find progress bar');
    return null;
  }

  findByPatterns() {
    const patterns = [
      '.progress-bar', '.progressbar', '.seek-bar', '.seekbar',
      '.scrubber', '.timeline', '.video-progress',
      '[class*="progress"]', '[class*="seek"]', '[class*="timeline"]'
    ];

    for (const pattern of patterns) {
      const elements = this.searchNearVideo(pattern);
      if (elements.length > 0) {
        console.log('[ProgressBarFinder] Found via pattern:', pattern);
        return elements[0];
      }
    }
    return null;
  }

  findInAncestors() {
    let current = this.videoElement.parentElement;
    let depth = 0;

    while (current && depth < this.options.searchDepth) {
      const candidates = Array.from(current.querySelectorAll('[class*="progress"], [class*="seek"], [class*="timeline"]'));

      // Filter to elements that look like progress bars
      const progressBars = candidates.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > rect.height * 5; // Horizontal bars
      });

      if (progressBars.length > 0) {
        console.log('[ProgressBarFinder] Found in ancestor at depth', depth);
        return progressBars[0];
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  findInShadowDOM() {
    const searchShadow = (root) => {
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot) {
          const progressBar = el.shadowRoot.querySelector('[class*="progress"], [class*="seek"], [class*="timeline"]');
          if (progressBar) {
            console.log('[ProgressBarFinder] Found in shadow DOM');
            return progressBar;
          }

          // Recursive search
          const nested = searchShadow(el.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    };

    let current = this.videoElement.parentElement;
    while (current) {
      const result = searchShadow(current);
      if (result) return result;
      current = current.parentElement;
    }

    return null;
  }

  findByAriaRoles() {
    const ariaElements = this.searchNearVideo('[role="slider"], [role="progressbar"]');
    if (ariaElements.length > 0) {
      console.log('[ProgressBarFinder] Found via ARIA role');
      return ariaElements[0];
    }
    return null;
  }

  /**
   * Use elementsFromPoint to find controls near bottom of video.
   */
  findBySpatialHeuristics() {
    const videoRect = this.videoElement.getBoundingClientRect();

    // Sample points along bottom edge of video
    const samplePoints = [];
    for (let i = 0.2; i <= 0.8; i += 0.2) {
      const x = videoRect.left + videoRect.width * i;
      const y = videoRect.bottom - 30; // 30px from bottom
      samplePoints.push({ x, y });
    }

    const candidates = new Set();
    for (const point of samplePoints) {
      const elements = document.elementsFromPoint(point.x, point.y);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();

        // Horizontal bar near bottom of video
        if (rect.width > rect.height * 5 && rect.bottom > videoRect.bottom - 100) {
          candidates.add(el);
        }
      }
    }

    if (candidates.size > 0) {
      console.log('[ProgressBarFinder] Found via spatial heuristics');
      return Array.from(candidates)[0];
    }

    return null;
  }

  searchNearVideo(selector) {
    const results = [];

    // Search in all ancestors up to searchDepth
    let current = this.videoElement.parentElement;
    let depth = 0;

    while (current && depth < this.options.searchDepth) {
      results.push(...current.querySelectorAll(selector));
      current = current.parentElement;
      depth++;
    }

    return Array.from(new Set(results)); // Deduplicate
  }
}
```

**Testing**:
- ✅ Standard controls (direct parent)
- ✅ YouTube theater mode (controls in ancestor)
- ✅ Vimeo overlay (controls in separate container)
- ✅ Shadow DOM controls
- ✅ Custom players with non-standard markup

---

#### Task 1.3: Video Lifecycle Manager (State Machine)

**Problem**: No centralized lifecycle management; reinitialization thrashes on rapid mutations.

**Files to create**:
- `extension/src/content/core/video-lifecycle-manager.js`

**Implementation**:
```javascript
// extension/src/content/core/video-lifecycle-manager.js (NEW)
export class VideoLifecycleManager {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.state = 'idle'; // idle → detecting → ready → error
    this.videoElement = null;
    this.healthCheckInterval = null;
    this.persistentDetectionInterval = null;
    this.stateChangeCallbacks = [];
    this.options = {
      healthCheckInterval: options.healthCheckInterval || 5000,
      persistentDetectionInterval: options.persistentDetectionInterval || 5000,
      persistentDetectionMaxAttempts: options.persistentDetectionMaxAttempts || 20,
      ...options
    };
  }

  /**
   * Start lifecycle management.
   */
  async start() {
    if (this.state !== 'idle') {
      console.log('[VideoLifecycle] Already started, state:', this.state);
      return;
    }

    this.setState('detecting');

    try {
      this.videoElement = await this.adapter.detectVideo();

      if (this.videoElement) {
        console.log('[VideoLifecycle] Video detected, starting health checks');
        this.setState('ready');
        this.startHealthChecks();
      } else {
        console.warn('[VideoLifecycle] No video found, starting persistent detection');
        this.setState('error');
        this.startPersistentDetection();
      }
    } catch (error) {
      console.error('[VideoLifecycle] Detection failed:', error);
      this.setState('error');
      this.startPersistentDetection();
    }
  }

  /**
   * Periodic health checks (video validity, adapter health).
   */
  startHealthChecks() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.videoElement || !document.contains(this.videoElement)) {
        console.warn('[VideoLifecycle] 🏥 Health check failed: video removed');
        this.setState('error');
        this.stop();
        this.start(); // Re-initialize
        return;
      }

      // Check if video is playable
      if (this.videoElement.error) {
        console.warn('[VideoLifecycle] 🏥 Health check failed: video error');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // Check adapter health
      if (this.adapter.isHealthy && !this.adapter.isHealthy()) {
        console.warn('[VideoLifecycle] 🏥 Health check failed: adapter unhealthy');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // All checks passed
      console.log('[VideoLifecycle] 🏥 Health check passed');
    }, this.options.healthCheckInterval);
  }

  /**
   * Persistent detection (retry until video found).
   */
  startPersistentDetection() {
    let attempts = 0;

    this.persistentDetectionInterval = setInterval(async () => {
      attempts++;
      console.log(`[VideoLifecycle] 🔄 Persistent detection attempt ${attempts}/${this.options.persistentDetectionMaxAttempts}`);

      if (attempts >= this.options.persistentDetectionMaxAttempts) {
        console.error('[VideoLifecycle] ❌ Persistent detection failed after max attempts');
        clearInterval(this.persistentDetectionInterval);
        this.persistentDetectionInterval = null;
        return;
      }

      try {
        this.videoElement = await this.adapter.detectVideo();

        if (this.videoElement) {
          console.log('[VideoLifecycle] ✅ Persistent detection succeeded!');
          clearInterval(this.persistentDetectionInterval);
          this.persistentDetectionInterval = null;
          this.setState('ready');
          this.startHealthChecks();

          // Notify listeners
          this.notifyStateChange('video_detected', { videoElement: this.videoElement });
        }
      } catch (error) {
        console.error('[VideoLifecycle] Persistent detection error:', error);
      }
    }, this.options.persistentDetectionInterval);
  }

  /**
   * Stop all monitoring.
   */
  stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.persistentDetectionInterval) {
      clearInterval(this.persistentDetectionInterval);
      this.persistentDetectionInterval = null;
    }

    this.setState('idle');
  }

  /**
   * State machine transitions.
   */
  setState(newState) {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    console.log(`[VideoLifecycle] State: ${oldState} → ${newState}`);
    this.notifyStateChange('state_changed', { oldState, newState });
  }

  /**
   * Register callback for state changes.
   */
  onStateChange(callback) {
    this.stateChangeCallbacks.push(callback);
  }

  notifyStateChange(event, data) {
    this.stateChangeCallbacks.forEach(cb => {
      try {
        cb(event, data);
      } catch (err) {
        console.error('[VideoLifecycle] Callback error:', err);
      }
    });
  }

  isReady() {
    return this.state === 'ready';
  }

  getVideoElement() {
    return this.videoElement;
  }

  destroy() {
    this.stop();
    this.stateChangeCallbacks = [];
  }
}
```

**Integration in universal.js**:
```javascript
// Replace init() with lifecycle-managed approach
import { VideoLifecycleManager } from './core/video-lifecycle-manager.js';

let lifecycleManager = null;

async function init() {
  if (lifecycleManager) {
    lifecycleManager.destroy();
  }

  lifecycleManager = new VideoLifecycleManager(adapter);

  lifecycleManager.onStateChange((event, data) => {
    if (event === 'video_detected') {
      console.log('[Lossy] 🔵 Video detected via lifecycle manager');
      onVideoReady(data.videoElement);
    } else if (event === 'state_changed' && data.newState === 'error') {
      console.warn('[Lossy] ⚠️ Lifecycle manager in error state');
    }
  });

  await lifecycleManager.start();
}

async function onVideoReady(videoElement) {
  // Continue with existing initialization logic
  // Extract video ID, create controller, setup overlays, etc.
}
```

**Testing**:
- ✅ Immediate detection (video available on load)
- ✅ Persistent detection (video loads after 10s)
- ✅ Health check recovery (video removed and re-added)
- ✅ State transitions logged correctly

---

#### Task 1.4: Fix Message Listener Singleton

**Problem**: `listenForEvents()` is invoked on every `init()` and never torn down in `cleanup()`, causing duplicate listeners to stack on SPA navigation.

**Files to modify**:
- `extension/src/content/universal.js`

**Implementation**:

```javascript
// universal.js (ADD at top level)
let messageListenerRegistered = false;
let messageListenerHandler = null;

function listenForEvents() {
  // SINGLETON GUARD: Only register once
  if (messageListenerRegistered) {
    console.log('[Lossy] Message listener already registered, skipping');
    return;
  }

  console.log('[Lossy] Registering message listener');

  messageListenerHandler = (message, sender, sendResponse) => {
    if (message.action === 'recording_started') {
      // Handle async operation properly
      videoController.getCurrentTime().then(timestamp => {
        console.log('[Lossy] Recording started at timestamp:', timestamp);

        videoController.pause();

        if (anchorChip) {
          anchorChip.show(timestamp);
        }

        chrome.runtime.sendMessage({
          action: 'timestamp_captured',
          data: {
            videoId: currentVideoId,
            videoDbId: currentVideoDbId,
            timestamp: timestamp
          }
        });

        sendResponse({ success: true, timestamp: timestamp });
      }).catch(err => {
        console.error('[Lossy] Error getting timestamp:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async response
    }

    // ... rest of message handlers (existing code) ...

    return true;
  };

  chrome.runtime.onMessage.addListener(messageListenerHandler);
  messageListenerRegistered = true;
}

function cleanup() {
  console.log('[Lossy] 🧹 CLEANUP: Starting cleanup');

  // Remove message listener (CRITICAL FIX)
  if (messageListenerRegistered && messageListenerHandler) {
    console.log('[Lossy] 🧹 CLEANUP: Removing message listener');
    chrome.runtime.onMessage.removeListener(messageListenerHandler);
    messageListenerRegistered = false;
    messageListenerHandler = null;
  }

  // ... existing cleanup code ...
}
```

**Alternative approach (if removeListener doesn't work reliably)**:

```javascript
// Use a single persistent listener with state checks
let isContentScriptActive = false;

// Register ONCE on script load (not in init())
const messageListener = (message, sender, sendResponse) => {
  // Ignore messages if content script is not active
  if (!isContentScriptActive) {
    console.log('[Lossy] Ignoring message, content script inactive');
    return false;
  }

  // ... handle messages ...
};

chrome.runtime.onMessage.addListener(messageListener);

function init() {
  isContentScriptActive = true;
  // ... rest of init ...
}

function cleanup() {
  isContentScriptActive = false;
  // Listener stays registered but ignores messages
}
```

**Testing**:
- ✅ Navigate through 5 YouTube videos (SPA navigation)
- ✅ Verify only ONE pause/seek happens per action
- ✅ Check chrome.runtime.onMessage.hasListeners() doesn't grow
- ✅ No duplicate message handling in console logs

---

### Phase 2: Note Loading Consolidation (1 day)

#### Task 2.1: Single Note Loader with Deduplication

**Problem**: Three overlapping retry systems create race conditions.

**Files to create**:
- `extension/src/content/core/note-loader.js`

**Implementation**:
```javascript
// extension/src/content/core/note-loader.js (NEW)
export class NoteLoader {
  constructor() {
    this.state = 'idle'; // idle | loading | loaded | failed
    this.videoDbId = null;
    this.loadPromise = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.sessionId = 0; // Increment on each video change
  }

  /**
   * Load notes for a video (deduplicated).
   */
  async loadNotes(videoDbId) {
    // Deduplication: if already loading this video, return existing promise
    if (this.state === 'loading' && this.videoDbId === videoDbId && this.loadPromise) {
      console.log('[NoteLoader] Already loading notes for', videoDbId);
      return this.loadPromise;
    }

    // If switching videos, reset state
    if (this.videoDbId !== videoDbId) {
      this.reset();
      this.videoDbId = videoDbId;
      this.sessionId++;
    }

    this.state = 'loading';
    this.loadPromise = this._loadNotesInternal(videoDbId);

    return this.loadPromise;
  }

  async _loadNotesInternal(videoDbId) {
    const currentSession = this.sessionId;

    try {
      console.log('[NoteLoader] 📝 Requesting notes for video:', videoDbId, 'session:', currentSession);

      const response = await chrome.runtime.sendMessage({
        action: 'request_notes',
        videoDbId: videoDbId,
        sessionId: currentSession
      });

      // Check if session is still valid (user didn't navigate away)
      if (this.sessionId !== currentSession) {
        console.log('[NoteLoader] ⚠️ Session invalidated (was', currentSession, 'now', this.sessionId, ')');
        throw new Error('Session invalidated');
      }

      if (response.error) {
        throw new Error(response.error);
      }

      this.state = 'loaded';
      this.retryCount = 0;
      console.log('[NoteLoader] ✅ Notes loaded successfully');

      return response;
    } catch (error) {
      console.error('[NoteLoader] Failed to load notes:', error);

      // Retry with exponential backoff
      if (this.retryCount < this.maxRetries && this.sessionId === currentSession) {
        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);

        console.log(`[NoteLoader] 🔄 Retry ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

        await new Promise(resolve => setTimeout(resolve, delay));

        // Verify session still valid before retrying
        if (this.sessionId === currentSession) {
          return this._loadNotesInternal(videoDbId);
        }
      }

      this.state = 'failed';
      throw error;
    }
  }

  reset() {
    this.state = 'idle';
    this.videoDbId = null;
    this.loadPromise = null;
    this.retryCount = 0;
  }

  invalidateSession() {
    this.sessionId++;
    console.log('[NoteLoader] Session invalidated, now:', this.sessionId);
  }

  isLoading() {
    return this.state === 'loading';
  }

  isLoaded() {
    return this.state === 'loaded';
  }
}
```

**Remove from universal.js**:
- Delete `startMarkerWatchdog()` (lines 346-388)
- Delete `attemptLoadMarkersWithRetry()` (lines 229-259)
- Delete `markerWatchdogTimer` and related cleanup

**Replace with**:
```javascript
import { NoteLoader } from './core/note-loader.js';

let noteLoader = null;

function createTimelineMarkers(videoElement, progressBar) {
  timelineMarkers = new TimelineMarkers(videoElement, progressBar);

  timelineMarkers.onMarkerClick((noteId, timestamp) => {
    chrome.runtime.sendMessage({
      action: 'marker_clicked',
      data: { noteId, timestamp }
    });
  });

  // Initialize note loader
  if (!noteLoader) {
    noteLoader = new NoteLoader();
  }

  // Request notes ONCE with automatic deduplication and retry
  if (currentVideoDbId) {
    noteLoader.loadNotes(currentVideoDbId)
      .then(() => {
        console.log('[Lossy] Notes loaded successfully');
      })
      .catch(err => {
        console.error('[Lossy] Failed to load notes after all retries:', err);
      });
  }
}
```

**Testing**:
- ✅ Single note request per video (no duplicates)
- ✅ Automatic retry with exponential backoff
- ✅ Session invalidation on video change
- ✅ Deduplication of concurrent requests

---

### Phase 3: Timeline Marker Resilience (1 day)

#### Task 3.1: Enhanced Timeline Markers with Reflow

**Problem**: Markers don't handle lazy metadata loading or control re-rendering.

**Files to modify**:
- `extension/src/content/shared/timeline-markers.js`

**Implementation** (key additions):
```javascript
// Add to TimelineMarkers class
export class TimelineMarkers {
  constructor(videoElement, progressBarElement) {
    // ... existing code ...

    this.progressBarObserver = null;
    this.resizeObserver = null;
    this.markerData = new Map(); // Store marker data for reflow

    this.setupProgressBarMonitoring();
  }

  /**
   * Monitor progress bar for resize/replacement.
   */
  setupProgressBarMonitoring() {
    // ResizeObserver: Reflow markers on resize
    this.resizeObserver = new ResizeObserver(() => {
      console.log('[TimelineMarkers] Progress bar resized, reflowing markers');
      this.reflowAllMarkers();
    });
    this.resizeObserver.observe(this.progressBar);

    this.cleanupFunctions.push(() => {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
    });

    // MutationObserver: Reattach if progress bar replaced
    this.progressBarObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Check if our container was removed
          if (!document.contains(this.container)) {
            console.log('[TimelineMarkers] Container removed, reattaching...');
            this.reattach();
          }
        }
      }
    });

    this.progressBarObserver.observe(this.progressBar.parentElement || document.body, {
      childList: true,
      subtree: true
    });

    this.cleanupFunctions.push(() => {
      if (this.progressBarObserver) {
        this.progressBarObserver.disconnect();
        this.progressBarObserver = null;
      }
    });
  }

  /**
   * Store marker data (not just DOM element).
   */
  addMarker({ id, timestamp, category, text }) {
    // Store data
    this.markerData.set(id, { id, timestamp, category, text });

    // Render (existing logic)
    // ... existing rendering code ...
  }

  /**
   * Reflow all markers (recalculate positions).
   */
  reflowAllMarkers() {
    const duration = this.videoElement.duration;
    if (!duration || isNaN(duration) || duration === 0) {
      console.warn('[TimelineMarkers] Cannot reflow, duration not available');
      return;
    }

    this.markerData.forEach((data, id) => {
      const marker = this.markers.get(id);
      if (marker) {
        const position = (data.timestamp / duration) * 100;
        marker.style.left = `${position}%`;
      }
    });

    console.log('[TimelineMarkers] Reflowed', this.markers.size, 'markers');
  }

  /**
   * Reattach shadow DOM after container removal.
   */
  reattach() {
    if (!document.contains(this.progressBar)) {
      console.error('[TimelineMarkers] Progress bar no longer in DOM, cannot reattach');
      return;
    }

    // Remove old container
    if (this.container && this.container.parentElement) {
      this.container.remove();
    }

    // Recreate container and shadow DOM
    this.init();

    // Re-render all markers from data
    const markerDataCopy = new Map(this.markerData);
    this.markers.clear();
    this.markerData.clear();

    markerDataCopy.forEach(data => {
      this.addMarker(data);
    });

    console.log('[TimelineMarkers] Reattached with', this.markers.size, 'markers');
  }

  clearAll() {
    super.clearAll(); // Existing implementation
    this.markerData.clear(); // Also clear data
  }

  destroy() {
    // ... existing cleanup ...
    this.markerData.clear();
  }
}
```

**Testing**:
- ✅ Markers reflow on window resize
- ✅ Markers persist after fullscreen toggle
- ✅ Markers reattach after control re-render
- ✅ Lazy metadata loading (duration becomes available late)

---

### Phase 4: Timecode Accuracy (0.5 days)

#### Task 4.1: Push-Based Timecode Updates

**Problem**: 500ms polling from side panel is inefficient and can be stale.

**Files to modify**:
- `extension/src/content/video-controller.js`
- `extension/src/sidepanel/sidepanel.js`
- `extension/src/background/service-worker.js`

**Implementation**:

```javascript
// video-controller.js (ADD)
export class VideoController {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.lastReportedTime = -1;
    this.setupTimeTracking();
  }

  setupTimeTracking() {
    this.timeUpdateHandler = () => {
      const currentTime = this.videoElement.currentTime;

      // Only send updates every ~0.5s to avoid spam
      if (Math.abs(currentTime - this.lastReportedTime) >= 0.5) {
        this.lastReportedTime = currentTime;
        this.pushTimeUpdate(currentTime);
      }
    };

    this.videoElement.addEventListener('timeupdate', this.timeUpdateHandler);
  }

  pushTimeUpdate(time) {
    chrome.runtime.sendMessage({
      action: 'video_time_update',
      timestamp: time
    }).catch(() => {
      // Side panel may not be open
    });
  }

  async getCurrentTime() {
    if (!this.videoElement) return null;

    // CRITICAL: Check if paused FIRST to avoid hanging
    // requestVideoFrameCallback never fires when video is paused
    if (this.videoElement.paused) {
      console.log('[VideoController] Video paused, using currentTime directly');
      return Promise.resolve(this.videoElement.currentTime);
    }

    // Use requestVideoFrameCallback for precision when playing
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      return new Promise((resolve) => {
        // CRITICAL: Timeout fallback in case callback doesn't fire
        const timeoutId = setTimeout(() => {
          console.warn('[VideoController] requestVideoFrameCallback timed out, using currentTime fallback');
          resolve(this.videoElement.currentTime);
        }, 100);

        this.videoElement.requestVideoFrameCallback((now, metadata) => {
          clearTimeout(timeoutId);
          resolve(metadata.mediaTime);
        });
      });
    }

    // Fallback for browsers without requestVideoFrameCallback
    return Promise.resolve(this.videoElement.currentTime);
  }

  destroy() {
    if (this.timeUpdateHandler) {
      this.videoElement.removeEventListener('timeupdate', this.timeUpdateHandler);
      this.timeUpdateHandler = null;
    }
  }

  // ... existing methods ...
}
```

```javascript
// service-worker.js (ADD handler)
if (message.action === 'video_time_update') {
  // Forward to side panel
  chrome.runtime.sendMessage({
    action: 'video_timestamp_update',
    timestamp: message.timestamp
  }).catch(() => {});
  return false;
}
```

```javascript
// sidepanel.js (EXPLICIT POLLING REMOVAL)

// DELETE these functions entirely (lines 254-268):
// - function startTimestampUpdates()
// - function stopTimestampUpdates()
// - let timestampUpdateInterval = null

// DELETE this call from init() (line 286):
// - startTimestampUpdates();

// KEEP the listener (already exists at line 271-281)
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'video_timestamp_update') {
    if (message.timestamp != null) {
      videoTimestampEl.textContent = `Video: ${formatTimestamp(message.timestamp)}`;
      videoTimestampEl.classList.add('active');
    } else {
      videoTimestampEl.textContent = 'Video: No video detected';
      videoTimestampEl.classList.remove('active');
    }
  }
});

// In init(), request initial timestamp ONCE (not polling)
async function init() {
  console.log('[SidePanel] Initializing...');

  // Get active tab context
  try {
    const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
    currentVideoContext = response.context;

    if (currentVideoContext) {
      console.log('[SidePanel] Initial video context:', currentVideoContext);
    }
  } catch (err) {
    console.error('[SidePanel] Failed to get active tab context:', err);
  }

  // Request initial timestamp ONCE (push updates will handle the rest)
  chrome.runtime.sendMessage({ action: 'get_video_timestamp' })
    .catch(() => {});
}
```

**Critical verification checklist**:
- ✅ `startTimestampUpdates()` function deleted
- ✅ `stopTimestampUpdates()` function deleted
- ✅ `timestampUpdateInterval` variable deleted
- ✅ Call to `startTimestampUpdates()` removed from init()
- ✅ No `setInterval()` calls remain in sidepanel.js
- ✅ Service worker no longer woken up every 500ms

**Testing**:
- ✅ Open side panel, verify timecode updates in real-time
- ✅ Close side panel, check service worker not being woken (use chrome://serviceworker-internals)
- ✅ CPU usage drops when side panel closed
- ✅ Timecode updates immediately on tab switch

---

**Impact**: Eliminates 120 service worker wake-ups per minute (2 per second × 60), reducing battery usage and improving performance on low-power devices.
```

**Testing**:
- ✅ Timecode updates in real-time (no polling)
- ✅ Accurate when video is paused (fallback)
- ✅ No updates when side panel closed (message rejected)
- ✅ Immediate update on tab switch

---

### Phase 5: State Management & Multi-Tab (1 day)

#### Task 5.1: Enhanced TabManager with Session Persistence

**Problem**: State lost on service worker restart; context deleted before replacement ready.

**Files to modify**:
- `extension/src/background/tab-manager.js`

**Implementation** (key changes):
```javascript
// tab-manager.js (MODIFY)
export class TabManager {
  async init() {
    // ... existing code ...

    // Load from session storage (survives service worker restart)
    try {
      const { recording_tab_id } = await chrome.storage.session.get('recording_tab_id');
      if (recording_tab_id) {
        this.recordingTabId = recording_tab_id;
        console.log('[TabManager] Restored recording state for tab', recording_tab_id);
      }
    } catch (err) {
      console.error('[TabManager] Failed to restore session state:', err);
    }

    // ... existing setup ...
  }

  setVideoContext(tabId, videoContext) {
    const existing = this.tabVideoMap.get(tabId);
    this.tabVideoMap.set(tabId, {
      ...videoContext,
      recordingState: existing?.recordingState || 'idle',
      lastUpdated: Date.now() // Track when context was set
    });

    this.persist();

    // Cache notes in local storage
    if (videoContext.videoDbId) {
      this.cacheNotesForVideo(videoContext.videoDbId);
    }

    // Notify side panel
    if (tabId === this.activeTabId) {
      this.onTabChanged(tabId);
    }
  }

  clearVideoContext(tabId) {
    const existing = this.tabVideoMap.get(tabId);

    // DON'T delete immediately - mark as "stale" and wait for replacement
    if (existing) {
      existing.stale = true;
      existing.staleTimestamp = Date.now();
      console.log('[TabManager] Marked video context as stale for tab', tabId);

      // Delete after timeout if no replacement
      setTimeout(() => {
        const current = this.tabVideoMap.get(tabId);
        if (current && current.stale && current.staleTimestamp === existing.staleTimestamp) {
          console.log('[TabManager] Deleting stale context for tab', tabId);
          this.tabVideoMap.delete(tabId);
          this.persist();
        }
      }, 10000); // 10s grace period
    }
  }

  startRecording(tabId) {
    // ... existing code ...

    // Persist to session storage
    chrome.storage.session.set({ recording_tab_id: tabId })
      .catch(err => console.error('[TabManager] Failed to persist recording state:', err));
  }

  stopRecording(tabId) {
    // ... existing code ...

    // Clear from session storage
    chrome.storage.session.remove('recording_tab_id')
      .catch(err => console.error('[TabManager] Failed to clear recording state:', err));
  }

  async cacheNotesForVideo(videoDbId) {
    // Cache notes for instant display on next load
    // Implementation depends on your backend API
  }

  // ... rest of existing code ...
}
```

**Testing**:
- ✅ State persists across service worker restart
- ✅ Recording state restored after extension reload
- ✅ Context not deleted during URL transition
- ✅ Stale context cleaned up after timeout

---

#### Task 5.2: Message Router with Per-Tab Channels

**Problem**: Cross-tab pollution (notes for tab A shown in tab B).

**Files to create**:
- `extension/src/background/message-router.js`

**Implementation**:
```javascript
// message-router.js (NEW)
export class MessageRouter {
  constructor() {
    this.panelSubscriptions = new Map(); // tabId → boolean (is panel subscribed?)
    this.activePanelTabId = null;
  }

  /**
   * Subscribe side panel to a specific tab.
   */
  subscribePanelToTab(tabId) {
    this.panelSubscriptions.set(tabId, true);
    this.activePanelTabId = tabId;
    console.log('[MessageRouter] Side panel subscribed to tab', tabId);
  }

  /**
   * Unsubscribe side panel from a tab.
   */
  unsubscribePanelFromTab(tabId) {
    this.panelSubscriptions.delete(tabId);
    if (this.activePanelTabId === tabId) {
      this.activePanelTabId = null;
    }
    console.log('[MessageRouter] Side panel unsubscribed from tab', tabId);
  }

  /**
   * Route message to side panel only if subscribed to tab.
   */
  routeToSidePanel(message, sourceTabId) {
    // Only route if side panel is subscribed to this tab
    if (this.activePanelTabId !== sourceTabId) {
      console.log('[MessageRouter] Dropping message from tab', sourceTabId, '(panel subscribed to', this.activePanelTabId, ')');
      return false;
    }

    chrome.runtime.sendMessage(message)
      .catch(err => console.log('[MessageRouter] Side panel not available:', err));

    return true;
  }

  /**
   * Check if panel is subscribed to tab.
   */
  isPanelSubscribed(tabId) {
    return this.activePanelTabId === tabId;
  }
}
```

**Integration in service-worker.js**:
```javascript
import { MessageRouter } from './message-router.js';

let messageRouter = null;

(async () => {
  // ... existing initialization ...
  messageRouter = new MessageRouter();
})();

// Add handler for panel subscription
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  if (message.action === 'subscribe_panel') {
    if (messageRouter) {
      messageRouter.subscribePanelToTab(message.tabId);
    }
    sendResponse({ success: true });
    return false;
  }

  // When forwarding notes to side panel, check subscription
  if (message.action === 'note_created') {
    const tabId = sender.tab?.id;
    if (tabId && messageRouter) {
      // Only forward if panel is subscribed to this tab
      messageRouter.routeToSidePanel({
        action: 'transcript',
        data: { ...message.data, tabId }
      }, tabId);
    }
  }

  // ... rest of handlers ...
});
```

**Update sidepanel.js**:
```javascript
// On tab change, subscribe to new tab
async function handleTabChanged(tabId, videoContext) {
  console.log('[SidePanel] Tab changed to', tabId);

  // Subscribe to this tab
  chrome.runtime.sendMessage({
    action: 'subscribe_panel',
    tabId: tabId
  }).catch(err => console.error('[SidePanel] Failed to subscribe:', err));

  // ... existing tab change logic ...
}
```

**Testing**:
- ✅ Notes from tab A not shown in panel for tab B
- ✅ Panel switches correctly when user switches tabs
- ✅ No duplicate notes across tabs
- ✅ Subscription state tracked correctly

---

### Phase 6: Performance & Cleanup (0.5 days)

#### Task 6.1: AbortController-Based Cleanup

**Problem**: Observers and intervals leak on reinitialization.

**Files to modify**:
- `extension/src/content/universal.js`

**Implementation**:
```javascript
// universal.js (ADD)
let abortController = null;

async function init() {
  // Create new AbortController for this initialization
  abortController = new AbortController();
  const signal = abortController.signal;

  // ... existing initialization ...

  // Example: Setup event listener with signal
  window.addEventListener('popstate', checkUrlChange, { signal });

  // Store cleanup functions on signal
  signal.addEventListener('abort', () => {
    console.log('[Lossy] 🧹 AbortController triggered cleanup');
    // All event listeners with { signal } will be removed automatically
  });
}

function cleanup() {
  console.log('[Lossy] 🧹 CLEANUP: Starting cleanup');

  // Abort all operations from current initialization
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  // ... existing cleanup ...
}
```

**Apply to all components**:
- VideoDetector: Use `signal` for MutationObserver and intervals
- TimelineMarkers: Use `signal` for ResizeObserver and event listeners
- VideoLifecycleManager: Use `signal` for health checks

**Testing**:
- ✅ Memory usage stable during repeated reinitialization
- ✅ No leaked intervals/observers after cleanup
- ✅ Chrome DevTools Performance tab shows no leaks

---

## Success Criteria

### Critical Metrics

✅ **Video Detection Reliability**
- Initial detection: 95%+ within 5 seconds
- Persistent detection: 99%+ within 30 seconds
- No "page refresh required" failures

✅ **Note Loading Reliability**
- Zero duplicate requests per video
- Automatic retry succeeds: 95%+ within 10s
- Cross-tab pollution: 0 instances

✅ **Timeline Marker Accuracy**
- Markers render: 99%+ success rate
- Position accuracy: ±1% of video width
- Survives fullscreen/resize: 100%

✅ **Timecode Accuracy**
- Update latency: <100ms
- Paused video accuracy: ±0.1s
- Tab switch latency: <500ms

✅ **Performance**
- Memory usage: <50MB stable
- No observer leaks after reinitialization
- CPU usage: <5% during video playback

✅ **State Persistence**
- Survives extension reload: 100%
- Survives tab switch: 100%
- Survives SPA navigation: 95%+

---

## Testing Plan

### Automated Tests

1. **Video Detection**
   - Multiple videos (ad + main)
   - Lazy-loaded video (scroll trigger)
   - Iframe video (same-origin)
   - Shadow DOM video
   - Non-standard video size

2. **Timeline Markers**
   - Add marker (immediate render)
   - Add 50 markers (performance)
   - Fullscreen toggle (reattach)
   - Resize window (reflow)
   - Control re-render (reattach)

3. **Note Loading**
   - Load notes (single request)
   - Load notes concurrently (deduplication)
   - Load notes with retry (network failure)
   - Switch videos (session invalidation)

4. **State Management**
   - Tab switch (context persists)
   - Extension reload (state restored)
   - URL change (graceful transition)

### Manual Tests (Cross-Platform)

| Platform | Video Detection | Progress Bar | Markers | Timecode | Tab Switch | Notes |
|----------|----------------|--------------|---------|----------|------------|-------|
| YouTube  | ✅             | ✅           | ✅      | ✅       | ✅         | ✅    |
| Frame.io | ✅             | ✅           | ✅      | ✅       | ✅         | ✅    |
| Vimeo    | ✅             | ✅           | ✅      | ✅       | ✅         | ✅    |
| Generic  | ✅             | ⚠️ (fallback)| ⚠️      | ✅       | ✅         | ✅    |

---

## Rollout Strategy

### Phase 1: Core Infrastructure (Days 1-2)
- VideoDetector consolidation
- VideoLifecycleManager
- ProgressBarFinder enhancements
- Baseline testing

### Phase 2: Note Loading & Markers (Days 3-4)
- NoteLoader implementation
- TimelineMarkers resilience
- Timecode push updates
- Integration testing

### Phase 3: State & Multi-Tab (Day 5)
- TabManager enhancements
- MessageRouter implementation
- Session persistence
- Cross-tab testing

### Phase 4: Performance & Polish (Day 6)
- AbortController cleanup
- Performance profiling
- Documentation
- Final testing

---

## Migration Path

### Backward Compatibility

- ✅ Existing adapters (YouTube, Frame.io) work without changes
- ✅ Existing note data structure unchanged
- ✅ No backend API changes required

### Breaking Changes

- ⚠️ `universal-video-detector.js` deleted (use `core/video-detector.js`)
- ⚠️ Note loading retry logic consolidated (remove custom retries from adapters)
- ⚠️ Side panel polling removed (must support push updates)

---

## Future Enhancements (Post-Sprint)

### Telemetry & Debugging
- Structured logging system
- Debug mode console commands
- Performance metrics dashboard
- Error reporting to backend

### Advanced Detection
- Canvas-based video players (Netflix, Disney+)
- WebRTC streams (Zoom, Meet)
- HLS/DASH player APIs
- Platform-specific API hooks

### AI-Powered Improvements
- ML-based video scoring
- Automatic platform detection
- Adaptive retry strategies
- Anomaly detection

---

## Dependencies

**Before Sprint:**
- ✅ Sprint 06 (Platform Adapters) complete
- ✅ TabManager implemented
- ✅ Backend note persistence working

**After Sprint:**
- Sprint 04 (Auto-Posting) can proceed
- Sprint 06 (Polish) builds on reliability

---

## References

### Research

- [Chrome Extension Best Practices](https://developer.chrome.com/docs/extensions/mv3/service_workers/)
- [MutationObserver Performance](https://developers.google.com/web/updates/2012/02/Detect-DOM-changes-with-Mutation-Observers)
- [requestVideoFrameCallback](https://web.dev/requestvideoframecallback-rvfc/)
- [AbortController for Cleanup](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)

### Similar Projects

- Loom (video recording extension)
- Descript (video annotation)
- Frame.io (video review)
- Screencastify (extension architecture)

---

## Notes

This sprint focuses on **systematic reliability improvements** across the entire extension architecture. Each phase builds on the previous, ensuring stable incremental progress.

The key principle: **Move from reactive/retry-based systems to proactive health monitoring with graceful degradation.**
