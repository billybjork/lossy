// Service Worker for Voice Video Companion
// Sprint 01: Audio streaming to Phoenix

import { Socket } from "phoenix";

console.log('Service worker loaded');

let socket = null;
let audioChannel = null;
let videoChannel = null;
let isRecording = false;
let currentVideo = null;
let currentTimestamp = null;

// Extension installed
chrome.runtime.onInstalled.addListener(() => {
  console.log('Voice Video Companion installed');
});

// Handle messages from extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Service worker received:', message, 'from', sender);

  // Handle messages from sidepanel
  if (message.action === 'toggle_recording' && !sender.url?.includes('offscreen.html')) {
    toggleRecording().then(sendResponse).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open
  }

  // Handle audio chunks from offscreen document
  if (message.action === 'audio_chunk' && sender.url?.includes('offscreen.html')) {
    if (audioChannel) {
      // Send binary audio to Phoenix
      const audioData = new Uint8Array(message.data);
      audioChannel.push('audio_chunk', { data: audioData })
        .receive('ok', () => console.log('Audio chunk sent'))
        .receive('error', (err) => console.error('Failed to send chunk:', err));
    }
    return false; // No async response needed
  }

  // Handle responses from offscreen document
  if ((message.action === 'start_recording' || message.action === 'stop_recording') && sender.url?.includes('offscreen.html')) {
    // This is a response from the offscreen document, not a command
    return false;
  }

  // Video detected from content script
  if (message.action === 'video_detected') {
    currentVideo = message.data;
    console.log('[Lossy] Video detected:', currentVideo);

    // Send to backend VideoChannel
    handleVideoDetected(currentVideo).then(response => {
      sendResponse(response);
    }).catch(err => {
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

  // Marker clicked in timeline → focus note in side panel
  if (message.action === 'marker_clicked') {
    console.log('[Lossy] Marker clicked:', message.data);

    // Forward to side panel
    chrome.runtime.sendMessage({
      action: 'focus_note',
      noteId: message.data.noteId,
      timestamp: message.data.timestamp
    }).catch(err => console.log('No sidepanel listening:', err));

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
        }).catch(err => console.log('No content script on this page:', err));
      }
    });

    sendResponse({ success: true });
    return false;
  }

  // Get current video timestamp (for side panel display)
  if (message.action === 'get_video_timestamp') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'get_current_timestamp'
        }).then(response => {
          console.log('[Lossy] Got timestamp from content script:', response);
          // Forward timestamp to side panel
          chrome.runtime.sendMessage({
            action: 'video_timestamp_update',
            timestamp: response?.timestamp
          }).catch(() => {});
        }).catch((err) => {
          console.log('[Lossy] No response from content script:', err);
          // No video detected
          chrome.runtime.sendMessage({
            action: 'video_timestamp_update',
            timestamp: null
          }).catch(() => {});
        });
      }
    });
    return false;
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

  // 1. Notify content script to pause video and capture timestamp
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let capturedTimestamp = null;

  if (tab?.id) {
    try {
      // Wait for timestamp response with timeout
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { action: 'recording_started' }),
        new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000))
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
  socket = new Socket("ws://localhost:4000/socket", {
    params: {},  // No token for now
    logger: (kind, msg, data) => {
      console.log(`Phoenix ${kind}:`, msg, data);
    }
  });

  socket.connect();

  // 4. Join audio channel with video context
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {
    video_id: currentVideo?.dbId,
    timestamp: capturedTimestamp
  });

  // Listen for structured note events (we only send the final structured note, not raw transcript)
  audioChannel.on('note_created', (payload) => {
    console.log('Received structured note:', payload);

    // Forward to sidepanel
    chrome.runtime.sendMessage({
      action: 'transcript',
      data: {
        id: payload.id,
        text: payload.text,
        category: payload.category,
        confidence: payload.confidence,
        timestamp_seconds: payload.timestamp_seconds,
        raw_transcript: payload.raw_transcript,
        timestamp: payload.timestamp
      }
    }).catch(err => console.log('No sidepanel listening:', err));

    // Forward to content script for timeline marker
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'note_created',
        data: {
          id: payload.id,
          text: payload.text,
          category: payload.category,
          timestamp_seconds: payload.timestamp_seconds
        }
      }).catch(err => console.log('[Lossy] No content script on this page'));
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
    audioChannel.join()
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
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  console.log('Offscreen contexts found:', offscreenClients.length);

  if (offscreenClients.length > 0) {
    // Send message directly to offscreen document
    console.log('Sending start_recording message to offscreen...');
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_recording'
    }).catch(err => console.error('Failed to start offscreen recording:', err));
  } else {
    console.warn('No offscreen document found to send recording message');
  }

  isRecording = true;
}

async function stopRecording() {
  console.log('Stopping recording...');

  // 1. Notify content script to resume video
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'recording_stopped' })
      .catch((err) => console.log('[Lossy] No content script on this page'));
  }

  // 2. Stop audio capture
  if (await hasOffscreenDocument()) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_recording'
    }).catch(err => console.error('Failed to stop offscreen recording:', err));
  }

  // 3. Tell backend to finalize transcription and wait for confirmation
  if (audioChannel) {
    await new Promise((resolve) => {
      audioChannel.push('stop_recording', {})
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
      justification: 'Recording audio for voice notes'
    });
    console.log('Offscreen document created successfully');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
    throw error;
  }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

async function handleVideoDetected(videoData) {
  console.log('[Lossy] Handling video detected:', videoData);

  // Connect to socket if not already connected
  if (!socket || !socket.isConnected()) {
    socket = new Socket("ws://localhost:4000/socket", {
      params: {},
      logger: (kind, msg, data) => {
        console.log(`Phoenix ${kind}:`, msg, data);
      }
    });
    socket.connect();
  }

  // Join video channel
  videoChannel = socket.channel('video:meta', {});

  return new Promise((resolve, reject) => {
    videoChannel.join()
      .receive('ok', () => {
        console.log('[Lossy] Joined video channel');

        // Send video_detected event
        videoChannel.push('video_detected', videoData)
          .receive('ok', (response) => {
            console.log('[Lossy] Video record created:', response);
            currentVideo.dbId = response.video_id;

            // Request existing notes for this video
            videoChannel.push('get_notes', { video_id: response.video_id })
              .receive('ok', (notesResponse) => {
                console.log('[Lossy] Received existing notes:', notesResponse);

                // Send notes to content script for timeline markers
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                  if (tabs[0]?.id) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                      action: 'load_markers',
                      notes: notesResponse.notes
                    }).catch(err => console.log('[Lossy] No content script on this page'));
                  }
                });

                resolve({ videoDbId: response.video_id });
              })
              .receive('error', (err) => {
                console.error('[Lossy] Failed to get notes:', err);
                resolve({ videoDbId: response.video_id }); // Still resolve with video ID
              });
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
