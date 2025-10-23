// Service Worker for Voice Video Companion
// Sprint 01: Audio streaming to Phoenix
// Sprint 03.5: Tab Management
// Sprint 10: Always-On Passive Audio

import { Socket } from 'phoenix';
import { TabManager } from './tab-manager.js';
import { MessageRouter } from './message-router.js';

let socket = null;
let audioChannel = null;
let videoChannel = null;
let isRecording = false;
let currentTimestamp = null;
let tabManager = null;
let messageRouter = null;

// Track side panel state per window: windowId → port
const openPanels = new Map();

// Sprint 10: Passive session coordinator
const MIN_DURATION_MS = 500;
const COOLDOWN_MS = 500;
const AUTO_RESUME_DELAY_MS = 500;
const AUTO_PAUSE_DEFAULT = true;
const HEARTBEAT_INTERVAL_MS = 5000;

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
    autoResumeDelayMs: AUTO_RESUME_DELAY_MS,
  },

  circuitBreaker: {
    state: 'closed',
    restartCount: 0,
    lastRestartAt: 0,
    maxRestarts: 3,
    resetWindowMs: 60000,
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

function resetPassiveTelemetry() {
  passiveSession.telemetry.speechDetections = 0;
  passiveSession.telemetry.ignoredShort = 0;
  passiveSession.telemetry.ignoredCooldown = 0;
  passiveSession.telemetry.ignoredPendingNote = 0;
  passiveSession.telemetry.avgLatencyMs = 0;
  passiveSession.telemetry.lastConfidence = 0;
  passiveSession.telemetry.lastLatencyMs = 0;
  passiveSession.telemetry.restartAttempts = 0;
  passiveSession.telemetry.notesCreated = 0;
  passiveSession.telemetry.startedAt = Date.now();
}

function formatUptime(startedAt) {
  if (!startedAt) return '0s';
  const deltaMs = Date.now() - startedAt;
  const totalSeconds = Math.floor(deltaMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function updateActionBadge() {
  if (!chrome?.action?.setBadgeText) {
    return;
  }

  const noteCount = passiveSession.telemetry.notesCreated || 0;
  const text = noteCount > 0 ? `${noteCount}` : '';
  chrome.action.setBadgeText({ text }).catch(() => {});

  let color = '#4b5563';
  if (passiveSession.status === 'recording') {
    color = '#dc2626';
  } else if (passiveSession.status === 'error') {
    color = '#b91c1c';
  } else if (passiveSession.status === 'observing') {
    color = '#22c55e';
  }

  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function broadcastPassiveStatus({ errorMessage } = {}) {
  updateActionBadge();

  const telemetryPayload = {
    speechDetections: passiveSession.telemetry.speechDetections,
    ignoredShort: passiveSession.telemetry.ignoredShort,
    ignoredCooldown: passiveSession.telemetry.ignoredCooldown,
    ignoredPendingNote: passiveSession.telemetry.ignoredPendingNote,
    ignoredNoContext: passiveSession.telemetry.ignoredNoContext,
    avgLatencyMs: Math.round(passiveSession.telemetry.avgLatencyMs || 0),
    lastConfidence: passiveSession.telemetry.lastConfidence,
    lastLatencyMs: passiveSession.telemetry.lastLatencyMs,
    restartAttempts: passiveSession.telemetry.restartAttempts,
    notesCreated: passiveSession.telemetry.notesCreated,
    uptime: formatUptime(passiveSession.telemetry.startedAt),
  };

  chrome.runtime
    .sendMessage({
      action: 'passive_status_update',
      status: passiveSession.status,
      telemetry: telemetryPayload,
      errorMessage,
    })
    .catch(() => {
      // Sidepanel may not be open; ignore
    });
}

async function requestPassivePause(tabId) {
  if (!passiveSession.settings.autoPauseVideo || !tabId) {
    return { wasPlaying: false };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'passive_pause_video',
    });
    return {
      wasPlaying: Boolean(response?.wasPlaying),
    };
  } catch (error) {
    console.warn('[Passive] Failed to auto-pause video:', error.message);
    return { wasPlaying: false };
  }
}

function schedulePassiveResume(tabId, wasPlaying) {
  if (!passiveSession.settings.autoPauseVideo || !wasPlaying || !tabId) {
    return;
  }

  if (passiveSession.resumeTimeout) {
    clearTimeout(passiveSession.resumeTimeout);
    passiveSession.resumeTimeout = null;
  }

  passiveSession.resumeTimeout = setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'passive_resume_video',
      });
      console.log('[Passive] Auto-resumed video after speech');
    } catch (error) {
      console.warn('[Passive] Failed to auto-resume video:', error.message);
    } finally {
      passiveSession.resumeTimeout = null;
    }
  }, passiveSession.settings.autoResumeDelayMs);
}

function clearPassiveResumeTimer() {
  if (passiveSession.resumeTimeout) {
    clearTimeout(passiveSession.resumeTimeout);
    passiveSession.resumeTimeout = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restartVADWithBackoff() {
  const breaker = passiveSession.circuitBreaker;
  if (breaker.state === 'open') {
    console.warn('[Passive] Circuit breaker open, skipping VAD restart');
    return;
  }

  if (!passiveSession.vadConfig) {
    console.warn('[Passive] VAD restart requested but no configuration available');
    return;
  }

  const now = Date.now();
  if (now - breaker.lastRestartAt > breaker.resetWindowMs) {
    breaker.restartCount = 0;
    breaker.state = 'closed';
  }

  if (breaker.restartCount >= breaker.maxRestarts) {
    breaker.state = 'open';
    passiveSession.status = 'error';
    passiveSession.vadEnabled = false;
    broadcastPassiveStatus({
      errorMessage:
        'VAD failed after multiple restart attempts. Please reload the extension or disable passive mode.',
    });
    return;
  }

  breaker.restartCount += 1;
  breaker.lastRestartAt = now;
  passiveSession.telemetry.restartAttempts = breaker.restartCount;

  const backoffMs = 1000 * breaker.restartCount;
  console.warn(
    `[Passive] Attempting VAD restart (${breaker.restartCount}/${breaker.maxRestarts}) in ${backoffMs}ms`
  );
  await sleep(backoffMs);

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_vad',
    });
  } catch (error) {
    console.warn('[Passive] stop_vad during restart failed:', error.message);
  }

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: passiveSession.vadConfig,
    });
    breaker.state = 'half-open';
    passiveSession.heartbeatFailures = 0;
    passiveSession.vadEnabled = true;
    passiveSession.status = 'observing';
    broadcastPassiveStatus();
    console.log('[Passive] VAD restarted successfully');
  } catch (error) {
    console.error('[Passive] VAD restart failed:', error);
  }
}

async function handleHeartbeatFailure(error) {
  passiveSession.heartbeatFailures += 1;
  console.warn(`[Passive] Heartbeat failure #${passiveSession.heartbeatFailures}:`, error);
  await restartVADWithBackoff();
}

function acknowledgeHeartbeatSuccess() {
  passiveSession.heartbeatFailures = 0;
  if (passiveSession.circuitBreaker.state === 'half-open') {
    passiveSession.circuitBreaker.state = 'closed';
  }
}

// Initialize TabManager and MessageRouter
(async () => {
  tabManager = new TabManager();
  await tabManager.init();

  messageRouter = new MessageRouter();

  // Subscribe panel to the current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    messageRouter.subscribePanelToTab(tabs[0].id);
  }
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
        : audioChannel;

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
  if (message.action === 'timestamp_captured') {
    currentTimestamp = message.data.timestamp;
    console.log('[Lossy] Timestamp captured:', currentTimestamp);
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

async function toggleRecording() {
  if (isRecording) {
    // Stop recording
    await stopRecording();
    return { recording: false, success: true };
  } else {
    // Start recording
    try {
      await startRecording();
      return { recording: true, success: true };
    } catch (error) {
      console.error('Failed to start recording:', error);
      return { recording: false, success: false, error: error.message || String(error) };
    }
  }
}

async function startRecording(options = {}) {
  const { pauseVideo = true } = options; // Default true for manual mode

  console.log('[Lossy] Starting recording (pauseVideo:', pauseVideo, ')');

  // 1. Get active tab and check recording state
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    console.error('[Lossy] No active tab');
    return;
  }

  // Check if another tab is recording
  if (tabManager) {
    const recordingTabId = tabManager.getRecordingTabId();
    if (recordingTabId !== null && recordingTabId !== tab.id) {
      console.error('[Lossy] Tab', recordingTabId, 'is already recording');
      throw new Error(`Another tab is already recording`);
    }

    // Mark this tab as recording
    tabManager.startRecording(tab.id);
  }

  // 2. Capture timestamp (pause video if manual mode, just get timestamp if passive)
  let capturedTimestamp = null;

  if (tab?.id) {
    // Sprint 10 Fix: Check extension context before sending message
    if (!chrome?.runtime?.id) {
      console.log('[Lossy] Extension context invalidated, skipping timestamp capture');
    } else {
      try {
        // Wait for timestamp response with timeout
        const action = pauseVideo ? 'recording_started' : 'get_timestamp';
        const response = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { action }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
        ]);

        if (response && response.success && response.timestamp != null) {
          console.log('[Lossy] Captured timestamp from content script:', response.timestamp);
          capturedTimestamp = response.timestamp;
          currentTimestamp = response.timestamp; // Also store globally
        }
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.log('[Lossy] Extension context invalidated during timestamp capture');
        } else {
          console.log('[Lossy] No content script on this page or timeout');
        }
      }
    }
  }

  console.log('[Lossy] Using timestamp:', capturedTimestamp);

  // 2. Create offscreen document first
  await createOffscreenDocument();

  // 3. Connect to Phoenix Socket
  socket = new Socket('ws://localhost:4000/socket', {
    params: {}, // No token for now
  });

  socket.connect();

  // 4. Join audio channel with video context
  const sessionId = crypto.randomUUID();

  // Get video context from TabManager
  const videoContext = tabManager ? tabManager.getVideoContext(tab.id) : null;

  audioChannel = socket.channel(`audio:${sessionId}`, {
    video_id: videoContext?.videoDbId,
    timestamp: capturedTimestamp,
  });

  // Listen for structured note events
  // Sprint 12: Sidepanel now subscribes directly to NotesChannel via Phoenix Socket
  // Service worker only forwards to content script for timeline markers
  audioChannel.on('note_created', (payload) => {
    console.log('[ServiceWorker] Received structured note:', payload.id);

    // Forward to content script for timeline marker
    if (tab?.id) {
      sendMessageToTab(tab.id, {
        action: 'note_created',
        data: {
          id: payload.id,
          text: payload.text,
          category: payload.category,
          timestamp_seconds: payload.timestamp_seconds,
        },
      });
    }

    // Now we can safely cleanup the channel
    if (!isRecording && audioChannel) {
      console.log('Note received, cleaning up channel');
      setTimeout(() => {
        if (audioChannel) {
          audioChannel.leave();
          audioChannel = null;
        }
        if (socket) {
          socket.disconnect();
          socket = null;
        }
      }, 500); // Small delay to ensure message is sent
    }
  });

  await new Promise((resolve, reject) => {
    audioChannel
      .join()
      .receive('ok', () => {
        console.log('Joined audio channel');
        resolve();
      })
      .receive('error', (err) => {
        console.error('Failed to join channel:', err);
        reject(err);
      });
  });

  // 5. Start audio capture in offscreen document
  const offscreenClients = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (offscreenClients.length > 0) {
    console.log('Sending start_recording message to offscreen (local-only mode)');
    chrome.runtime
      .sendMessage({
        target: 'offscreen',
        action: 'start_recording',
      })
      .catch((err) => console.error('Failed to start offscreen recording:', err));
  } else {
    console.warn('No offscreen document found to send recording message');
  }

  isRecording = true;
}

async function stopRecording() {
  console.log('Stopping recording...');

  // 1. Get the recording tab (not necessarily the active tab)
  const recordingTabId = tabManager ? tabManager.getRecordingTabId() : null;

  if (recordingTabId === null) {
    console.warn('[Lossy] No recording in progress');
    return;
  }

  // Mark tab as idle
  if (tabManager) {
    tabManager.stopRecording(recordingTabId);
  }

  // 2. Notify content script to resume video
  sendMessageToTab(recordingTabId, { action: 'recording_stopped' });

  // 2. Stop audio capture (local transcription happens automatically)
  if (await hasOffscreenDocument()) {
    try {
      const offscreenResponse = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'stop_recording',
      });

      console.log('[Lossy] Offscreen stop response:', offscreenResponse);

      if (offscreenResponse?.success) {
        console.log('[Lossy] Local transcription succeeded, transcript sent to backend');
        // Offscreen already sent transcript_final, backend will handle it
      } else {
        console.error('[Lossy] Local transcription failed:', offscreenResponse?.error);
      }
    } catch (err) {
      console.error('[Lossy] Failed to stop offscreen recording:', err);
    }
  }

  // 4. DON'T leave the channel yet - wait for note_created event
  // The channel will be cleaned up when the note arrives or after a timeout
  // We'll set a timeout to cleanup after 30 seconds if no note arrives
  setTimeout(() => {
    if (audioChannel) {
      console.log('Cleaning up channel after timeout');
      audioChannel.leave();
      audioChannel = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }, 30000); // 30 second timeout

  isRecording = false;
}

async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('Offscreen document already exists');
    return; // Already exists
  }

  console.log('Creating offscreen document...');
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording audio for voice notes',
    });
    console.log('Offscreen document created successfully');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
    throw error;
  }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

/**
 * Sprint 10: Handle passive VAD event from offscreen document
 *
 * Sprint 10 Fix: Uses persistent audio channel instead of creating new sessions
 * Applies debounce/min-duration rules and triggers recording for valid speech segments.
 */
async function handlePassiveEvent(event) {
  if (!passiveSession.vadEnabled) {
    console.log('[Passive] VAD disabled, ignoring event');
    return;
  }

  if (event.type === 'metrics') {
    const m = event.data || {};
    console.log(
      '[Passive] VAD:',
      `state=${m.state || '?'}`,
      `conf=${(m.confidence ?? 0).toFixed(3)}`,
      `speech=${Math.round(m.speechDurationMs || 0)}ms`,
      `silence=${Math.round(m.silenceDurationMs || 0)}ms`,
      `lat=${(m.latencyMs ?? 0).toFixed(1)}ms`
    );
    passiveSession.telemetry.lastConfidence = m.confidence ?? 0;
    passiveSession.telemetry.lastLatencyMs = m.latencyMs ?? 0;
    acknowledgeHeartbeatSuccess();
    broadcastPassiveStatus();
    return;
  }

  const now = Date.now();

  if (event.type === 'speech_start' && passiveSession.status !== 'recording') {
    // Ignore if in cooldown
    if (passiveSession.status === 'cooldown') {
      passiveSession.telemetry.ignoredCooldown++;
      console.log('[Passive] Ignored speech during cooldown');
      return;
    }

    // FIX: More permissive blocking - only block if context is very recent (< 2s)
    if (passiveSession.recordingContext) {
      const contextAge = Date.now() - passiveSession.recordingContext.startedAt;

      // If context is older than 2s, assume backend is stuck - clear and proceed
      if (contextAge > 2000) {
        console.warn('[Passive] Stale recording context (', contextAge, 'ms) - clearing and proceeding');
        passiveSession.recordingContext = null;
        if (passiveSession.recordingContextTimeout) {
          clearTimeout(passiveSession.recordingContextTimeout);
          passiveSession.recordingContextTimeout = null;
        }
      } else {
        // Still fresh, block to prevent context corruption
        passiveSession.telemetry.ignoredPendingNote++;
        console.log('[Passive] Ignored speech - context age:', contextAge, 'ms (< 2s threshold)');
        return;
      }
    }

    const confidence = event.data?.confidence ?? 0;
    const latencyMs = event.data?.latencyMs ?? 0;
    console.log(
      '[Passive] Speech detected (confidence:',
      confidence.toFixed(3),
      'latency:',
      latencyMs.toFixed(1),
      'ms)'
    );

    clearPassiveResumeTimer();

    // CRITICAL: Capture recording context atomically at speech_start
    // This ensures notes/timestamps always route to the correct tab/video,
    // even if the user switches tabs during recording
    const currentTabId = passiveSession.tabId;
    let currentVideoContext = tabManager ? tabManager.getVideoContext(currentTabId) : null;

    // Validate we have a video context - if not, try to hydrate it on the fly
    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Passive] No video context for current tab, attempting refresh');
      currentVideoContext = await ensureVideoContextForTab(currentTabId);
    }

    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Passive] Still no video context after refresh, skipping speech segment');
      passiveSession.telemetry.ignoredNoContext++;
      return;
    }

    console.log('[Passive] Captured recording context:', {
      tabId: currentTabId,
      videoDbId: currentVideoContext.videoDbId,
      video: currentVideoContext.title || currentVideoContext.videoId,
    });

    // Capture timestamp from the CURRENT tab (where speech is starting)
    let capturedTimestamp = null;
    if (!chrome?.runtime?.id) {
      console.log('[Passive] Extension context invalidated, skipping timestamp capture');
    } else {
      try {
        // Get timestamp without pausing video (passive mode)
        const response = await Promise.race([
          chrome.tabs.sendMessage(currentTabId, { action: 'get_timestamp' }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
        ]);

        if (response && response.success && response.timestamp != null) {
          capturedTimestamp = response.timestamp;
          console.log('[Passive] Captured timestamp:', capturedTimestamp);
        }
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.log('[Passive] Extension context invalidated during timestamp capture');
        } else {
          console.log('[Passive] Failed to capture timestamp:', err.message);
        }
      }
    }

    // Store the complete recording context (frozen for this utterance)
    passiveSession.recordingContext = {
      tabId: currentTabId,
      videoDbId: currentVideoContext.videoDbId,
      videoContext: currentVideoContext,
      timestamp: capturedTimestamp,
      startedAt: now,
      autoPause: { wasPlaying: false },
    };

    passiveSession.status = 'recording';
    passiveSession.lastStartAt = now;
    passiveSession.telemetry.speechDetections++;
    passiveSession.telemetry.lastConfidence = confidence;
    passiveSession.telemetry.lastLatencyMs = latencyMs;

    if (passiveSession.settings.autoPauseVideo) {
      const pauseResult = await requestPassivePause(currentTabId);
      passiveSession.recordingContext.autoPause = pauseResult;
    }

    // Clear first speech timeout on first detection (auto-start behavior)
    if (passiveSession.firstSpeechTimeout) {
      clearTimeout(passiveSession.firstSpeechTimeout);
      passiveSession.firstSpeechTimeout = null;
      console.log('[Passive] First speech detected - cleared auto-stop timeout');
    }

    // Send timestamp to backend via persistent channel
    if (passiveSession.audioChannel && capturedTimestamp != null) {
      passiveSession.audioChannel
        .push('set_timestamp', { timestamp: capturedTimestamp })
        .receive('ok', () => {
          console.log('[Passive] Timestamp sent to backend:', capturedTimestamp);
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to send timestamp:', err);
        });
    }

    // Start recording in offscreen (audio flows to persistent channel)
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'start_recording',
      });
      console.log('[Passive] Recording started successfully');
    } catch (error) {
      console.error('[Passive] Failed to start recording:', error);
      if (passiveSession.recordingContext?.autoPause?.wasPlaying) {
        schedulePassiveResume(currentTabId, true);
      }
      passiveSession.status = 'observing';
      passiveSession.recordingContext = null; // Clear context on error
    }

    broadcastPassiveStatus();
  } else if (event.type === 'speech_end' && passiveSession.status === 'recording') {
    const duration = now - passiveSession.lastStartAt;
    const confidence = event.data?.confidence ?? passiveSession.telemetry.lastConfidence;
    const latencyMs = event.data?.latencyMs ?? passiveSession.telemetry.lastLatencyMs;
    const resumeInfo = {
      tabId: passiveSession.recordingContext?.tabId,
      wasPlaying: passiveSession.recordingContext?.autoPause?.wasPlaying,
    };

    if (duration >= MIN_DURATION_MS) {
      console.log('[Passive] Speech ended, duration:', duration, 'ms');

      // Stop recording in offscreen
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'stop_recording',
        });
        console.log('[Passive] Recording stopped successfully');
      } catch (error) {
        console.error('[Passive] Failed to stop recording:', error);
      }

      passiveSession.status = 'cooldown';

      // Log latency
      const count = passiveSession.telemetry.speechDetections;
      passiveSession.telemetry.avgLatencyMs =
        (passiveSession.telemetry.avgLatencyMs * (count - 1) + latencyMs) / count;
      passiveSession.telemetry.lastConfidence = confidence;
      passiveSession.telemetry.lastLatencyMs = latencyMs;

      // Enter cooldown - recording context is PRESERVED until note arrives
      // FIX: Don't clear context after cooldown, wait for note_created or timeout
      setTimeout(() => {
        if (passiveSession.status === 'cooldown') {
          passiveSession.status = 'observing';
          console.log('[Passive] Cooldown complete, resuming observation');
          broadcastPassiveStatus();
        }
      }, COOLDOWN_MS);

      // Set a safety timeout to clear stale context (5 seconds)
      // This handles cases where note_created never arrives (backend errors, etc.)
      if (passiveSession.recordingContextTimeout) {
        clearTimeout(passiveSession.recordingContextTimeout);
      }
      passiveSession.recordingContextTimeout = setTimeout(() => {
        if (passiveSession.recordingContext) {
          const age = Date.now() - passiveSession.recordingContext.startedAt;
          console.warn('[Passive] Recording context timeout after', age, 'ms - clearing');
          passiveSession.recordingContext = null;
          passiveSession.recordingContextTimeout = null;
        }
      }, 5000); // 5 seconds safety timeout

      schedulePassiveResume(resumeInfo.tabId, resumeInfo.wasPlaying);
    } else {
      passiveSession.telemetry.ignoredShort++;
      console.log('[Passive] Ignored short speech segment:', duration, 'ms');
      passiveSession.status = 'observing';
      // Clear recording context immediately for ignored segments
      passiveSession.recordingContext = null;
      if (passiveSession.recordingContextTimeout) {
        clearTimeout(passiveSession.recordingContextTimeout);
        passiveSession.recordingContextTimeout = null;
      }

      schedulePassiveResume(resumeInfo.tabId, resumeInfo.wasPlaying);
    }

    broadcastPassiveStatus();
  } else if (event.type === 'error') {
    console.error('[Passive] VAD error:', event.data);
    passiveSession.vadEnabled = false;
    passiveSession.status = 'error';
    passiveSession.circuitBreaker.state = 'open';

    // FIX #3: Clear recording context on error
    if (passiveSession.recordingContext) {
      passiveSession.recordingContext = null;
    }
    if (passiveSession.recordingContextTimeout) {
      clearTimeout(passiveSession.recordingContextTimeout);
      passiveSession.recordingContextTimeout = null;
    }

    stopPassiveSession();
    broadcastPassiveStatus({ errorMessage: event.data?.message });
  }
}

/**
 * Sprint 10: Start passive session (VAD + heartbeat + persistent audio channel)
 *
 * Sprint 10 Fix: Creates ONE persistent audio channel that stays open
 * across multiple speech segments (no reconnecting on each segment).
 */
async function startPassiveSession() {
  console.log('[Passive] Starting passive session');

  try {
    // Get active tab for video context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab');
    }

    passiveSession.tabId = tab.id;

    // Ensure offscreen document exists
    await createOffscreenDocument();

    // Sprint 10 Fix: Create persistent socket and audio channel
    console.log('[Passive] Creating persistent audio channel');
    passiveSession.sessionId = crypto.randomUUID();
    passiveSession.socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    passiveSession.socket.connect();

    // Get video context from TabManager
    const videoContext = tabManager ? tabManager.getVideoContext(tab.id) : null;

    // Create audio channel with video context (timestamp will be added per speech segment)
    passiveSession.audioChannel = passiveSession.socket.channel(
      `audio:${passiveSession.sessionId}`,
      {
        video_id: videoContext?.videoDbId,
        passive_mode: true, // Flag to indicate this is a persistent passive session
      }
    );

    // Listen for note_created events on the persistent channel
    // Sprint 12: Sidepanel subscribes directly via NotesChannel
    passiveSession.audioChannel.on('note_created', (payload) => {
      console.log('[Passive] Received structured note:', payload.id);
      passiveSession.telemetry.notesCreated += 1;

      // CRITICAL FIX: Route timeline marker to the tab where recording started,
      // not the currently active tab. Use recordingContext if available.
      const targetTabId = passiveSession.recordingContext?.tabId || passiveSession.tabId;

      if (targetTabId) {
        console.log('[Passive] Routing timeline marker to recording tab:', targetTabId);
        sendMessageToTab(targetTabId, {
          action: 'note_created',
          data: {
            id: payload.id,
            text: payload.text,
            category: payload.category,
            timestamp_seconds: payload.timestamp_seconds,
          },
        });
      } else {
        console.warn('[Passive] No target tab for timeline marker, note:', payload.id);
      }

      // FIX #2: Clear recording context now that note has been delivered
      // This ensures the context is preserved long enough for the note to arrive,
      // even with slow backend responses
      if (passiveSession.recordingContext) {
        console.log('[Passive] Clearing recording context after note delivery');
        passiveSession.recordingContext = null;

        // Clear the safety timeout since note arrived successfully
        if (passiveSession.recordingContextTimeout) {
          clearTimeout(passiveSession.recordingContextTimeout);
          passiveSession.recordingContextTimeout = null;
        }
      }

      broadcastPassiveStatus();
    });

    // Join the persistent channel
    await new Promise((resolve, reject) => {
      passiveSession.audioChannel
        .join()
        .receive('ok', () => {
          console.log('[Passive] Persistent audio channel joined');
          resolve();
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to join audio channel:', err);
          reject(err);
        });
    });

    passiveSession.vadConfig = {
      minSpeechDurationMs: 250, // Faster reaction - capture first second of speech
      minSilenceDurationMs: 2000, // 2 seconds tolerance for natural pauses
      sileroConfidence: 0.45, // More sensitive to speech onset
      sileroNegativeThreshold: 0.40, // Raised from 0.35 - cleaner end detection
    };

    // Start VAD in offscreen
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: passiveSession.vadConfig,
    });

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Start heartbeat
    heartbeatInterval = setInterval(async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'heartbeat',
        });
        if (response?.alive) {
          acknowledgeHeartbeatSuccess();
        }
      } catch (err) {
        await handleHeartbeatFailure(err);
      }
    }, HEARTBEAT_INTERVAL_MS);

    passiveSession.vadEnabled = true;
    passiveSession.status = 'observing';
    resetPassiveTelemetry();
    broadcastPassiveStatus();
    console.log('[Passive] Session active with persistent audio channel');

    // Auto-start behavior: Stop session if no speech detected within 10 seconds
    // This prevents forgotten sidepanels from recording indefinitely
    passiveSession.firstSpeechTimeout = setTimeout(async () => {
      if (passiveSession.telemetry.speechDetections === 0) {
        console.log('[Passive] No speech detected in first 10 seconds - auto-stopping');
        await stopPassiveSession();
      }
    }, 10000);
  } catch (error) {
    console.error('[Passive] Failed to start session:', error);
    // Clean up on error
    if (passiveSession.audioChannel) {
      passiveSession.audioChannel.leave();
      passiveSession.audioChannel = null;
    }
    if (passiveSession.socket) {
      passiveSession.socket.disconnect();
      passiveSession.socket = null;
    }
    throw error;
  }
}

/**
 * Sprint 10: Stop passive session
 *
 * Sprint 10 Fix: Tears down persistent audio channel and cleans up resources.
 */
async function stopPassiveSession() {
  console.log('[Passive] Stopping passive session');

  // Clear heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Stop VAD in offscreen
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_vad',
    });
  } catch (err) {
    console.log('[Passive] Could not stop VAD (offscreen may be gone):', err.message);
  }

  // Sprint 10 Fix: Tear down persistent audio channel
  if (passiveSession.audioChannel) {
    console.log('[Passive] Leaving persistent audio channel');
    passiveSession.audioChannel.leave();
    passiveSession.audioChannel = null;
  }

  if (passiveSession.socket) {
    console.log('[Passive] Disconnecting persistent socket');
    passiveSession.socket.disconnect();
    passiveSession.socket = null;
  }

  // FIX #3: Clear recording context to prevent stale routing
  // This handles cases where late note_created events arrive after session stops
  if (passiveSession.recordingContext) {
    console.log('[Passive] Clearing stale recording context');
    passiveSession.recordingContext = null;
  }

  // Clear any pending timeouts
  if (passiveSession.recordingContextTimeout) {
    clearTimeout(passiveSession.recordingContextTimeout);
    passiveSession.recordingContextTimeout = null;
  }

  if (passiveSession.firstSpeechTimeout) {
    clearTimeout(passiveSession.firstSpeechTimeout);
    passiveSession.firstSpeechTimeout = null;
  }

  clearPassiveResumeTimer();

  passiveSession.vadEnabled = false;
  passiveSession.status = 'idle';
  passiveSession.tabId = null;
  passiveSession.sessionId = null;
  passiveSession.circuitBreaker.state = 'closed';
  passiveSession.circuitBreaker.restartCount = 0;
  passiveSession.heartbeatFailures = 0;
  passiveSession.vadConfig = null;
  broadcastPassiveStatus();
  console.log('[Passive] Session stopped and cleaned up');
}

/**
 * Sprint 09 Phase 3: Set up video channel broadcast listeners
 * Forwards video updates to side panel for real-time UI updates
 */
let broadcastsSetUp = false;
function setupVideoChannelBroadcasts() {
  // Only set up once to avoid duplicate listeners
  if (broadcastsSetUp || !videoChannel) {
    return;
  }

  console.log('[ServiceWorker] 📡 Setting up video channel broadcasts');

  // Listen for video_updated broadcasts
  videoChannel.on('video_updated', (payload) => {
    console.log('[ServiceWorker] 📡 Broadcast: video_updated', payload);
    // Forward to side panel
    chrome.runtime
      .sendMessage({
        type: 'channel_broadcast',
        event: 'video_updated',
        data: payload,
      })
      .catch(() => {
        // Silently ignore if side panel not open
      });
  });

  // Listen for video_queued broadcasts
  videoChannel.on('video_queued', (payload) => {
    console.log('[ServiceWorker] 📡 Broadcast: video_queued', payload);
    // Forward to side panel
    chrome.runtime
      .sendMessage({
        type: 'channel_broadcast',
        event: 'video_queued',
        data: payload,
      })
      .catch(() => {
        // Silently ignore if side panel not open
      });
  });

  broadcastsSetUp = true;
}

async function handleVideoDetected(videoData) {
  console.log('[Lossy] Handling video detected:', videoData);

  // Connect to socket if not already connected
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Join video channel
  videoChannel = socket.channel('video:meta', {});

  return new Promise((resolve, reject) => {
    videoChannel
      .join()
      .receive('ok', () => {
        console.log('[Lossy] Joined video channel');

        // Set up broadcast listeners
        setupVideoChannelBroadcasts();

        // Send video_detected event
        videoChannel
          .push('video_detected', videoData)
          .receive('ok', (response) => {
            console.log('[Lossy] Video record created:', response);
            // Don't load notes here - content script will request them after initialization
            resolve({ videoDbId: response.video_id });
          })
          .receive('error', (err) => {
            console.error('[Lossy] Failed to create video record:', err);
            reject(new Error('Failed to create video record'));
          });
      })
      .receive('error', (err) => {
        console.error('[Lossy] Failed to join video channel:', err);
        reject(new Error('Failed to join video channel'));
      });
  });
}

async function loadNotesForVideo(videoDbId, tabId) {
  console.log('[ServiceWorker] 📝 Loading notes for video:', videoDbId, 'in tab:', tabId);

  // Ensure we have a video channel connection
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Reuse or create video channel
  if (!videoChannel) {
    videoChannel = socket.channel('video:meta', {});
    await new Promise((resolve, reject) => {
      videoChannel.join().receive('ok', resolve).receive('error', reject);
    });
  }

  // Request notes
  return new Promise((resolve, reject) => {
    videoChannel
      .push('get_notes', { video_id: videoDbId })
      .receive('ok', (notesResponse) => {
        console.log(
          '[ServiceWorker] 📝 Received',
          notesResponse.notes?.length || 0,
          'existing notes for content script'
        );

        // Send notes ONLY to content script for timeline markers (NOT to side panel)
        chrome.tabs
          .sendMessage(tabId, {
            action: 'load_markers',
            notes: notesResponse.notes,
          })
          .catch(() => console.log('[ServiceWorker] ⚠️ No content script on this page'));

        resolve();
      })
      .receive('error', (err) => {
        console.error('[Lossy] Failed to get notes:', err);
        reject(err);
      });
  });
}

// Sprint 12: Removed loadNotesForSidePanel() and sendNotesToSidePanel()
// Sidepanel now subscribes directly to NotesChannel via Phoenix Socket

async function deleteNote(noteId) {
  console.log('[ServiceWorker] 🗑️ Deleting note:', noteId);

  // Ensure we have a video channel connection
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Reuse or create video channel
  if (!videoChannel) {
    videoChannel = socket.channel('video:meta', {});
    await new Promise((resolve, reject) => {
      videoChannel.join().receive('ok', resolve).receive('error', reject);
    });
  }

  // Delete the note
  return new Promise((resolve, reject) => {
    videoChannel
      .push('delete_note', { note_id: noteId })
      .receive('ok', () => {
        console.log('[ServiceWorker] 🗑️ Note deleted successfully');
        resolve();
      })
      .receive('error', (err) => {
        console.error('[ServiceWorker] Failed to delete note:', err);
        reject(err);
      });
  });
}

/**
 * Ensure content script is injected and trigger video detection.
 * Called when side panel opens on a tab without cached video context.
 * Returns success/failure gracefully without throwing.
 */
async function handleTriggerVideoDetection() {
  console.log('[ServiceWorker] 🔍 TRIGGER_VIDEO_DETECTION: Handling request');

  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    console.log('[ServiceWorker] No active tab found');
    return { success: false, error: 'No active tab found' };
  }

  console.log('[ServiceWorker] 🔍 Triggering detection on tab:', tab.id, tab.url);

  // Check if URL is supported - return gracefully for restricted pages
  if (
    !tab.url ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://')
  ) {
    console.log('[ServiceWorker] Cannot inject content script on restricted page:', tab.url);
    return { success: false, error: 'Cannot inject content script on this page', restricted: true };
  }

  // Ensure content script is injected
  try {
    await ensureContentScriptInjected(tab.id);
  } catch (err) {
    console.log('[ServiceWorker] Failed to inject content script:', err.message);
    return { success: false, error: 'Failed to inject content script' };
  }

  // Trigger detection in content script
  try {
    console.log('[ServiceWorker] 🔍 Sending re_initialize message to content script');
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 're_initialize',
    });

    if (response?.success) {
      console.log('[ServiceWorker] ✅ Content script re-initialized successfully');
      return { success: true, tabId: tab.id };
    } else {
      console.log('[ServiceWorker] Content script re-initialization failed');
      return { success: false, error: 'Content script re-initialization failed' };
    }
  } catch (err) {
    console.log('[ServiceWorker] Failed to communicate with content script:', err.message);
    return { success: false, error: 'Failed to communicate with content script' };
  }
}

/**
 * Ensure content script is injected in the given tab.
 * Uses programmatic injection if not already present.
 */
async function ensureContentScriptInjected(tabId) {
  console.log('[ServiceWorker] 🔍 Ensuring content script is injected in tab:', tabId);

  // Sprint 10 Fix: Check extension context
  if (!chrome?.runtime?.id) {
    throw new Error('Extension context invalidated');
  }

  // Try to ping the content script first
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: 'ping' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 500)),
    ]);

    if (response?.pong) {
      console.log('[ServiceWorker] ✅ Content script already present');
      return; // Already injected
    }
  } catch (err) {
    if (err.message?.includes('Extension context invalidated')) {
      throw err;
    }
    console.log('[ServiceWorker] Content script not present, injecting...');
  }

  // Content script not present - inject it programmatically
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content/universal.js'],
    });
    console.log('[ServiceWorker] ✅ Content script injected successfully');

    // Wait a bit for the script to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (err) {
    // Ignore "Cannot access" errors (means a script is already running, likely orphaned)
    if (err.message?.includes('Cannot access')) {
      console.log(
        '[ServiceWorker] ⚠️ Content script injection blocked (likely orphaned script exists)'
      );
      // Continue anyway - we'll try to communicate with whatever is there
    } else {
      console.error('[ServiceWorker] ❌ Failed to inject content script:', err);
      throw err;
    }
  }
}

async function ensureVideoContextForTab(tabId, timeoutMs = 2000) {
  if (!tabManager) {
    return null;
  }

  let context = tabManager.getVideoContext(tabId);
  if (context?.videoDbId) {
    return context;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.warn('[ServiceWorker] Failed to get tab for context refresh:', err.message);
    return null;
  }

  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    console.log('[ServiceWorker] Tab URL not eligible for video detection:', tab?.url);
    return null;
  }

  try {
    await ensureContentScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, { action: 're_initialize' }).catch((err) => {
      console.log('[ServiceWorker] re_initialize failed (will continue waiting):', err.message);
    });
  } catch (err) {
    console.warn('[ServiceWorker] Failed to refresh video context for tab:', err.message);
    return null;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    context = tabManager.getVideoContext(tabId);
    if (context?.videoDbId) {
      return context;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}

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
    // Ensure we have a video channel connection
    if (!socket || !socket.isConnected()) {
      console.log('[ServiceWorker] Creating new socket connection');
      socket = new Socket('ws://localhost:4000/socket', {
        params: {},
      });
      socket.connect();
    }

    // Always ensure video channel is joined
    if (!videoChannel) {
      console.log('[ServiceWorker] Creating new video channel');
      videoChannel = socket.channel('video:meta', {});
      await new Promise((resolve, reject) => {
        videoChannel.join().receive('ok', resolve).receive('error', reject);
      });
    }

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

  // Ensure we have a video channel connection
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Reuse or create video channel
  if (!videoChannel) {
    videoChannel = socket.channel('video:meta', {});
    await new Promise((resolve, reject) => {
      videoChannel
        .join()
        .receive('ok', () => {
          // Set up broadcast listeners
          setupVideoChannelBroadcasts();
          resolve();
        })
        .receive('error', reject);
    });
  }

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

  // Ensure we have a video channel connection
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Reuse or create video channel
  if (!videoChannel) {
    videoChannel = socket.channel('video:meta', {});
    await new Promise((resolve, reject) => {
      videoChannel
        .join()
        .receive('ok', () => {
          // Set up broadcast listeners
          setupVideoChannelBroadcasts();
          resolve();
        })
        .receive('error', reject);
    });
  }

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

  // Ensure we have a video channel connection
  if (!socket || !socket.isConnected()) {
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }

  // Reuse or create video channel
  if (!videoChannel) {
    videoChannel = socket.channel('video:meta', {});
    await new Promise((resolve, reject) => {
      videoChannel
        .join()
        .receive('ok', () => {
          // Set up broadcast listeners
          setupVideoChannelBroadcasts();
          resolve();
        })
        .receive('error', reject);
    });
  }

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
