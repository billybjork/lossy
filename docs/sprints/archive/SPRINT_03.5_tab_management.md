# Sprint 03.5: Tab Management & Context Switching

**Status:** 🚧 In Progress
**Started:** 2025-10-15
**Estimated Duration:** 2-3 days

---

## Goal

Implement intelligent tab tracking so the side panel automatically syncs to the active tab's video and notes. Each tab maintains its own independent recording state and note collection. Users can switch between tabs seamlessly, with the side panel always showing content relevant to the current video.

---

## Prerequisites

- ✅ Sprint 03 complete (video integration & timeline markers working)
- ✅ Notes linked to videos in database
- ✅ Bidirectional navigation (note → video, marker → note) working

---

## Core Features

### 1. Per-Tab Video Context Tracking
- Service worker maintains map: `tabId → { videoDbId, platform, videoId, url, title }`
- Each tab tracks its own current video
- Tab video context persists across page reloads (chrome.storage)

### 2. Per-Tab Recording State
- Recording state tied to specific tab
- Can't start recording in Tab A while Tab B is recording (global constraint)
- Switching tabs during recording → shows recording state in original tab only

### 3. Side Panel Auto-Sync
- Listens to `chrome.tabs.onActivated` (tab switch)
- Listens to `chrome.tabs.onUpdated` (URL change within tab)
- Automatically loads notes for active tab's video
- Visual indicator shows which tab/video is active

### 4. Tab Switcher UI (Optional Enhancement)
- Side panel header shows tabs with videos
- Click tab → switches browser to that tab
- Shows video thumbnail, title, note count per tab
- Highlights active tab

---

## Deliverables

- [ ] `TabManager` class in service worker (state tracking)
- [ ] `chrome.tabs.onActivated` listener (tab switch detection)
- [ ] `chrome.tabs.onUpdated` listener (URL change detection)
- [ ] Per-tab video context persistence (chrome.storage.local)
- [ ] Side panel syncs to active tab automatically
- [ ] Side panel displays active video title/metadata
- [ ] Side panel filters notes by active video
- [ ] Tab switcher UI component (optional)
- [ ] Recording state per-tab enforcement

---

## Technical Architecture

### State Management

```
Service Worker (Background)
├─ TabManager
│  ├─ tabVideoMap: Map<tabId, VideoContext>
│  │  └─ VideoContext { videoDbId, platform, videoId, url, title, recordingState }
│  ├─ activeTabId: number
│  └─ recordingTabId: number | null
│
└─ Persistence (chrome.storage.local)
   └─ "tab_video_contexts" → serialized tabVideoMap
```

### Message Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      USER SWITCHES TAB                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
                 chrome.tabs.onActivated
                           │
                           ▼
                   ┌───────────────┐
                   │  TabManager   │
                   │ (Service Worker)│
                   └───────────────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
                 ▼                   ▼
        Update activeTabId    Fetch notes for
                              active tab's video
                                     │
                                     ▼
                             ┌──────────────┐
                             │  Side Panel  │
                             │ (Update UI)  │
                             └──────────────┘
                                     │
                                     ▼
                         Display notes for active video
                         Update header with video title
```

---

## Implementation Tasks

### Task 1: TabManager Class (Service Worker)

**File:** `extension/src/background/tab-manager.js` (new)

```javascript
/**
 * TabManager - Tracks video context and recording state per tab.
 * Persists state to chrome.storage for recovery after extension reload.
 */
export class TabManager {
  constructor() {
    this.tabVideoMap = new Map(); // tabId → VideoContext
    this.activeTabId = null;
    this.recordingTabId = null;
    this.init();
  }

  async init() {
    // Load persisted state
    const { tab_video_contexts } = await chrome.storage.local.get('tab_video_contexts');
    if (tab_video_contexts) {
      this.tabVideoMap = new Map(Object.entries(tab_video_contexts).map(([k, v]) => [parseInt(k), v]));
      console.log('[TabManager] Loaded persisted contexts:', this.tabVideoMap.size, 'tabs');
    }

    // Set initial active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      this.activeTabId = tabs[0].id;
    }

    // Listen for tab events
    this.setupListeners();
  }

  setupListeners() {
    // Tab activated (user switched tabs)
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      console.log('[TabManager] Tab activated:', activeInfo.tabId);
      this.activeTabId = activeInfo.tabId;
      await this.onTabChanged(activeInfo.tabId);
    });

    // Tab updated (URL changed, page loaded, etc)
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      // Only care about URL changes and completed loads
      if (changeInfo.url || (changeInfo.status === 'complete' && tab.active)) {
        console.log('[TabManager] Tab updated:', tabId, changeInfo);
        await this.onTabChanged(tabId);
      }
    });

    // Tab removed (user closed tab)
    chrome.tabs.onRemoved.addListener((tabId) => {
      console.log('[TabManager] Tab removed:', tabId);
      this.removeTab(tabId);
    });
  }

  async onTabChanged(tabId) {
    // Notify side panel to sync to this tab
    chrome.runtime.sendMessage({
      action: 'tab_changed',
      tabId: tabId,
      videoContext: this.getVideoContext(tabId)
    }).catch(() => {
      // Side panel may not be open, that's OK
    });
  }

  setVideoContext(tabId, videoContext) {
    this.tabVideoMap.set(tabId, {
      ...videoContext,
      recordingState: this.tabVideoMap.get(tabId)?.recordingState || 'idle'
    });
    this.persist();
    console.log('[TabManager] Video context set for tab', tabId, ':', videoContext);
  }

  getVideoContext(tabId) {
    return this.tabVideoMap.get(tabId) || null;
  }

  getActiveVideoContext() {
    return this.getVideoContext(this.activeTabId);
  }

  removeTab(tabId) {
    this.tabVideoMap.delete(tabId);
    this.persist();

    // If recording tab was closed, reset recording state
    if (this.recordingTabId === tabId) {
      this.recordingTabId = null;
    }
  }

  startRecording(tabId) {
    // Only one tab can record at a time
    if (this.recordingTabId !== null && this.recordingTabId !== tabId) {
      throw new Error(`Tab ${this.recordingTabId} is already recording`);
    }

    this.recordingTabId = tabId;
    const context = this.tabVideoMap.get(tabId);
    if (context) {
      context.recordingState = 'recording';
      this.persist();
    }

    console.log('[TabManager] Recording started on tab', tabId);
  }

  stopRecording(tabId) {
    if (this.recordingTabId !== tabId) {
      console.warn('[TabManager] Attempted to stop recording on non-recording tab', tabId);
      return;
    }

    this.recordingTabId = null;
    const context = this.tabVideoMap.get(tabId);
    if (context) {
      context.recordingState = 'idle';
      this.persist();
    }

    console.log('[TabManager] Recording stopped on tab', tabId);
  }

  isRecording(tabId) {
    return this.recordingTabId === tabId;
  }

  getRecordingTabId() {
    return this.recordingTabId;
  }

  getAllTabs() {
    return Array.from(this.tabVideoMap.entries()).map(([tabId, context]) => ({
      tabId,
      ...context
    }));
  }

  async persist() {
    // Convert Map to object for storage
    const obj = Object.fromEntries(this.tabVideoMap);
    await chrome.storage.local.set({ tab_video_contexts: obj });
  }
}
```

---

### Task 2: Service Worker Integration

**File:** `extension/src/background/service-worker.js` (update)

```javascript
import { TabManager } from './tab-manager.js';

// ... existing imports ...

let tabManager = null;
let currentVideo = null; // DEPRECATED - use tabManager instead
let currentTimestamp = null;

// Initialize TabManager
(async () => {
  tabManager = new TabManager();
  console.log('[ServiceWorker] TabManager initialized');
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  // Video detected from content script
  if (message.action === 'video_detected') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return false;
    }

    const videoData = message.data;
    console.log('[ServiceWorker] Video detected in tab', tabId, ':', videoData);

    // Send to backend VideoChannel
    if (socket && socket.isConnected()) {
      const videoChannel = socket.channel('video:meta', {});
      videoChannel.join()
        .receive('ok', () => {
          videoChannel.push('video_detected', videoData)
            .receive('ok', (response) => {
              console.log('[ServiceWorker] Video record created:', response);

              // Store in TabManager
              tabManager.setVideoContext(tabId, {
                videoDbId: response.video_id,
                platform: videoData.platform,
                videoId: videoData.videoId,
                url: videoData.url,
                title: videoData.title
              });

              // Return DB ID to content script
              sendResponse({ videoDbId: response.video_id });

              // Request existing notes for this video
              videoChannel.push('get_notes', { video_id: response.video_id })
                .receive('ok', (notesResponse) => {
                  // Send notes to content script for timeline markers
                  chrome.tabs.sendMessage(tabId, {
                    action: 'load_markers',
                    notes: notesResponse.notes
                  }).catch(() => {});

                  // Also send to side panel if it's open
                  chrome.runtime.sendMessage({
                    action: 'notes_loaded',
                    tabId: tabId,
                    notes: notesResponse.notes
                  }).catch(() => {});
                });
            })
            .receive('error', (err) => {
              console.error('[ServiceWorker] Failed to create video record:', err);
              sendResponse({ error: err });
            });
        });
    } else {
      sendResponse({ error: 'Socket not connected' });
    }

    return true; // Keep channel open for async response
  }

  // Get active tab context (from side panel)
  if (message.action === 'get_active_tab_context') {
    const context = tabManager.getActiveVideoContext();
    sendResponse({ context });
    return false;
  }

  // Get all tabs with videos (for tab switcher UI)
  if (message.action === 'get_all_tabs') {
    const tabs = tabManager.getAllTabs();
    sendResponse({ tabs });
    return false;
  }

  // Switch to specific tab (from side panel tab switcher)
  if (message.action === 'switch_to_tab') {
    chrome.tabs.update(message.tabId, { active: true });
    sendResponse({ success: true });
    return false;
  }
});

// Update startRecording to use TabManager
async function startRecording() {
  console.log('[ServiceWorker] Starting recording...');

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    console.error('[ServiceWorker] No active tab');
    return;
  }

  // Check if another tab is recording
  const recordingTabId = tabManager.getRecordingTabId();
  if (recordingTabId !== null && recordingTabId !== tab.id) {
    console.error('[ServiceWorker] Tab', recordingTabId, 'is already recording');
    // TODO: Show error to user
    return;
  }

  // Mark tab as recording
  tabManager.startRecording(tab.id);

  // Get video context for this tab
  const videoContext = tabManager.getVideoContext(tab.id);

  // Notify content script to pause video
  chrome.tabs.sendMessage(tab.id, { action: 'recording_started' })
    .catch((err) => console.log('[ServiceWorker] No content script on this page'));

  // ... rest of existing startRecording code ...

  // Pass video context to AgentSession
  const sessionId = crypto.randomUUID();
  audioChannel = socket.channel(`audio:${sessionId}`, {
    video_id: videoContext?.videoDbId,
    timestamp: currentTimestamp,
    tab_id: tab.id
  });

  // Listen for note created event
  audioChannel.on('note_created', (payload) => {
    console.log('[ServiceWorker] Note created:', payload);

    // Forward to side panel
    chrome.runtime.sendMessage({
      action: 'transcript',
      data: payload,
      tabId: tab.id
    });

    // Forward to content script for timeline marker
    chrome.tabs.sendMessage(tab.id, {
      action: 'note_created',
      data: payload
    }).catch(() => {});
  });

  // ... rest of channel setup ...
}

async function stopRecording() {
  console.log('[ServiceWorker] Stopping recording...');

  // Get recording tab
  const recordingTabId = tabManager.getRecordingTabId();
  if (recordingTabId === null) {
    console.warn('[ServiceWorker] No recording in progress');
    return;
  }

  // Mark tab as idle
  tabManager.stopRecording(recordingTabId);

  // Notify content script to resume video
  chrome.tabs.sendMessage(recordingTabId, { action: 'recording_stopped' })
    .catch((err) => console.log('[ServiceWorker] Content script not available'));

  // ... rest of existing stopRecording code ...
}
```

---

### Task 3: Side Panel Auto-Sync

**File:** `extension/src/sidepanel/sidepanel.js` (update)

```javascript
// ... existing code ...

let currentTabId = null;
let currentVideoContext = null;
let allNotes = []; // All notes for current video

// Initialize side panel
async function init() {
  console.log('[SidePanel] Initializing...');

  // Get active tab context
  const { context } = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
  currentVideoContext = context;

  if (context) {
    updateHeader(context);
    await loadNotesForVideo(context.videoDbId);
  }

  // Listen for tab changes
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'tab_changed') {
      handleTabChanged(message.tabId, message.videoContext);
    }

    if (message.action === 'notes_loaded') {
      if (message.tabId === currentTabId) {
        renderNotes(message.notes);
      }
    }

    if (message.action === 'transcript') {
      // Only show notes for current tab
      if (message.tabId === currentTabId || !message.tabId) {
        addNote(message.data);
      }
    }
  });
}

function handleTabChanged(tabId, videoContext) {
  console.log('[SidePanel] Tab changed:', tabId, videoContext);

  currentTabId = tabId;
  currentVideoContext = videoContext;

  if (videoContext) {
    updateHeader(videoContext);
    loadNotesForVideo(videoContext.videoDbId);
  } else {
    // No video on this tab
    updateHeader(null);
    clearNotes();
  }
}

function updateHeader(videoContext) {
  const headerEl = document.getElementById('video-header');
  if (!headerEl) return;

  if (videoContext) {
    headerEl.innerHTML = `
      <div class="video-platform">${videoContext.platform}</div>
      <div class="video-title">${videoContext.title || 'Untitled Video'}</div>
      <div class="video-url">${truncateUrl(videoContext.url)}</div>
    `;
    headerEl.style.display = 'block';
  } else {
    headerEl.innerHTML = '<div class="no-video">No video on this page</div>';
  }
}

function truncateUrl(url) {
  if (!url) return '';
  return url.length > 50 ? url.slice(0, 50) + '...' : url;
}

async function loadNotesForVideo(videoDbId) {
  if (!videoDbId) {
    clearNotes();
    return;
  }

  // Request notes from backend via service worker
  // (Service worker will fetch from VideoChannel)
  // For now, notes are loaded via 'notes_loaded' message
  console.log('[SidePanel] Loading notes for video:', videoDbId);
}

function clearNotes() {
  allNotes = [];
  const notesContainer = document.getElementById('notes-container');
  if (notesContainer) {
    notesContainer.innerHTML = '<div class="no-notes">No notes yet</div>';
  }
}

function renderNotes(notes) {
  allNotes = notes;
  const notesContainer = document.getElementById('notes-container');
  if (!notesContainer) return;

  if (notes.length === 0) {
    notesContainer.innerHTML = '<div class="no-notes">No notes yet</div>';
    return;
  }

  notesContainer.innerHTML = '';
  notes.forEach(note => {
    notesContainer.appendChild(renderNote(note));
  });
}

function addNote(note) {
  allNotes.push(note);
  const notesContainer = document.getElementById('notes-container');
  if (!notesContainer) return;

  // Remove "no notes" message
  const noNotesEl = notesContainer.querySelector('.no-notes');
  if (noNotesEl) {
    noNotesEl.remove();
  }

  notesContainer.appendChild(renderNote(note));
}

// ... existing renderNote, highlightNote functions ...

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

**File:** `extension/src/sidepanel/sidepanel.html` (add header)

```html
<!DOCTYPE html>
<html>
<head>
  <title>Lossy - Voice Video Companion</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #ffffff;
    }

    #video-header {
      padding: 16px;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
      margin-bottom: 16px;
    }

    .video-platform {
      display: inline-block;
      padding: 2px 8px;
      background: #3b82f6;
      color: white;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .video-title {
      font-size: 14px;
      font-weight: 600;
      color: #111827;
      margin-bottom: 4px;
    }

    .video-url {
      font-size: 11px;
      color: #6b7280;
      font-family: 'Courier New', monospace;
    }

    .no-video {
      font-size: 13px;
      color: #9ca3af;
      text-align: center;
      padding: 12px;
    }

    #recording-controls {
      padding: 16px;
      border-bottom: 1px solid #e5e7eb;
    }

    #notes-container {
      padding: 16px;
    }

    .no-notes {
      font-size: 13px;
      color: #9ca3af;
      text-align: center;
      padding: 24px;
    }

    /* ... existing note styles ... */
  </style>
</head>
<body>
  <div id="video-header"></div>

  <div id="recording-controls">
    <button id="record-btn">Start Recording</button>
    <span id="status">Ready</span>
  </div>

  <div id="notes-container"></div>

  <script src="sidepanel.js"></script>
</body>
</html>
```

---

### Task 4: Tab Switcher UI (Optional Enhancement)

**File:** `extension/src/sidepanel/sidepanel.html` (add tab switcher)

```html
<div id="tab-switcher">
  <div id="tab-list"></div>
</div>

<style>
  #tab-switcher {
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    max-height: 200px;
    overflow-y: auto;
  }

  .tab-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    margin-bottom: 6px;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
  }

  .tab-item:hover {
    background: #f3f4f6;
  }

  .tab-item.active {
    border-color: #3b82f6;
    background: #eff6ff;
  }

  .tab-platform {
    display: inline-block;
    padding: 2px 6px;
    background: #3b82f6;
    color: white;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .tab-title {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    color: #374151;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-note-count {
    font-size: 11px;
    color: #6b7280;
    background: #f3f4f6;
    padding: 2px 8px;
    border-radius: 12px;
  }
</style>
```

**File:** `extension/src/sidepanel/sidepanel.js` (add tab switcher logic)

```javascript
async function renderTabSwitcher() {
  const { tabs } = await chrome.runtime.sendMessage({ action: 'get_all_tabs' });
  const tabList = document.getElementById('tab-list');
  if (!tabList) return;

  tabList.innerHTML = '';

  tabs.forEach(tab => {
    const tabItem = document.createElement('div');
    tabItem.className = 'tab-item';
    if (tab.tabId === currentTabId) {
      tabItem.classList.add('active');
    }

    tabItem.innerHTML = `
      <span class="tab-platform">${tab.platform}</span>
      <div class="tab-title">${tab.title || 'Untitled'}</div>
      <span class="tab-note-count">0 notes</span>
    `;

    tabItem.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'switch_to_tab',
        tabId: tab.tabId
      });
    });

    tabList.appendChild(tabItem);
  });
}

// Refresh tab switcher when tabs change
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'tab_changed') {
    renderTabSwitcher();
  }
});
```

---

## Testing Checklist

### Tab Tracking
- [ ] Open YouTube video in Tab 1 → TabManager records video context
- [ ] Open different YouTube video in Tab 2 → TabManager tracks separate context
- [ ] Switch between tabs → side panel updates automatically
- [ ] Close Tab 1 → TabManager removes context
- [ ] Reload extension → tab contexts persist (chrome.storage)

### Per-Tab Recording State
- [ ] Start recording in Tab 1 → recording state set for Tab 1
- [ ] Switch to Tab 2 → recording continues in Tab 1 (background)
- [ ] Attempt recording in Tab 2 → blocked (only one tab can record)
- [ ] Return to Tab 1 → still recording, can stop
- [ ] Stop recording in Tab 1 → state reset, Tab 2 can now record

### Side Panel Sync
- [ ] Active tab has video → side panel shows video title/platform
- [ ] Active tab has no video → side panel shows "No video"
- [ ] Switch to tab with existing notes → notes load automatically
- [ ] New note created in Tab 1 → only shows when Tab 1 is active
- [ ] Tab Switcher shows all tabs with videos

### Edge Cases
- [ ] Recording in Tab 1, close Tab 1 → recording stops gracefully
- [ ] No tabs with videos → tab switcher empty
- [ ] Same video in multiple tabs → separate note collections per tab
- [ ] URL change within tab → video context updates

---

## Success Criteria

✅ **Sprint complete when:**
1. Each tab maintains its own video context
2. Side panel syncs to active tab automatically
3. Recording state enforced per-tab (one at a time globally)
4. Tab contexts persist across extension reloads
5. Side panel header shows active video metadata
6. Notes filtered by active tab's video
7. Tab switcher UI functional (optional)

---

## Next Sprint

👉 [Sprint 04 - Auto-Posting](./SPRINT_04_auto_posting.md)

**Focus:** Browserbase automation to post notes as comments on video platforms
