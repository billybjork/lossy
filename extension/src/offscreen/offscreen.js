console.log('Offscreen document loaded');

let mediaRecorder = null;
let recordedChunks = [];

// Listen for commands from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted to offscreen or without a target
  if (message.target && message.target !== 'offscreen') {
    return false;
  }

  console.log('Offscreen received:', message);

  if (message.action === 'start_recording') {
    startRecording().then(() => {
      console.log('Offscreen: Recording started successfully');
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Offscreen: Failed to start recording:', error);
      const errorMessage = error.name === 'NotAllowedError'
        ? 'Microphone permission denied. Please grant permission when prompted.'
        : error.message || String(error);
      sendResponse({ success: false, error: errorMessage });
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'stop_recording') {
    stopRecording();
    console.log('Offscreen: Recording stopped');
    sendResponse({ success: true });
    return false;
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,  // Mono
        sampleRate: 16000,  // 16kHz for Whisper
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Prefer WebM/Opus for OpenAI Whisper API
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 16000
    });

    recordedChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        console.log('Audio chunk available:', event.data.size, 'bytes');

        // Convert Blob to ArrayBuffer and send to service worker
        event.data.arrayBuffer().then(buffer => {
          chrome.runtime.sendMessage({
            action: 'audio_chunk',
            data: Array.from(new Uint8Array(buffer)),
            mimeType: mimeType,
            size: buffer.byteLength
          });
        });
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };

    mediaRecorder.onstop = () => {
      console.log('MediaRecorder stopped');
      stream.getTracks().forEach(track => track.stop());
    };

    // Start recording with 1-second chunks
    // (Balance between latency and efficiency)
    mediaRecorder.start(1000);
    console.log('Recording started');

  } catch (error) {
    console.error('Failed to start recording:', error);
    throw error;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}
