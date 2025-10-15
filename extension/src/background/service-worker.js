// Service Worker for Voice Video Companion
// Sprint 01: Audio streaming to Phoenix

import { Socket } from "phoenix";

console.log('Service worker loaded');

let socket = null;
let audioChannel = null;
let isRecording = false;

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

  // 1. Create offscreen document first
  await createOffscreenDocument();

  // 2. Connect to Phoenix Socket
  socket = new Socket("ws://localhost:4000/socket", {
    params: {},  // No token for now
    logger: (kind, msg, data) => {
      console.log(`Phoenix ${kind}:`, msg, data);
    }
  });

  socket.connect();

  // 3. Join audio channel
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {});

  audioChannel.on('transcript', (payload) => {
    console.log('Received transcript:', payload);
    // Forward to sidepanel
    chrome.runtime.sendMessage({
      action: 'transcript',
      data: payload
    }).catch(err => console.log('No sidepanel listening:', err));
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

  // 4. Start audio capture in offscreen document
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

  // 1. Stop audio capture
  if (await hasOffscreenDocument()) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_recording'
    }).catch(err => console.error('Failed to stop offscreen recording:', err));
  }

  // 2. Tell backend to finalize transcription
  if (audioChannel) {
    audioChannel.push('stop_recording', {})
      .receive('ok', () => console.log('Backend notified to finalize'))
      .receive('error', (err) => console.error('Failed to notify backend:', err));
  }

  // 3. Leave channel (after stop_recording sent)
  setTimeout(() => {
    if (audioChannel) {
      audioChannel.leave();
      audioChannel = null;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    isRecording = false;
  }, 500);
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
