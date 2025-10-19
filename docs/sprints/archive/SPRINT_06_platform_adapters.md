# Sprint 06: Platform-Specific Video Adapters

**Status:** ✅ Completed
**Duration:** 3 days
**Completion Date:** October 19, 2025
**Priority:** High

---

## Goal

Refactor video detection and control into a plugin-based adapter architecture that cleanly separates universal fallback logic from platform-specific optimizations. Enable reliable video detection, timestamp capture, and timeline marker injection across any arbitrary video site/SPA.

---

## Current State Analysis

### Architecture Review

**Current Structure:**
```
extension/src/content/
├── universal.js                 # Main orchestrator (mixed concerns)
├── universal-video-detector.js  # Generic video detection
├── universal-progress-bar.js    # Progress bar finding (platform selectors mixed in)
├── universal-video-id.js        # Platform ID extraction (some platform logic)
├── video-controller.js          # Generic HTML5 video control
└── shared/
    ├── timeline-markers.js      # Timeline marker overlay
    └── anchor-chip.js           # Recording indicator
```

### Problems Identified

1. **Mixed Concerns**: Platform-specific selectors scattered throughout supposedly "universal" code
   - `UniversalProgressBar` has hardcoded `.ytp-progress-bar-container` for YouTube
   - `UniversalVideoId` has platform extraction but no platform-specific behaviors
   - No platform-specific handling for SPAs, custom video players, or non-standard controls

2. **Reliability Issues**:
   - Video detection works well on YouTube (heavily tested)
   - Fails or is unreliable on other platforms (Vimeo, Twitch, custom sites)
   - Progress bar detection fails on platforms with non-standard controls
   - Timeline marker injection depends on finding progress bar container

3. **Extensibility**:
   - Adding new platform support requires editing multiple "universal" files
   - No clear pattern for platform-specific overrides
   - Difficult to test platform-specific behaviors in isolation

4. **Code Organization**:
   - Platform logic mixed with universal fallback logic
   - Hard to see what's platform-specific vs. what's universal
   - Maintenance burden increases with each platform

---

## Proposed Architecture

### Plugin-Based Adapter Pattern

```
extension/src/content/
├── universal.js                      # Main orchestrator (no platform logic)
├── core/                             # Universal components
│   ├── video-detector.js             # Generic video detection (fallback)
│   ├── video-controller.js           # Generic HTML5 video control
│   ├── progress-bar-finder.js        # Generic progress bar heuristics
│   └── video-id-generator.js         # Generic URL-based ID generation
│
├── platforms/                        # Platform-specific adapters
│   ├── base-adapter.js               # Abstract base class
│   ├── index.js                      # Platform registry & loader
│   │
│   ├── youtube/                      # YouTube-specific
│   │   ├── youtube-adapter.js        # Main adapter implementation
│   │   ├── youtube-selectors.js      # DOM selectors
│   │   ├── youtube-video-id.js       # ID extraction
│   │   └── youtube-spa-hooks.js      # SPA navigation handling
│   │
│   ├── vimeo/                        # Vimeo-specific
│   │   ├── vimeo-adapter.js
│   │   ├── vimeo-selectors.js
│   │   └── vimeo-video-id.js
│   │
│   ├── twitch/                       # Twitch-specific
│   │   ├── twitch-adapter.js
│   │   ├── twitch-selectors.js
│   │   └── twitch-video-id.js
│   │
│   └── generic/                      # Generic fallback adapter
│       └── generic-adapter.js        # Uses core/* heuristics
│
└── shared/                           # UI components (no platform logic)
    ├── timeline-markers.js
    └── anchor-chip.js
```

### Adapter Interface

```javascript
/**
 * Base adapter class - all platform adapters extend this.
 */
export class BasePlatformAdapter {
  /**
   * Platform identifier (e.g., 'youtube', 'vimeo', 'twitch', 'generic')
   */
  static get platformId() {
    throw new Error('Must implement platformId');
  }

  /**
   * Check if this adapter can handle the current page.
   * @returns {boolean}
   */
  static canHandle() {
    throw new Error('Must implement canHandle()');
  }

  /**
   * Initialize the adapter.
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = options;
  }

  // Video Detection
  async detectVideo() {
    throw new Error('Must implement detectVideo()');
  }

  // Video ID Extraction
  extractVideoId(url = window.location.href) {
    throw new Error('Must implement extractVideoId()');
  }

  // Progress Bar Finding
  findProgressBar(videoElement) {
    throw new Error('Must implement findProgressBar()');
  }

  // Timeline Marker Injection Point
  findTimelineContainer(progressBar) {
    // Optional: some platforms need special container
    return progressBar; // Default: use progress bar as container
  }

  // SPA Navigation Hooks
  setupNavigationHooks(onNavigate) {
    // Optional: override for platform-specific SPA detection
    // Default: use History API interception
  }

  // Video Controller Customization
  createVideoController(videoElement) {
    // Optional: override for platform-specific controls
    return new VideoController(videoElement);
  }

  // Lifecycle
  destroy() {
    // Optional: cleanup platform-specific resources
  }
}
```

---

## Implementation Plan

### Phase 1: Refactor Core (1 day)

**Task 1.1: Extract Universal Logic**
- Move `UniversalVideoDetector` → `core/video-detector.js` (remove platform selectors)
- Move `UniversalProgressBar` → `core/progress-bar-finder.js` (remove platform selectors)
- Move `UniversalVideoId` → `core/video-id-generator.js` (URL hash only)
- Keep `VideoController` as-is (already universal)

**Task 1.2: Create Base Adapter**
- Implement `platforms/base-adapter.js` with interface above
- Create `platforms/index.js` for adapter registry

**Task 1.3: Create Generic Fallback Adapter**
- Implement `platforms/generic/generic-adapter.js`
- Use core heuristics (visual detection, pattern matching)
- This becomes the "unknown platform" handler

### Phase 2: YouTube Adapter (0.5 days)

**Task 2.1: Extract YouTube-Specific Logic**
- Create `platforms/youtube/youtube-adapter.js`
- Move YouTube selectors from universal code:
  - Progress bar: `.ytp-progress-bar-container`, `.ytp-progress-bar`
  - Video container: `#movie_player`
  - Player: `.html5-video-player`
- Implement YouTube video ID extraction
- Implement YouTube SPA hooks (`yt-navigate-finish` event)

**Task 2.2: YouTube Testing**
- Test regular videos
- Test YouTube Shorts
- Test embedded videos
- Test SPA navigation

### Phase 3: Additional Platform Adapters (1.5 days)

**Task 3.1: Frame.io Adapter**
- Video ID from URL path
- Selectors for Frame.io player controls
- Progress bar discovery
- Handle Frame.io's custom video player

**Task 3.2: Air.inc Adapter**
- Video ID from URL
- Selectors for Air player
- Progress bar discovery
- Handle Air's video interface

**Task 3.3: Future Platform Adapters** (Post-Sprint)
- Vimeo
- Twitch
- Netflix
- Coursera
- Udemy
- Loom

### Phase 4: Integration & Testing (1 day)

**Task 4.1: Update Main Orchestrator**
- Modify `universal.js` to use adapter pattern:
  ```javascript
  import { PlatformRegistry } from './platforms/index.js';

  async function init() {
    // Detect platform and load appropriate adapter
    const adapter = await PlatformRegistry.getAdapter();
    console.log('[Lossy] Using adapter:', adapter.constructor.platformId);

    // Use adapter for all operations
    const videoElement = await adapter.detectVideo();
    const videoId = adapter.extractVideoId();
    const progressBar = adapter.findProgressBar(videoElement);

    // ...rest of init
  }
  ```

**Task 4.2: Fallback Chain**
- Try platform-specific adapter first
- Fall back to generic adapter if platform adapter fails
- Log adapter selection and fallback events

**Task 4.3: Testing Matrix**
- Test on YouTube (primary use case)
- Test on Vimeo
- Test on Twitch
- Test on arbitrary video site (e.g., personal blog with HTML5 video)
- Test SPA navigation on each platform
- Verify timeline markers work on each platform

---

## Detailed Component Specs

### Platform Registry

```javascript
// platforms/index.js
export class PlatformRegistry {
  static adapters = [
    YouTubeAdapter,
    VimeoAdapter,
    TwitchAdapter,
    // ... more platforms
    GenericAdapter // Always last (catch-all)
  ];

  /**
   * Get the appropriate adapter for current page.
   * Returns first adapter where canHandle() returns true.
   */
  static async getAdapter() {
    for (const AdapterClass of this.adapters) {
      if (AdapterClass.canHandle()) {
        console.log('[PlatformRegistry] Selected:', AdapterClass.platformId);
        return new AdapterClass();
      }
    }

    // Should never reach here (GenericAdapter always matches)
    console.warn('[PlatformRegistry] No adapter found, using Generic');
    return new GenericAdapter();
  }
}
```

### YouTube Adapter Example

```javascript
// platforms/youtube/youtube-adapter.js
import { BasePlatformAdapter } from '../base-adapter.js';
import { YouTubeSelectors } from './youtube-selectors.js';
import { YouTubeVideoId } from './youtube-video-id.js';
import { YouTubeSpaHooks } from './youtube-spa-hooks.js';

export class YouTubeAdapter extends BasePlatformAdapter {
  static get platformId() {
    return 'youtube';
  }

  static canHandle() {
    const hostname = window.location.hostname;
    return hostname.includes('youtube.com') || hostname.includes('youtu.be');
  }

  async detectVideo() {
    // Try platform-specific selectors first
    let video = document.querySelector(YouTubeSelectors.VIDEO);
    if (video) return video;

    // Fallback to generic detection
    const videos = document.querySelectorAll('video');
    if (videos.length === 1) return videos[0];

    // Score videos by heuristics
    return this.selectBestVideo(videos);
  }

  extractVideoId(url = window.location.href) {
    return YouTubeVideoId.extract(url);
  }

  findProgressBar(videoElement) {
    // Try YouTube-specific selectors
    for (const selector of YouTubeSelectors.PROGRESS_BAR) {
      const el = document.querySelector(selector);
      if (el) return el;
    }

    // Fallback to generic
    return super.findProgressBar(videoElement);
  }

  setupNavigationHooks(onNavigate) {
    return YouTubeSpaHooks.setup(onNavigate);
  }
}
```

### Selectors Module Example

```javascript
// platforms/youtube/youtube-selectors.js
export const YouTubeSelectors = {
  VIDEO: '#movie_player video',

  PROGRESS_BAR: [
    '.ytp-progress-bar-container',
    '.ytp-progress-bar',
  ],

  PLAYER_CONTAINER: [
    '#movie_player',
    '.html5-video-player',
  ],

  CONTROLS: [
    '.ytp-chrome-bottom',
  ],
};
```

---

## Benefits

### Clear Separation of Concerns
- Universal logic in `core/`
- Platform-specific logic in `platforms/[platform]/`
- Easy to see what's general vs. specific

### Extensibility
- Adding new platform = create new `platforms/[platform]/` folder
- No need to modify existing universal code
- Platform adapters can be developed and tested independently

### Reliability
- Platform-specific optimizations for reliable detection
- Graceful fallback to generic adapter
- Each platform can handle its own quirks (SPA navigation, custom players)

### Maintainability
- Each adapter is self-contained
- Changes to one platform don't affect others
- Easy to add/remove platforms

### Testing
- Test platform adapters in isolation
- Mock adapter interface for unit tests
- Test fallback chain

---

## Migration Strategy

1. **Direct Refactor**: Move directly to new adapter architecture (no backward compatibility needed)
2. **Incremental Implementation**:
   - Phase 1: Refactor core + base adapter infrastructure
   - Phase 2: Add YouTube adapter (extract existing YouTube logic)
   - Phase 3: Add Frame.io and Air.inc adapters (new functionality)
3. **Testing**: Test YouTube thoroughly after Phase 2 before adding new platforms
4. **Git Commits**: Commit per phase for easy rollback if needed

---

## Success Criteria

✅ **Architecture**
- Clear separation: universal code in `core/`, platform code in `platforms/`
- All platforms extend `BasePlatformAdapter`
- Platform registry selects appropriate adapter

✅ **YouTube** (Existing Functionality)
- Video detection works reliably
- Timeline markers appear consistently
- SPA navigation handled properly
- No regression from current behavior

✅ **New Platforms**
- Frame.io: video detection + timeline markers working
- Air.inc: video detection + timeline markers working
- Generic sites: basic video detection working (may not have timeline markers)

✅ **Fallback**
- Unknown platforms gracefully fall back to generic adapter
- Partial failures (e.g., no progress bar found) don't break entire extension

✅ **Code Quality**
- No platform-specific code in universal files
- Each platform adapter is <200 lines
- Easy to add new platform (create folder, implement interface)

---

## Generic Adapter Compatibility

The generic adapter uses pure heuristics (video element detection, progress bar pattern matching) and works well on many platforms without requiring a dedicated adapter. This is a list of platforms that have been tested and confirmed to work with the generic adapter:

### Confirmed Working
- **Dropbox** (dropbox.com) - Standard HTML5 video playback
- **Dropbox Replay** (replay.dropbox.com) - Video review platform with timeline markers
- **Filestage** (app.filestage.io) - Video review and approval platform with timeline markers
- **Krock** (krock.io) - Video review and approval platform with timeline markers
- **ReviewStudio** (reviewstudio.com) - Video review and approval platform with timeline markers
- **Ziflow** (ziflow.io) - Video review and approval platform with timeline markers

### Testing Notes
- Generic adapter successfully detects video elements using visual heuristics
- Progress bar detection works when platforms use standard HTML5 controls or detectable progress bar patterns
- Timeline markers may or may not appear depending on progress bar availability
- Platforms with custom video players or non-standard controls may require dedicated adapters

### When to Create a Dedicated Adapter
Consider creating a platform-specific adapter when:
- Video detection fails or is unreliable with generic heuristics
- Platform uses non-standard video controls or custom players
- Need platform-specific features (e.g., extracting platform video IDs, SPA navigation hooks)
- Timeline marker injection requires special container or positioning logic

## Platform-Specific Adapters

### TikTok (tiktok.com)
- **Status**: ✅ Fully Working
- **Implementation**: Dedicated adapter with aggressive z-index and overflow fixes
- **Key Features**:
  - TikTok-specific DOM selectors for CSS-in-JS class names (DivSeekBarContainer, DivVideoSwiperControlContainer)
  - Video ID extraction from `/video/[ID]` URLs
  - Multi-level parent container overflow fixes (walks up 5 levels)
  - Shadow DOM style injection for marker visibility
  - Ultra-high z-index (999999) to overcome TikTok's complex UI layering
  - MutationObserver to watch for marker container creation
- **Challenges Solved**: TikTok's CSS-in-JS with dynamic class names, complex z-index stacking, CSS containment clipping
- **Commit**: `eca51e2`

### Iconik (iconik.io)
- **Status**: Partial - Timeline markers visible but partially clipped
- **Known Limitation**: Markers are clipped at edges due to Iconik's CSS containment hierarchy that cannot be fully overridden from the adapter level
- **Workaround Attempted**: Setting `overflow-y: visible !important` on progress bar and parent containers
- **Potential Fix**: Portal pattern (attach markers to `document.body` with fixed positioning) would require changes to shared `TimelineMarkers` class
- **Current Functionality**: Video detection works, progress bar found, markers are positioned correctly but may be clipped at top/bottom edges

---

## Sprint Completion Summary

**Completed:** October 19, 2025
**Duration:** 3 days

### Delivered
✅ **Core Architecture**
- Plugin-based adapter pattern with `BasePlatformAdapter` interface
- Platform registry for automatic adapter selection
- Separation of universal (`core/`) and platform-specific (`platforms/`) code

✅ **Platform Adapters Implemented**
- YouTube (video detection, SPA hooks, timeline markers)
- Frame.io (custom video player support)
- Vimeo (timeline positioning fixes)
- Air.inc (overflow visibility fixes)
- Wipster (heuristic-based progress bar detection)
- Iconik (multi-view support with partial marker clipping)
- **TikTok (full support with aggressive visibility fixes)**
- Generic fallback adapter (works on most HTML5 video sites)

✅ **Generic Adapter Compatibility**
- Confirmed working on: Dropbox, Dropbox Replay, Filestage, Krock, ReviewStudio, Ziflow
- Robust fallback for unknown platforms

### Key Achievements
- **Clean Architecture**: Platform-specific code isolated in separate adapters
- **Extensibility**: New platforms can be added without modifying core code
- **Reliability**: Platform-specific optimizations + generic fallback
- **TikTok Support**: Solved complex CSS-in-JS and z-index stacking challenges

### Lessons Learned
- Z-index alone isn't sufficient for complex platforms - need multi-level overflow fixes
- CSS-in-JS platforms require pattern matching on class name fragments
- Shadow DOM style injection necessary for isolated marker visibility
- MutationObserver pattern effective for dynamic marker container creation

### Technical Debt
- Iconik markers still partially clipped (would require portal pattern in shared TimelineMarkers)
- Some adapters could benefit from more specific selectors as platforms evolve

---

## Future Enhancements (Post-Sprint)

- **Platform Auto-Detection Improvements**: ML-based video element scoring
- **Community Adapters**: Plugin system for user-contributed platform adapters
- **Adapter Configuration**: User preferences per platform (e.g., disable timeline markers on certain sites)
- **Performance Metrics**: Track adapter success rates, detection times
- **Platform Marketplace**: Share/discover community-built platform adapters

---

## Dependencies

**Before Sprint:**
- ✅ Sprint 03 (Video Integration) complete
- ✅ Sprint 04 (Tab Management) complete

**After Sprint:**
- Sprint 07: Auto-Posting (will use platform adapters for posting logic)
- Sprint 09: Polish (may add more platforms)

---

## References

### Research Findings

**Cross-Platform Patterns:**
- Strategy Pattern for platform-specific behavior
- Adapter Pattern for unifying different platform APIs
- Registry Pattern for dynamic adapter selection
- Fallback Chain for graceful degradation

**Examples from Other Projects:**
- [openpnp-capture](https://github.com/openpnp/openpnp-capture): Platform-specific adapters for DirectShow/V4L2/AVFoundation
- Mozilla WebExtensions: Platform-specific modules with standardized API
- VidGear: Extensible multi-threaded APIs for device-specific streams

**Best Practices:**
- Separate platform-specific modules rather than abstractions
- Make all methods async (easy to wrap sync, hard to unwrap async)
- Use composition over inheritance where possible
- Keep platform adapters stateless when possible

---

## Notes

- This sprint focuses on **architecture and infrastructure**
- YouTube adapter is mostly **extracting existing logic** (not new features)
- Additional platform adapters add **new functionality**
- Generic adapter provides **safety net** for unknown platforms
- Future sprints can add more platforms **without touching core code**
