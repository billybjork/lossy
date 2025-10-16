import './platforms/bootstrap.js'; // Register all adapters
import { PlatformRegistry } from './platforms/index.js';
import { AnchorChip } from './shared/anchor-chip.js';
import { TimelineMarkers } from './shared/timeline-markers.js';

console.log('[Lossy] Universal content script loaded');

let adapter = null;
let videoController = null;
let currentVideoId = null;
let currentVideoDbId = null;
let anchorChip = null;
let timelineMarkers = null;
let currentUrl = window.location.href;
let isInitializing = false;
let historyIntercepted = false;
let pendingNotesForMarkers = null;
let markerWatchdogTimer = null;
let spaCleanup = null; // Platform-specific SPA navigation cleanup

async function init() {
  // Prevent multiple simultaneous initializations
  if (isInitializing) {
    console.log('[Lossy] ⚠️ INIT: Already initializing, skipping...');
    return;
  }

  isInitializing = true;
  console.log('[Lossy] 🔵 INIT: Starting initialization for URL:', window.location.href);

  // Tell side panel to clear old notes (we're loading a fresh video)
  console.log('[Lossy] 🔵 INIT: Sending clear_ui to side panel');
  chrome.runtime.sendMessage({
    action: 'clear_ui'
  }).catch(() => {
    console.log('[Lossy] 🔵 INIT: Side panel not available for clear_ui');
  });

  // Get appropriate adapter for current page
  try {
    adapter = await PlatformRegistry.getAdapter();
    console.log('[Lossy] 🔵 INIT: Using adapter:', adapter.constructor.platformId);
  } catch (error) {
    console.error('[Lossy] ❌ INIT: Failed to get adapter:', error);
    isInitializing = false;
    return;
  }

  // Detect video using adapter
  const videoElement = await adapter.detectVideo();

  if (!videoElement) {
    console.warn('[Lossy] ⚠️ INIT: No video element found on this page');
    isInitializing = false;
    return;
  }

  console.log('[Lossy] 🔵 INIT: Video element found:', videoElement);

  // Extract video ID using adapter
  const videoIdData = adapter.extractVideoId(window.location.href);
  currentVideoId = videoIdData.id;

  console.log('[Lossy] 🔵 INIT: Video ID:', videoIdData);

  // Create video controller using adapter
  videoController = adapter.createVideoController(videoElement);

  // Send video context to service worker
  console.log('[Lossy] 🔵 INIT: Sending video_detected to service worker');
  const response = await chrome.runtime.sendMessage({
    action: 'video_detected',
    data: {
      platform: videoIdData.platform,
      videoId: videoIdData.id,
      url: window.location.href,
      title: document.title
    }
  }).catch(err => {
    console.warn('[Lossy] ⚠️ INIT: Could not send video_detected message:', err);
    return null;
  });

  if (response?.videoDbId) {
    currentVideoDbId = response.videoDbId;
    console.log('[Lossy] 🔵 INIT: Video database ID:', currentVideoDbId);
  } else {
    console.warn('[Lossy] ⚠️ INIT: No videoDbId in response');
  }

  // Set up overlays
  setupAnchorChip(videoElement);

  // Listen for events (before setup so we can receive messages)
  listenForEvents();

  // Set up timeline markers (may retry if progress bar not found)
  setupTimelineMarkers(videoElement);

  // Watch for video changes using adapter
  adapter.watchForChanges((newVideo) => {
    console.log('[Lossy] 🔄 Video element changed, reinitializing...');
    debouncedReinit();
  });

  // Set up platform-specific SPA navigation hooks
  spaCleanup = adapter.setupNavigationHooks(() => {
    console.log('[Lossy] 🔄 Platform SPA navigation detected, reinitializing...');
    debouncedReinit();
  });

  // Watch for URL changes (generic History API interception)
  if (!historyIntercepted) {
    interceptHistoryApi();
    historyIntercepted = true;
  }

  isInitializing = false;
  console.log('[Lossy] 🔵 INIT: Initialization complete');
}

// Debounce reinitialization to prevent rapid sequential calls
let reinitTimer = null;
function debouncedReinit() {
  if (reinitTimer) {
    clearTimeout(reinitTimer);
  }

  reinitTimer = setTimeout(() => {
    cleanup();
    init();
  }, 300); // 300ms debounce
}

/**
 * Intercept History API to detect URL changes efficiently.
 * This is better than polling and catches YouTube's pushState navigation.
 */
function interceptHistoryApi() {
  currentUrl = window.location.href;

  // Intercept pushState
  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    checkUrlChange();
  };

  // Intercept replaceState
  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    checkUrlChange();
  };

  // Also listen for popstate (back/forward buttons)
  window.addEventListener('popstate', checkUrlChange);

  console.log('[Lossy] 🔵 INIT: History API intercepted for URL monitoring');
}

function checkUrlChange() {
  const newUrl = window.location.href;
  if (newUrl !== currentUrl) {
    console.log('[Lossy] 🔄 URL CHANGED:', currentUrl, '→', newUrl);
    currentUrl = newUrl;
    debouncedReinit();
  }
}

function setupAnchorChip(videoElement) {
  // Get platform-specific anchor container from adapter
  const anchorContainer = adapter.getAnchorChipContainer(videoElement);
  anchorChip = new AnchorChip(videoElement, anchorContainer);
  anchorChip.hide();
}

/**
 * Load markers from notes array.
 * Extracted to a function so it can be called from retry logic.
 */
function loadMarkersFromNotes(notes) {
  if (!timelineMarkers) {
    console.error('[Lossy] ❌ Cannot load markers, timeline markers not initialized');
    return false;
  }

  if (!notes || notes.length === 0) {
    console.log('[Lossy] ℹ️ No notes to load');
    return true;
  }

  let queued = 0;
  let added = 0;
  let skipped = 0;

  notes.forEach(note => {
    if (note.timestamp_seconds != null) {
      const hadPending = timelineMarkers.pendingMarkers.length;
      timelineMarkers.addMarker({
        id: note.id,
        timestamp: note.timestamp_seconds,
        category: note.category,
        text: note.text
      });
      const nowPending = timelineMarkers.pendingMarkers.length;

      if (nowPending > hadPending) {
        queued++;
      } else if (timelineMarkers.markers.has(note.id)) {
        added++;
      } else {
        skipped++;
      }
    } else {
      console.warn('[Lossy] ⚠️ Note missing timestamp:', note.id);
      skipped++;
    }
  });

  console.log('[Lossy] 📍 LOAD_MARKERS: Results - Added:', added, 'Queued:', queued, 'Skipped:', skipped);
  return added > 0 || queued > 0;
}

/**
 * Attempt to load markers with exponential backoff retry.
 * This handles cases where notes arrive before timeline markers are ready.
 */
function attemptLoadMarkersWithRetry(notes, attempt) {
  const maxAttempts = 6;
  const delays = [500, 1000, 2000, 3000, 5000, 10000]; // Up to 10 seconds

  if (attempt >= maxAttempts) {
    console.error('[Lossy] ❌ Failed to load markers after', maxAttempts, 'retry attempts');
    return;
  }

  setTimeout(() => {
    if (timelineMarkers) {
      console.log('[Lossy] 🔄 Retry attempt', attempt + 1, 'to load markers');
      const success = loadMarkersFromNotes(notes);

      if (success) {
        console.log('[Lossy] ✅ Successfully loaded markers on retry', attempt + 1);
        // Clear pending since we succeeded
        if (pendingNotesForMarkers === notes) {
          pendingNotesForMarkers = null;
        }
      } else {
        // Try again
        attemptLoadMarkersWithRetry(notes, attempt + 1);
      }
    } else {
      // Timeline markers still not ready, try again
      console.log('[Lossy] ⏳ Timeline markers still not ready on retry', attempt + 1);
      attemptLoadMarkersWithRetry(notes, attempt + 1);
    }
  }, delays[attempt]);
}

function setupTimelineMarkers(videoElement) {
  console.log('[Lossy] 🎯 Setting up timeline markers...');

  // Find progress bar using adapter
  const progressBar = adapter.findProgressBar(videoElement);

  if (!progressBar) {
    console.warn('[Lossy] ⚠️ Could not find progress bar immediately, will retry...');
    retryTimelineMarkersSetup(videoElement, 0);
    return;
  }

  console.log('[Lossy] 🎯 Progress bar found, creating TimelineMarkers instance');
  createTimelineMarkers(videoElement, progressBar);
}

/**
 * Retry finding progress bar with exponential backoff.
 * YouTube's controls can take time to render during SPA navigation.
 */
function retryTimelineMarkersSetup(videoElement, attempt) {
  const maxAttempts = 5;
  const delays = [500, 1000, 2000, 3000, 5000]; // Exponential backoff

  if (attempt >= maxAttempts) {
    console.error('[Lossy] ❌ Failed to find progress bar after', maxAttempts, 'attempts. Timeline markers disabled.');
    return;
  }

  setTimeout(() => {
    console.log('[Lossy] 🔄 Retry attempt', attempt + 1, 'to find progress bar...');

    const progressBar = adapter.findProgressBar(videoElement);

    if (progressBar) {
      console.log('[Lossy] ✅ Progress bar found on retry', attempt + 1);
      createTimelineMarkers(videoElement, progressBar);
    } else {
      retryTimelineMarkersSetup(videoElement, attempt + 1);
    }
  }, delays[attempt]);
}

/**
 * Create and configure TimelineMarkers instance.
 */
function createTimelineMarkers(videoElement, progressBar) {
  timelineMarkers = new TimelineMarkers(videoElement, progressBar);

  timelineMarkers.onMarkerClick((noteId, timestamp) => {
    console.log('[Lossy] 📍 Timeline marker clicked:', noteId, timestamp);
    chrome.runtime.sendMessage({
      action: 'marker_clicked',
      data: { noteId, timestamp }
    });
  });

  console.log('[Lossy] 🎯 Timeline markers setup complete');

  // If we had pending notes waiting for timeline markers, load them now
  if (pendingNotesForMarkers && pendingNotesForMarkers.length > 0) {
    console.log('[Lossy] 🎯 Timeline markers ready, loading', pendingNotesForMarkers.length, 'pending notes');
    loadMarkersFromNotes(pendingNotesForMarkers);
    pendingNotesForMarkers = null;
  }

  // Always request notes when timeline markers become ready
  if (currentVideoDbId && timelineMarkers) {
    console.log('[Lossy] 🎯 Timeline markers ready, requesting notes for video:', currentVideoDbId);
    chrome.runtime.sendMessage({
      action: 'request_notes',
      videoDbId: currentVideoDbId
    }).catch(err => {
      console.log('[Lossy] ⚠️ Failed to request notes after timeline setup:', err);
    });

    // Start watchdog to ensure markers are eventually loaded
    startMarkerWatchdog();
  }
}

/**
 * Watchdog timer to periodically check if we have a video with notes but no markers.
 * This catches edge cases where notes loaded but markers failed to render.
 */
function startMarkerWatchdog() {
  // Clear any existing watchdog
  if (markerWatchdogTimer) {
    clearInterval(markerWatchdogTimer);
  }

  console.log('[Lossy] 🐕 Starting marker watchdog...');

  // Check every 3 seconds for 30 seconds
  let attempts = 0;
  const maxAttempts = 10;

  markerWatchdogTimer = setInterval(() => {
    attempts++;

    if (attempts >= maxAttempts) {
      console.log('[Lossy] 🐕 Watchdog stopping after', maxAttempts, 'attempts');
      clearInterval(markerWatchdogTimer);
      markerWatchdogTimer = null;
      return;
    }

    // If timeline markers exist but no markers are displayed, request notes again
    if (timelineMarkers && currentVideoDbId) {
      const markerCount = timelineMarkers.markers.size;
      const pendingCount = timelineMarkers.pendingMarkers.length;

      if (markerCount === 0 && pendingCount === 0) {
        console.log('[Lossy] 🐕 Watchdog detected no markers, re-requesting notes (attempt', attempts, ')');
        chrome.runtime.sendMessage({
          action: 'request_notes',
          videoDbId: currentVideoDbId
        }).catch(err => {
          console.log('[Lossy] ⚠️ Watchdog note request failed:', err);
        });
      } else if (markerCount > 0) {
        console.log('[Lossy] 🐕 Watchdog found', markerCount, 'markers, stopping');
        clearInterval(markerWatchdogTimer);
        markerWatchdogTimer = null;
      }
    }
  }, 3000); // Check every 3 seconds
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
      console.log('[Lossy] 📍 NOTE_CREATED: Adding new timeline marker:', message.data);

      if (!timelineMarkers) {
        console.warn('[Lossy] ⚠️ NOTE_CREATED: Timeline markers not initialized');
        sendResponse({ success: false, error: 'Timeline markers not initialized' });
        return false;
      }

      if (message.data.timestamp_seconds != null) {
        timelineMarkers.addMarker({
          id: message.data.id,
          timestamp: message.data.timestamp_seconds,
          category: message.data.category,
          text: message.data.text
        });
      } else {
        console.warn('[Lossy] ⚠️ NOTE_CREATED: Missing timestamp for note:', message.data.id);
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
      console.log('[Lossy] 📍 LOAD_MARKERS: Received', message.notes?.length || 0, 'notes');

      if (!message.notes || message.notes.length === 0) {
        console.log('[Lossy] ℹ️ LOAD_MARKERS: No notes to display');
        sendResponse({ success: true });
        return false;
      }

      if (!timelineMarkers) {
        console.warn('[Lossy] ⚠️ LOAD_MARKERS: Timeline markers not initialized yet, storing notes for later...');

        // Store notes for when timeline markers become ready
        pendingNotesForMarkers = message.notes;

        // Also try multiple retries with increasing delays
        attemptLoadMarkersWithRetry(message.notes, 0);

        sendResponse({ success: false, error: 'Timeline markers initializing, notes stored for retry' });
        return false;
      }

      loadMarkersFromNotes(message.notes);
      sendResponse({ success: true });
    }

    if (message.action === 'clear_markers') {
      console.log('[Lossy] Clearing timeline markers');

      if (timelineMarkers) {
        timelineMarkers.clearAll();
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
  console.log('[Lossy] 🧹 CLEANUP: Starting cleanup');

  // Clear debounce timer
  if (reinitTimer) {
    clearTimeout(reinitTimer);
    reinitTimer = null;
  }

  // Clear watchdog timer
  if (markerWatchdogTimer) {
    clearInterval(markerWatchdogTimer);
    markerWatchdogTimer = null;
  }

  // Cleanup platform-specific SPA hooks
  if (spaCleanup) {
    spaCleanup();
    spaCleanup = null;
  }

  // Destroy UI components
  if (anchorChip) {
    anchorChip.destroy();
    anchorChip = null;
  }

  if (timelineMarkers) {
    timelineMarkers.destroy();
    timelineMarkers = null;
  }

  if (adapter) {
    adapter.destroy();
    adapter = null;
  }

  if (videoController) {
    videoController.destroy();
    videoController = null;
  }

  // Reset state
  currentVideoId = null;
  currentVideoDbId = null;
  isInitializing = false;
  pendingNotesForMarkers = null;

  console.log('[Lossy] 🧹 CLEANUP: Complete');
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
