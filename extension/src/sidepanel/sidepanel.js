// Extension Side Panel JavaScript (extension/src/sidepanel/)
//
// Purpose: Client-side UI for extension side panel
// - Currently: Vanilla JS communicating with service worker
// - Future: Will bundle phoenix.js and connect to LiveView backend via WebSocket
//
// Architecture:
// - Runs in extension context (chrome-extension:// origin)
// - Communicates with service worker (chrome.runtime.sendMessage)
// - Will connect to Phoenix backend at wss://... for LiveView streaming
//
// See docs/03_LIVEVIEW_PATTERNS.md for LiveView integration pattern

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

    if (response.success === false) {
      console.error('Recording failed:', response.error);
      statusEl.textContent = `Error: ${response.error}`;
      statusEl.classList.remove('connected');
      isRecording = false;
      updateUI();
      return;
    }

    isRecording = response.recording;
    updateUI();
  } catch (error) {
    console.error('Failed to toggle recording:', error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.classList.remove('connected');
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
