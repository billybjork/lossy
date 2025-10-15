# Sprint 01: Audio Streaming (No Auth)

**Status:** ✅ Complete
**Started:** 2025-10-14
**Completed:** 2025-10-14
**Duration:** 1 day

---

## Goal

Establish the audio pipeline: extension captures voice → streams to Phoenix via WebSocket → backend echoes back to extension. Skip authentication to focus on core functionality.

---

## Prerequisites

- ✅ Sprint 00 complete (scaffolding done)
- ✅ Phoenix server running on :4000
- ✅ Extension builds successfully
- ⏳ Microphone access permission in Chrome

---

## Deliverables

- [x] Offscreen document captures microphone audio
- [x] Audio chunks stream from offscreen → service worker
- [x] Service worker connects to Phoenix Channel
- [x] Backend receives binary audio data
- [x] Backend echoes back fake transcript
- [x] Side panel displays received messages
- [x] No authentication required (open channel)

---

## Technical Tasks

### Task 1: Phoenix Channel Setup (Backend)

#### 1.1 Create UserSocket (no auth)

**File:** `lossy/lib/lossy_web/user_socket.ex`

```elixir
defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  # Channels
  channel "audio:*", LossyWeb.AudioChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    # For now: accept all connections (no auth)
    # Later: verify token from params["token"]
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
```

**Why no auth:** We want to test the audio pipeline first. Auth will be added in Sprint 05.

#### 1.2 Create AudioChannel

**File:** `lossy/lib/lossy_web/channels/audio_channel.ex`

```elixir
defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  @impl true
  def join("audio:" <> session_id, _payload, socket) do
    Logger.info("Audio channel joined: #{session_id}")
    {:ok, assign(socket, :session_id, session_id)}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) do
    Logger.info("Received audio chunk: #{byte_size(audio_data)} bytes")

    # Echo back a fake transcript for testing
    push(socket, "transcript", %{
      text: "This is a test transcript",
      timestamp: System.system_time(:second)
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
  end
end
```

#### 1.3 Update Endpoint

**File:** `lossy/lib/lossy_web/endpoint.ex`

Add socket mount:

```elixir
defmodule LossyWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :lossy

  # Add this line:
  socket "/socket", LossyWeb.UserSocket,
    websocket: true,
    longpoll: false

  # ... rest of endpoint config
end
```

#### 1.4 Test Channel from IEx

```bash
cd lossy && iex -S mix phx.server
```

In IEx:
```elixir
# Test socket connection
{:ok, socket} = Phoenix.ChannelTest.connect(LossyWeb.UserSocket, %{})
{:ok, _, socket} = Phoenix.ChannelTest.subscribe_and_join(socket, "audio:test", %{})
Phoenix.ChannelTest.push(socket, "ping", %{})
# Should receive: {:ok, %{pong: true}}
```

---

### Task 2: Extension Audio Capture

#### 2.1 Offscreen Document Audio Capture

**File:** `extension/src/offscreen/offscreen.js`

```javascript
console.log('Offscreen document loaded');

let mediaRecorder = null;
let recordedChunks = [];

// Listen for commands from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received:', message);

  if (message.action === 'start_recording') {
    startRecording().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'stop_recording') {
    stopRecording();
    sendResponse({ success: true });
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
```

**File:** `extension/src/offscreen/offscreen.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Offscreen Audio Capture</title>
</head>
<body>
  <script src="offscreen.js"></script>
</body>
</html>
```

#### 2.2 Service Worker Audio Routing

**File:** `extension/src/background/service-worker.js`

```javascript
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
  console.log('Service worker received:', message);

  if (message.action === 'toggle_recording') {
    toggleRecording().then(sendResponse).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open
  }

  if (message.action === 'audio_chunk') {
    if (audioChannel) {
      // Send binary audio to Phoenix
      const audioData = new Uint8Array(message.data);
      audioChannel.push('audio_chunk', { data: audioData })
        .receive('ok', () => console.log('Audio chunk sent'))
        .receive('error', (err) => console.error('Failed to send chunk:', err));
    }
  }
});

async function toggleRecording() {
  if (isRecording) {
    // Stop recording
    await stopRecording();
    return { recording: false };
  } else {
    // Start recording
    await startRecording();
    return { recording: true };
  }
}

async function startRecording() {
  console.log('Starting recording...');

  // 1. Connect to Phoenix Socket
  socket = new Socket("ws://localhost:4000/socket", {
    params: {},  // No token for now
    logger: (kind, msg, data) => {
      console.log(`Phoenix ${kind}:`, msg, data);
    }
  });

  socket.connect();

  // 2. Join audio channel
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {});

  audioChannel.on('transcript', (payload) => {
    console.log('Received transcript:', payload);
    // Forward to sidepanel
    chrome.runtime.sendMessage({
      action: 'transcript',
      data: payload
    });
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

  // 3. Create offscreen document for audio capture
  await createOffscreenDocument();

  // 4. Start audio capture
  await chrome.runtime.sendMessage({
    action: 'start_recording'
  });

  isRecording = true;
}

async function stopRecording() {
  console.log('Stopping recording...');

  // 1. Stop audio capture
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ action: 'stop_recording' });
  }

  // 2. Leave channel
  if (audioChannel) {
    audioChannel.leave();
    audioChannel = null;
  }

  // 3. Disconnect socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  isRecording = false;
}

async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return; // Already exists
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording audio for voice notes'
  });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}
```

---

### Task 3: Side Panel UI

#### 3.1 Simple Recording UI

**File:** `extension/src/sidepanel/sidepanel.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Notes</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      padding: 20px;
      margin: 0;
    }

    .header {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    button {
      padding: 12px 24px;
      font-size: 16px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    button.record {
      background: #dc2626;
      color: white;
    }

    button.record:hover {
      background: #b91c1c;
    }

    button.recording {
      background: #059669;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .status {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      background: #f3f4f6;
    }

    .status.connected {
      background: #d1fae5;
      color: #065f46;
    }

    .transcripts {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .transcript {
      padding: 12px;
      background: #f9fafb;
      border-left: 3px solid #3b82f6;
      border-radius: 4px;
    }

    .transcript-text {
      margin: 0;
      font-size: 14px;
    }

    .transcript-time {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin: 0;">Voice Notes</h1>
    <div class="status" id="status">Disconnected</div>
    <button id="recordBtn" class="record">🎤 Start Recording</button>
  </div>

  <div class="transcripts" id="transcripts"></div>

  <script src="sidepanel.js"></script>
</body>
</html>
```

**File:** `extension/src/sidepanel/sidepanel.js`

```javascript
console.log('Side panel loaded');

let isRecording = false;

const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');
const transcriptsEl = document.getElementById('transcripts');

// Handle record button
recordBtn.addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'toggle_recording'
    });

    isRecording = response.recording;
    updateUI();
  } catch (error) {
    console.error('Failed to toggle recording:', error);
    statusEl.textContent = `Error: ${error.message}`;
  }
});

// Listen for transcripts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'transcript') {
    addTranscript(message.data);
  }
});

function updateUI() {
  if (isRecording) {
    recordBtn.textContent = '⏹️ Stop Recording';
    recordBtn.classList.add('recording');
    statusEl.textContent = 'Recording...';
    statusEl.classList.add('connected');
  } else {
    recordBtn.textContent = '🎤 Start Recording';
    recordBtn.classList.remove('recording');
    statusEl.textContent = 'Ready';
    statusEl.classList.remove('connected');
  }
}

function addTranscript(data) {
  const transcriptDiv = document.createElement('div');
  transcriptDiv.className = 'transcript';

  const textP = document.createElement('p');
  textP.className = 'transcript-text';
  textP.textContent = data.text;

  const timeDiv = document.createElement('div');
  timeDiv.className = 'transcript-time';
  timeDiv.textContent = new Date(data.timestamp * 1000).toLocaleTimeString();

  transcriptDiv.appendChild(textP);
  transcriptDiv.appendChild(timeDiv);

  transcriptsEl.insertBefore(transcriptDiv, transcriptsEl.firstChild);
}

// Initialize UI
updateUI();
```

---

## Testing Checklist

### Backend Tests

- [ ] `iex -S mix phx.server` starts without errors
- [ ] Can connect to socket from IEx test (see Task 1.4)
- [ ] Logs show "Audio channel joined" when connection made
- [ ] Channel echoes back fake transcript

### Extension Tests

- [ ] Extension builds: `npm run build`
- [ ] Extension loads in Chrome with no errors
- [ ] Open side panel shows UI
- [ ] Click "Start Recording" → browser requests mic permission
- [ ] Grant permission → button changes to "Stop Recording"
- [ ] Check service worker console: "Joined audio channel"
- [ ] Check Phoenix logs: "Audio channel joined: [uuid]"
- [ ] After 1-2 seconds: transcript appears in side panel
- [ ] Click "Stop Recording" → recording stops cleanly

### Integration Tests

- [ ] Audio flows: offscreen → service worker → Phoenix → service worker → sidepanel
- [ ] No memory leaks (check Chrome task manager after 5 min)
- [ ] Reconnection works if Phoenix server restarts
- [ ] Multiple start/stop cycles work correctly

---

## Notes & Learnings

### Audio Format Decisions

- **WebM/Opus**: Best browser support, OpenAI Whisper compatible
- **16kHz mono**: Optimal for speech recognition
- **1-second chunks**: Balance between latency and overhead

### Why No Auth?

Deferring auth to Sprint 05 allows us to:
1. Test audio pipeline independently
2. Iterate faster without token management
3. Add auth as an enhancement layer later

### Chrome Extension Gotchas

- **Offscreen document required**: Service workers can't access `getUserMedia`
- **Message serialization**: ArrayBuffers must be converted to Arrays for `chrome.runtime.sendMessage`
- **CSP restrictions**: Must explicitly allow `ws://localhost:4000` in manifest

### Phoenix Channel Notes

- Binary payloads are more efficient but harder to debug
- Use `handle_in("event", %{"data" => ...})` for JSON payloads
- Use `handle_in("event", {:binary, data})` for binary payloads

---

## Known Issues

1. **No error recovery**: If channel disconnects, must restart recording
2. **No audio buffering**: Chunks could be lost if network is slow
3. **No session persistence**: UUID session ID not stored anywhere

These will be addressed in later sprints.

---

## Reference Documentation

See [03_LIVEVIEW_PATTERNS.md](../03_LIVEVIEW_PATTERNS.md) for:
- Complete LiveView setup requirements
- Authentication patterns (for when we add auth in Sprint 05)
- Advanced streaming patterns
- Connection state management
- Offline handling

---

## Next Sprint

👉 [Sprint 02 - Transcription](./SPRINT_02_transcription.md)

**Focus:** Replace fake transcripts with real OpenAI Whisper API + GPT-4o note structuring
