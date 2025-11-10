import type { CapturePayload } from '../types/capture';

// Prevent duplicate initialization if script loads multiple times
if ((window as any).lossyInitialized) {
  console.log('[Lossy] Content script already initialized, skipping duplicate load');
} else {
  (window as any).lossyInitialized = true;
  console.log('[Lossy] Content script initialized');

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_CAPTURE') {
      startCapture();
      sendResponse({ received: true });
    } else if (message.type === 'SCREENSHOT_CAPTURED') {
      handleScreenshotCaptured(message.imageData);
      sendResponse({ received: true });
    }
    return true; // Keep message channel open for async responses
  });

  function startCapture() {
    console.log('[Lossy] Starting capture...');

    // Show overlay briefly, then hide it before taking screenshot
    showOverlay('Capturing screenshot...');

    // Remove overlay before taking screenshot so it's not included
    setTimeout(() => {
      removeOverlay();

      // Now request screenshot from background
      chrome.runtime.sendMessage({ type: 'REQUEST_SCREENSHOT' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Lossy] Error requesting screenshot:', chrome.runtime.lastError);
        } else {
          console.log('[Lossy] Screenshot request sent:', response);
        }
      });
    }, 100); // Brief delay to show the overlay, then remove it before screenshot
  }

  function handleScreenshotCaptured(imageData: string) {
    // Show processing message
    showOverlay('Processing capture...');

    // Send capture data with actual screenshot
    sendCapture({
      source_url: window.location.href,
      capture_mode: 'screenshot',
      image_data: imageData
    });

    // Remove overlay after a brief moment (editor will open in new tab)
    setTimeout(removeOverlay, 500);
  }

  function showOverlay(messageText: string) {
    // Remove existing overlay if any
    removeOverlay();

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'lossy-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.5);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const message = document.createElement('div');
    message.style.cssText = `
      background: white;
      padding: 24px 48px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      font-size: 18px;
      font-weight: 500;
      color: #1f2937;
    `;
    message.textContent = messageText;

    overlay.appendChild(message);
    document.body.appendChild(overlay);
  }

  function removeOverlay() {
    const overlay = document.getElementById('lossy-overlay');
    if (overlay) {
      overlay.remove();
    }
  }

  function sendCapture(payload: CapturePayload) {
    chrome.runtime.sendMessage({
      type: 'IMAGE_CAPTURED',
      payload
    }, (response) => {
      if (response?.success) {
        console.log('[Lossy] Capture sent successfully:', response.captureId);
      } else if (response?.error) {
        console.error('[Lossy] Capture failed:', response.error);
      }
    });
  }
}
