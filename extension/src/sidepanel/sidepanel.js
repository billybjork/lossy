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
let tabChangedTimer = null; // Debounce timer for tab_changed messages
let pendingTabChange = null; // Store pending tab change data
const notesCache = new Map(); // Persist notes per video to avoid flicker on reloads
const transcriptsClearDelayMs = 250;
let scheduledTranscriptClear = null;

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
    const noteVideoId = message.data.video_id;

    if (noteVideoId) {
      const cacheResult = storeNoteInCache(noteVideoId, message.data);

      if (noteVideoId === displayedVideoDbId) {
        console.log('[SidePanel] 📝 Adding transcript for video', noteVideoId);
        addTranscript(message.data, { skipCache: true });
      } else if (cacheResult.added) {
        console.log('[SidePanel] 💾 Cached transcript for inactive video', noteVideoId);
      }
    } else {
      console.log('[SidePanel] ⚠️ Transcript missing video ID, skipping cache');
    }
  }

  // Listen for focus_note messages (from timeline marker clicks)
  if (message.action === 'focus_note') {
    highlightNote(message.noteId);
  }

  // Listen for tab changes (debounced to handle rapid messages)
  if (message.action === 'tab_changed') {
    // Store the latest tab change
    pendingTabChange = { tabId: message.tabId, videoContext: message.videoContext };

    // Clear existing timer
    if (tabChangedTimer) {
      clearTimeout(tabChangedTimer);
    }

    // Debounce: only handle after 100ms of no new tab_changed messages
    tabChangedTimer = setTimeout(() => {
      console.log('[SidePanel] 🔄 TAB_CHANGED (debounced): Processing tab', pendingTabChange.tabId);
      handleTabChanged(pendingTabChange.tabId, pendingTabChange.videoContext);
      pendingTabChange = null;
      tabChangedTimer = null;
    }, 100);
  }

  // Clear UI when content script initializes (new video loading)
  if (message.action === 'clear_ui') {
    console.log('[SidePanel] 🧹 CLEAR_UI: Clearing for new video');
    markTranscriptsLoading({ preserveContent: true });
    scheduleTranscriptClear();
    currentVideoContext = null;
    displayedVideoDbId = null;
    loadingSessionId++; // Invalidate any in-flight requests
    console.log('[SidePanel] 🧹 Loading session ID incremented to', loadingSessionId);
  }
});

async function handleTabChanged(tabId, videoContext) {
  console.log('[SidePanel] 🔄 TAB_CHANGED: Tab', tabId, 'with context:', videoContext);

  const newVideoDbId = videoContext?.videoDbId;
  const previousVideoDbId = displayedVideoDbId;
  const isSameVideo = previousVideoDbId === newVideoDbId;

  // Update state
  currentTabId = tabId;
  currentVideoContext = videoContext;
  cancelScheduledTranscriptClear();

  // If switching to a tab with a video
  if (newVideoDbId) {
    let hadCachedNotes = false;
    let hasCacheEntry = false;

    if (!isSameVideo) {
      hasCacheEntry = notesCache.has(newVideoDbId);
      hadCachedNotes = renderNotesFromCache(newVideoDbId);
      if (hadCachedNotes) {
        console.log('[SidePanel] ♻️ Restored cached notes for video', newVideoDbId);
      }

      displayedVideoDbId = newVideoDbId;
    } else {
      displayedVideoDbId = newVideoDbId;
      hasCacheEntry = notesCache.has(newVideoDbId);
      const cachedNotes = notesCache.get(newVideoDbId);
      hadCachedNotes = !!(cachedNotes && cachedNotes.length > 0);
    }

    // Request current timestamp for the newly active tab
    // This also serves as a liveness check for the content script
    console.log('[SidePanel] 🔄 Requesting timestamp for new active tab');
    try {
      const timestampResult = await chrome.runtime.sendMessage({ action: 'get_video_timestamp' });

      // If content script isn't responding (success: false), we have stale cached context
      // but no live content script - need to trigger fresh detection
      if (timestampResult && timestampResult.success === false) {
        console.log('[SidePanel] ⚠️ Content script not responding despite cached context - triggering detection');

        // Show detecting status
        videoTimestampEl.textContent = 'Video: Detecting...';

        // Trigger fresh detection to initialize content script
        const detectionResult = await chrome.runtime.sendMessage({ action: 'trigger_video_detection' });

        if (detectionResult?.success) {
          console.log('[SidePanel] ✅ Detection complete after finding stale context');
          // Wait for detection, then request timestamp again
          setTimeout(() => {
            chrome.runtime.sendMessage({ action: 'get_video_timestamp' })
              .catch(() => console.log('[SidePanel] Still could not get timestamp after detection'));
          }, 2000);
        }
      }
    } catch (err) {
      console.log('[SidePanel] Could not get timestamp for new tab:', err);
    }

    // If we're not currently displaying this video's notes, load them
    if (!hadCachedNotes && (!isSameVideo || !hasCacheEntry)) {
      console.log('[SidePanel] 🔄 Loading notes for video', newVideoDbId, '(was displaying:', previousVideoDbId, ')');

      // Show loading state while we fetch notes
      markTranscriptsLoading();
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
          if (transcriptsEl.classList.contains('is-loading')) {
            finalizeTranscriptRender();
          }
        } else {
          console.log('[SidePanel] ⚠️ Session', thisSessionId, 'was invalidated (now on session', loadingSessionId, ')');
        }
      } catch (err) {
        console.log('[SidePanel] ⚠️ Failed to request notes:', err);
      }
    }
  } else {
    // No cached video context - trigger fresh detection on this tab
    console.log('[SidePanel] 🔍 No cached context for tab, triggering fresh detection...');

    // Clear notes and timestamp while we detect
    clearTranscriptsImmediately();
    finalizeTranscriptRender();
    displayedVideoDbId = null;
    loadingSessionId++;
    videoTimestampEl.textContent = 'Video: Detecting...';
    videoTimestampEl.classList.remove('active');

    try {
      // Trigger detection on the newly active tab
      const result = await chrome.runtime.sendMessage({ action: 'trigger_video_detection' });

      if (result?.success) {
        console.log('[SidePanel] ✅ Video detection completed on new tab');

        // Wait a moment, then get context and timestamp
        setTimeout(async () => {
          try {
            // Request timestamp immediately
            chrome.runtime.sendMessage({ action: 'get_video_timestamp' })
              .catch(() => console.log('[SidePanel] Could not get timestamp'));

            // Get video context
            const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
            if (response.context) {
              currentVideoContext = response.context;
              const videoDbId = response.context.videoDbId;
              console.log('[SidePanel] ✅ Video context now available for switched tab:', videoDbId);

              // Load notes for this video
              if (videoDbId) {
                displayedVideoDbId = videoDbId;
                loadingSessionId++;
                const thisSessionId = loadingSessionId;

                chrome.runtime.sendMessage({
                  action: 'request_notes_for_sidepanel',
                  videoDbId: videoDbId,
                  tabId: tabId,
                  sessionId: thisSessionId
                }).catch(err => console.log('[SidePanel] Failed to load notes:', err));
              }
            } else {
              console.log('[SidePanel] No video detected on this tab');
              videoTimestampEl.textContent = 'Video: No video detected';
            }
          } catch (err) {
            console.log('[SidePanel] Could not get context after detection:', err);
            videoTimestampEl.textContent = 'Video: No video detected';
          }
        }, 2000);
      } else {
        console.log('[SidePanel] Video detection not available on this tab');
        videoTimestampEl.textContent = 'Video: No video detected';
      }
    } catch (err) {
      console.log('[SidePanel] Could not trigger detection:', err.message);
      videoTimestampEl.textContent = 'Video: No video detected';
    }
  }
}

function storeNoteInCache(videoDbId, noteData) {
  const existing = notesCache.get(videoDbId) || [];
  const existingIndex = existing.findIndex(note => note.id === noteData.id);

  if (existingIndex >= 0) {
    const updated = [...existing];
    updated[existingIndex] = { ...updated[existingIndex], ...noteData };
    notesCache.set(videoDbId, updated);
    return { added: false, count: updated.length };
  }

  const updated = [noteData, ...existing];
  notesCache.set(videoDbId, updated);
  return { added: true, count: updated.length };
}

function renderNotesFromCache(videoDbId) {
  cancelScheduledTranscriptClear();
  const cachedNotes = notesCache.get(videoDbId);

  if (!cachedNotes || cachedNotes.length === 0) {
    clearTranscriptsImmediately();
    finalizeTranscriptRender();
    return false;
  }

  const fragment = document.createDocumentFragment();
  cachedNotes.forEach(note => {
    fragment.appendChild(buildNoteElement(note));
  });

  transcriptsEl.replaceChildren(fragment);
  finalizeTranscriptRender();
  return true;
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

function addTranscript(data, options = {}) {
  const { skipCache = false, prepend = true } = options;

  if (!skipCache && data.video_id) {
    storeNoteInCache(data.video_id, data);
  }

  const existing = transcriptsEl.querySelector(`[data-note-id="${data.id}"]`);
  if (existing) {
    console.log('[SidePanel] ℹ️ Note', data.id, 'already displayed, updating content');
    updateNoteElement(existing, data);
    return;
  }

  const noteDiv = buildNoteElement(data);

  if (prepend && transcriptsEl.firstChild) {
    transcriptsEl.insertBefore(noteDiv, transcriptsEl.firstChild);
  } else {
    transcriptsEl.appendChild(noteDiv);
  }

  finalizeTranscriptRender();
}

function buildNoteElement(data) {
  const noteDiv = document.createElement('div');
  noteDiv.className = 'note-item';
  noteDiv.dataset.noteId = data.id;

  if (data.timestamp_seconds != null) {
    noteDiv.dataset.timestamp = data.timestamp_seconds;
  }

  const categoryDiv = document.createElement('div');
  categoryDiv.className = 'note-category';
  categoryDiv.textContent = data.category || 'note';

  let timestampDiv = null;
  if (data.timestamp_seconds != null) {
    timestampDiv = document.createElement('div');
    timestampDiv.className = 'note-timestamp';
    timestampDiv.textContent = formatTimestamp(data.timestamp_seconds);
  }

  const textP = document.createElement('div');
  textP.className = 'note-text';
  textP.textContent = data.text;

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

  if (data.timestamp_seconds != null) {
    noteDiv.style.cursor = 'pointer';
    noteDiv.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'note_clicked',
        timestamp: data.timestamp_seconds
      });

      highlightNote(data.id);
    });
  }

  return noteDiv;
}

function updateNoteElement(element, data) {
  if (data.timestamp_seconds != null) {
    element.dataset.timestamp = data.timestamp_seconds;
  } else if (element.dataset.timestamp) {
    delete element.dataset.timestamp;
  }

  const categoryEl = element.querySelector('.note-category');
  if (categoryEl) {
    categoryEl.textContent = data.category || 'note';
  }

  const textEl = element.querySelector('.note-text');
  if (textEl) {
    textEl.textContent = data.text;

    if (data.confidence != null) {
      let confidenceEl = textEl.querySelector('.note-confidence');
      if (!confidenceEl) {
        confidenceEl = document.createElement('div');
        confidenceEl.className = 'note-confidence';
        textEl.appendChild(confidenceEl);
      }
      confidenceEl.textContent = `Confidence: ${Math.round(data.confidence * 100)}%`;
    }
  }

  const timestampEl = element.querySelector('.note-timestamp');
  if (timestampEl) {
    if (data.timestamp_seconds != null) {
      timestampEl.textContent = formatTimestamp(data.timestamp_seconds);
    } else {
      timestampEl.remove();
    }
  }

  finalizeTranscriptRender();
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
updateTranscriptEmptyState();

function markTranscriptsLoading(options = {}) {
  const { preserveContent = false } = options;
  transcriptsEl.classList.add('is-loading');
  transcriptsEl.classList.remove('is-empty');

  if (!preserveContent) {
    transcriptsEl.replaceChildren();
    updateTranscriptEmptyState();
  }
}

function finalizeTranscriptRender() {
  transcriptsEl.classList.remove('is-loading');
  cancelScheduledTranscriptClear();
  updateTranscriptEmptyState();
}

function scheduleTranscriptClear(delay = transcriptsClearDelayMs) {
  cancelScheduledTranscriptClear();
  scheduledTranscriptClear = setTimeout(() => {
    transcriptsEl.replaceChildren();
    transcriptsEl.classList.remove('is-loading');
    updateTranscriptEmptyState();
    scheduledTranscriptClear = null;
  }, delay);
}

function cancelScheduledTranscriptClear() {
  if (scheduledTranscriptClear) {
    clearTimeout(scheduledTranscriptClear);
    scheduledTranscriptClear = null;
  }
}

function clearTranscriptsImmediately() {
  cancelScheduledTranscriptClear();
  transcriptsEl.replaceChildren();
  updateTranscriptEmptyState();
}

function updateTranscriptEmptyState() {
  const isEmpty = transcriptsEl.childElementCount === 0;
  transcriptsEl.classList.toggle('is-empty', isEmpty);
}
