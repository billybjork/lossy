/**
 * TabManager - Tracks video context and recording state per tab.
 * Persists state to chrome.storage for recovery after extension reload.
 */
export class TabManager {
  constructor() {
    this.tabVideoMap = new Map(); // tabId → VideoContext
    this.activeTabId = null;
    this.recordingTabId = null;
  }

  async init() {
    console.log('[TabManager] Initializing...');

    // Load persisted state from local storage
    try {
      const { tab_video_contexts } = await chrome.storage.local.get('tab_video_contexts');
      if (tab_video_contexts) {
        // Convert object back to Map
        this.tabVideoMap = new Map(
          Object.entries(tab_video_contexts).map(([k, v]) => [parseInt(k), v])
        );
        console.log('[TabManager] Loaded persisted contexts:', this.tabVideoMap.size, 'tabs');

        // Clean up any stale recording states (extension reload clears recording)
        for (const [tabId, context] of this.tabVideoMap.entries()) {
          if (context.recordingState === 'recording') {
            context.recordingState = 'idle';
          }
        }
      }
    } catch (err) {
      console.error('[TabManager] Failed to load persisted state:', err);
      // Continue with empty state
    }

    // Load recording state from session storage (survives service worker restart)
    try {
      const { recording_tab_id } = await chrome.storage.session.get('recording_tab_id');
      if (recording_tab_id) {
        this.recordingTabId = recording_tab_id;
        console.log('[TabManager] Restored recording state for tab', recording_tab_id);
      }
    } catch (err) {
      console.error('[TabManager] Failed to restore session state:', err);
    }

    // Set initial active tab
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        this.activeTabId = tabs[0].id;
        console.log('[TabManager] Initial active tab:', this.activeTabId);
      }
    } catch (err) {
      console.error('[TabManager] Failed to get active tab:', err);
    }

    // Setup listeners
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

        // If URL changed, clear the video context (new video might be detected)
        if (changeInfo.url) {
          this.clearVideoContext(tabId);
        }

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
    const existing = this.tabVideoMap.get(tabId);
    this.tabVideoMap.set(tabId, {
      ...videoContext,
      recordingState: existing?.recordingState || 'idle',
      lastUpdated: Date.now() // Track when context was set
    });
    this.persist();
    console.log('[TabManager] Video context set for tab', tabId);

    // If this is the active tab, notify side panel
    if (tabId === this.activeTabId) {
      this.onTabChanged(tabId);
    }
  }

  getVideoContext(tabId) {
    return this.tabVideoMap.get(tabId) || null;
  }

  getActiveVideoContext() {
    return this.getVideoContext(this.activeTabId);
  }

  clearVideoContext(tabId) {
    const existing = this.tabVideoMap.get(tabId);

    // DON'T delete immediately - mark as "stale" and wait for replacement
    if (existing) {
      existing.stale = true;
      existing.staleTimestamp = Date.now();
      console.log('[TabManager] Marked video context as stale for tab', tabId);

      // Delete after timeout if no replacement
      setTimeout(() => {
        const current = this.tabVideoMap.get(tabId);
        if (current && current.stale && current.staleTimestamp === existing.staleTimestamp) {
          console.log('[TabManager] Deleting stale context for tab', tabId);
          this.tabVideoMap.delete(tabId);
          this.persist();
        }
      }, 10000); // 10s grace period

      // Tell content script to clear timeline markers
      chrome.tabs.sendMessage(tabId, {
        action: 'clear_markers'
      }).catch(err => {
        console.log('[TabManager] Could not send clear_markers (content script may not be loaded yet):', err);
      });

      // If this is the active tab, immediately tell side panel to clear
      if (tabId === this.activeTabId) {
        console.log('[TabManager] Clearing side panel for active tab', tabId);
        chrome.runtime.sendMessage({
          action: 'clear_ui'
        }).catch(err => {
          console.log('[TabManager] Could not send clear_ui to side panel:', err);
        });
      }
    }
  }

  removeTab(tabId) {
    this.tabVideoMap.delete(tabId);
    this.persist();

    // If recording tab was closed, reset recording state
    if (this.recordingTabId === tabId) {
      console.warn('[TabManager] Recording tab was closed, stopping recording');
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

    // Persist to session storage
    chrome.storage.session.set({ recording_tab_id: tabId })
      .catch(err => console.error('[TabManager] Failed to persist recording state:', err));

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

    // Clear from session storage
    chrome.storage.session.remove('recording_tab_id')
      .catch(err => console.error('[TabManager] Failed to clear recording state:', err));

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
    try {
      // Convert Map to object for storage
      const obj = Object.fromEntries(this.tabVideoMap);
      await chrome.storage.local.set({ tab_video_contexts: obj });
    } catch (err) {
      console.error('[TabManager] Failed to persist state:', err);
      // Continue - this is not a fatal error
    }
  }
}
