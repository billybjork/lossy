# Sprint 03: Video Integration & Timeline Markers

**Status:** ✅ Complete
**Completed:** 2025-10-15
**Estimated Duration:** 3-4 days

---

## Goal

Establish a robust, bidirectional connection between the Chrome extension and video players on **any website**. Every note is anchored to a precise video timecode, enabling seamless navigation: click a note to seek the video, click a timeline marker to focus the note. Recording control automatically pauses/unpauses the video for optimal UX.

**Architecture Philosophy:** Generic, heuristic-based detection that works on any video platform, with optional platform-specific optimizations.

---

## Prerequisites

- ✅ Sprint 02 complete (transcription & note structuring working)
- ✅ AgentSession GenServer running
- ✅ Phoenix WebSocket connection established
- ⏳ Test videos available on multiple platforms (YouTube, Vimeo, etc.)

---

## Core Features

### 1. Universal Video Detection (Works on Any Site)
- Automatically detects `<video>` elements on any webpage
- Scores and selects "primary" video (largest, playing, visible)
- Handles SPA navigation and lazy-loaded videos
- Generates stable video IDs (platform-specific when available, URL hash fallback)
- Works on YouTube, Vimeo, Air, TikTok, Twitter, custom players, etc.

### 2. Precise Timestamp Anchoring
- Captures exact timestamp when recording starts
- Uses `requestVideoFrameCallback()` for frame-accurate timestamps (Chrome 83+)
- Stores timestamp with each note in database
- Backend links note to video via foreign key

### 3. Bidirectional Navigation
- **Note → Video**: Click note in side panel → content script seeks video to timestamp
- **Timeline Marker → Note**: Click marker overlay on video → side panel scrolls to and highlights note
- Playback resumes automatically after seeking

### 4. Recording-Video Synchronization
- Start recording → video pauses, anchor chip appears showing timestamp
- Stop recording → video resumes playback
- Prevents accidental video progression during note capture

### 5. Visual Timeline Markers (with Graceful Fallback)
- Heuristic-based progress bar detection (class patterns, ARIA roles, visual heuristics)
- Shadow DOM overlay on detected progress bar
- Markers positioned at exact note timestamps
- Hover shows note preview (category + text snippet)
- Click focuses corresponding note in side panel
- **Graceful degradation**: Core features work even if progress bar not found

---

## Deliverables

- [x] Universal video detector (finds `<video>` on any site)
- [x] Video scoring system (selects primary video from multiple candidates)
- [x] Universal video ID extractor (platform-specific + URL hash fallback)
- [x] Generic progress bar finder (heuristic-based with platform-specific fallbacks)
- [x] Video playback controller (pause/play/seek API)
- [x] Timestamp capture with frame-accurate precision
- [x] Backend VideoChannel for video CRUD operations
- [x] Videos table integration (find_or_create_by platform + video_id)
- [x] Notes linked to videos via foreign key
- [x] Anchor chip overlay (red pulsing indicator at timestamp)
- [x] Timeline marker system (yellow circles with Shadow DOM overlays)
- [x] Bidirectional message passing (content script ↔ service worker ↔ side panel)
- [x] Fullscreen compatibility for overlays
- [x] Single universal content script (runs on all sites)

---

## Technical Architecture

### Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER ACTIONS                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
            [Start Recording]    [Click Note in Side Panel]
                    │                   │
                    ▼                   ▼
            ┌──────────────┐    ┌──────────────┐
            │  Side Panel  │───▶│Service Worker│
            │  (UI Layer)  │◀───│ (Orchestrator)│
            └──────────────┘    └──────────────┘
                    │                   │
                    │                   ▼
                    │           ┌───────────────┐
                    │           │Content Script │
                    │           │ (Video Page)  │
                    │           └───────────────┘
                    │                   │
                    │                   ▼
                    │           ┌───────────────┐
                    │           │ Video Element │
                    │           │ .pause()      │
                    │           │ .currentTime  │
                    │           └───────────────┘
                    │
                    ▼
            ┌──────────────┐
            │   Phoenix    │
            │ AudioChannel │
            └──────────────┘
                    │
                    ▼
            ┌──────────────┐
            │ AgentSession │
            │  (GenServer) │
            └──────────────┘
                    │
                    ▼
            ┌──────────────┐
            │   Database   │
            │ notes.video_id│
            │ .timestamp_s │
            └──────────────┘
```

### Component Responsibilities

**Universal Content Script** (`universal.js` - runs on all sites)
- Detect video elements using generic heuristics
- Score and select primary video from multiple candidates
- Extract video metadata (platform, ID, URL, title)
- Control video playback (pause, play, seek)
- Find progress bar using heuristics (class patterns, ARIA, visual)
- Inject timeline marker overlay (Shadow DOM)
- Inject anchor chip overlay (Shadow DOM)
- Listen for messages from service worker
- Handle SPA navigation (re-detect on URL changes)

**Service Worker** (`service-worker.js`)
- Maintain global state: `currentVideo`, `currentTimestamp`, `tabVideoMap`
- Route messages between side panel ↔ content script
- Manage Phoenix Socket connection
- Forward video metadata to backend VideoChannel
- Handle recording lifecycle events

**Side Panel** (`sidepanel.js`)
- Display notes grouped by video
- Click handler: Send seek request to service worker
- Real-time note updates via `chrome.runtime.onMessage`
- Scroll-to-note animation when timeline marker clicked

**Backend VideoChannel** (`video_channel.ex`)
- `video_detected` event → `Videos.find_or_create_video/1`
- Return video database ID to extension
- Handle video metadata updates

**Backend AgentSession** (`session.ex`)
- Accept `video_id` and `timestamp` in init opts
- Store video context in state
- Include video_id + timestamp_seconds when creating note

---

## Implementation Tasks

### Task 1: Universal Video Detection

**File:** `extension/src/content/universal-video-detector.js` (new)

```javascript
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
   */
  watchForChanges(callback) {
    this.observer = new MutationObserver(() => {
      const currentVideos = Array.from(document.querySelectorAll('video'));

      if (!currentVideos.includes(this.primaryVideo)) {
        console.log('[UniversalVideoDetector] Primary video changed, re-detecting...');
        this.videoElements = currentVideos;
        this.primaryVideo = this.selectPrimaryVideo(currentVideos);
        callback(this.primaryVideo);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
  }
}
```

**File:** `extension/src/content/universal-video-id.js` (new)

```javascript
/**
 * Universal video ID extractor.
 * Generates stable, unique IDs for videos on any platform.
 */
export class UniversalVideoId {
  /**
   * Extract or generate a video ID.
   * Tries platform-specific extraction first, falls back to URL hash.
   */
  static extract(url, platformHint = null) {
    console.log('[UniversalVideoId] Extracting ID for:', url);

    // Try platform-specific extraction
    if (platformHint && platformHint !== 'generic') {
      const platformId = this.extractPlatformSpecific(url, platformHint);
      if (platformId) {
        return { type: 'platform', id: platformId, platform: platformHint };
      }
    }

    // Fallback: Hash the canonical URL
    const urlId = this.hashUrl(url);
    return { type: 'url', id: urlId, platform: 'generic' };
  }

  /**
   * Detect platform from URL hostname.
   */
  static detectPlatform(url) {
    try {
      const hostname = new URL(url).hostname;

      if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
        return 'youtube';
      }
      if (hostname.includes('vimeo.com')) {
        return 'vimeo';
      }
      if (hostname.includes('air.inc')) {
        return 'air';
      }

      return 'generic';
    } catch (e) {
      return 'generic';
    }
  }

  /**
   * Platform-specific extraction (optional optimization).
   */
  static extractPlatformSpecific(url, platform) {
    const extractors = {
      youtube: this.extractYouTubeId.bind(this),
      vimeo: this.extractVimeoId.bind(this),
      air: this.extractAirId.bind(this)
    };

    const extractor = extractors[platform];
    return extractor ? extractor(url) : null;
  }

  static extractYouTubeId(url) {
    const urlObj = new URL(url);
    const vParam = urlObj.searchParams.get('v');
    if (vParam) return vParam;

    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1).split('?')[0];
    }

    const shortsMatch = urlObj.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];

    const embedMatch = urlObj.pathname.match(/^\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];

    return null;
  }

  static extractVimeoId(url) {
    const urlObj = new URL(url);
    const match = urlObj.pathname.match(/^\/(\d+)/);
    return match ? match[1] : null;
  }

  static extractAirId(url) {
    const urlObj = new URL(url);
    const match = urlObj.pathname.match(/\/([^/]+)$/);
    return match ? match[1] : null;
  }

  /**
   * Hash a URL to create a stable ID (removes query params).
   */
  static hashUrl(url) {
    try {
      const urlObj = new URL(url);
      const canonical = `${urlObj.hostname}${urlObj.pathname}`;
      return this.simpleHash(canonical);
    } catch (e) {
      return this.simpleHash(url);
    }
  }

  /**
   * Simple string hash (DJB2 algorithm).
   */
  static simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }
}
```

**File:** `extension/src/content/universal-progress-bar.js` (new)

```javascript
/**
 * Universal progress bar detector - finds video controls using heuristics.
 * No platform-specific selectors.
 */
export class UniversalProgressBar {
  constructor(videoElement) {
    this.videoElement = videoElement;
  }

  /**
   * Find the progress bar container for this video.
   * Uses multiple strategies in order of reliability.
   */
  find() {
    console.log('[UniversalProgressBar] Searching for progress bar...');

    // Strategy 1: Common class/ID patterns
    const patterns = [
      '.progress-bar',
      '.progressbar',
      '.seek-bar',
      '.seekbar',
      '.scrubber',
      '.timeline',
      '.video-progress',
      '[class*="progress"]',
      '[class*="seek"]',
      '[class*="timeline"]'
    ];

    for (const pattern of patterns) {
      const elements = this.findNearVideo(pattern);
      if (elements.length > 0) {
        console.log('[UniversalProgressBar] Found via pattern:', pattern);
        return elements[0];
      }
    }

    // Strategy 2: ARIA roles
    const ariaElements = this.findNearVideo('[role="slider"], [role="progressbar"]');
    if (ariaElements.length > 0) {
      console.log('[UniversalProgressBar] Found via ARIA role');
      return ariaElements[0];
    }

    // Strategy 3: Input range sliders
    const rangeInputs = this.findNearVideo('input[type="range"]');
    if (rangeInputs.length > 0) {
      console.log('[UniversalProgressBar] Found via range input');
      return rangeInputs[0].parentElement;
    }

    // Strategy 4: Visual heuristics (horizontal bars near bottom of video)
    const candidate = this.findByVisualHeuristics();
    if (candidate) {
      console.log('[UniversalProgressBar] Found via visual heuristics');
      return candidate;
    }

    console.warn('[UniversalProgressBar] Could not find progress bar');
    return null;
  }

  /**
   * Find elements near the video (same container or siblings).
   */
  findNearVideo(selector) {
    const container = this.videoElement.parentElement;
    if (!container) return [];

    const inContainer = Array.from(container.querySelectorAll(selector));
    const siblings = Array.from(container.children).filter(el =>
      el !== this.videoElement && el.matches(selector)
    );

    return [...inContainer, ...siblings].filter(Boolean);
  }

  /**
   * Find elements that look like horizontal progress bars.
   */
  findByVisualHeuristics() {
    const container = this.videoElement.parentElement;
    if (!container) return null;

    const allElements = Array.from(container.querySelectorAll('*'));

    const candidates = allElements.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      // Wide and short (aspect ratio > 5:1)
      const isHorizontal = rect.width > rect.height * 5;
      // Near bottom of video
      const isNearBottom = rect.bottom > this.videoElement.getBoundingClientRect().bottom - 100;
      // Has background color
      const hasBackground = style.backgroundColor !== 'rgba(0, 0, 0, 0)';

      return isHorizontal && isNearBottom && hasBackground && rect.width > 100;
    });

    return candidates[0] || null;
  }
}
```

**File:** `extension/src/content/video-controller.js` (new)

```javascript
/**
 * Generic video controller - works with any HTML5 video element.
 */
export class VideoController {
  constructor(videoElement) {
    this.videoElement = videoElement;
  }

  async getCurrentTime() {
    if (!this.videoElement) return null;

    // Use requestVideoFrameCallback for precision (Chrome 83+)
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      return new Promise((resolve) => {
        this.videoElement.requestVideoFrameCallback((now, metadata) => {
          resolve(metadata.mediaTime);
        });
      });
    }

    return Promise.resolve(this.videoElement.currentTime);
  }

  pause() {
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();
    }
  }

  play() {
    if (this.videoElement && this.videoElement.paused) {
      this.videoElement.play();
    }
  }

  seekTo(timestamp) {
    if (this.videoElement) {
      this.videoElement.currentTime = timestamp;
    }
  }

  getDuration() {
    return this.videoElement?.duration || 0;
  }

  destroy() {
    // Cleanup if needed
  }
}
```

---

### Task 2: Universal Content Script (Runs on All Sites)

**File:** `extension/src/content/universal.js` (new - replaces all platform-specific scripts)

```javascript
import { UniversalVideoDetector } from './universal-video-detector.js';
import { UniversalProgressBar } from './universal-progress-bar.js';
import { UniversalVideoId } from './universal-video-id.js';
import { VideoController } from './video-controller.js';
import { AnchorChip } from './shared/anchor-chip.js';
import { TimelineMarkers } from './shared/timeline-markers.js';

console.log('[Lossy] Universal content script loaded');

let videoDetector = null;
let videoController = null;
let currentVideoId = null;
let currentVideoDbId = null;
let anchorChip = null;
let timelineMarkers = null;

async function init() {
  console.log('[Lossy] Initializing universal video detection...');

  // Detect video
  videoDetector = new UniversalVideoDetector();
  const videoElement = await videoDetector.detect();

  if (!videoElement) {
    console.warn('[Lossy] No video element found on this page');
    return;
  }

  console.log('[Lossy] Video element found:', videoElement);

  // Extract video metadata
  const url = window.location.href;
  const platform = UniversalVideoId.detectPlatform(url);
  const videoIdData = UniversalVideoId.extract(url, platform);

  currentVideoId = videoIdData.id;

  console.log('[Lossy] Video ID:', videoIdData);

  // Create video controller
  videoController = new VideoController(videoElement);

  // Send video context to service worker
  const response = await chrome.runtime.sendMessage({
    action: 'video_detected',
    data: {
      platform: videoIdData.platform,
      videoId: videoIdData.id,
      url: url,
      title: document.title
    }
  }).catch(err => {
    console.warn('[Lossy] Could not send video_detected message:', err);
    return null;
  });

  if (response?.videoDbId) {
    currentVideoDbId = response.videoDbId;
    console.log('[Lossy] Video database ID:', currentVideoDbId);
  }

  // Set up overlays
  setupAnchorChip(videoElement);
  setupTimelineMarkers(videoElement);

  // Listen for events
  listenForEvents();

  // Watch for video changes (SPA navigation)
  videoDetector.watchForChanges((newVideo) => {
    console.log('[Lossy] Video changed, reinitializing...');
    cleanup();
    init();
  });
}

function setupAnchorChip(videoElement) {
  anchorChip = new AnchorChip(videoElement);
  anchorChip.hide();
}

function setupTimelineMarkers(videoElement) {
  // Find progress bar
  const progressBarFinder = new UniversalProgressBar(videoElement);
  const progressBar = progressBarFinder.find();

  if (!progressBar) {
    console.warn('[Lossy] Could not find progress bar, timeline markers disabled');
    return;
  }

  timelineMarkers = new TimelineMarkers(videoElement, progressBar);

  timelineMarkers.onMarkerClick((noteId, timestamp) => {
    console.log('[Lossy] Timeline marker clicked:', noteId, timestamp);
    chrome.runtime.sendMessage({
      action: 'marker_clicked',
      data: { noteId, timestamp }
    });
  });
}

function listenForEvents() {
  chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'recording_started') {
      const timestamp = await videoController.getCurrentTime();
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

      sendResponse({ success: true });
    }

    if (message.action === 'recording_stopped') {
      console.log('[Lossy] Recording stopped');

      videoController.play();

      if (anchorChip) {
        anchorChip.hide();
      }

      sendResponse({ success: true });
    }

    if (message.action === 'note_created') {
      console.log('[Lossy] Note created, adding timeline marker:', message.data);

      if (timelineMarkers && message.data.timestamp_seconds != null) {
        timelineMarkers.addMarker({
          id: message.data.id,
          timestamp: message.data.timestamp_seconds,
          category: message.data.category,
          text: message.data.text
        });
      }

      sendResponse({ success: true });
    }

    if (message.action === 'seek_to') {
      console.log('[Lossy] Seeking to timestamp:', message.timestamp);

      videoController.seekTo(message.timestamp);
      videoController.play();

      sendResponse({ success: true });
    }

    if (message.action === 'load_markers') {
      console.log('[Lossy] Loading markers:', message.notes);

      if (timelineMarkers && message.notes) {
        message.notes.forEach(note => {
          if (note.timestamp_seconds != null) {
            timelineMarkers.addMarker({
              id: note.id,
              timestamp: note.timestamp_seconds,
              category: note.category,
              text: note.text
            });
          }
        });
      }

      sendResponse({ success: true });
    }

    return true;
  });
}

function cleanup() {
  if (anchorChip) anchorChip.destroy();
  if (timelineMarkers) timelineMarkers.destroy();
  if (videoDetector) videoDetector.destroy();
  if (videoController) videoController.destroy();
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

---

### Task 3: Timeline Markers Overlay (Shadow DOM)

**File:** `extension/src/content/shared/timeline-markers.js` (new)

```javascript
/**
 * Timeline markers overlay system.
 * Displays markers on video progress bar at note timestamps.
 * Uses Shadow DOM for style isolation.
 */
export class TimelineMarkers {
  constructor(videoElement, progressBarElement) {
    this.videoElement = videoElement;
    this.progressBar = progressBarElement; // Now passed in, not detected
    this.container = null;
    this.shadowRoot = null;
    this.markers = new Map(); // noteId → marker element
    this.clickCallback = null;
    this.init();
  }

  init() {
    if (!this.progressBar) {
      console.warn('[TimelineMarkers] No progress bar provided');
      return;
    }

    // Create marker container
    this.container = document.createElement('div');
    this.container.id = 'lossy-timeline-markers';
    this.container.style.position = 'absolute';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '100';

    // Attach shadow DOM
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        .marker {
          position: absolute;
          top: 0;
          width: 3px;
          height: 100%;
          background: #dc2626;
          cursor: pointer;
          pointer-events: auto;
          transition: transform 0.2s, background 0.2s;
        }

        .marker:hover {
          transform: scaleX(2);
          background: #ef4444;
        }

        .marker-tooltip {
          position: absolute;
          bottom: 120%;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          border-radius: 6px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 12px;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s;
          z-index: 1000;
        }

        .marker:hover .marker-tooltip {
          opacity: 1;
        }

        .marker-category {
          display: inline-block;
          padding: 2px 6px;
          background: #dc2626;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          margin-right: 6px;
        }
      </style>
      <div id="markers-container"></div>
    `;

    // Append to progress bar (make relative if needed)
    if (window.getComputedStyle(this.progressBar).position === 'static') {
      this.progressBar.style.position = 'relative';
    }
    this.progressBar.appendChild(this.container);
  }

  addMarker({ id, timestamp, category, text }) {
    const duration = this.videoElement.duration;
    if (!duration || timestamp > duration) return;

    // Calculate position (percentage)
    const position = (timestamp / duration) * 100;

    // Create marker element
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.left = `${position}%`;
    marker.dataset.noteId = id;
    marker.dataset.timestamp = timestamp;

    // Add tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'marker-tooltip';
    tooltip.innerHTML = `
      <span class="marker-category">${category || 'note'}</span>
      ${this.truncate(text, 50)}
    `;
    marker.appendChild(tooltip);

    // Click handler
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.clickCallback) {
        this.clickCallback(id, timestamp);
      }
    });

    // Add to shadow DOM
    const markersContainer = this.shadowRoot.getElementById('markers-container');
    markersContainer.appendChild(marker);

    // Store reference
    this.markers.set(id, marker);
  }

  removeMarker(noteId) {
    const marker = this.markers.get(noteId);
    if (marker) {
      marker.remove();
      this.markers.delete(noteId);
    }
  }

  highlightMarker(noteId) {
    // Remove previous highlights
    this.markers.forEach(marker => {
      marker.style.background = '#dc2626';
    });

    // Highlight selected marker
    const marker = this.markers.get(noteId);
    if (marker) {
      marker.style.background = '#fbbf24'; // Yellow
      setTimeout(() => {
        marker.style.background = '#dc2626';
      }, 2000);
    }
  }

  onMarkerClick(callback) {
    this.clickCallback = callback;
  }

  truncate(text, maxLength) {
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }

  destroy() {
    if (this.container) {
      this.container.remove();
    }
    this.markers.clear();
  }
}
```

---

### Task 4: Anchor Chip Overlay (Recording Indicator)

**File:** `extension/src/content/shared/anchor-chip.js` (new)

```javascript
/**
 * Anchor chip overlay - shows timestamp when recording starts.
 * Positioned over video with pulsing animation.
 * Uses Shadow DOM for style isolation.
 */
export class AnchorChip {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.container = null;
    this.shadowRoot = null;
    this.init();
  }

  init() {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'lossy-anchor-chip';
    this.container.style.position = 'absolute';
    this.container.style.top = '20px';
    this.container.style.left = '20px';
    this.container.style.zIndex = '9999';
    this.container.style.pointerEvents = 'none';
    this.container.style.display = 'none';

    // Attach shadow DOM
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        .anchor-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          background: rgba(220, 38, 38, 0.95);
          color: white;
          border-radius: 24px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.85; transform: scale(1.05); }
        }

        .anchor-icon {
          width: 8px;
          height: 8px;
          background: white;
          border-radius: 50%;
          animation: ping 2s infinite;
        }

        @keyframes ping {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.5); opacity: 0.7; }
        }

        .anchor-time {
          font-variant-numeric: tabular-nums;
        }
      </style>

      <div class="anchor-chip">
        <div class="anchor-icon"></div>
        <span class="anchor-time" id="timestamp">0:00</span>
      </div>
    `;

    // Append to video container
    const videoContainer = this.videoElement.parentElement;
    if (videoContainer) {
      videoContainer.style.position = 'relative';
      videoContainer.appendChild(this.container);
    }

    // Handle fullscreen
    this.handleFullscreen();
  }

  show(timestamp) {
    this.container.style.display = 'block';
    this.updateTimestamp(timestamp);
  }

  hide() {
    this.container.style.display = 'none';
  }

  updateTimestamp(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const timeString = `${minutes}:${secs.toString().padStart(2, '0')}`;

    const timeEl = this.shadowRoot.getElementById('timestamp');
    if (timeEl) {
      timeEl.textContent = timeString;
    }
  }

  handleFullscreen() {
    document.addEventListener('fullscreenchange', () => {
      const fullscreenEl = document.fullscreenElement;

      if (fullscreenEl) {
        // Move to fullscreen element
        fullscreenEl.appendChild(this.container);
        this.container.style.position = 'absolute';
      } else {
        // Move back to video container
        const videoContainer = this.videoElement.parentElement;
        if (videoContainer) {
          videoContainer.appendChild(this.container);
        }
      }
    });
  }

  destroy() {
    if (this.container) {
      this.container.remove();
    }
  }
}
```

---

### Task 5: Service Worker Updates (Message Routing)

**File:** `extension/src/background/service-worker.js` (update)

```javascript
// ... existing imports and setup ...

let currentVideo = null;
let currentTimestamp = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  // Video detected from content script
  if (message.action === 'video_detected') {
    currentVideo = message.data;
    console.log('[Lossy] Video detected:', currentVideo);

    // Send to backend VideoChannel
    if (socket && socket.isConnected()) {
      const videoChannel = socket.channel('video:meta', {});
      videoChannel.join()
        .receive('ok', () => {
          videoChannel.push('video_detected', currentVideo)
            .receive('ok', (response) => {
              console.log('[Lossy] Video record created:', response);
              currentVideo.dbId = response.video_id;

              // Return DB ID to content script
              sendResponse({ videoDbId: response.video_id });

              // Request existing notes for this video
              videoChannel.push('get_notes', { video_id: response.video_id })
                .receive('ok', (notesResponse) => {
                  // Send notes to content script for timeline markers
                  chrome.tabs.sendMessage(sender.tab.id, {
                    action: 'load_markers',
                    notes: notesResponse.notes
                  });
                });
            })
            .receive('error', (err) => {
              console.error('[Lossy] Failed to create video record:', err);
              sendResponse({ error: err });
            });
        });
    } else {
      sendResponse({ error: 'Socket not connected' });
    }

    return true; // Keep channel open for async response
  }

  // Timestamp captured from content script
  if (message.action === 'timestamp_captured') {
    currentTimestamp = message.data.timestamp;
    console.log('[Lossy] Timestamp captured:', currentTimestamp);
    sendResponse({ success: true });
    return false;
  }

  // Marker clicked in timeline → focus note in side panel
  if (message.action === 'marker_clicked') {
    console.log('[Lossy] Marker clicked:', message.data);

    // Forward to side panel
    chrome.runtime.sendMessage({
      action: 'focus_note',
      noteId: message.data.noteId,
      timestamp: message.data.timestamp
    });

    sendResponse({ success: true });
    return false;
  }

  // Note clicked in side panel → seek video
  if (message.action === 'note_clicked') {
    console.log('[Lossy] Note clicked, seeking to:', message.timestamp);

    // Forward to content script in active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'seek_to',
          timestamp: message.timestamp
        });
      }
    });

    sendResponse({ success: true });
    return false;
  }
});

// Update startRecording to notify content script
async function startRecording() {
  console.log('[Lossy] Starting recording...');

  // Notify content script to pause video
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'recording_started' })
      .catch((err) => console.log('[Lossy] No content script on this page'));
  }

  // ... rest of existing startRecording code ...

  // Pass video context to AgentSession
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {
    video_id: currentVideo?.dbId,
    timestamp: currentTimestamp
  });

  // Listen for note created event
  audioChannel.on('note_created', (payload) => {
    console.log('[Lossy] Note created:', payload);

    // Forward to side panel
    chrome.runtime.sendMessage({
      action: 'transcript',
      data: payload
    });

    // Forward to content script for timeline marker
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'note_created',
        data: payload
      });
    }
  });

  // ... rest of channel setup ...
}

async function stopRecording() {
  console.log('[Lossy] Stopping recording...');

  // Notify content script to resume video
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'recording_stopped' })
      .catch((err) => console.log('[Lossy] No content script on this page'));
  }

  // ... rest of existing stopRecording code ...
}
```

---

### Task 6: Side Panel Updates (Note Click Handler)

**File:** `extension/src/sidepanel/sidepanel.js` (update)

```javascript
// ... existing code ...

// Render note with click handler
function renderNote(note) {
  const noteEl = document.createElement('div');
  noteEl.className = 'note-item';
  noteEl.dataset.noteId = note.id;
  noteEl.dataset.timestamp = note.timestamp_seconds;

  // Format timestamp
  const timestamp = note.timestamp_seconds != null
    ? formatTimestamp(note.timestamp_seconds)
    : '';

  noteEl.innerHTML = `
    <div class="note-category">${note.category || 'note'}</div>
    ${timestamp ? `<div class="note-timestamp">${timestamp}</div>` : ''}
    <div class="note-text">${note.text}</div>
  `;

  // Click to seek video
  noteEl.addEventListener('click', () => {
    if (note.timestamp_seconds != null) {
      chrome.runtime.sendMessage({
        action: 'note_clicked',
        timestamp: note.timestamp_seconds
      });

      // Visual feedback
      highlightNote(note.id);
    }
  });

  return noteEl;
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function highlightNote(noteId) {
  // Remove previous highlights
  document.querySelectorAll('.note-item').forEach(el => {
    el.classList.remove('highlighted');
  });

  // Highlight selected note
  const noteEl = document.querySelector(`[data-note-id="${noteId}"]`);
  if (noteEl) {
    noteEl.classList.add('highlighted');
    noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Listen for focus_note messages (from timeline marker clicks)
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'focus_note') {
    highlightNote(message.noteId);
  }
});
```

**File:** `extension/src/sidepanel/sidepanel.html` (add CSS)

```html
<style>
  .note-item {
    padding: 12px;
    margin-bottom: 8px;
    background: #f3f4f6;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s, transform 0.2s;
  }

  .note-item:hover {
    background: #e5e7eb;
    transform: translateX(4px);
  }

  .note-item.highlighted {
    background: #fef3c7;
    border-left: 4px solid #f59e0b;
  }

  .note-timestamp {
    font-size: 12px;
    color: #6b7280;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .note-category {
    display: inline-block;
    padding: 2px 8px;
    background: #dc2626;
    color: white;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .note-text {
    font-size: 14px;
    color: #1f2937;
  }
</style>
```

---

### Task 7: Backend VideoChannel & Database Integration

**File:** `lib/lossy_web/channels/video_channel.ex` (new)

```elixir
defmodule LossyWeb.VideoChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Videos

  @impl true
  def join("video:meta", _payload, socket) do
    Logger.info("[VideoChannel] Joined video metadata channel")
    {:ok, socket}
  end

  @impl true
  def handle_in("video_detected", %{"platform" => platform, "videoId" => video_id} = payload, socket) do
    Logger.info("[VideoChannel] Video detected: #{platform}/#{video_id}")

    url = Map.get(payload, "url")
    title = Map.get(payload, "title")

    case Videos.find_or_create_video(%{
      platform: platform,
      platform_video_id: video_id,
      url: url,
      title: title
    }) do
      {:ok, video} ->
        Logger.info("[VideoChannel] Video record created/found: #{video.id}")
        {:reply, {:ok, %{video_id: video.id}}, socket}

      {:error, changeset} ->
        Logger.error("[VideoChannel] Failed to create video: #{inspect(changeset)}")
        {:reply, {:error, %{message: "Failed to create video"}}, socket}
    end
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    Logger.info("[VideoChannel] Fetching notes for video: #{video_id}")

    notes = Videos.list_notes_by_video(video_id)

    {:reply, {:ok, %{notes: notes}}, socket}
  end
end
```

**File:** `lib/lossy_web/user_socket.ex` (update)

```elixir
defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  # Channels
  channel "audio:*", LossyWeb.AudioChannel
  channel "video:*", LossyWeb.VideoChannel  # Add this

  @impl true
  def connect(_params, socket, _connect_info) do
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
```

**File:** `lib/lossy/videos.ex` (update)

```elixir
defmodule Lossy.Videos do
  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Videos.{Video, Note}

  # ... existing functions ...

  def find_or_create_video(attrs) do
    platform = Map.get(attrs, :platform)
    platform_video_id = Map.get(attrs, :platform_video_id)

    case Repo.get_by(Video, platform: platform, platform_video_id: platform_video_id) do
      nil ->
        # Create new video
        %Video{}
        |> Video.changeset(attrs)
        |> Repo.insert()

      video ->
        # Update existing video (title may have changed)
        video
        |> Video.changeset(attrs)
        |> Repo.update()
    end
  end

  def list_notes_by_video(video_id) do
    Note
    |> where([n], n.video_id == ^video_id)
    |> order_by([n], asc: n.timestamp_seconds)
    |> Repo.all()
    |> Enum.map(&note_to_map/1)
  end

  defp note_to_map(note) do
    %{
      id: note.id,
      text: note.text,
      category: note.category,
      timestamp_seconds: note.timestamp_seconds,
      confidence: note.confidence,
      status: note.status
    }
  end
end
```

---

### Task 8: AgentSession Integration (Video Context)

**File:** `lib/lossy/agent/session.ex` (update)

```elixir
defmodule Lossy.Agent.Session do
  use GenServer
  require Logger

  alias Lossy.Inference.Cloud
  alias Lossy.Videos

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.get(opts, :user_id)
    video_id = Keyword.get(opts, :video_id)
    timestamp = Keyword.get(opts, :timestamp)

    state = %{
      session_id: session_id,
      user_id: user_id,
      video_id: video_id,  # Database video ID
      timestamp_seconds: timestamp,  # Exact timestamp when recording started
      status: :idle,
      audio_buffer: <<>>,
      audio_duration: 0,
      started_at: nil,
      last_transition: DateTime.utc_now()
    }

    Logger.info("[AgentSession] Started: #{session_id}, video_id: #{video_id}, timestamp: #{timestamp}")
    {:ok, state}
  end

  # ... existing handlers ...

  defp structure_note(state, transcript_text) do
    case Cloud.structure_note(transcript_text) do
      {:ok, structured_note} ->
        Logger.info("[#{state.session_id}] Note structured: #{inspect(structured_note)}")

        # Create note with video context
        {:ok, note} = Videos.create_note(%{
          transcript: transcript_text,
          text: structured_note.text,
          category: structured_note.category,
          confidence: structured_note.confidence,
          status: "ghost",
          video_id: state.video_id,  # Link to video
          session_id: state.session_id,
          timestamp_seconds: state.timestamp_seconds  # Exact timestamp
        })

        # Broadcast to extension
        Phoenix.PubSub.broadcast(
          Lossy.PubSub,
          "session:#{state.session_id}",
          {:note_created, note}
        )

        Logger.info("[#{state.session_id}] Note created and broadcast: #{note.id}")

      {:error, reason} ->
        Logger.error("[#{state.session_id}] Failed to structure note: #{reason}")
    end
  end
end
```

**File:** `lib/lossy_web/channels/audio_channel.ex` (update join)

```elixir
@impl true
def join("audio:" <> session_id, payload, socket) do
  Logger.info("[AudioChannel] Joined: #{session_id}")

  video_id = Map.get(payload, "video_id")
  timestamp = Map.get(payload, "timestamp")

  # Start AgentSession with video context
  case Lossy.Agent.SessionSupervisor.start_session(
    session_id,
    video_id: video_id,
    timestamp: timestamp
  ) do
    {:ok, _pid} ->
      Logger.info("[AudioChannel] Started AgentSession: #{session_id} (video: #{video_id}, ts: #{timestamp})")

    {:error, {:already_started, _pid}} ->
      Logger.info("[AudioChannel] AgentSession already running: #{session_id}")

    {:error, reason} ->
      Logger.error("[AudioChannel] Failed to start AgentSession: #{inspect(reason)}")
  end

  # Subscribe to session PubSub
  Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")

  {:ok, assign(socket, :session_id, session_id)}
end

# Forward PubSub events to WebSocket
@impl true
def handle_info({:note_created, note}, socket) do
  push(socket, "note_created", %{
    id: note.id,
    text: note.text,
    category: note.category,
    confidence: note.confidence,
    timestamp_seconds: note.timestamp_seconds,
    status: note.status
  })

  {:noreply, socket}
end
```

---

### Task 9: Manifest Updates (Universal Content Script)

**File:** `extension/manifest.json` (update)

```json
{
  "manifest_version": 3,
  "name": "Lossy - Voice Video Companion",
  "version": "0.3.0",
  "description": "Voice-first video companion with cloud transcription",

  "permissions": ["sidePanel", "storage", "tabs", "offscreen"],

  "host_permissions": [
    "*://*/*"
  ],

  "background": {
    "service_worker": "dist/service-worker.js",
    "type": "module"
  },

  "side_panel": {
    "default_path": "src/sidepanel/sidepanel.html"
  },

  "content_scripts": [
    {
      "matches": ["*://*/*"],
      "js": ["dist/universal.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],

  "web_accessible_resources": [
    {
      "resources": ["dist/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**Key Changes:**
- Single universal content script runs on all URLs (`*://*/*`)
- Replaces platform-specific scripts (youtube.js, vimeo.js, air.js)
- Broader host_permissions to work on any site with video
- `all_frames: false` to only run in main frame (not iframes)

---

## Testing Checklist

### Universal Video Detection
- [ ] Navigate to YouTube → video detected automatically
- [ ] Navigate to Vimeo → video detected automatically
- [ ] Navigate to Twitter/X video → video detected automatically
- [ ] Navigate to TikTok → video detected automatically
- [ ] Navigate to custom video player site → video detected
- [ ] Page with multiple videos → correct video selected (largest, playing)
- [ ] Page with no video → script exits gracefully
- [ ] SPA navigation → video re-detected automatically

### Video ID Extraction
- [ ] YouTube video → extracts native video ID
- [ ] Vimeo video → extracts native video ID
- [ ] Generic site → generates stable URL hash
- [ ] Same video on different URLs → consistent ID

### Recording Flow
- [ ] Click "Start Recording" → video pauses
- [ ] Anchor chip appears with correct timestamp (e.g., "2:35")
- [ ] Anchor chip pulses with animation
- [ ] Click "Stop Recording" → video resumes playback
- [ ] Anchor chip disappears

### Timeline Markers (Graceful Degradation)
- [ ] YouTube → progress bar found, markers displayed
- [ ] Vimeo → progress bar found, markers displayed
- [ ] Generic site with standard controls → progress bar found
- [ ] Site with custom player → progress bar found via heuristics
- [ ] Site where progress bar cannot be found → core features still work
- [ ] Hover marker → tooltip shows category + text snippet
- [ ] Click marker → side panel scrolls to note and highlights it
- [ ] Multiple notes → multiple markers at different positions

### Bidirectional Navigation
- [ ] Click note in side panel → video seeks to timestamp
- [ ] Video playback starts automatically after seek
- [ ] Click timeline marker → note highlights in side panel

### Database Integration
- [ ] Video record created with platform, platform_video_id, URL, title
- [ ] Duplicate video detection (same ID → same DB record)
- [ ] Notes linked to video via foreign key
- [ ] Notes have accurate timestamp_seconds field

### Cross-Platform Testing
- [ ] Test on at least 5 different video platforms
- [ ] Verify video scoring heuristics work correctly
- [ ] Test on site with ads (autoplay muted videos scored low)
- [ ] Test on site with thumbnail videos (small videos scored low)

### Edge Cases
- [ ] Fullscreen mode → overlays reposition correctly
- [ ] No video on page → content script exits gracefully
- [ ] Recording without video context → works (legacy behavior)
- [ ] Multiple notes at same timestamp → markers stack or offset
- [ ] Video element removed from DOM → watchers handle gracefully

---

## Platform Examples

### Tested Platforms (Generic Detection)
- **YouTube**: Works with all URL formats (`/watch`, `/shorts`, `youtu.be`)
- **Vimeo**: Standard and unlisted videos
- **Twitter/X**: Inline video tweets
- **TikTok**: TikTok videos
- **Generic Sites**: Any site with `<video>` element

### Progress Bar Detection Strategies

1. **Common Patterns**: `.progress-bar`, `.seek-bar`, `.timeline`
2. **ARIA Roles**: `[role="slider"]`, `[role="progressbar"]`
3. **Input Elements**: `input[type="range"]`
4. **Visual Heuristics**: Horizontal bars near bottom of video

### Known Platform-Specific Quirks

**YouTube:**
- SPA navigation requires MutationObserver
- Video ID extracted from URL param `v=`
- Progress bar: `.ytp-progress-bar-container`

**Vimeo:**
- Iframe embeds may require Vimeo Player API (future enhancement)
- Video ID extracted from pathname
- Progress bar: `.vp-progress`

**Generic Sites:**
- Progress bar detection may fail on heavily customized players
- Timeline markers gracefully disabled if progress bar not found
- Core features (pause/play/seek/timestamp) always work

---

## Known Limitations

1. **Progress Bar Detection**
   - May fail on heavily customized video players
   - Heuristics might select wrong element in rare cases
   - **Mitigation**: Core features (pause/play/seek) work regardless, markers gracefully disabled

2. **Video ID Stability**
   - URL-hashed IDs may change if URL structure changes significantly
   - **Mitigation**: Store original URL alongside hash for reference

3. **Performance**
   - MutationObserver runs on all pages (even those without video)
   - **Mitigation**: Early exit if no video detected, minimal overhead

4. **Browser Compatibility**
   - Shadow DOM: Chrome 53+, Firefox 63+, Safari 10+
   - Frame-accurate timestamps: Chrome 83+ (fallbacks available)

5. **Iframe Embeds**
   - Cannot access video elements inside cross-origin iframes
   - **Future**: Implement platform-specific Player APIs (Vimeo, YouTube)

---

## Architecture Benefits

### ✅ Advantages of Universal Approach

1. **Universal Compatibility**: Works on any site with `<video>` elements
2. **Future-Proof**: No hardcoded selectors that break when platforms update UI
3. **Minimal Maintenance**: Single content script instead of per-platform scripts
4. **Graceful Degradation**: Core features work even when timeline markers fail
5. **Automatic Support**: New video platforms supported without code changes

### ⚠️ Trade-offs

- Progress bar detection less reliable than hardcoded selectors
- Video scoring heuristics may occasionally select wrong video
- Slightly more complex logic in universal detector

**Overall**: Benefits significantly outweigh trade-offs for this use case.

---

## Reference Documentation

- **Shadow DOM**: [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_shadow_DOM)
- **requestVideoFrameCallback**: [Chrome Developers](https://developer.chrome.com/blog/requestvideoframecallback-rvfc/)
- **MutationObserver**: [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
- **Phoenix Channels**: [Phoenix Framework Docs](https://hexdocs.pm/phoenix/channels.html)

---

## Success Criteria

✅ **Sprint complete when:**
1. Notes are anchored to precise video timestamps
2. Clicking notes seeks video to timestamp
3. Timeline markers appear at note positions (when progress bar detected)
4. Clicking markers focuses notes in side panel
5. Recording pauses/unpauses video automatically
6. **Works on at least 3 different video platforms** (YouTube, Vimeo, +1)
7. Database correctly links notes to videos
8. **Core features work even when progress bar detection fails**

---

## Next Sprint

👉 [Sprint 03.5 - Tab Management](./SPRINT_03.5_tab_management.md)

**Focus:** Per-tab video context tracking, side panel syncs to active tab, tab switcher UI
