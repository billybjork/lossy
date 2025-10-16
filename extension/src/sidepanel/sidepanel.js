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
let currentTabId = null;
let currentVideoContext = null;
let displayedVideoDbId = null; // Track which video's notes are currently displayed
let loadingSessionId = 0; // Increment this to invalidate in-flight note requests

const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');
const transcriptsEl = document.getElementById('transcripts');
const videoTimestampEl = document.getElementById('videoTimestamp');

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

// Initialize side panel
async function init() {
  console.log('[SidePanel] Initializing...');

  // Request initial timestamp immediately (in parallel with detection)
  // This ensures timecode appears as fast as notes
  console.log('[SidePanel] Requesting initial timestamp...');
  chrome.runtime.sendMessage({ action: 'get_video_timestamp' })
    .catch(() => console.log('[SidePanel] Could not get initial timestamp'));

  // Always trigger fresh detection to ensure content script is alive
  // This handles the case where cached context exists but content script is orphaned
  console.log('[SidePanel] Triggering fresh video detection...');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'trigger_video_detection' });

    if (result?.success) {
      console.log('[SidePanel] ✅ Video detection completed successfully');

      // Wait a moment for detection to complete, then get context
      setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
          if (response.context) {
            currentVideoContext = response.context;
            console.log('[SidePanel] ✅ Video context available:', currentVideoContext);
          } else {
            console.log('[SidePanel] No video detected on this page');
          }
        } catch (err) {
          console.log('[SidePanel] Could not get video context:', err);
        }
      }, 2000); // Increased to 2s to allow detection to complete
    } else {
      console.log('[SidePanel] Video detection not available on this page');
    }
  } catch (err) {
    console.log('[SidePanel] Could not trigger video detection:', err.message);

    // Fallback: try to get cached context anyway (might work if content script is alive)
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
      if (response.context) {
        currentVideoContext = response.context;
        console.log('[SidePanel] Using cached video context:', currentVideoContext);
      }
    } catch (err2) {
      console.error('[SidePanel] Failed to get any video context:', err2);
    }
  }
}

// Listen for transcripts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'transcript') {
    // Only add transcript if it belongs to the currently displayed video
    const noteVideoId = message.data.video_id;
    if (noteVideoId === displayedVideoDbId) {
      console.log('[SidePanel] 📝 Adding transcript for video', noteVideoId);
      addTranscript(message.data);
    } else {
      console.log('[SidePanel] ⚠️ Ignoring transcript for video', noteVideoId, '(displaying:', displayedVideoDbId, ')');
    }
  }

  // Listen for focus_note messages (from timeline marker clicks)
  if (message.action === 'focus_note') {
    highlightNote(message.noteId);
  }

  // Listen for tab changes
  if (message.action === 'tab_changed') {
    handleTabChanged(message.tabId, message.videoContext);
  }

  // Clear UI when content script initializes (new video loading)
  if (message.action === 'clear_ui') {
    console.log('[SidePanel] 🧹 CLEAR_UI: Clearing for new video');
    transcriptsEl.innerHTML = '';
    currentVideoContext = null;
    displayedVideoDbId = null;
    loadingSessionId++; // Invalidate any in-flight requests
    console.log('[SidePanel] 🧹 Loading session ID incremented to', loadingSessionId);
  }
});

async function handleTabChanged(tabId, videoContext) {
  console.log('[SidePanel] 🔄 TAB_CHANGED: Tab', tabId, 'with context:', videoContext);

  const newVideoDbId = videoContext?.videoDbId;

  // Update state
  currentTabId = tabId;
  currentVideoContext = videoContext;

  // If switching to a tab with a video
  if (newVideoDbId) {
    // If we're not currently displaying this video's notes, load them
    if (displayedVideoDbId !== newVideoDbId) {
      console.log('[SidePanel] 🔄 Loading notes for video', newVideoDbId, '(was displaying:', displayedVideoDbId, ')');

      // Clear existing notes and invalidate old requests
      transcriptsEl.innerHTML = '';
      displayedVideoDbId = newVideoDbId;
      loadingSessionId++; // Invalidate any in-flight requests from previous video
      const thisSessionId = loadingSessionId;
      console.log('[SidePanel] 🔄 Started loading session', thisSessionId, 'for video', newVideoDbId);

      // Request notes for this video
      try {
        console.log('[SidePanel] 🔄 Requesting notes for video', newVideoDbId);
        await chrome.runtime.sendMessage({
          action: 'request_notes_for_sidepanel',
          videoDbId: newVideoDbId,
          tabId: tabId,
          sessionId: thisSessionId
        });

        // Check if we're still on the same session (user didn't navigate away)
        if (loadingSessionId === thisSessionId) {
          console.log('[SidePanel] ✅ Notes loaded successfully for session', thisSessionId);
        } else {
          console.log('[SidePanel] ⚠️ Session', thisSessionId, 'was invalidated (now on session', loadingSessionId, ')');
        }
      } catch (err) {
        console.log('[SidePanel] ⚠️ Failed to request notes:', err);
      }
    } else {
      console.log('[SidePanel] ℹ️ Already displaying notes for video', newVideoDbId);
    }
  } else {
    // Switched to a tab without a video - clear notes
    console.log('[SidePanel] 🧹 Tab has no video context, clearing notes');
    transcriptsEl.innerHTML = '';
    displayedVideoDbId = null;
    loadingSessionId++;
  }
}

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
  const noteDiv = document.createElement('div');
  noteDiv.className = 'note-item';
  noteDiv.dataset.noteId = data.id;

  if (data.timestamp_seconds != null) {
    noteDiv.dataset.timestamp = data.timestamp_seconds;
  }

  // Category badge
  const categoryDiv = document.createElement('div');
  categoryDiv.className = 'note-category';
  categoryDiv.textContent = data.category || 'note';

  // Timestamp (if available)
  let timestampDiv = null;
  if (data.timestamp_seconds != null) {
    timestampDiv = document.createElement('div');
    timestampDiv.className = 'note-timestamp';
    timestampDiv.textContent = formatTimestamp(data.timestamp_seconds);
  }

  // Text content
  const textP = document.createElement('div');
  textP.className = 'note-text';
  textP.textContent = data.text;

  // Confidence (optional, for debugging)
  if (data.confidence != null) {
    const confidenceDiv = document.createElement('div');
    confidenceDiv.className = 'note-confidence';
    confidenceDiv.textContent = `Confidence: ${Math.round(data.confidence * 100)}%`;
    textP.appendChild(confidenceDiv);
  }

  noteDiv.appendChild(categoryDiv);
  if (timestampDiv) {
    noteDiv.appendChild(timestampDiv);
  }
  noteDiv.appendChild(textP);

  // Click to seek video (if timestamp available)
  if (data.timestamp_seconds != null) {
    noteDiv.style.cursor = 'pointer';
    noteDiv.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'note_clicked',
        timestamp: data.timestamp_seconds
      });

      // Visual feedback
      highlightNote(data.id);
    });
  }

  transcriptsEl.insertBefore(noteDiv, transcriptsEl.firstChild);
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function highlightNote(noteId) {
  // Remove previous highlights
  document.querySelectorAll('.note-item').forEach(el => {
    el.classList.remove('highlighted');
  });

  // Highlight selected note
  const noteEl = document.querySelector(`[data-note-id="${noteId}"]`);
  if (noteEl) {
    noteEl.classList.add('highlighted');
    noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Remove highlight after 2 seconds
    setTimeout(() => {
      noteEl.classList.remove('highlighted');
    }, 2000);
  }
}

// Listen for timestamp updates (push-based, no polling)
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'video_timestamp_update') {
    if (message.timestamp != null) {
      videoTimestampEl.textContent = `Video: ${formatTimestamp(message.timestamp)}`;
      videoTimestampEl.classList.add('active');
    } else {
      videoTimestampEl.textContent = 'Video: No video detected';
      videoTimestampEl.classList.remove('active');
    }
  }
});

// Initialize
init();
updateUI();
