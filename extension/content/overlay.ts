/**
 * Selection Overlay - Interactive UI for selecting images
 *
 * Shows a dimmed overlay with highlighted candidate images.
 * Supports click and keyboard navigation.
 */

import type { CandidateImage } from '../lib/dom-scanner';

export class CaptureOverlay {
  private overlay: HTMLDivElement;
  private highlights: HTMLDivElement[] = [];
  private candidates: CandidateImage[];
  private currentIndex = 0;
  private onSelect: (candidate: CandidateImage) => void;
  private handleKeydown: (e: KeyboardEvent) => void;

  constructor(candidates: CandidateImage[], onSelect: (candidate: CandidateImage) => void) {
    this.candidates = candidates;
    this.onSelect = onSelect;
    this.overlay = this.createOverlay();

    // Bind keyboard handler to this instance
    this.handleKeydown = (e: KeyboardEvent) => {
      this.onKeydown(e);
    };

    this.createHighlights();
    this.attachEventListeners();

    // Highlight first candidate by default
    if (this.highlights.length > 0) {
      this.updateHighlight();
    }
  }

  private createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'lossy-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 2147483647;
      cursor: crosshair;
      pointer-events: none;
    `;

    // Create SVG with mask to cut holes for images
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
    mask.id = 'lossy-spotlight-mask';

    // White background (shows the dim)
    const maskBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    maskBg.setAttribute('width', '100%');
    maskBg.setAttribute('height', '100%');
    maskBg.setAttribute('fill', 'white');
    mask.appendChild(maskBg);

    // Black rectangles for each image (cuts holes)
    this.candidates.forEach(c => {
      const hole = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hole.setAttribute('x', String(c.rect.left));
      hole.setAttribute('y', String(c.rect.top));
      hole.setAttribute('width', String(c.rect.width));
      hole.setAttribute('height', String(c.rect.height));
      hole.setAttribute('fill', 'black');
      mask.appendChild(hole);
    });

    defs.appendChild(mask);
    svg.appendChild(defs);

    // Dim rectangle with mask applied
    const dimRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    dimRect.setAttribute('width', '100%');
    dimRect.setAttribute('height', '100%');
    dimRect.setAttribute('fill', 'rgba(0, 0, 0, 0.45)');
    dimRect.setAttribute('mask', 'url(#lossy-spotlight-mask)');
    svg.appendChild(dimRect);

    overlay.appendChild(svg);
    document.body.appendChild(overlay);
    return overlay;
  }

  private createHighlights() {
    this.candidates.forEach((candidate, index) => {
      const highlight = this.createHighlight(candidate.rect, index);
      this.highlights.push(highlight);
      this.overlay.appendChild(highlight);
    });
  }

  private createHighlight(rect: DOMRect, index: number): HTMLDivElement {
    const highlight = document.createElement('div');
    highlight.className = 'lossy-highlight';
    highlight.dataset.index = String(index);
    highlight.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid #3B82F6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
      pointer-events: auto;
      transition: all 0.2s ease;
      cursor: pointer;
      z-index: 2147483648;
    `;

    // Add click handler
    highlight.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectCandidate(index);
    });

    return highlight;
  }

  private attachEventListeners() {
    // Attach keyboard listener with capture phase to ensure we get events first
    document.addEventListener('keydown', this.handleKeydown, true);

    // Cancel on overlay background click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.cancel();
      }
    });
  }

  private onKeydown(e: KeyboardEvent) {
    // Only handle our keys
    const handledKeys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape'];
    if (!handledKeys.includes(e.key)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      this.currentIndex = (this.currentIndex + 1) % this.candidates.length;
      this.updateHighlight();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      this.currentIndex = (this.currentIndex - 1 + this.candidates.length) % this.candidates.length;
      this.updateHighlight();
    } else if (e.key === 'Enter') {
      this.selectCandidate(this.currentIndex);
    } else if (e.key === 'Escape') {
      this.cancel();
    }
  }

  private updateHighlight() {
    // Reset all highlights
    this.highlights.forEach((highlight, index) => {
      if (index === this.currentIndex) {
        // Active highlight: brighter and thicker
        highlight.style.border = '4px solid #3B82F6';
        highlight.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.5), 0 0 20px rgba(59, 130, 246, 0.4)';
      } else {
        // Inactive highlight: subtle
        highlight.style.border = '3px solid #3B82F6';
        highlight.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.3)';
      }
    });

    // Scroll current highlight into view if needed
    const currentHighlight = this.highlights[this.currentIndex];
    if (currentHighlight) {
      const rect = this.candidates[this.currentIndex].rect;
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      // Check if element is outside viewport
      if (rect.top < 0 || rect.bottom > viewportHeight || rect.left < 0 || rect.right > viewportWidth) {
        this.candidates[this.currentIndex].element.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'center'
        });
      }
    }
  }

  private selectCandidate(index: number) {
    const candidate = this.candidates[index];
    this.cleanup();
    this.onSelect(candidate);
  }

  private cancel() {
    this.cleanup();
  }

  private cleanup() {
    // Remove keyboard listener
    document.removeEventListener('keydown', this.handleKeydown, true);

    // Remove overlay from DOM
    this.overlay.remove();
  }
}
