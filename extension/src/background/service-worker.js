// Service Worker for Voice Video Companion
// Sprint 01: Audio streaming to Phoenix
// Sprint 03.5: Tab Management

import { Socket } from 'phoenix';
import { TabManager } from './tab-manager.js';
import { MessageRouter } from './message-router.js';
import { getLocalSttMode } from '../shared/settings.js';

let socket = null;
let audioChannel = null;
let videoChannel = null;
let isRecording = false;
let currentTimestamp = null;
let tabManager = null;
let messageRouter = null;

// Track side panel state per window: windowId → port
const openPanels = new Map();

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
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (messageRouter) {
    messageRouter.subscribePanelToTab(activeInfo.tabId);
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
        chrome.tabs
          .sendMessage(tab.id, { action: 'panel_opened' })
          .catch(() => {
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
          chrome.tabs
            .sendMessage(tab.id, { action: 'panel_closed' })
            .catch(() => {
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

// Handle messages from extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle messages from sidepanel
  if (message.action === 'toggle_recording' && !sender.url?.includes('offscreen.html')) {
    toggleRecording()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open
  }

  // Handle audio chunks from offscreen document
  if (message.action === 'audio_chunk' && sender.url?.includes('offscreen.html')) {
    if (audioChannel) {
      // Send binary audio to Phoenix as plain Array (not Uint8Array)
      // Phoenix.js doesn't properly serialize Uint8Array, so keep it as Array
      audioChannel
        .push('audio_chunk', { data: message.data })
        .receive('error', (err) => console.error('Failed to send chunk:', err));
    }
    return false; // No async response needed
  }

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

    if (audioChannel) {
      audioChannel
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

  // Sprint 07: Handle local transcription fallback
  if (message.action === 'transcript_fallback_required' && sender.url?.includes('offscreen.html')) {
    console.warn('[Lossy] Local transcription failed, cloud fallback:', message.reason);

    // Notify side panel of fallback
    chrome.runtime.sendMessage({
      action: 'transcription_status',
      stage: 'fallback',
      source: 'cloud',
      reason: message.reason,
    }).catch(() => {});

    if (!message.canFallback) {
      console.error('[Lossy] Cloud fallback disabled by user settings');
      // TODO: Show error to user in side panel
    }

    // Backend will use buffered audio for cloud transcription
    return false;
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
    handleVideoDetected(videoData, tabId)
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

  // Request notes for side panel only (from side panel when switching tabs)
  if (message.action === 'request_notes_for_sidepanel') {
    if (!message.videoDbId || !message.tabId) {
      sendResponse({ error: 'Missing videoDbId or tabId' });
      return false;
    }

    console.log(
      '[ServiceWorker] 📝 REQUEST_NOTES_FOR_SIDEPANEL for video:',
      message.videoDbId,
      'tab:',
      message.tabId
    );

    loadNotesForSidePanel(message.videoDbId, message.tabId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error('[Lossy] Failed to load notes:', err);
        sendResponse({ error: err.message });
      });

    return true; // Keep channel open for async response
  }

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

async function startRecording() {
  console.log('Starting recording...');

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

  // 2. Notify content script to pause video and capture timestamp
  let capturedTimestamp = null;

  if (tab?.id) {
    try {
      // Wait for timestamp response with timeout
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { action: 'recording_started' }),
        new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
      ]);

      if (response && response.success && response.timestamp != null) {
        console.log('[Lossy] Captured timestamp from content script:', response.timestamp);
        capturedTimestamp = response.timestamp;
        currentTimestamp = response.timestamp; // Also store globally
      }
    } catch (err) {
      console.log('[Lossy] No content script on this page or timeout');
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

  // Listen for structured note events (we only send the final structured note, not raw transcript)
  audioChannel.on('note_created', (payload) => {
    console.log('Received structured note:', payload);

    // Forward to sidepanel with video context (only if panel is viewing this tab)
    if (tab?.id && messageRouter) {
      messageRouter.routeToSidePanel(
        {
          action: 'transcript',
          data: {
            id: payload.id,
            text: payload.text,
            category: payload.category,
            confidence: payload.confidence,
            timestamp_seconds: payload.timestamp_seconds,
            raw_transcript: payload.raw_transcript,
            timestamp: payload.timestamp,
            video_id: videoContext?.videoDbId, // Add video context
          },
        },
        tab.id
      );
    }

    // Forward to content script for timeline marker
    if (tab?.id) {
      chrome.tabs
        .sendMessage(tab.id, {
          action: 'note_created',
          data: {
            id: payload.id,
            text: payload.text,
            category: payload.category,
            timestamp_seconds: payload.timestamp_seconds,
          },
        })
        .catch((err) => console.log('[Lossy] No content script on this page'));
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
    // Get STT mode and send to offscreen document
    const sttMode = await getLocalSttMode();
    console.log('Sending start_recording message to offscreen with mode:', sttMode);
    chrome.runtime
      .sendMessage({
        target: 'offscreen',
        action: 'start_recording',
        sttMode: sttMode,
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
  chrome.tabs
    .sendMessage(recordingTabId, { action: 'recording_stopped' })
    .catch((err) => console.log('[Lossy] No content script on this page'));

  // 2. Stop audio capture and attempt local transcription
  let localTranscriptSent = false;

  if (await hasOffscreenDocument()) {
    try {
      const offscreenResponse = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'stop_recording',
      });

      console.log('[Lossy] Offscreen stop response:', offscreenResponse);

      // Check if local transcription was attempted and succeeded
      if (offscreenResponse?.localTranscription && offscreenResponse?.success) {
        console.log('[Lossy] Local transcription succeeded, transcript already sent to backend');
        localTranscriptSent = true;
        // Offscreen already sent transcript_final, backend will handle it
        // Don't send stop_recording to backend - it would trigger cloud transcription
      }
    } catch (err) {
      console.error('[Lossy] Failed to stop offscreen recording:', err);
    }
  }

  // 3. Tell backend to finalize transcription ONLY if local transcription didn't happen
  // If local transcript was sent, backend is already processing it
  if (audioChannel && !localTranscriptSent) {
    console.log('[Lossy] Sending stop_recording to backend (local transcript not available)');
    await new Promise((resolve) => {
      audioChannel
        .push('stop_recording', {})
        .receive('ok', () => {
          console.log('Backend notified to finalize');
          resolve();
        })
        .receive('error', (err) => {
          console.error('Failed to notify backend:', err);
          resolve(); // Resolve anyway to continue cleanup
        })
        .receive('timeout', () => {
          console.error('Backend notification timed out');
          resolve();
        });
    });
  } else if (localTranscriptSent) {
    console.log('[Lossy] Skipping stop_recording to backend - local transcript already sent');
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

async function handleVideoDetected(videoData, tabId) {
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
          .catch((err) => console.log('[ServiceWorker] ⚠️ No content script on this page'));

        resolve();
      })
      .receive('error', (err) => {
        console.error('[Lossy] Failed to get notes:', err);
        reject(err);
      });
  });
}

async function loadNotesForSidePanel(videoDbId, tabId) {
  console.log('[ServiceWorker] 📝 Loading notes for side panel only:', videoDbId, 'tab:', tabId);

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
          'existing notes for side panel'
        );

        // Send notes to side panel only (filtered by tab)
        sendNotesToSidePanel(notesResponse.notes, videoDbId, tabId);

        resolve();
      })
      .receive('error', (err) => {
        console.error('[Lossy] Failed to get notes:', err);
        reject(err);
      });
  });
}

function sendNotesToSidePanel(notes, videoDbId, tabId) {
  if (notes && notes.length > 0 && messageRouter) {
    notes.forEach((note) => {
      // Only send to side panel if it's viewing this tab
      messageRouter.routeToSidePanel(
        {
          action: 'transcript',
          data: {
            id: note.id,
            text: note.text,
            category: note.category,
            confidence: note.confidence,
            timestamp_seconds: note.timestamp_seconds,
            raw_transcript: note.raw_transcript,
            timestamp: note.timestamp,
            video_id: videoDbId, // Add video context for filtering
          },
        },
        tabId
      );
    });
  }
}

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
