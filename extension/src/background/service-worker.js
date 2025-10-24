// Service Worker for Voice Video Companion
// Sprint 01: Audio streaming to Phoenix
// Sprint 03.5: Tab Management
// Sprint 10: Always-On Passive Audio

import { Socket } from 'phoenix';
import { TabManager } from './tab-manager.js';
import { MessageRouter } from './message-router.js';
import { VAD_CONFIG, PASSIVE_SESSION_CONFIG } from '../shared/shared-constants.js';
import {
  initPassiveSessionManager,
  resetPassiveTelemetry,
  broadcastPassiveStatus,
  restartVADWithBackoff,
  handleHeartbeatFailure,
  acknowledgeHeartbeatSuccess,
  handlePassiveEvent,
  startPassiveSession,
  stopPassiveSession,
} from './modules/passive-session-manager.js';
import {
  initRecordingManager,
  toggleRecording,
  startRecording,
  stopRecording,
  createOffscreenDocument,
  hasOffscreenDocument,
  getRecordingState,
  getAudioChannel,
} from './modules/recording-manager.js';
import {
  initSocketManager,
  getOrCreateSocket,
  getOrCreateVideoChannel,
  getVideoChannel,
} from './modules/socket-manager.js';
import {
  initVideoContextManager,
  handleVideoDetected,
  handleTriggerVideoDetection,
  ensureVideoContextForTab,
  ensureContentScriptInjected,
} from './modules/video-context-manager.js';
import {
  initNoteManager,
  loadNotesForVideo,
  deleteNote,
} from './modules/note-manager.js';

let tabManager = null;
let messageRouter = null;

// Track side panel state per window: windowId → port
const openPanels = new Map();

// Sprint 10: Passive session coordinator
const AUTO_PAUSE_DEFAULT = true;

const passiveSession = {
  tabId: null,
  status: 'idle', // 'idle' | 'observing' | 'recording' | 'cooldown' | 'error'
  vadEnabled: false, // Default OFF per Sprint 10 spec
  lastStartAt: 0,
  vadConfig: null,

  // Sprint 10 Fix: Persistent audio channel for passive mode
  socket: null,
  audioChannel: null,
  sessionId: null,

  // Recording context snapshot (captured atomically at speech_start)
  // This ensures notes/timestamps always route to the correct tab/video,
  // even if the user switches tabs mid-recording
  recordingContext: null, // { tabId, videoDbId, videoContext, timestamp, startedAt }
  recordingContextTimeout: null, // Safety timeout to clear stale context

  // Auto-start behavior: Stop passive session if no speech detected within 10 seconds
  firstSpeechTimeout: null,
  resumeTimeout: null,

  // Telemetry (console only)
  telemetry: {
    speechDetections: 0,
    ignoredShort: 0,
    ignoredCooldown: 0,
    ignoredPendingNote: 0, // NEW: Count speech ignored while waiting for previous note
    ignoredNoContext: 0,
    avgLatencyMs: 0,
    lastConfidence: 0,
    lastLatencyMs: 0,
    restartAttempts: 0,
    notesCreated: 0,
    startedAt: null,
  },

  settings: {
    autoPauseVideo: AUTO_PAUSE_DEFAULT,
    autoResumeDelayMs: PASSIVE_SESSION_CONFIG.AUTO_RESUME_DELAY_MS,
  },

  circuitBreaker: {
    state: 'closed',
    restartCount: 0,
    lastRestartAt: 0,
    maxRestarts: PASSIVE_SESSION_CONFIG.MAX_RESTARTS,
    resetWindowMs: PASSIVE_SESSION_CONFIG.RESET_WINDOW_MS,
  },

  heartbeatFailures: 0,
};

let heartbeatInterval = null;

/**
 * Sprint 10 Fix: Safe wrapper for sending messages to tabs
 * Handles extension context invalidation gracefully
 */
function sendMessageToTab(tabId, message) {
  // Check if extension context is valid
  if (!chrome?.runtime?.id) {
    console.log('[ServiceWorker] Extension context invalidated, skipping message to tab');
    return;
  }

  chrome.tabs.sendMessage(tabId, message).catch((err) => {
    // Silently handle common errors
    if (err.message?.includes('Extension context invalidated')) {
      console.log('[ServiceWorker] Extension context invalidated while sending message');
    } else if (err.message?.includes('Receiving end does not exist')) {
      // Content script not loaded yet or tab closed - this is normal
      console.log('[ServiceWorker] No content script on tab', tabId);
    } else {
      console.log('[ServiceWorker] Failed to send message to tab:', err.message);
    }
  });
}

// Initialize TabManager, MessageRouter, PassiveSessionManager, RecordingManager, and SocketManager
(async () => {
  tabManager = new TabManager();
  await tabManager.init();

  messageRouter = new MessageRouter();

  // Initialize socket manager with dependencies
  initSocketManager({
    Socket,
  });

  // Initialize video context manager with dependencies
  initVideoContextManager({
    tabManager,
    getOrCreateVideoChannel,
  });

  // Initialize note manager with dependencies
  initNoteManager({
    getOrCreateVideoChannel,
  });

  // Initialize passive session manager with dependencies
  initPassiveSessionManager({
    passiveSession,
    tabManager,
    Socket,
    sendMessageToTab,
    createOffscreenDocument,
    ensureVideoContextForTab,
  });

  // Initialize recording manager with dependencies
  initRecordingManager({
    tabManager,
    sendMessageToTab,
    Socket,
  });

  // Subscribe panel to the current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    messageRouter.subscribePanelToTab(tabs[0].id);
  }

  console.log('[ServiceWorker] Initialized TabManager, MessageRouter, SocketManager, PassiveSessionManager, and RecordingManager');
})();

// Track tab activation to subscribe panel to active tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (messageRouter) {
    messageRouter.subscribePanelToTab(activeInfo.tabId);
  }

  // Update the current active tab ID for passive session
  // NOTE: This does NOT update the recording context mid-recording
  // Recording context is captured atomically at speech_start and frozen
  passiveSession.tabId = activeInfo.tabId;

  // If passive mode is observing (not recording), update the video context
  // so the next speech segment will use the current tab's context
  if (passiveSession.status === 'observing' && passiveSession.audioChannel) {
    // Reset VAD state when tab switches to prevent cross-tab audio confusion
    console.log('[Passive] Tab switch detected - resetting VAD state');
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'reset_vad',
      });
    } catch (err) {
      console.warn('[Passive] Failed to reset VAD on tab switch:', err.message);
    }

    const newVideoContext = tabManager ? tabManager.getVideoContext(activeInfo.tabId) : null;

    if (newVideoContext?.videoDbId) {
      console.log(
        `[Passive] Tab switched while observing, updating context to: ${newVideoContext.videoDbId}`
      );

      // Update backend AgentSession's video context for next recording
      passiveSession.audioChannel
        .push('update_video_context', { video_id: newVideoContext.videoDbId })
        .receive('ok', () => {
          console.log('[Passive] Video context updated successfully');
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to update video context:', err);
        });
    } else {
      console.log('[Passive] New tab has no video context - clearing backend context');

      // Phase 2: Clear video context in backend when switching to non-video tab
      // This prevents notes from bleeding into unrelated videos
      passiveSession.audioChannel
        .push('update_video_context', { video_id: null })
        .receive('ok', () => {
          console.log('[Passive] Backend video context cleared (no video on active tab)');
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to clear backend video context:', err);
        });
    }
  }
});

// Clean up when tabs are removed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (messageRouter) {
    messageRouter.unsubscribeFromTab(tabId);
  }
});

// Track side panel open/close via port connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  console.log('[ServiceWorker] Side panel connected');

  // Get the window ID from the sender
  // Since side panel doesn't have a tab, we need to find the active window
  chrome.windows.getCurrent((window) => {
    const windowId = window.id;
    console.log('[ServiceWorker] Side panel opened for window:', windowId);

    // Store the port
    openPanels.set(windowId, port);

    // Notify all tabs in this window that panel is open
    chrome.tabs.query({ windowId }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, { action: 'panel_opened' }).catch(() => {
          // Silently ignore tabs without content script
        });
      });
    });

    // Listen for disconnect (panel closed)
    port.onDisconnect.addListener(() => {
      console.log('[ServiceWorker] Side panel disconnected for window:', windowId);

      // Remove from tracking
      openPanels.delete(windowId);

      // Notify all tabs in this window that panel is closed
      chrome.tabs.query({ windowId }, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, { action: 'panel_closed' }).catch(() => {
            // Silently ignore tabs without content script
          });
        });
      });
    });
  });
});

// Extension installed - preload Whisper model for better first-run experience
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('Voice Video Companion installed');

  // Sprint 09 Phase 3: Create context menu for queueing videos
  chrome.contextMenus.create({
    id: 'queue-video',
    title: 'Add to Lossy Queue',
    contexts: ['page', 'link'],
    documentUrlPatterns: [
      '*://*.youtube.com/*',
      '*://*.vimeo.com/*',
      '*://*.frame.io/*',
      '*://app.iconik.io/*',
    ],
  });

  // Warm cache on install or update
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('[ServiceWorker] Preloading Whisper model...');

    try {
      // Create offscreen document for model loading
      await createOffscreenDocument();

      // Send warm cache message
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'warm_cache',
      });

      console.log('[ServiceWorker] Model preloading initiated');
    } catch (err) {
      console.warn('[ServiceWorker] Failed to preload model:', err);
      // Non-critical error - extension still works
    }
  }
});

// Extension button clicked - open side panel
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Sprint 09 Phase 3: Context menu click handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'queue-video') {
    queueCurrentVideo(tab);
  }
});

/**
 * Sprint 09 Phase 3: Queue video from context menu
 */
async function queueCurrentVideo(tab) {
  try {
    console.log('[ServiceWorker] 📋 Context menu: Queue video from tab', tab.id);

    // Extract video metadata from tab
    const videoData = await extractVideoMetadata(tab);

    // Send to backend via channel
    const response = await handleQueueVideo(videoData);

    if (response.success) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Video Queued',
        message: `Added "${videoData.title}" to your queue`,
      });
    }
  } catch (error) {
    console.error('[ServiceWorker] Failed to queue video:', error);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Queue Failed',
      message: 'Failed to add video to queue',
    });
  }
}

/**
 * Sprint 09 Phase 3: Extract video metadata from tab
 */
async function extractVideoMetadata(tab) {
  console.log('[ServiceWorker] 📋 Extracting video metadata from tab:', tab.url);

  // Try to inject content script and get metadata
  let result = null;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const title = document.querySelector('h1')?.textContent || document.title;
        const thumbnail = document.querySelector('meta[property="og:image"]')?.content;
        return { title, thumbnail };
      },
    });
  } catch (err) {
    console.log('[ServiceWorker] Could not extract page metadata:', err.message);
  }

  const url = new URL(tab.url);
  const platform = detectPlatform(url.hostname);
  const external_id = extractExternalId(url, platform);

  return {
    platform,
    external_id,
    url: tab.url,
    title: result?.result?.title || tab.title,
    thumbnail_url: result?.result?.thumbnail,
  };
}

/**
 * Sprint 09 Phase 3: Detect platform from hostname
 */
function detectPlatform(hostname) {
  if (hostname.includes('youtube.com')) return 'youtube';
  if (hostname.includes('vimeo.com')) return 'vimeo';
  if (hostname.includes('frame.io')) return 'frame_io';
  if (hostname.includes('iconik.io')) return 'iconik';
  return 'generic';
}

/**
 * Sprint 09 Phase 3: Extract external ID from URL
 */
function extractExternalId(url, platform) {
  switch (platform) {
    case 'youtube':
      return url.searchParams.get('v') || url.pathname.split('/').pop();
    case 'vimeo':
      return url.pathname.split('/').filter(Boolean).pop();
    default:
      return url.pathname;
  }
}

// Handle messages from extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sprint 10: Handle passive VAD events from offscreen
  if (message.action === 'passive_event' && sender.url?.includes('offscreen.html')) {
    handlePassiveEvent(message);
    return false; // No async response needed
  }

  // Sprint 10: Start passive session (from sidepanel)
  if (message.action === 'start_passive_session') {
    startPassiveSession()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Passive] Failed to start passive session:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open
  }

  // Sprint 10: Stop passive session (from sidepanel)
  if (message.action === 'stop_passive_session') {
    stopPassiveSession()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Passive] Failed to stop passive session:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open
  }

  if (message.action === 'retry_passive_vad') {
    const executor = passiveSession.status === 'idle' ? startPassiveSession : restartVADWithBackoff;

    executor()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Passive] Retry VAD failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // Handle messages from sidepanel
  if (message.action === 'toggle_recording' && !sender.url?.includes('offscreen.html')) {
    toggleRecording()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open
  }

  // Sprint 11: Audio chunks removed - all transcription happens locally

  // Sprint 07: Handle transcription status updates from offscreen
  if (message.action === 'transcription_status' && sender.url?.includes('offscreen.html')) {
    // Forward status to side panel for UI updates
    chrome.runtime.sendMessage(message).catch(() => {
      // Silently ignore if side panel not open
    });
    return false;
  }

  // Sprint 07: Handle transcript from local transcription
  if (message.action === 'transcript_final' && sender.url?.includes('offscreen.html')) {
    console.log('[Lossy] Local transcript received:', message.text.substring(0, 50) + '...');

    // Sprint 10 Fix: Route transcript to correct channel (passive vs manual)
    const targetChannel =
      passiveSession.status === 'recording' || passiveSession.status === 'cooldown'
        ? passiveSession.audioChannel
        : getAudioChannel();

    if (targetChannel) {
      targetChannel
        .push('transcript_final', {
          text: message.text,
          source: message.source,
          chunks: message.chunks,
          durationSeconds: message.durationSeconds,
          transcriptionTimeMs: message.transcriptionTimeMs,
        })
        .receive('ok', () => {
          console.log('[Lossy] Local transcript sent to backend');
        })
        .receive('error', (err) => {
          console.error('[Lossy] Failed to send transcript:', err);
        });
    }
    return false;
  }

  // Sprint 11: Handle transcription errors (no cloud fallback)
  if (message.action === 'transcription_error' && sender.url?.includes('offscreen.html')) {
    console.error('[Lossy] Local transcription failed:', message.error);

    // Notify side panel of error
    chrome.runtime
      .sendMessage({
        action: 'transcription_status',
        stage: 'error',
        source: 'local',
        error: message.error,
      })
      .catch(() => {});

    return false;
  }

  // Sprint 08: Refine note with GPT-4o Vision
  if (message.action === 'refine_note_with_vision') {
    handleRefineNoteWithVision(message.noteId, message.timestamp)
      .then(sendResponse)
      .catch((error) => {
        console.error('[ServiceWorker] Refine note with vision failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Handle responses from offscreen document
  if (
    (message.action === 'start_recording' || message.action === 'stop_recording') &&
    sender.url?.includes('offscreen.html')
  ) {
    // This is a response from the offscreen document, not a command
    return false;
  }

  // Video detected from content script
  if (message.action === 'video_detected') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return false;
    }

    const videoData = message.data;
    console.log('[ServiceWorker] 📹 VIDEO_DETECTED in tab', tabId, ':', videoData);

    // Send to backend VideoChannel
    handleVideoDetected(videoData)
      .then((response) => {
        console.log('[ServiceWorker] 📹 Backend returned videoDbId:', response.videoDbId);

        // Store in TabManager
        if (response.videoDbId && tabManager) {
          console.log('[ServiceWorker] 📹 Storing video context in TabManager for tab', tabId);
          tabManager.setVideoContext(tabId, {
            videoDbId: response.videoDbId,
            platform: videoData.platform,
            videoId: videoData.videoId,
            url: videoData.url,
            title: videoData.title,
          });

          // Phase 2: If this is the active tab and passive mode is observing,
          // update the backend context immediately (handles late detection)
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (
              tabs[0]?.id === tabId &&
              passiveSession.status === 'observing' &&
              passiveSession.audioChannel
            ) {
              console.log('[Passive] Late video detection on active tab, updating backend context');
              passiveSession.audioChannel
                .push('update_video_context', { video_id: response.videoDbId })
                .receive('ok', () => {
                  console.log('[Passive] Backend context updated after late detection');
                })
                .receive('error', (err) => {
                  console.error('[Passive] Failed to update backend context:', err);
                });
            }
          });
        }

        sendResponse(response);
      })
      .catch((err) => {
        console.error('[Lossy] Failed to handle video detected:', err);
        sendResponse({ error: err.message });
      });

    return true; // Keep channel open for async response
  }

  // Timestamp captured from content script
  // Note: Recording manager now handles timestamp capture directly during startRecording
  if (message.action === 'timestamp_captured') {
    console.log('[Lossy] Timestamp captured:', message.data.timestamp);
    sendResponse({ success: true });
    return false;
  }

  // Video time update from content script (push-based)
  if (message.action === 'video_time_update') {
    const sourceTabId = sender.tab?.id;
    if (sourceTabId && messageRouter) {
      // Only forward to side panel if it's viewing this tab
      messageRouter.routeToSidePanel(
        {
          action: 'video_timestamp_update',
          timestamp: message.timestamp,
          timecodeUnavailable: message.timecodeUnavailable,
        },
        sourceTabId
      );
    }
    return false;
  }

  // Marker clicked in timeline → focus note in side panel
  if (message.action === 'marker_clicked') {
    console.log('[Lossy] Marker clicked:', message.data);

    const sourceTabId = sender.tab?.id;
    if (sourceTabId && messageRouter) {
      // Only forward to side panel if it's viewing this tab
      messageRouter.routeToSidePanel(
        {
          action: 'focus_note',
          noteId: message.data.noteId,
          timestamp: message.data.timestamp,
        },
        sourceTabId
      );
    }

    sendResponse({ success: true });
    return false;
  }

  // Note clicked in side panel → seek video
  if (message.action === 'note_clicked') {
    console.log('[Lossy] Note clicked, seeking to:', message.timestamp);

    // Forward to content script in active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs
          .sendMessage(tabs[0].id, {
            action: 'seek_to',
            timestamp: message.timestamp,
          })
          .catch((err) => console.log('No content script on this page:', err));
      }
    });

    sendResponse({ success: true });
    return false;
  }

  // Get current video timestamp (for side panel display)
  if (message.action === 'get_video_timestamp') {
    // Sprint 10 Fix: Check extension context before proceeding
    if (!chrome?.runtime?.id) {
      sendResponse({
        success: false,
        timestamp: null,
        timecodeUnavailable: true,
        error: 'Extension context invalidated',
      });
      return false;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]?.id) {
        try {
          const response = await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'get_current_timestamp',
          });
          console.log('[Lossy] Got timestamp from content script:', response);
          // Forward timestamp to side panel
          chrome.runtime
            .sendMessage({
              action: 'video_timestamp_update',
              timestamp: response?.timestamp,
              timecodeUnavailable: response?.timecodeUnavailable,
            })
            .catch(() => {});

          // Also send response back to caller for liveness check
          sendResponse({
            success: true,
            timestamp: response?.timestamp,
            timecodeUnavailable: response?.timecodeUnavailable,
          });
        } catch (err) {
          console.log('[Lossy] No response from content script:', err);
          // No video detected - content script not responding
          chrome.runtime
            .sendMessage({
              action: 'video_timestamp_update',
              timestamp: null,
              timecodeUnavailable: true,
            })
            .catch(() => {});

          // Send response indicating content script is not alive
          sendResponse({
            success: false,
            timestamp: null,
            timecodeUnavailable: true,
            error: 'Content script not responding',
          });
        }
      } else {
        sendResponse({
          success: false,
          timestamp: null,
          timecodeUnavailable: true,
          error: 'No active tab',
        });
      }
    });
    return true; // Will respond asynchronously
  }

  // Get active tab context (from side panel)
  if (message.action === 'get_active_tab_context') {
    const context = tabManager ? tabManager.getActiveVideoContext() : null;
    sendResponse({ context });
    return false;
  }

  // Check if side panel is open (from content script on initialization)
  if (message.action === 'is_panel_open') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ isOpen: false });
      return false;
    }

    // Get window ID for this tab
    chrome.tabs.get(tabId, (tab) => {
      const isOpen = openPanels.has(tab.windowId);
      sendResponse({ isOpen });
    });
    return true; // Will respond asynchronously
  }

  // Trigger video detection on current tab (from side panel when no context)
  if (message.action === 'trigger_video_detection') {
    handleTriggerVideoDetection()
      .then(sendResponse)
      .catch((err) => {
        // Don't log as error - handle gracefully for restricted pages
        console.log('[ServiceWorker] Could not trigger video detection:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  // Get all tabs with videos (for tab switcher UI)
  if (message.action === 'get_all_tabs') {
    const tabs = tabManager ? tabManager.getAllTabs() : [];
    sendResponse({ tabs });
    return false;
  }

  // Switch to specific tab (from side panel tab switcher)
  if (message.action === 'switch_to_tab') {
    chrome.tabs.update(message.tabId, { active: true });
    sendResponse({ success: true });
    return false;
  }

  // Request notes for a video (from content script after initialization)
  if (message.action === 'request_notes') {
    const tabId = sender.tab?.id;
    if (!tabId || !message.videoDbId) {
      sendResponse({ error: 'Missing tabId or videoDbId' });
      return false;
    }

    console.log(
      '[ServiceWorker] 📝 REQUEST_NOTES from content script for video:',
      message.videoDbId,
      'tab:',
      tabId
    );

    loadNotesForVideo(message.videoDbId, tabId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error('[Lossy] Failed to load notes:', err);
        sendResponse({ error: err.message });
      });

    return true; // Keep channel open for async response
  }

  // Sprint 12: Removed 'request_notes_for_sidepanel' handler
  // Sidepanel now subscribes directly to NotesChannel via Phoenix Socket

  // Delete note (from side panel)
  if (message.action === 'delete_note') {
    if (!message.noteId) {
      sendResponse({ error: 'Missing noteId' });
      return false;
    }

    console.log('[ServiceWorker] 🗑️ DELETE_NOTE:', message.noteId);

    deleteNote(message.noteId)
      .then(() => {
        // Notify all tabs to remove the timeline marker
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((tab) => {
            chrome.tabs
              .sendMessage(tab.id, {
                action: 'remove_marker',
                noteId: message.noteId,
              })
              .catch(() => {
                // Silently ignore tabs without content script
              });
          });
        });

        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error('[Lossy] Failed to delete note:', err);
        sendResponse({ error: err.message });
      });

    return true; // Keep channel open for async response
  }

  // Sprint 09 Phase 3: List videos from library
  if (message.type === 'list_videos') {
    handleListVideos(message.filters)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }

  // Sprint 09 Phase 3: Update video status
  if (message.type === 'update_video_status') {
    handleUpdateVideoStatus(message.videoId, message.status)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }

  // Sprint 09 Phase 3: Queue video
  if (message.type === 'queue_video') {
    handleQueueVideo(message.videoData)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }
});

/**
 * Sprint 08: Refine note with GPT-4o Vision using captured video frame
 */
async function handleRefineNoteWithVision(noteId, timestamp) {
  console.log('[ServiceWorker] 🔍 Refining note with vision:', noteId, 'at timestamp:', timestamp);

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab');
  }

  // Request frame capture from content script
  console.log('[ServiceWorker] Requesting frame capture from content script...');

  // Sprint 10 Fix: Check extension context
  if (!chrome?.runtime?.id) {
    throw new Error('Extension context invalidated');
  }

  const captureResponse = await chrome.tabs.sendMessage(tab.id, {
    action: 'capture_frame',
    timestamp: timestamp,
  });

  if (!captureResponse?.success) {
    throw new Error(captureResponse?.error || 'Frame capture failed');
  }

  const { actualTimestamp, base64 } = captureResponse;
  console.log('[ServiceWorker] Frame captured at', actualTimestamp);

  // Validate we have base64 data
  if (!base64) {
    throw new Error('No base64 image data returned from frame capture');
  }

  console.log('[ServiceWorker] Sending frame to backend for GPT-4o Vision refinement...');

  try {
    // Get or create video channel
    const videoChannel = await getOrCreateVideoChannel();

    // Send refinement request with base64 frame
    return new Promise((resolve, reject) => {
      videoChannel
        .push('refine_note_with_vision', {
          note_id: noteId,
          frame_base64: base64,
          timestamp: actualTimestamp,
        })
        .receive('ok', (response) => {
          console.log('[ServiceWorker] ✅ Note refined successfully with GPT-4o Vision');
          resolve({
            success: true,
            noteId: noteId,
            timestamp: actualTimestamp,
            refinedText: response.refined_text,
          });
        })
        .receive('error', (err) => {
          console.error('[ServiceWorker] Failed to refine note:', err);
          reject(new Error('Failed to refine note with vision'));
        })
        .receive('timeout', () => {
          console.error('[ServiceWorker] Vision refinement timed out');
          reject(new Error('Vision refinement timed out'));
        });
    });
  } catch (error) {
    console.error('[ServiceWorker] Error in vision refinement flow:', error);
    throw error;
  }
}

/**
 * Sprint 09 Phase 3: Handle list videos request
 */
async function handleListVideos(filters) {
  console.log('[ServiceWorker] 📚 LIST_VIDEOS with filters:', filters);

  // Get or create video channel
  const videoChannel = await getOrCreateVideoChannel();

  // Request videos
  return new Promise((resolve, reject) => {
    videoChannel
      .push('list_videos', { filters })
      .receive('ok', (response) => {
        console.log('[ServiceWorker] 📚 Received', response.videos?.length || 0, 'videos');
        resolve(response);
      })
      .receive('error', (err) => {
        console.error('[ServiceWorker] Failed to list videos:', err);
        reject(new Error('Failed to list videos'));
      })
      .receive('timeout', () => {
        reject(new Error('List videos request timed out'));
      });
  });
}

/**
 * Sprint 09 Phase 3: Handle update video status request
 */
async function handleUpdateVideoStatus(videoId, status) {
  console.log('[ServiceWorker] 📝 UPDATE_VIDEO_STATUS:', videoId, '→', status);

  // Get or create video channel
  const videoChannel = await getOrCreateVideoChannel();

  // Update status
  return new Promise((resolve, reject) => {
    videoChannel
      .push('update_video_status', { video_id: videoId, status })
      .receive('ok', (response) => {
        console.log('[ServiceWorker] ✅ Video status updated');
        resolve({ success: true, video: response.video });
      })
      .receive('error', (err) => {
        console.error('[ServiceWorker] Failed to update video status:', err);
        reject(new Error('Failed to update video status'));
      })
      .receive('timeout', () => {
        reject(new Error('Update video status timed out'));
      });
  });
}

/**
 * Sprint 09 Phase 3: Handle queue video request
 */
async function handleQueueVideo(videoData) {
  console.log('[ServiceWorker] ➕ QUEUE_VIDEO:', videoData);

  // Get or create video channel
  const videoChannel = await getOrCreateVideoChannel();

  // Queue video
  return new Promise((resolve, reject) => {
    videoChannel
      .push('queue_video', videoData)
      .receive('ok', (response) => {
        console.log('[ServiceWorker] ✅ Video queued successfully');
        resolve({ success: true, video: response.video });
      })
      .receive('error', (err) => {
        console.error('[ServiceWorker] Failed to queue video:', err);
        reject(new Error('Failed to queue video'));
      })
      .receive('timeout', () => {
        reject(new Error('Queue video request timed out'));
      });
  });
}
