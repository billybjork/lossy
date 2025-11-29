/**
 * Smart Capture - Intelligently captures images from the page
 *
 * Strategies:
 * 1. Direct URL extraction: For <img> and <picture> elements
 * 2. Background image URL extraction: For CSS background-image
 * 3. Screenshot fallback: For transformed images or when URL unavailable
 *
 * NOTE: Text detection is performed in the service worker to avoid
 * Content Security Policy restrictions on dynamic imports.
 */

import type { CandidateImage } from './dom-scanner';
import type { CapturePayload } from '../types/capture';

// Screenshot handler for receiving screenshot from background script
let screenshotResolver: ((data: string) => void) | null = null;

export function setScreenshotHandler(imageData: string) {
  if (screenshotResolver) {
    screenshotResolver(imageData);
    screenshotResolver = null;
  }
}

export async function captureImage(candidate: CandidateImage): Promise<CapturePayload> {
  // Try direct URL if available and image isn't transformed
  if (candidate.imageUrl && isDirectImage(candidate)) {
    // Test URL accessibility via service worker (bypasses CORS)
    const accessible = await testUrlAccessibility(candidate.imageUrl);

    if (accessible) {
      return {
        source_url: window.location.href,
        capture_mode: 'direct_asset',
        image_url: candidate.imageUrl,
        bounding_rect: rectToJSON(candidate.rect)
      };
    }
  }

  // Fall back to screenshot (transformed image, inaccessible URL, or no URL)
  const imageDataUrl = await captureRegionScreenshot(candidate.rect);
  return {
    source_url: window.location.href,
    capture_mode: 'screenshot',
    image_data: imageDataUrl,
    bounding_rect: rectToJSON(candidate.rect)
  };
}

/**
 * Test if an image URL is accessible by asking the service worker.
 * Service workers bypass CORS, allowing us to fetch cross-origin images.
 */
async function testUrlAccessibility(url: string): Promise<boolean> {
  try {
    // Quick check for same-origin (always accessible)
    const imageUrl = new URL(url, window.location.href);
    if (imageUrl.origin === window.location.origin) {
      return true;
    }

    // Ask service worker to test the URL
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_IMAGE_URL',
      url: url
    });

    return response?.accessible === true;
  } catch (error) {
    console.warn('[Lossy] URL accessibility test failed:', error);
    return false;
  }
}

function isDirectImage(candidate: CandidateImage): boolean {
  // For background images, check accessibility but don't check transforms
  if (candidate.type === 'background') {
    return true;
  }

  // For img/picture elements, check if image is not heavily transformed
  const el = candidate.element;
  const style = window.getComputedStyle(el);
  const transform = style.transform;

  // If no transform or identity matrix, we can use direct URL
  // Identity matrix is: matrix(1, 0, 0, 1, 0, 0)
  if (transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)') {
    return true;
  }

  // Check for simple translations (which don't affect the image itself)
  // Translation matrix: matrix(1, 0, 0, 1, tx, ty)
  const matrixMatch = transform.match(/matrix\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/);
  if (matrixMatch) {
    const [, a, b, c, d] = matrixMatch;
    // If a=1, b=0, c=0, d=1, it's just a translation
    if (a === '1' && b === '0' && c === '0' && d === '1') {
      return true;
    }
  }

  // Image is transformed (rotated, scaled, skewed), use screenshot
  return false;
}

async function captureRegionScreenshot(rect: DOMRect): Promise<string> {
  // Set up promise to wait for screenshot
  const screenshotPromise = new Promise<string>((resolve, reject) => {
    screenshotResolver = resolve;

    // Timeout after 10 seconds
    setTimeout(() => {
      if (screenshotResolver === resolve) {
        screenshotResolver = null;
        reject(new Error('Screenshot capture timed out'));
      }
    }, 10000);
  });

  // Request screenshot from background script
  await chrome.runtime.sendMessage({
    type: 'REQUEST_SCREENSHOT'
  });

  // Wait for screenshot to arrive via setScreenshotHandler
  const fullScreenshotData = await screenshotPromise;

  // Crop the screenshot to the selected region
  return cropScreenshotToRegion(fullScreenshotData, rect);
}

async function cropScreenshotToRegion(screenshotDataUrl: string, rect: DOMRect): Promise<string> {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;

  // Set canvas dimensions to match the cropped region
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Load the full screenshot
  const img = new Image();
  img.src = screenshotDataUrl;

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to load screenshot'));
  });

  // Calculate the source coordinates (accounting for scroll position)
  // Note: captureVisibleTab captures only the visible viewport, so we don't need scroll offsets
  const sourceX = Math.round(rect.left * dpr);
  const sourceY = Math.round(rect.top * dpr);
  const sourceWidth = Math.round(rect.width * dpr);
  const sourceHeight = Math.round(rect.height * dpr);

  // Draw the cropped region onto the canvas
  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight
  );

  // Return as base64 data URL
  return canvas.toDataURL('image/png');
}

function rectToJSON(rect: DOMRect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}
