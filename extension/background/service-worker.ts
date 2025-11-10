import type { CapturePayload, CaptureResponse } from '../types/capture';

// Listen for keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture') {
    activateCapture();
  }
});

// Listen for browser action (toolbar icon) click
chrome.action.onClicked.addListener(() => {
  activateCapture();
});

async function activateCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.id || !tab.url) {
    console.error('[Lossy] No active tab found');
    return;
  }

  // Check if URL is valid for content script injection
  if (!isValidUrl(tab.url)) {
    console.warn('[Lossy] Cannot capture on this page:', tab.url);
    return;
  }

  try {
    // Try to send message to content script
    console.log('[Lossy] Attempting to communicate with content script...');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' });
    console.log('[Lossy] Content script responded:', response);
  } catch (error) {
    // Content script not loaded - inject it programmatically
    console.log('[Lossy] Content script not found, injecting programmatically...');

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });

      console.log('[Lossy] Content script injected, retrying...');

      // Wait a moment for the script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try sending message again
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' });
      console.log('[Lossy] Content script responded after injection:', response);
    } catch (injectionError) {
      console.error('[Lossy] Failed to inject content script:', injectionError);
      console.error('[Lossy] This page may not allow script injection');
    }
  }
}

function isValidUrl(url: string): boolean {
  // Disallow chrome:// URLs and other restricted protocols
  const restrictedProtocols = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'data:', 'file:'];
  return !restrictedProtocols.some(protocol => url.startsWith(protocol));
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REQUEST_SCREENSHOT') {
    // Capture screenshot of the active tab
    captureScreenshot(sender.tab!)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;  // Keep channel open for async response
  } else if (message.type === 'IMAGE_CAPTURED') {
    handleImageCapture(message.payload, sender.tab!)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;  // Keep channel open for async response
  }
});

async function captureScreenshot(tab: chrome.tabs.Tab) {
  if (!tab.id) return;

  // Capture visible tab as PNG data URL
  const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });

  // Send screenshot back to content script with error handling
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SCREENSHOT_CAPTURED',
      imageData: imageData
    });
  } catch (error) {
    console.error('Failed to send screenshot to content script:', error);
    // If content script isn't responding, we can't recover from this
    throw error;
  }
}

async function handleImageCapture(payload: CapturePayload, tab: chrome.tabs.Tab) {
  try {
    console.log('[Lossy] Sending capture to backend:', {
      source_url: tab.url,
      capture_mode: payload.capture_mode,
      has_image_url: !!payload.image_url,
      has_image_data: !!payload.image_data
    });

    // POST to backend API
    const response = await fetch('http://localhost:4000/api/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_url: tab.url || '',
        capture_mode: payload.capture_mode,
        image_url: payload.image_url,
        image_data: payload.image_data,
        bounding_rect: payload.bounding_rect
      })
    });

    console.log('[Lossy] Backend response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Lossy] Backend error:', errorText);
      throw new Error(`Backend returned ${response.status}: ${errorText}`);
    }

    const data: CaptureResponse = await response.json();
    console.log('[Lossy] Capture created with ID:', data.id);

    // Open editor in new tab
    chrome.tabs.create({ url: `http://localhost:4000/capture/${data.id}` });

    return { success: true, captureId: data.id };
  } catch (error) {
    console.error('[Lossy] Failed to handle image capture:', error);
    throw error;
  }
}
