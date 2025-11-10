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

  if (!tab.id || !tab.url) return;

  // Check if URL is valid for content script injection
  if (!isValidUrl(tab.url)) {
    console.warn('Cannot capture on this page:', tab.url);
    return;
  }

  try {
    // Content script is already loaded via manifest, just send message
    chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' });
  } catch (error) {
    console.error('Failed to send message to content script:', error);
  }
}

function isValidUrl(url: string): boolean {
  // Disallow chrome:// URLs and other restricted protocols
  const restrictedProtocols = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'data:', 'file:'];
  return !restrictedProtocols.some(protocol => url.startsWith(protocol));
}

// Listen for captured images from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMAGE_CAPTURED') {
    handleImageCapture(message.payload, sender.tab!)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;  // Keep channel open for async response
  }
});

async function handleImageCapture(payload: CapturePayload, tab: chrome.tabs.Tab) {
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

  const data: CaptureResponse = await response.json();

  // Open editor in new tab
  chrome.tabs.create({ url: `http://localhost:4000/capture/${data.id}` });

  return { success: true, captureId: data.id };
}
