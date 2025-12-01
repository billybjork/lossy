import type { CapturePayload, CaptureResponse, TextRegionPayload } from '../types/capture';
import type { DetectionResult } from '../lib/text-detection';

// Track if offscreen document exists
let creatingOffscreen: Promise<void> | null = null;

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
  } else if (message.type === 'TEST_IMAGE_URL') {
    // Test if an image URL is accessible (service worker bypasses CORS)
    testImageUrlAccessibility(message.url)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ accessible: false, error: error.message }));
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
    // Run local text detection in the offscreen document
    let textRegions: TextRegionPayload[] | undefined;
    let detectionBackend: 'webgpu' | 'wasm' | null = null;
    let detectionTimeMs: number | undefined;

    try {
      const detectionResult = await runLocalTextDetection(payload);
      if (detectionResult) {
        textRegions = detectionResult.regions.map(regionToPayload);
        detectionBackend = detectionResult.backend;
        detectionTimeMs = detectionResult.inferenceTimeMs;
        console.log(`[Lossy] Local detection: ${textRegions.length} regions in ${detectionTimeMs.toFixed(0)}ms (${detectionBackend})`);
      }
    } catch (error) {
      console.warn('[Lossy] Local text detection failed, will use cloud detection:', error);
    }

    console.log('[Lossy] Sending capture to backend:', {
      source_url: tab.url,
      capture_mode: payload.capture_mode,
      has_image_url: !!payload.image_url,
      has_image_data: !!payload.image_data,
      text_regions_count: textRegions?.length ?? 0,
      detection_backend: detectionBackend,
      detection_time_ms: detectionTimeMs
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
        bounding_rect: payload.bounding_rect,
        // Image dimensions for skeleton placeholder sizing
        image_width: payload.image_width,
        image_height: payload.image_height,
        // Include local text detection results
        text_regions: textRegions,
        detection_backend: detectionBackend,
        detection_time_ms: detectionTimeMs
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

    // Open editor in new tab with fresh param for arrival animation
    chrome.tabs.create({ url: `http://localhost:4000/edit/${data.id}?fresh=1` });

    // Notify source tab that editor opened - triggers overlay dismiss
    if (tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'EDITOR_OPENED' });
      } catch (error) {
        // Content script may have been unloaded - that's OK
        console.log('[Lossy] Could not notify source tab (may have navigated away)');
      }
    }

    return { success: true, captureId: data.id };
  } catch (error) {
    console.error('[Lossy] Failed to handle image capture:', error);
    throw error;
  }
}

/**
 * Ensure the offscreen document exists
 */
async function ensureOffscreenDocument(): Promise<void> {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document if not already creating
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run ONNX text detection model'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

/**
 * Run local text detection via offscreen document
 */
async function runLocalTextDetection(payload: CapturePayload): Promise<DetectionResult | null> {
  console.log('[Lossy] Starting local text detection via offscreen document...');

  // Ensure offscreen document exists
  await ensureOffscreenDocument();

  // Send detection request to offscreen document
  const response = await chrome.runtime.sendMessage({
    type: 'DETECT_TEXT',
    payload: {
      capture_mode: payload.capture_mode,
      image_data: payload.image_data,
      image_url: payload.image_url
    }
  });

  if (response.success) {
    console.log('[Lossy] Detection complete:', response.result);
    return response.result;
  } else {
    console.error('[Lossy] Detection failed:', response.error);
    return null;
  }
}

/**
 * Convert DetectedRegion to TextRegionPayload for API
 */
function regionToPayload(region: {
  bbox: { x: number; y: number; w: number; h: number };
  polygon: Array<{ x: number; y: number }>;
  confidence: number;
}): TextRegionPayload {
  return {
    bbox: region.bbox,
    polygon: region.polygon,
    confidence: region.confidence
  };
}

/**
 * Test if an image URL is accessible by attempting a HEAD request.
 * Service workers bypass CORS, so this works for cross-origin images.
 */
async function testImageUrlAccessibility(url: string): Promise<{ accessible: boolean; error?: string }> {
  try {
    // Validate URL
    const parsedUrl = new URL(url);

    // Block known auth-required domains
    const authRequiredDomains = [
      'drive.google.com',
      'docs.google.com',
      'onedrive.live.com',
      '1drv.ms',
      'icloud.com',
      'dropbox.com',
      'previews.dropboxusercontent.com'
    ];

    if (authRequiredDomains.some(domain => parsedUrl.hostname.includes(domain))) {
      return { accessible: false, error: 'Auth-required domain' };
    }

    // Try HEAD request first (faster, less bandwidth)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        // Don't send credentials to avoid auth complications
        credentials: 'omit'
      });

      clearTimeout(timeoutId);

      // Check if it's an image
      const contentType = response.headers.get('content-type') || '';
      const isImage = contentType.startsWith('image/');

      if (response.ok && isImage) {
        return { accessible: true };
      } else if (response.ok) {
        // Response OK but not an image
        return { accessible: false, error: `Not an image: ${contentType}` };
      } else if (response.status === 405) {
        // HEAD not allowed, try GET with range header
        return await tryGetRequest(url);
      } else {
        return { accessible: false, error: `HTTP ${response.status}` };
      }
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        return { accessible: false, error: 'Timeout' };
      }

      // Some servers don't support HEAD, try GET
      return await tryGetRequest(url);
    }
  } catch (error: any) {
    return { accessible: false, error: error.message };
  }
}

/**
 * Fallback GET request with Range header to minimize data transfer
 */
async function tryGetRequest(url: string): Promise<{ accessible: boolean; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
      headers: {
        // Request only first byte to minimize bandwidth
        'Range': 'bytes=0-0'
      }
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    const isImage = contentType.startsWith('image/');

    // 200 or 206 (partial content) are both acceptable
    if ((response.ok || response.status === 206) && isImage) {
      return { accessible: true };
    } else {
      return { accessible: false, error: `HTTP ${response.status}, type: ${contentType}` };
    }
  } catch (error: any) {
    clearTimeout(timeoutId);
    return { accessible: false, error: error.message };
  }
}
