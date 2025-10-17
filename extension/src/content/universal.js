import './platforms/bootstrap.js'; // Register all adapters
import { PlatformRegistry } from './platforms/index.js';
import { AnchorChip } from './shared/anchor-chip.js';
import { TimelineMarkers } from './shared/timeline-markers.js';
import { VideoLifecycleManager } from './core/video-lifecycle-manager.js';
import { NoteLoader } from './core/note-loader.js';

console.log('[Lossy] Universal content script loaded');

// Detect if extension context is invalidated (happens after extension reload)
// Use a non-throwing check to avoid errors in Extension Manager console
let extensionContextInvalidated = (() => {
  try {
    // Access chrome.runtime.id - if this throws OR returns undefined, context is invalid
    return !chrome?.runtime?.id;
  } catch {
    // Context is invalidated
    return true;
  }
})();

if (extensionContextInvalidated) {
  console.log('[Lossy] 🔴 Extension context is already invalidated on load - this content script is orphaned');
}

// Wrap all chrome.runtime calls to detect invalidation
const safeRuntimeSendMessage = async (message) => {
  if (extensionContextInvalidated) {
    console.log('[Lossy] ⚠️ Extension context invalidated, skipping message');
    return null;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (err.message?.includes('Extension context invalidated')) {
      console.log('[Lossy] 🔴 Extension context invalidated - content script is orphaned. Please reload the page.');
      extensionContextInvalidated = true;
      // Cleanup to stop all activity
      cleanup();
    }
    throw err;
  }
};

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
let spaCleanup = null; // Platform-specific SPA navigation cleanup
let lifecycleManager = null;
let messageListenerRegistered = false;
let messageListenerHandler = null;
let noteLoader = null;
let abortController = null; // AbortController for cleanup
let lastClearedVideoId = null; // Track last video ID we cleared UI for

async function init() {
  // Prevent multiple simultaneous initializations
  if (isInitializing) {
    console.log('[Lossy] ⚠️ INIT: Already initializing, skipping...');
    return;
  }

  isInitializing = true;
  console.log('[Lossy] 🔵 INIT: Starting initialization for URL:', window.location.href);

  // Create new AbortController for this initialization
  abortController = new AbortController();
  const signal = abortController.signal;

  // Setup abort listener for logging
  signal.addEventListener('abort', () => {
    console.log('[Lossy] 🧹 AbortController triggered cleanup');
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

  // Extract video ID to determine if we need to clear the UI
  // Only clear if we're switching to a different video
  let shouldClearUI = false;
  try {
    const videoIdData = adapter.extractVideoId(window.location.href);
    const detectedVideoId = videoIdData.id;

    if (lastClearedVideoId !== detectedVideoId) {
      shouldClearUI = true;
      lastClearedVideoId = detectedVideoId;
      console.log('[Lossy] 🔵 INIT: Video changed to', detectedVideoId, '- will clear UI');
    } else {
      console.log('[Lossy] 🔵 INIT: Same video', detectedVideoId, '- skipping clear UI');
    }
  } catch (error) {
    // If we can't extract video ID, clear to be safe
    console.warn('[Lossy] ⚠️ INIT: Could not extract video ID, will clear UI to be safe');
    shouldClearUI = true;
  }

  // Tell side panel to clear old notes only if switching to different video
  if (shouldClearUI) {
    console.log('[Lossy] 🔵 INIT: Sending clear_ui to side panel');
    safeRuntimeSendMessage({
      action: 'clear_ui'
    }).catch(() => {
      console.log('[Lossy] 🔵 INIT: Side panel not available for clear_ui');
    });
  }

  // Create lifecycle manager with adapter
  if (lifecycleManager) {
    lifecycleManager.destroy();
  }

  lifecycleManager = new VideoLifecycleManager(adapter, { signal });

  // Set up callback for when video is detected
  lifecycleManager.onStateChange((event, data) => {
    if (event === 'video_detected') {
      console.log('[Lossy] 🔵 Video detected via lifecycle manager');
      onVideoReady(data.videoElement);
    } else if (event === 'state_changed' && data.newState === 'error') {
      console.warn('[Lossy] ⚠️ Lifecycle manager in error state');
    }
  });

  // Watch for URL changes (generic History API interception)
  if (!historyIntercepted) {
    interceptHistoryApi();
    historyIntercepted = true;
  }

  // Start lifecycle manager (handles video detection with health checks)
  await lifecycleManager.start();

  isInitializing = false;
  console.log('[Lossy] 🔵 INIT: Initialization complete');
}

/**
 * Called when video is detected and ready.
 * Continues with initialization logic.
 */
async function onVideoReady(videoElement) {
  console.log('[Lossy] 🔵 Video element ready:', videoElement);

  // Extract video ID using adapter
  const videoIdData = adapter.extractVideoId(window.location.href);
  currentVideoId = videoIdData.id;

  console.log('[Lossy] 🔵 Video ID:', videoIdData);

  // Create video controller using adapter
  videoController = adapter.createVideoController(videoElement);

  // Send video context to service worker
  console.log('[Lossy] 🔵 Sending video_detected to service worker');
  const response = await safeRuntimeSendMessage({
    action: 'video_detected',
    data: {
      platform: videoIdData.platform,
      videoId: videoIdData.id,
      url: window.location.href,
      title: document.title
    }
  }).catch(err => {
    console.warn('[Lossy] ⚠️ Could not send video_detected message:', err);
    return null;
  });

  if (response?.videoDbId) {
    currentVideoDbId = response.videoDbId;
    console.log('[Lossy] 🔵 Video database ID:', currentVideoDbId);
  } else {
    console.warn('[Lossy] ⚠️ No videoDbId in response');
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

  console.log('[Lossy] 🔵 Video ready setup complete');
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

// attemptLoadMarkersWithRetry removed - consolidated into NoteLoader

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
  // Pass the AbortSignal if available
  const options = abortController ? { signal: abortController.signal } : {};
  timelineMarkers = new TimelineMarkers(videoElement, progressBar, options);

  timelineMarkers.onMarkerClick((noteId, timestamp) => {
    console.log('[Lossy] 📍 Timeline marker clicked:', noteId, timestamp);
    safeRuntimeSendMessage({
      action: 'marker_clicked',
      data: { noteId, timestamp }
    }).catch(() => {});
  });

  console.log('[Lossy] 🎯 Timeline markers setup complete');

  // If we had pending notes waiting for timeline markers, load them now
  if (pendingNotesForMarkers && pendingNotesForMarkers.length > 0) {
    console.log('[Lossy] 🎯 Timeline markers ready, loading', pendingNotesForMarkers.length, 'pending notes');
    loadMarkersFromNotes(pendingNotesForMarkers);
    pendingNotesForMarkers = null;
  }

  // Initialize note loader
  if (!noteLoader) {
    noteLoader = new NoteLoader();
  }

  // Request notes ONCE with automatic deduplication and retry
  if (currentVideoDbId) {
    noteLoader.loadNotes(currentVideoDbId)
      .then(() => {
        console.log('[Lossy] Notes loaded successfully via NoteLoader');
      })
      .catch(err => {
        console.error('[Lossy] Failed to load notes after all retries:', err);
      });
  }
}

// startMarkerWatchdog removed - retry logic consolidated into NoteLoader

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

        // Store timestamp globally for later use
        safeRuntimeSendMessage({
          action: 'timestamp_captured',
          data: {
            videoId: currentVideoId,
            videoDbId: currentVideoDbId,
            timestamp: timestamp
          }
        }).catch(() => {});

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

    if (message.action === 'remove_marker') {
      console.log('[Lossy] 🗑️ REMOVE_MARKER:', message.noteId);

      if (timelineMarkers) {
        timelineMarkers.removeMarker(message.noteId);
        console.log('[Lossy] ✅ Timeline marker removed');
      } else {
        console.warn('[Lossy] ⚠️ Timeline markers not initialized');
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

    // Ping check for content script presence (used by programmatic injection)
    if (message.action === 'ping') {
      sendResponse({ pong: true });
      return false;
    }

    // Re-initialize video detection (triggered when side panel opens on existing tab)
    if (message.action === 're_initialize') {
      console.log('[Lossy] 🔄 RE_INITIALIZE: Received request to re-detect video');

      // Clean up existing state
      cleanup();

      // Re-run initialization
      init().then(() => {
        console.log('[Lossy] ✅ RE_INITIALIZE: Re-initialization complete');
        sendResponse({ success: true });
      }).catch(err => {
        console.error('[Lossy] ❌ RE_INITIALIZE: Failed to re-initialize:', err);
        sendResponse({ success: false, error: err.message });
      });

      return true; // Will respond asynchronously
    }

    return true;
  };

  chrome.runtime.onMessage.addListener(messageListenerHandler);
  messageListenerRegistered = true;
}

function cleanup() {
  console.log('[Lossy] 🧹 CLEANUP: Starting cleanup');

  // Abort all operations from current initialization
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  // Clear debounce timer
  if (reinitTimer) {
    clearTimeout(reinitTimer);
    reinitTimer = null;
  }

  // Invalidate note loader session (cancels in-flight requests)
  if (noteLoader) {
    noteLoader.invalidateSession();
  }

  // Remove message listener (CRITICAL FIX)
  if (messageListenerRegistered && messageListenerHandler) {
    console.log('[Lossy] 🧹 CLEANUP: Removing message listener');
    chrome.runtime.onMessage.removeListener(messageListenerHandler);
    messageListenerRegistered = false;
    messageListenerHandler = null;
  }

  // Cleanup platform-specific SPA hooks
  if (spaCleanup) {
    spaCleanup();
    spaCleanup = null;
  }

  // Destroy lifecycle manager
  if (lifecycleManager) {
    lifecycleManager.destroy();
    lifecycleManager = null;
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

// Initialize (only if extension context is valid)
if (!extensionContextInvalidated) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
} else {
  console.log('[Lossy] 🔴 Skipping initialization - extension context invalidated');
}
