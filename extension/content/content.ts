import type { CapturePayload } from '../types/capture';

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_CAPTURE') {
    startCapture();
  }
});

function startCapture() {
  // For MVP: Show a simple overlay and send a stubbed capture
  showOverlay();

  // Send stubbed capture data after a short delay
  setTimeout(() => {
    sendCapture({
      source_url: window.location.href,
      capture_mode: 'screenshot'
    });
  }, 1500);
}

function showOverlay() {
  // Remove existing overlay if any
  const existingOverlay = document.getElementById('lossy-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

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
  message.textContent = 'Lossy activated! Opening editor...';

  overlay.appendChild(message);
  document.body.appendChild(overlay);

  // Remove overlay after sending capture
  setTimeout(() => {
    overlay.remove();
  }, 2000);
}

function sendCapture(payload: CapturePayload) {
  chrome.runtime.sendMessage({
    type: 'IMAGE_CAPTURED',
    payload
  }, (response) => {
    if (response?.success) {
      console.log('Capture sent successfully:', response.captureId);
    } else if (response?.error) {
      console.error('Capture failed:', response.error);
    }
  });
}
