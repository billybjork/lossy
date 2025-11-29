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
  let payload: CapturePayload;

  // Case 1 & 2: Direct image URL or background image URL available
  // But only if it's accessible (not cross-origin or protected)
  if (candidate.imageUrl && isDirectImage(candidate) && isAccessibleUrl(candidate.imageUrl)) {
    payload = {
      source_url: window.location.href,
      capture_mode: 'direct_asset',
      image_url: candidate.imageUrl,
      bounding_rect: rectToJSON(candidate.rect)
    };
  } else {
    // Case 3: Need to screenshot (transformed image, cross-origin, or no URL available)
    const imageDataUrl = await captureRegionScreenshot(candidate.rect);
    payload = {
      source_url: window.location.href,
      capture_mode: 'screenshot',
      image_data: imageDataUrl,
      bounding_rect: rectToJSON(candidate.rect)
    };
  }

  // Text detection will be performed in the service worker
  // to avoid CSP restrictions on dynamic imports

  return payload;
}

function isAccessibleUrl(url: string): boolean {
  try {
    const imageUrl = new URL(url, window.location.href);
    const currentOrigin = window.location.origin;

    // Allow same-origin images
    if (imageUrl.origin === currentOrigin) {
      return true;
    }

    // Allow common CDN and image hosting domains that are publicly accessible
    const publicDomains = [
      'i.imgur.com',
      'images.unsplash.com',
      'cdn.pixabay.com',
      'images.pexels.com',
      'cdn.shopify.com',
      'static.wikia.nocookie.net'
    ];

    const hostname = imageUrl.hostname;
    if (publicDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
      return true;
    }

    // Disallow known protected/authentication-required domains
    const protectedDomains = [
      'previews.dropbox.com',
      'drive.google.com',
      'onedrive.live.com',
      'icloud.com'
    ];

    if (protectedDomains.some(domain => hostname.includes(domain))) {
      return false;
    }

    // For other cross-origin URLs, be conservative and use screenshot
    // This avoids CORS issues and authentication problems
    return false;
  } catch {
    // Invalid URL, fall back to screenshot
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
