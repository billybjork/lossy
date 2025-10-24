/**
 * Recording Manager Module
 *
 * Responsibilities:
 * - Manual recording start/stop
 * - Offscreen document lifecycle management
 * - Timestamp capture from content scripts
 * - Audio channel creation and management for manual recording
 * - Recording state coordination with TabManager
 *
 * Dependencies (injected):
 * - tabManager: TabManager instance
 * - sendMessageToTab: Function to send messages to tabs
 * - Socket: Phoenix Socket constructor
 */

// Dependencies (will be injected via init)
let tabManager = null;
let sendMessageToTab = null;
let Socket = null;

// Recording state
let isRecording = false;
let currentTimestamp = null;
let socket = null;
let audioChannel = null;

/**
 * Initialize recording manager with dependencies
 */
export function initRecordingManager(deps) {
  tabManager = deps.tabManager;
  sendMessageToTab = deps.sendMessageToTab;
  Socket = deps.Socket;
}

/**
 * Get current recording state
 */
export function getRecordingState() {
  return {
    isRecording,
    currentTimestamp,
  };
}

/**
 * Toggle recording on/off
 */
export async function toggleRecording() {
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
      console.error('[RecordingManager] Failed to start recording:', error);
      return { recording: false, success: false, error: error.message || String(error) };
    }
  }
}

/**
 * Start manual recording
 * @param {Object} options - Recording options
 * @param {boolean} options.pauseVideo - Whether to pause video (default: true for manual mode)
 */
export async function startRecording(options = {}) {
  const { pauseVideo = true } = options; // Default true for manual mode

  console.log('[RecordingManager] Starting recording (pauseVideo:', pauseVideo, ')');

  // 1. Get active tab and check recording state
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    console.error('[RecordingManager] No active tab');
    return;
  }

  // Check if another tab is recording
  if (tabManager) {
    const recordingTabId = tabManager.getRecordingTabId();
    if (recordingTabId !== null && recordingTabId !== tab.id) {
      console.error('[RecordingManager] Tab', recordingTabId, 'is already recording');
      throw new Error(`Another tab is already recording`);
    }

    // Mark this tab as recording
    tabManager.startRecording(tab.id);
  }

  // 2. Capture timestamp (pause video if manual mode, just get timestamp if voice mode)
  let capturedTimestamp = null;

  if (tab?.id) {
    // Sprint 10 Fix: Check extension context before sending message
    if (!chrome?.runtime?.id) {
      console.log('[RecordingManager] Extension context invalidated, skipping timestamp capture');
    } else {
      try {
        // Wait for timestamp response with timeout
        const action = pauseVideo ? 'recording_started' : 'get_timestamp';
        const response = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { action }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
        ]);

        if (response && response.success && response.timestamp != null) {
          console.log('[RecordingManager] Captured timestamp from content script:', response.timestamp);
          capturedTimestamp = response.timestamp;
          currentTimestamp = response.timestamp; // Also store globally
        }
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.log('[RecordingManager] Extension context invalidated during timestamp capture');
        } else {
          console.log('[RecordingManager] No content script on this page or timeout');
        }
      }
    }
  }

  console.log('[RecordingManager] Using timestamp:', capturedTimestamp);

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
    console.log('[RecordingManager] Received structured note:', payload.id);

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
      console.log('[RecordingManager] Note received, cleaning up channel');
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
        console.log('[RecordingManager] Joined audio channel');
        resolve();
      })
      .receive('error', (err) => {
        console.error('[RecordingManager] Failed to join channel:', err);
        reject(err);
      });
  });

  // 5. Start audio capture in offscreen document
  const offscreenClients = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (offscreenClients.length > 0) {
    console.log('[RecordingManager] Sending start_recording message to offscreen (local-only mode)');
    chrome.runtime
      .sendMessage({
        target: 'offscreen',
        action: 'start_recording',
      })
      .catch((err) => console.error('[RecordingManager] Failed to start offscreen recording:', err));
  } else {
    console.warn('[RecordingManager] No offscreen document found to send recording message');
  }

  isRecording = true;
}

/**
 * Stop manual recording
 */
export async function stopRecording() {
  console.log('[RecordingManager] Stopping recording...');

  // 1. Get the recording tab (not necessarily the active tab)
  const recordingTabId = tabManager ? tabManager.getRecordingTabId() : null;

  if (recordingTabId === null) {
    console.warn('[RecordingManager] No recording in progress');
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

      console.log('[RecordingManager] Offscreen stop response:', offscreenResponse);

      if (offscreenResponse?.success) {
        console.log('[RecordingManager] Local transcription succeeded, transcript sent to backend');
        // Offscreen already sent transcript_final, backend will handle it
      } else {
        console.error('[RecordingManager] Local transcription failed:', offscreenResponse?.error);
      }
    } catch (err) {
      console.error('[RecordingManager] Failed to stop offscreen recording:', err);
    }
  }

  // 4. DON'T leave the channel yet - wait for note_created event
  // The channel will be cleaned up when the note arrives or after a timeout
  // We'll set a timeout to cleanup after 30 seconds if no note arrives
  setTimeout(() => {
    if (audioChannel) {
      console.log('[RecordingManager] Cleaning up channel after timeout');
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

/**
 * Create offscreen document for audio capture
 */
export async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('[RecordingManager] Offscreen document already exists');
    return; // Already exists
  }

  console.log('[RecordingManager] Creating offscreen document...');
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording audio for voice notes',
    });
    console.log('[RecordingManager] Offscreen document created successfully');
  } catch (error) {
    console.error('[RecordingManager] Failed to create offscreen document:', error);
    throw error;
  }
}

/**
 * Check if offscreen document exists
 */
export async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

/**
 * Get audio channel for voice mode to use
 */
export function getAudioChannel() {
  return audioChannel;
}
