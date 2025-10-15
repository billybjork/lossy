# Sprint 03: Video Integration & On-Page Overlays

**Status:** ⏳ Planned
**Estimated Duration:** 2-3 days

---

## Goal

Connect notes to specific videos and timestamps. Content script detects video players across platforms (YouTube, Vimeo, Air), extracts video metadata, captures precise timestamps, and displays on-page visual feedback (anchor chips, ghost comments).

---

## Prerequisites

- ✅ Sprint 02 complete (transcription & note structuring working)
- ⏳ Test videos on YouTube, Vimeo, and Air
- ⏳ AgentSession GenServer running

---

## Deliverables

- [ ] Content script detects video player on supported platforms
- [ ] Extract video ID, platform, URL, current timestamp
- [ ] Videos table created with platform-specific IDs
- [ ] Notes linked to video records via foreign key
- [ ] Timestamp captured when recording starts
- [ ] On-page anchor chip shows recording timestamp
- [ ] Ghost comment preview cards (optional for sprint)
- [ ] Shadow DOM isolates overlay styles from page

---

## Technical Tasks

### Task 1: Content Script Setup

#### 1.1 Manifest Configuration

**File:** `extension/manifest.json` (update)

```json
{
  "manifest_version": 3,
  "name": "Voice Video Companion",
  "version": "0.1.0",

  "permissions": ["sidePanel", "storage", "tabs", "offscreen"],

  "content_scripts": [
    {
      "matches": [
        "*://*.youtube.com/*",
        "*://*.youtu.be/*"
      ],
      "js": ["content/youtube.js"],
      "css": ["content/overlays.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["*://*.vimeo.com/*"],
      "js": ["content/vimeo.js"],
      "css": ["content/overlays.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["*://*.air.inc/*"],
      "js": ["content/air.js"],
      "css": ["content/overlays.css"],
      "run_at": "document_idle"
    }
  ],

  "web_accessible_resources": [
    {
      "resources": ["content/anchor-chip.html", "content/ghost-card.html"],
      "matches": ["<all_urls>"]
    }
  ],

  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:4000 wss://localhost:4000"
  }
}
```

#### 1.2 Platform Detection Module

**File:** `extension/src/content/shared/platform-detector.js` (new)

```javascript
/**
 * Platform-agnostic video detection utilities.
 * Each platform has specific selectors and URL patterns.
 */

export class PlatformDetector {
  static detectPlatform(url) {
    const hostname = new URL(url).hostname;

    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return 'youtube';
    } else if (hostname.includes('vimeo.com')) {
      return 'vimeo';
    } else if (hostname.includes('air.inc')) {
      return 'air';
    }

    return null;
  }

  static extractVideoId(url, platform) {
    switch (platform) {
      case 'youtube':
        return this.extractYouTubeId(url);
      case 'vimeo':
        return this.extractVimeoId(url);
      case 'air':
        return this.extractAirId(url);
      default:
        return null;
    }
  }

  static extractYouTubeId(url) {
    const urlObj = new URL(url);

    // Standard watch URL: youtube.com/watch?v=VIDEO_ID
    const vParam = urlObj.searchParams.get('v');
    if (vParam) return vParam;

    // Short URL: youtu.be/VIDEO_ID
    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1).split('?')[0];
    }

    // Shorts: youtube.com/shorts/VIDEO_ID
    const shortsMatch = urlObj.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];

    // Embed: youtube.com/embed/VIDEO_ID
    const embedMatch = urlObj.pathname.match(/^\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];

    return null;
  }

  static extractVimeoId(url) {
    const urlObj = new URL(url);

    // Standard URL: vimeo.com/123456789
    const match = urlObj.pathname.match(/^\/(\d+)/);
    if (match) return match[1];

    // Unlisted: vimeo.com/123456789/HASH
    const unlistedMatch = urlObj.pathname.match(/^\/(\d+)\/[a-f0-9]+/);
    if (unlistedMatch) return unlistedMatch[1];

    return null;
  }

  static extractAirId(url) {
    const urlObj = new URL(url);

    // Air URL: air.inc/workspace/VIDEO_ID
    const match = urlObj.pathname.match(/\/([^/]+)$/);
    if (match) return match[1];

    return null;
  }
}
```

#### 1.3 Video Element Finder

**File:** `extension/src/content/shared/video-finder.js` (new)

```javascript
/**
 * Platform-specific video element detection.
 * Waits for video element to load, handles SPAs.
 */

export class VideoFinder {
  constructor(platform) {
    this.platform = platform;
    this.videoElement = null;
    this.observer = null;
  }

  async findVideo() {
    switch (this.platform) {
      case 'youtube':
        return this.findYouTubeVideo();
      case 'vimeo':
        return this.findVimeoVideo();
      case 'air':
        return this.findAirVideo();
      default:
        return null;
    }
  }

  async findYouTubeVideo() {
    // YouTube uses #movie_player container
    const selector = '#movie_player video';

    // Try immediate query
    let video = document.querySelector(selector);
    if (video) {
      this.videoElement = video;
      return video;
    }

    // Wait for SPA navigation
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        video = document.querySelector(selector);
        if (video) {
          observer.disconnect();
          this.videoElement = video;
          resolve(video);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 10000);
    });
  }

  async findVimeoVideo() {
    // Vimeo uses iframe embed or native player
    const iframeSelector = 'iframe[src*="player.vimeo.com"]';
    const videoSelector = 'video';

    let iframe = document.querySelector(iframeSelector);
    if (iframe) {
      // For iframe embeds, we can't access the video element directly
      // Instead, we'll use Vimeo Player API
      return { type: 'iframe', element: iframe };
    }

    let video = document.querySelector(videoSelector);
    if (video) {
      this.videoElement = video;
      return video;
    }

    // Wait for load
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        video = document.querySelector(videoSelector);
        if (video) {
          observer.disconnect();
          this.videoElement = video;
          resolve(video);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 10000);
    });
  }

  async findAirVideo() {
    // Air uses custom video player
    const selector = 'video';

    let video = document.querySelector(selector);
    if (video) {
      this.videoElement = video;
      return video;
    }

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        video = document.querySelector(selector);
        if (video) {
          observer.disconnect();
          this.videoElement = video;
          resolve(video);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 10000);
    });
  }

  getCurrentTime() {
    if (!this.videoElement) return null;

    // Use requestVideoFrameCallback for precise timestamp (Chrome 83+)
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      return new Promise((resolve) => {
        this.videoElement.requestVideoFrameCallback((now, metadata) => {
          resolve(metadata.mediaTime);
        });
      });
    }

    // Fallback to currentTime property
    return Promise.resolve(this.videoElement.currentTime);
  }

  pauseVideo() {
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();
    }
  }

  playVideo() {
    if (this.videoElement && this.videoElement.paused) {
      this.videoElement.play();
    }
  }

  seekTo(timestamp) {
    if (this.videoElement) {
      this.videoElement.currentTime = timestamp;
    }
  }
}
```

#### 1.4 YouTube Content Script

**File:** `extension/src/content/youtube.js` (new)

```javascript
import { PlatformDetector } from './shared/platform-detector.js';
import { VideoFinder } from './shared/video-finder.js';
import { AnchorChip } from './shared/anchor-chip.js';

console.log('YouTube content script loaded');

let videoFinder = null;
let currentVideoId = null;
let anchorChip = null;

async function init() {
  const platform = PlatformDetector.detectPlatform(window.location.href);
  if (platform !== 'youtube') return;

  const videoId = PlatformDetector.extractVideoId(window.location.href, platform);
  if (!videoId) {
    console.warn('Could not extract YouTube video ID');
    return;
  }

  currentVideoId = videoId;
  console.log('YouTube video detected:', videoId);

  // Find video element
  videoFinder = new VideoFinder('youtube');
  const videoElement = await videoFinder.findVideo();

  if (!videoElement) {
    console.warn('Could not find YouTube video element');
    return;
  }

  console.log('YouTube video element found');

  // Send video context to service worker
  chrome.runtime.sendMessage({
    action: 'video_detected',
    data: {
      platform: 'youtube',
      videoId: videoId,
      url: window.location.href,
      title: document.title
    }
  });

  // Set up anchor chip overlay
  setupAnchorChip(videoElement);

  // Listen for recording events
  listenForRecordingEvents();
}

function setupAnchorChip(videoElement) {
  // Create anchor chip (hidden initially)
  anchorChip = new AnchorChip(videoElement);
  anchorChip.hide();
}

function listenForRecordingEvents() {
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === 'recording_started') {
      // Get precise timestamp
      const timestamp = await videoFinder.getCurrentTime();

      console.log('Recording started at timestamp:', timestamp);

      // Pause video
      videoFinder.pauseVideo();

      // Show anchor chip
      if (anchorChip) {
        anchorChip.show(timestamp);
      }

      // Send timestamp to service worker
      chrome.runtime.sendMessage({
        action: 'timestamp_captured',
        data: {
          videoId: currentVideoId,
          timestamp: timestamp
        }
      });
    }

    if (message.action === 'recording_stopped') {
      // Resume video
      videoFinder.playVideo();

      // Hide anchor chip
      if (anchorChip) {
        anchorChip.hide();
      }
    }

    if (message.action === 'seek_to') {
      // Seek video to timestamp (from side panel click)
      videoFinder.seekTo(message.timestamp);
      videoFinder.playVideo();
    }
  });
}

// Handle YouTube SPA navigation
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    console.log('YouTube navigation detected, reinitializing...');
    init();
  }
}).observe(document, { subtree: true, childList: true });

// Initial load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

---

### Task 2: Anchor Chip Overlay (Shadow DOM)

**File:** `extension/src/content/shared/anchor-chip.js` (new)

```javascript
/**
 * Anchor chip overlay - shows timestamp when recording starts.
 * Uses Shadow DOM to isolate styles from page.
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
    this.container.id = 'lossy-anchor-chip-container';

    // Position absolutely over video
    this.container.style.position = 'absolute';
    this.container.style.top = '20px';
    this.container.style.left = '20px';
    this.container.style.zIndex = '9999';
    this.container.style.pointerEvents = 'none';

    // Attach shadow DOM for style isolation
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });

    // Create anchor chip content
    this.shadowRoot.innerHTML = `
      <style>
        .anchor-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          background: rgba(220, 38, 38, 0.95);
          color: white;
          border-radius: 24px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }

        .anchor-chip-icon {
          width: 16px;
          height: 16px;
          background: white;
          border-radius: 50%;
          animation: ping 2s infinite;
        }

        @keyframes ping {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.2); }
        }

        .anchor-chip-time {
          font-variant-numeric: tabular-nums;
        }
      </style>

      <div class="anchor-chip">
        <div class="anchor-chip-icon"></div>
        <span class="anchor-chip-time" id="timestamp">0:00</span>
      </div>
    `;

    // Find video container and append
    const videoContainer = this.videoElement.parentElement;
    if (videoContainer) {
      // Position relative to video container
      const rect = this.videoElement.getBoundingClientRect();
      this.container.style.position = 'fixed';
      this.container.style.top = `${rect.top + 20}px`;
      this.container.style.left = `${rect.left + 20}px`;

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
    // Re-append to fullscreen element when entering fullscreen
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

### Task 3: Service Worker Video Context

**File:** `extension/src/background/service-worker.js` (update)

```javascript
// ... existing code ...

let currentVideo = null;
let currentTimestamp = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  // NEW: Handle video detected event
  if (message.action === 'video_detected') {
    currentVideo = message.data;
    console.log('Video detected:', currentVideo);

    // Send to backend to create/find video record
    if (socket && socket.isConnected()) {
      const videoChannel = socket.channel('video:meta', {});
      videoChannel.join()
        .receive('ok', () => {
          videoChannel.push('video_detected', currentVideo)
            .receive('ok', (response) => {
              console.log('Video record created/found:', response);
              currentVideo.id = response.video_id;
            });
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // NEW: Handle timestamp captured event
  if (message.action === 'timestamp_captured') {
    currentTimestamp = message.data.timestamp;
    console.log('Timestamp captured:', currentTimestamp);
    sendResponse({ success: true });
    return false;
  }
});

// Update startRecording to include video context
async function startRecording() {
  console.log('Starting recording...');

  // Notify content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'recording_started' })
      .catch((err) => console.log('No content script listening:', err));
  }

  // ... rest of existing startRecording code ...

  // Pass video context to AgentSession
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {
    video_id: currentVideo?.id,
    timestamp: currentTimestamp
  });

  // ... rest of channel setup ...
}

async function stopRecording() {
  console.log('Stopping recording...');

  // Notify content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'recording_stopped' })
      .catch((err) => console.log('No content script listening:', err));
  }

  // ... rest of existing stopRecording code ...
}
```

---

### Task 4: Backend Video Channel

**File:** `lib/lossy_web/channels/video_channel.ex` (new)

```elixir
defmodule LossyWeb.VideoChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Videos

  @impl true
  def join("video:meta", _payload, socket) do
    Logger.info("Video metadata channel joined")
    {:ok, socket}
  end

  @impl true
  def handle_in("video_detected", %{"platform" => platform, "videoId" => video_id} = payload, socket) do
    Logger.info("Video detected: #{platform}/#{video_id}")

    url = Map.get(payload, "url")
    title = Map.get(payload, "title")

    # Find or create video record
    case Videos.find_or_create_video(%{
      platform: platform,
      platform_video_id: video_id,
      url: url,
      title: title
    }) do
      {:ok, video} ->
        {:reply, {:ok, %{video_id: video.id}}, socket}

      {:error, changeset} ->
        Logger.error("Failed to create video: #{inspect(changeset)}")
        {:reply, {:error, %{message: "Failed to create video"}}, socket}
    end
  end
end
```

**File:** `lib/lossy_web/user_socket.ex` (update)

```elixir
defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  # Channels
  channel "audio:*", LossyWeb.AudioChannel
  channel "video:*", LossyWeb.VideoChannel  # Add this line

  @impl true
  def connect(_params, socket, _connect_info) do
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
```

---

### Task 5: Update AgentSession with Video Context

**File:** `lib/lossy/agent/session.ex` (update)

```elixir
defmodule Lossy.Agent.Session do
  # ... existing code ...

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.get(opts, :user_id)
    video_id = Keyword.get(opts, :video_id)  # Now passed from channel join
    timestamp = Keyword.get(opts, :timestamp)  # Timestamp when recording started

    state = %{
      session_id: session_id,
      user_id: user_id,
      video_id: video_id,
      timestamp_seconds: timestamp,  # NEW
      status: :idle,
      audio_buffer: <<>>,
      audio_duration: 0,
      started_at: nil,
      last_transition: DateTime.utc_now()
    }

    Logger.info("AgentSession started: #{session_id}, video_id: #{video_id}, timestamp: #{timestamp}")
    {:ok, state}
  end

  # Update structure_note to include video_id and timestamp
  defp structure_note(state, transcript_text) do
    case Cloud.structure_note(transcript_text) do
      {:ok, structured_note} ->
        Logger.info("[#{state.session_id}] Note structured: #{inspect(structured_note)}")

        # Store in database with video context
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

        # ... rest of existing code ...
    end
  end
end
```

**File:** `lib/lossy_web/channels/audio_channel.ex` (update join)

```elixir
@impl true
def join("audio:" <> session_id, payload, socket) do
  Logger.info("Audio channel joined: #{session_id}")

  video_id = Map.get(payload, "video_id")
  timestamp = Map.get(payload, "timestamp")

  # Start AgentSession with video context
  case SessionSupervisor.start_session(session_id, video_id: video_id, timestamp: timestamp) do
    {:ok, _pid} ->
      Logger.info("Started new AgentSession: #{session_id} (video: #{video_id}, timestamp: #{timestamp})")

    {:error, {:already_started, _pid}} ->
      Logger.info("AgentSession already running: #{session_id}")

    {:error, reason} ->
      Logger.error("Failed to start AgentSession: #{inspect(reason)}")
  end

  {:ok, assign(socket, :session_id, session_id)}
end
```

---

## Database Schema Updates

The `videos` table was already created in Sprint 02's migration (`create_videos_and_notes`), so no additional migration needed. The foreign key relationship between `notes.video_id → videos.id` is already established.

**Verify migration includes:**
- ✅ `videos` table with platform, platform_video_id, url
- ✅ `notes` table with `video_id` foreign key
- ✅ `timestamp_seconds` field on notes

---

## Testing Checklist

### Content Script Tests

- [ ] Load YouTube video, check console: "YouTube video detected: VIDEO_ID"
- [ ] Load Vimeo video, check console: "Vimeo video detected: VIDEO_ID"
- [ ] Load Air video, check console: "Air video detected: VIDEO_ID"
- [ ] Click record → video pauses, anchor chip appears
- [ ] Anchor chip shows correct timestamp (e.g., "2:35")
- [ ] Stop recording → video resumes, anchor chip disappears
- [ ] YouTube navigation (SPA) → content script reinitializes

### Backend Tests

- [ ] Video detected event creates video record in database
- [ ] Duplicate video detection works (same platform + video_id)
- [ ] Notes correctly linked to video via foreign key
- [ ] Timestamp saved accurately in notes table

### Integration Tests

- [ ] Record note at 1:30 → note has timestamp_seconds: 90.0
- [ ] Click note in side panel → content script seeks to 1:30
- [ ] Multiple notes on same video → all linked to same video record
- [ ] Fullscreen mode → anchor chip repositions correctly

---

## Platform-Specific Notes

### YouTube
- Uses SPA navigation (needs MutationObserver)
- Video element inside `#movie_player`
- URL formats: `/watch?v=ID`, `/shorts/ID`, `youtu.be/ID`

### Vimeo
- Can be iframe embed or native player
- For iframes, may need Vimeo Player API (future enhancement)
- URL format: `vimeo.com/123456789`

### Air
- Custom video player
- URL format: `air.inc/workspace/VIDEO_ID`
- Need to test against actual Air videos

---

## Known Limitations

1. **Vimeo iframe embeds**: Cannot access video element directly, need Vimeo Player API
2. **Shadow DOM compatibility**: Only works in modern browsers (Chrome 53+, Firefox 63+)
3. **Fullscreen handling**: May need per-platform adjustments
4. **Private/unlisted videos**: May not extract metadata correctly

These will be addressed in future sprints as needed.

---

## Reference Documentation

- **Shadow DOM**: For style isolation in overlays
- **requestVideoFrameCallback**: For precise timestamps (Chrome 83+)
- **MutationObserver**: For SPA navigation detection
- **TECHNICAL_REFERENCES.md**: Frame capture patterns (for future emoji chips)

---

## Next Sprint

👉 [Sprint 04 - Auto-Posting](./SPRINT_04_auto_posting.md)

**Focus:** Browserbase automation to post notes as comments on video platforms
