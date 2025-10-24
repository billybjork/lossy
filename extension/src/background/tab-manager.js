/**
 * TabManager - Tracks video context and recording state per tab.
 * Persists state to chrome.storage for recovery after extension reload.
 */
export class TabManager {
  constructor() {
    this.tabVideoMap = new Map(); // tabId → VideoContext
    this.activeTabId = null;
    this.recordingTabId = null;
    this.tabUpdateTimers = new Map(); // tabId → timeout for debouncing
    this.pendingClearContext = new Map(); // tabId → boolean (track if we should clear context)
  }

  /**
   * Check if a URL change represents meaningful navigation (different page/video).
   * Returns true if the page changed, false if only query parameters changed.
   *
   * This prevents Voice Mode from stopping when video players update the URL
   * with timestamp parameters (e.g., ?ts=16.489585 → ?ts=10.383610).
   */
  isSignificantUrlChange(oldUrl, newUrl) {
    if (!oldUrl || !newUrl) return true;

    try {
      const oldParsed = new URL(oldUrl);
      const newParsed = new URL(newUrl);

      // Different host/domain = significant change
      if (oldParsed.host !== newParsed.host) {
        return true;
      }

      // Different path = significant change
      if (oldParsed.pathname !== newParsed.pathname) {
        return true;
      }

      // Different hash = significant change (might be SPA navigation)
      if (oldParsed.hash !== newParsed.hash) {
        return true;
      }

      // Only query parameters changed (e.g., ?ts=X) - NOT significant
      return false;
    } catch (err) {
      // If URL parsing fails, assume it's significant
      console.warn('[TabManager] Failed to parse URLs for comparison:', err);
      return true;
    }
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
        for (const context of this.tabVideoMap.values()) {
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

    // Tab updated (URL changed, page loaded, etc) - DEBOUNCED
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      // Only care about URL changes and completed loads
      if (changeInfo.url || (changeInfo.status === 'complete' && tab.active)) {
        console.log('[TabManager] Tab updated:', tabId, changeInfo);

        // If URL changed, check if it's a significant change (not just query params)
        if (changeInfo.url) {
          const existingContext = this.getVideoContext(tabId);
          const oldUrl = existingContext?.url;
          const newUrl = changeInfo.url;

          if (this.isSignificantUrlChange(oldUrl, newUrl)) {
            // Real navigation - mark context for clearing
            console.log('[TabManager] Significant URL change detected, will clear context');
            this.pendingClearContext.set(tabId, true);
          } else {
            // Just query parameters changed (e.g., timestamp) - update URL but keep context
            console.log('[TabManager] Query parameter change only, updating URL in context');
            if (existingContext) {
              existingContext.url = newUrl;
              this.persist();
            }
          }
        }

        // Clear existing debounce timer for this tab
        if (this.tabUpdateTimers.has(tabId)) {
          clearTimeout(this.tabUpdateTimers.get(tabId));
        }

        // Debounce: wait 300ms before processing to avoid rapid status change cascades
        const timer = setTimeout(async () => {
          console.log('[TabManager] Processing debounced tab update:', tabId);
          this.tabUpdateTimers.delete(tabId);

          // Check if we should clear context (URL changed at any point during debounce period)
          if (this.pendingClearContext.get(tabId)) {
            this.clearVideoContext(tabId);
            this.pendingClearContext.delete(tabId);
          }

          await this.onTabChanged(tabId);
        }, 300);

        this.tabUpdateTimers.set(tabId, timer);
      }
    });

    // Tab removed (user closed tab)
    chrome.tabs.onRemoved.addListener((tabId) => {
      console.log('[TabManager] Tab removed:', tabId);

      // Clear debounce timer if exists
      if (this.tabUpdateTimers.has(tabId)) {
        clearTimeout(this.tabUpdateTimers.get(tabId));
        this.tabUpdateTimers.delete(tabId);
      }

      // Clear pending context clear flag
      this.pendingClearContext.delete(tabId);

      this.removeTab(tabId);
    });
  }

  async onTabChanged(tabId) {
    const context = this.getVideoContext(tabId);

    // Don't send tab_changed if context is stale (waiting for replacement)
    // This prevents the side panel from reloading notes for the old video during navigation
    if (context && context.stale) {
      console.log('[TabManager] Skipping tab_changed for stale context (tab:', tabId, ')');
      return;
    }

    // Notify side panel to sync to this tab
    chrome.runtime
      .sendMessage({
        action: 'tab_changed',
        tabId: tabId,
        videoContext: context,
      })
      .catch(() => {
        // Side panel may not be open, that's OK
      });
  }

  setVideoContext(tabId, videoContext) {
    const existing = this.tabVideoMap.get(tabId);
    this.tabVideoMap.set(tabId, {
      ...videoContext,
      recordingState: existing?.recordingState || 'idle',
      lastUpdated: Date.now(), // Track when context was set
    });
    this.persist();
    console.log('[TabManager] Video context set for tab', tabId);

    // If this is the active tab, notify side panel
    // Note: This may send a second tab_changed after onActivated(), but the debouncing
    // in the side panel (100ms) will coalesce these into a single update with the latest context.
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
      chrome.tabs
        .sendMessage(tabId, {
          action: 'clear_markers',
        })
        .catch((err) => {
          console.log(
            '[TabManager] Could not send clear_markers (content script may not be loaded yet):',
            err
          );
        });

      // DON'T send clear_ui here - the content script will handle it
      // The content script has smart logic to only clear when the video actually changes
      // (see universal.js lines 100-111)
      console.log(
        '[TabManager] Context marked as stale - content script will handle UI clearing if needed'
      );
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
    chrome.storage.session
      .set({ recording_tab_id: tabId })
      .catch((err) => console.error('[TabManager] Failed to persist recording state:', err));

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
    chrome.storage.session
      .remove('recording_tab_id')
      .catch((err) => console.error('[TabManager] Failed to clear recording state:', err));

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
      ...context,
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
