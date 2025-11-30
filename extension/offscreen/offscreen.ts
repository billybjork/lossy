/**
 * Offscreen document for running ONNX inference
 *
 * Service workers can't use dynamic imports, but offscreen documents can.
 * This runs the text detection model and sends results back to the service worker.
 */

import {
  detectTextRegions,
  imageDataFromDataUrl,
  imageDataFromUrl,
  type DetectionResult
} from '../lib/text-detection';

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  if (message.type === 'DETECT_TEXT') {
    handleDetection(message.payload)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function handleDetection(payload: {
  capture_mode: string;
  image_data?: string;
  image_url?: string;
}): Promise<DetectionResult | null> {
  console.log('[Lossy Offscreen] Starting text detection...', {
    capture_mode: payload.capture_mode,
    has_image_data: !!payload.image_data,
    has_image_url: !!payload.image_url
  });

  let imageData: ImageData;

  if (payload.capture_mode === 'screenshot' && payload.image_data) {
    console.log('[Lossy Offscreen] Loading image from data URL...');
    imageData = await imageDataFromDataUrl(payload.image_data);
    console.log('[Lossy Offscreen] Image loaded:', imageData.width, 'x', imageData.height);
  } else if (payload.image_url) {
    console.log('[Lossy Offscreen] Loading image from URL:', payload.image_url);
    imageData = await imageDataFromUrl(payload.image_url);
    console.log('[Lossy Offscreen] Image loaded:', imageData.width, 'x', imageData.height);
  } else {
    console.log('[Lossy Offscreen] No image data available');
    return null;
  }

  console.log('[Lossy Offscreen] Running inference...');
  const result = await detectTextRegions(imageData, imageData.width, imageData.height);
  console.log('[Lossy Offscreen] Detection complete:', result.regions.length, 'regions');
  return result;
}

console.log('[Lossy Offscreen] Document ready');
