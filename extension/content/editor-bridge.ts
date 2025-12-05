/**
 * Editor Bridge - Content script for editor page communication
 *
 * This script is injected on localhost:4000/edit/* pages to enable
 * direct communication between the editor's JavaScript and the extension.
 * Uses window.postMessage to bridge the gap between page context and
 * content script context.
 */

interface SegmentRequest {
  type: 'LOSSY_SEGMENT_REQUEST';
  documentId: string;
  points: Array<{ x: number; y: number; label: number }>;
  imageSize: { width: number; height: number };
  requestId: string;
}

interface SegmentResponse {
  type: 'LOSSY_SEGMENT_RESPONSE';
  requestId: string;
  success: boolean;
  mask?: {
    mask_png: string;
    bbox: { x: number; y: number; w: number; h: number };
    score: number;
    stabilityScore: number;
    area: number;
  };
  error?: string;
}

// Listen for segment requests from the page
window.addEventListener('message', async (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;

  const data = event.data as SegmentRequest;
  if (data.type !== 'LOSSY_SEGMENT_REQUEST') return;

  const { documentId, points, imageSize, requestId } = data;

  console.log('[Lossy Bridge] Received segment request:', {
    documentId,
    points,
    pointCount: points?.length,
    imageSize,
    requestId,
  });

  try {
    // Send to service worker via chrome.runtime.sendMessage
    const messageToSend = {
      type: 'SEGMENT_AT_POINTS',
      documentId,
      points,
      imageSize,
    };
    console.log('[Lossy Bridge] Sending to service worker:', messageToSend);
    const response = await chrome.runtime.sendMessage(messageToSend);

    // Send response back to page
    const pageResponse: SegmentResponse = {
      type: 'LOSSY_SEGMENT_RESPONSE',
      requestId,
      success: response.success,
      mask: response.mask,
      error: response.error,
    };

    window.postMessage(pageResponse, '*');

    console.log('[Lossy Bridge] Sent segment response:', {
      requestId,
      success: response.success,
    });
  } catch (error) {
    // Send error response back to page
    const errorResponse: SegmentResponse = {
      type: 'LOSSY_SEGMENT_RESPONSE',
      requestId,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    window.postMessage(errorResponse, '*');

    console.error('[Lossy Bridge] Segment request failed:', error);
  }
});

// Notify the page that the bridge is ready
window.postMessage({ type: 'LOSSY_BRIDGE_READY' }, '*');

console.log('[Lossy Bridge] Editor bridge ready');
