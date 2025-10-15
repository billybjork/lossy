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
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'recording_started') {
      // Handle async operation properly
      videoController.getCurrentTime().then(timestamp => {
        console.log('[Lossy] Recording started at timestamp:', timestamp);

        videoController.pause();

        if (anchorChip) {
          anchorChip.show(timestamp);
        }

        // Store timestamp globally for later use
        chrome.runtime.sendMessage({
          action: 'timestamp_captured',
          data: {
            videoId: currentVideoId,
            videoDbId: currentVideoDbId,
            timestamp: timestamp
          }
        });

        // Return timestamp directly in response
        sendResponse({ success: true, timestamp: timestamp });
      }).catch(err => {
        console.error('[Lossy] Error getting timestamp:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async response
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

    if (message.action === 'get_current_timestamp') {
      console.log('[Lossy] get_current_timestamp request received, videoController:', videoController);
      if (videoController) {
        videoController.getCurrentTime().then(timestamp => {
          console.log('[Lossy] Sending timestamp:', timestamp);
          sendResponse({ timestamp: timestamp });
        }).catch(err => {
          console.error('[Lossy] Error getting timestamp:', err);
          sendResponse({ timestamp: null });
        });
      } else {
        console.log('[Lossy] No videoController, sending null');
        sendResponse({ timestamp: null });
      }
      return true; // Will respond asynchronously
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
