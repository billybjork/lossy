/**
 * Video Context Manager Module
 *
 * Responsibilities:
 * - Video detection flow (handle video_detected events)
 * - Context refresh/hydration (ensure tabs have video context)
 * - Content script injection
 * - Tab-to-video mapping (delegates to TabManager)
 *
 * Dependencies (injected):
 * - tabManager: TabManager instance
 * - getOrCreateVideoChannel: Function to get/create video channel
 */

// Dependencies (will be injected via init)
let tabManager = null;
let getOrCreateVideoChannel = null;

/**
 * Initialize video context manager with dependencies
 */
export function initVideoContextManager(deps) {
  tabManager = deps.tabManager;
  getOrCreateVideoChannel = deps.getOrCreateVideoChannel;
}

/**
 * Handle video detected from content script
 * Sends video metadata to backend and returns videoDbId
 */
export async function handleVideoDetected(videoData) {
  console.log('[VideoContextManager] Handling video detected:', videoData);

  // Get or create video channel (handles socket connection and broadcast setup)
  const videoChannel = await getOrCreateVideoChannel();

  return new Promise((resolve, reject) => {
    // Send video_detected event
    videoChannel
      .push('video_detected', videoData)
      .receive('ok', (response) => {
        console.log('[VideoContextManager] Video record created:', response);
        // Don't load notes here - content script will request them after initialization
        resolve({ videoDbId: response.video_id });
      })
      .receive('error', (err) => {
        console.error('[VideoContextManager] Failed to create video record:', err);
        reject(new Error('Failed to create video record'));
      });
  });
}

/**
 * Trigger video detection on current tab
 * Ensures content script is injected and triggers detection
 * Returns success/failure gracefully without throwing
 */
export async function handleTriggerVideoDetection() {
  console.log('[VideoContextManager] 🔍 TRIGGER_VIDEO_DETECTION: Handling request');

  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    console.log('[VideoContextManager] No active tab found');
    return { success: false, error: 'No active tab found' };
  }

  console.log('[VideoContextManager] 🔍 Triggering detection on tab:', tab.id, tab.url);

  // Check if URL is supported - return gracefully for restricted pages
  if (
    !tab.url ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://')
  ) {
    console.log('[VideoContextManager] Cannot inject content script on restricted page:', tab.url);
    return { success: false, error: 'Cannot inject content script on this page', restricted: true };
  }

  // Ensure content script is injected
  try {
    await ensureContentScriptInjected(tab.id);
  } catch (err) {
    console.log('[VideoContextManager] Failed to inject content script:', err.message);
    return { success: false, error: 'Failed to inject content script' };
  }

  // Trigger detection in content script
  try {
    console.log('[VideoContextManager] 🔍 Sending re_initialize message to content script');
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 're_initialize',
    });

    if (response?.success) {
      console.log('[VideoContextManager] ✅ Content script re-initialized successfully');
      return { success: true, tabId: tab.id };
    } else {
      console.log('[VideoContextManager] Content script re-initialization failed');
      return { success: false, error: 'Content script re-initialization failed' };
    }
  } catch (err) {
    console.log('[VideoContextManager] Failed to communicate with content script:', err.message);
    return { success: false, error: 'Failed to communicate with content script' };
  }
}

/**
 * Ensure content script is injected in the given tab
 * Uses programmatic injection if not already present
 */
export async function ensureContentScriptInjected(tabId) {
  console.log('[VideoContextManager] 🔍 Ensuring content script is injected in tab:', tabId);

  // Sprint 10 Fix: Check extension context
  if (!chrome?.runtime?.id) {
    throw new Error('Extension context invalidated');
  }

  // Try to ping the content script first
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: 'ping' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 500)),
    ]);

    if (response?.pong) {
      console.log('[VideoContextManager] ✅ Content script already present');
      return; // Already injected
    }
  } catch (err) {
    if (err.message?.includes('Extension context invalidated')) {
      throw err;
    }
    console.log('[VideoContextManager] Content script not present, injecting...');
  }

  // Content script not present - inject it programmatically
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content/universal.js'],
    });
    console.log('[VideoContextManager] ✅ Content script injected successfully');

    // Wait a bit for the script to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (err) {
    // Ignore "Cannot access" errors (means a script is already running, likely orphaned)
    if (err.message?.includes('Cannot access')) {
      console.log(
        '[VideoContextManager] ⚠️ Content script injection blocked (likely orphaned script exists)'
      );
      // Continue anyway - we'll try to communicate with whatever is there
    } else {
      console.error('[VideoContextManager] ❌ Failed to inject content script:', err);
      throw err;
    }
  }
}

/**
 * Ensure tab has video context
 * If not, triggers video detection and waits for context to be available
 * Returns video context or null if unavailable
 */
export async function ensureVideoContextForTab(tabId, timeoutMs = 2000) {
  if (!tabManager) {
    return null;
  }

  let context = tabManager.getVideoContext(tabId);
  if (context?.videoDbId) {
    return context;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.warn('[VideoContextManager] Failed to get tab for context refresh:', err.message);
    return null;
  }

  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    console.log('[VideoContextManager] Tab URL not eligible for video detection:', tab?.url);
    return null;
  }

  try {
    await ensureContentScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, { action: 're_initialize' }).catch((err) => {
      console.log('[VideoContextManager] re_initialize failed (will continue waiting):', err.message);
    });
  } catch (err) {
    console.warn('[VideoContextManager] Failed to refresh video context for tab:', err.message);
    return null;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    context = tabManager.getVideoContext(tabId);
    if (context?.videoDbId) {
      return context;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}
