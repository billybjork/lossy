/**
 * MessageRouter - Routes messages between content scripts, service worker, and side panel.
 * Prevents cross-tab pollution (e.g., notes from tab A shown in panel for tab B).
 *
 * Key Responsibilities:
 * - Track which tab the side panel is currently subscribed to
 * - Only forward messages from the active tab to the side panel
 * - Filter out messages from inactive tabs
 */
export class MessageRouter {
  constructor() {
    this.panelSubscriptions = new Map(); // tabId → boolean (true if panel is subscribed)
    this.activePanelTabId = null; // The tab currently displayed in the side panel
  }

  /**
   * Subscribe the side panel to a specific tab.
   * When user switches to a different tab, the panel subscribes to that tab's messages.
   *
   * @param {number} tabId - The tab to subscribe to
   */
  subscribePanelToTab(tabId) {
    console.log('[MessageRouter] Panel subscribed to tab', tabId);
    this.panelSubscriptions.set(tabId, true);
    this.activePanelTabId = tabId;
  }

  /**
   * Unsubscribe from a specific tab (e.g., when tab is closed).
   *
   * @param {number} tabId - The tab to unsubscribe from
   */
  unsubscribeFromTab(tabId) {
    console.log('[MessageRouter] Unsubscribing from tab', tabId);
    this.panelSubscriptions.delete(tabId);

    // If the active panel tab was closed, clear the active tab
    if (this.activePanelTabId === tabId) {
      this.activePanelTabId = null;
    }
  }

  /**
   * Route a message to the side panel, but ONLY if it comes from the active tab.
   * This prevents notes from tab A appearing in the panel when viewing tab B.
   *
   * @param {object} message - The message to route
   * @param {number} sourceTabId - The tab the message came from
   * @returns {boolean} - True if message was routed, false if filtered out
   */
  routeToSidePanel(message, sourceTabId) {
    // Filter: Only route messages from the currently active tab
    if (this.activePanelTabId !== sourceTabId) {
      console.log(
        '[MessageRouter] Filtering message from tab',
        sourceTabId,
        '(active:',
        this.activePanelTabId,
        ')'
      );
      return false;
    }

    console.log('[MessageRouter] Routing message to side panel from tab', sourceTabId);

    // Forward to side panel
    chrome.runtime.sendMessage(message).catch((err) => {
      // Side panel may not be open, that's OK
      console.log('[MessageRouter] Side panel not reachable:', err.message);
    });

    return true;
  }

  /**
   * Check if the side panel is currently subscribed to a specific tab.
   *
   * @param {number} tabId - The tab to check
   * @returns {boolean} - True if subscribed
   */
  isPanelSubscribedToTab(tabId) {
    return this.panelSubscriptions.has(tabId);
  }

  /**
   * Get the currently active panel tab ID.
   *
   * @returns {number|null} - The active tab ID, or null if none
   */
  getActivePanelTabId() {
    return this.activePanelTabId;
  }

  /**
   * Clear all subscriptions (useful for testing or reset).
   */
  clearAllSubscriptions() {
    console.log('[MessageRouter] Clearing all subscriptions');
    this.panelSubscriptions.clear();
    this.activePanelTabId = null;
  }
}
