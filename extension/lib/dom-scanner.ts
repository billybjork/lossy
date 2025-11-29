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
 * - Visibility (CSS display/visibility/opacity)
 * - Overflow clipping (handles carousels with overflow:hidden)
 */

export interface CandidateImage {
  element: HTMLElement;
  type: 'img' | 'picture' | 'background';
  rect: DOMRect;
  imageUrl?: string;
}

const MIN_SIZE = 100; // Minimum width and height in pixels
const MIN_VISIBLE_RATIO = 0.5; // Require at least 50% visible within overflow container

/**
 * Check if element is clipped by an overflow container (carousel, etc.)
 * Returns true if the element is sufficiently visible within its overflow ancestors
 */
function isWithinOverflowBounds(element: HTMLElement): boolean {
  let parent = element.parentElement;

  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    const overflow = style.overflow + style.overflowX + style.overflowY;

    // Check for any overflow clipping
    if (overflow.includes('hidden') || overflow.includes('scroll') || overflow.includes('auto')) {
      const elementRect = element.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();

      // Calculate visible area within the overflow container
      const visibleWidth = Math.max(0,
        Math.min(elementRect.right, parentRect.right) - Math.max(elementRect.left, parentRect.left)
      );
      const visibleHeight = Math.max(0,
        Math.min(elementRect.bottom, parentRect.bottom) - Math.max(elementRect.top, parentRect.top)
      );

      const visibleArea = visibleWidth * visibleHeight;
      const totalArea = elementRect.width * elementRect.height;

      // Element is clipped if less than threshold is visible
      if (totalArea > 0 && visibleArea / totalArea < MIN_VISIBLE_RATIO) {
        return false;
      }
    }

    parent = parent.parentElement;
  }

  return true;
}

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

  // Check if element is clipped by overflow container (carousel case)
  if (!isWithinOverflowBounds(element)) {
    return false;
  }

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
