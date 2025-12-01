import type { CapturePayload } from '../types/capture';
import { findCandidateImages } from '../lib/dom-scanner';
import { CaptureOverlay } from './overlay';
import { captureImage, setScreenshotHandler } from '../lib/capture';

// Track active overlay and abort controller for cancellation
let activeOverlay: CaptureOverlay | null = null;
let captureAbortController: AbortController | null = null;

// Prevent duplicate initialization if script loads multiple times
if ((window as any).lossyInitialized) {
  console.log('[Lossy] Content script already initialized, skipping duplicate load');
} else {
  (window as any).lossyInitialized = true;
  console.log('[Lossy] Content script initialized');

  // Set up screenshot handler for capture.ts
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_CAPTURE') {
      startCapture();
      sendResponse({ received: true });
    } else if (message.type === 'SCREENSHOT_CAPTURED') {
      // Forward to capture.ts handler
      setScreenshotHandler(message.imageData);
      sendResponse({ received: true });
    } else if (message.type === 'EDITOR_OPENED') {
      // Editor tab opened - dismiss overlay gracefully
      if (activeOverlay) {
        activeOverlay.dismiss();
        activeOverlay = null;
        captureAbortController = null;
      }
      sendResponse({ received: true });
    }
    return true; // Keep message channel open for async responses
  });

  async function startCapture() {
    console.log('[Lossy] Starting capture with image selection...');

    // Check if overlay already exists - prevent stacking
    if (document.getElementById('lossy-capture-overlay')) {
      console.log('[Lossy] Overlay already active, ignoring duplicate activation');
      return;
    }

    // Find all candidate images on the page
    const candidates = findCandidateImages();

    if (candidates.length === 0) {
      showToast('No sizeable images found on this page. Try scrolling or choose a different page.');
      return;
    }

    console.log(`[Lossy] Found ${candidates.length} candidate images`);

    // Create abort controller for cancellation
    captureAbortController = new AbortController();
    const signal = captureAbortController.signal;

    // Show selection overlay
    activeOverlay = new CaptureOverlay(candidates, async (selected) => {
      console.log('[Lossy] Image selected:', selected.type);

      // No toasts during hero state - the visual selection IS the indicator

      try {
        // Check if cancelled before capturing
        if (signal.aborted) return;

        // Capture the selected image (smart: URL or screenshot)
        const payload = await captureImage(selected);

        // Check if cancelled after capturing
        if (signal.aborted) return;

        // Send to background script
        // Overlay stays visible - dismissed when EDITOR_OPENED received
        sendCapture(payload);
      } catch (error) {
        // Don't show error if cancelled
        if (signal.aborted) return;

        console.error('[Lossy] Capture failed:', error);
        activeOverlay?.dismiss();
        showToast('Capture failed. Please try again.', 3000);
      }
    });

    // Set up cancellation callback (ESC pressed during processing)
    activeOverlay.onCancel(() => {
      captureAbortController?.abort();
      activeOverlay = null;
      captureAbortController = null;
    });
  }

  function showToast(message: string, duration = 2500) {
    // Remove any existing toast
    const existingToast = document.getElementById('lossy-toast');
    if (existingToast) {
      existingToast.remove();
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.id = 'lossy-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(31, 41, 55, 0.95);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      animation: lossy-toast-fadein 0.2s ease;
    `;

    // Add fade-in animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes lossy-toast-fadein {
        from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes lossy-toast-fadeout {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      }
    `;
    if (!document.getElementById('lossy-toast-styles')) {
      style.id = 'lossy-toast-styles';
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    // Auto-remove after duration
    setTimeout(() => {
      toast.style.animation = 'lossy-toast-fadeout 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  function sendCapture(payload: CapturePayload) {
    chrome.runtime.sendMessage(
      {
        type: 'IMAGE_CAPTURED',
        payload
      },
      (response) => {
        if (response?.success) {
          console.log('[Lossy] Capture sent successfully:', response.captureId);
        } else if (response?.error) {
          console.error('[Lossy] Capture failed:', response.error);
          showToast('Upload failed. Please try again.', 3000);
        }
      }
    );
  }
}
