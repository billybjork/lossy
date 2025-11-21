/**
 * DOM Scanner - Finds candidate images on a web page
 *
 * Scans for:
 * - <img> elements
 * - <picture> elements
 * - Elements with CSS background-image
 *
 * Filters by:
 * - Minimum size (100x100px)
 * - Visibility (in viewport or scrollable into view)
 */

export interface CandidateImage {
  element: HTMLElement;
  type: 'img' | 'picture' | 'background';
  rect: DOMRect;
  imageUrl?: string;
}

const MIN_SIZE = 100; // Minimum width and height in pixels

export function findCandidateImages(): CandidateImage[] {
  const candidates: CandidateImage[] = [];

  // 1. Find <img> elements (excluding Lossy's own clones)
  document.querySelectorAll('img').forEach(img => {
    // Skip our own overlay clones
    if (img.hasAttribute('data-lossy-clone')) {
      return;
    }

    const rect = img.getBoundingClientRect();
    if (isVisible(img) && isLargeEnough(rect)) {
      candidates.push({
        element: img,
        type: 'img',
        rect,
        imageUrl: img.currentSrc || img.src
      });
    }
  });

  // 2. Find <picture> elements
  document.querySelectorAll('picture').forEach(picture => {
    const img = picture.querySelector('img');
    if (img) {
      const rect = img.getBoundingClientRect();
      if (isVisible(img) && isLargeEnough(rect)) {
        candidates.push({
          element: picture as HTMLElement,
          type: 'picture',
          rect,
          imageUrl: img.currentSrc || img.src
        });
      }
    }
  });

  // 3. Find elements with background-image
  // Note: This can be expensive on large DOMs, so we limit to common containers
  const selectors = [
    'div', 'section', 'article', 'aside', 'header', 'footer',
    'main', 'figure', 'a', 'button', 'span'
  ];

  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;

      if (bgImage && bgImage !== 'none' && !bgImage.startsWith('linear-gradient') && !bgImage.startsWith('radial-gradient')) {
        const rect = el.getBoundingClientRect();
        if (isVisible(el as HTMLElement) && isLargeEnough(rect)) {
          const imageUrl = extractUrlFromBackground(bgImage);
          if (imageUrl) {
            candidates.push({
              element: el as HTMLElement,
              type: 'background',
              rect,
              imageUrl
            });
          }
        }
      }
    });
  });

  return candidates;
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();

  // Must have dimensions
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  // Check if element is hidden via CSS
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  // Element is visible if it has any dimensions
  return true;
}

function isLargeEnough(rect: DOMRect): boolean {
  return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
}

function extractUrlFromBackground(bgImage: string): string | undefined {
  // Extract URL from background-image: url("...") or url('...') or url(...)
  const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
  return match ? match[1] : undefined;
}
