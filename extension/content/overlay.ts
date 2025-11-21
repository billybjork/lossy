/**
 * Selection Overlay - Minimal cinematic spotlight effect
 *
 * Clones candidate images above a dark overlay with spotlight glow.
 * Fades out gracefully on scroll/resize.
 */

import type { CandidateImage } from '../lib/dom-scanner';
import { findCandidateImages } from '../lib/dom-scanner';

export class CaptureOverlay {
  private overlay: HTMLDivElement;
  private candidates: CandidateImage[];
  private clones: HTMLImageElement[] = [];
  private currentIndex = 0;
  private onSelect: (candidate: CandidateImage) => void;
  private handleKeydown: (e: KeyboardEvent) => void;
  private handleScroll: () => void;
  private handleResize: () => void;
  private fadeOutTimeout?: number;
  private lastScrollY = 0;
  private scrollDirection: 'up' | 'down' | null = null;
  private hasScrolled = false;
  private hoveredIndex: number | null = null;

  constructor(candidates: CandidateImage[], onSelect: (candidate: CandidateImage) => void) {
    this.candidates = candidates;
    this.onSelect = onSelect;
    this.overlay = this.createOverlay();

    // Bind event handlers
    this.handleKeydown = (e: KeyboardEvent) => this.onKeydown(e);
    this.handleScroll = () => {
      // On first scroll, switch to hover-only mode (don't fade out)
      if (!this.hasScrolled) {
        this.hasScrolled = true;
        this.updateHighlight();
      }
    };
    this.handleResize = () => this.fadeOutAndExit();

    // Store initial scroll position
    this.lastScrollY = window.pageYOffset || document.documentElement.scrollTop;

    this.createClones();
    this.attachEventListeners();
    this.updateHighlight();
  }

  private createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'lossy-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.92);
      backdrop-filter: blur(2px);
      z-index: 2147483640;
      cursor: crosshair;
      opacity: 0;
      transition: opacity 0.2s ease-out;
      pointer-events: auto;
    `;

    document.body.appendChild(overlay);

    // Trigger fade in
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
    });

    // Cancel on overlay click
    overlay.addEventListener('click', () => this.cancel());

    return overlay;
  }

  private createClones() {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    this.candidates.forEach((candidate, index) => {
      const rect = candidate.element.getBoundingClientRect();
      const clone = document.createElement('img');

      // Get image source
      const src = this.getImageSrc(candidate.element);
      if (src) {
        clone.src = src;
      }

      // Position clone at same location as original (absolute positioning)
      clone.style.cssText = `
        position: absolute;
        top: ${rect.top + scrollTop}px;
        left: ${rect.left + scrollLeft}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        object-fit: cover;
        z-index: 2147483641;
        cursor: pointer;
        transition: filter 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: auto;
        opacity: 0;
        transform: scale(0.85);
      `;

      // Add click handler
      clone.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectCandidate(index);
      });

      // Add hover handlers for hover-only mode + scale effect
      clone.addEventListener('mouseenter', () => {
        this.hoveredIndex = index;
        // Grow slightly on hover
        clone.style.transform = 'scale(1.05)';
        if (this.hasScrolled) {
          this.updateHighlight();
        }
      });

      clone.addEventListener('mouseleave', () => {
        // Return to normal size
        clone.style.transform = 'scale(1)';
        if (this.hoveredIndex === index) {
          this.hoveredIndex = null;
          if (this.hasScrolled) {
            this.updateHighlight();
          }
        }
      });

      this.clones.push(clone);
      document.body.appendChild(clone);

      // Staggered fade-in animation with bounce
      requestAnimationFrame(() => {
        setTimeout(() => {
          // Bouncy spring easing for more energy
          clone.style.transition = 'opacity 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.4s ease-out';
          clone.style.opacity = '1';
          clone.style.transform = 'scale(1)';
        }, index * 60); // Slightly longer stagger for dramatic effect
      });
    });
  }

  private getImageSrc(element: HTMLElement): string | null {
    if (element instanceof HTMLImageElement) {
      return element.currentSrc || element.src;
    }

    const bgImage = window.getComputedStyle(element).backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
      return match ? match[1] : null;
    }

    return null;
  }

  private attachEventListeners() {
    document.addEventListener('keydown', this.handleKeydown, true);
    window.addEventListener('scroll', this.handleScroll, { passive: true });
    window.addEventListener('resize', this.handleResize, { passive: true });
  }

  private onKeydown(e: KeyboardEvent) {
    const handledKeys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape'];
    if (!handledKeys.includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        this.currentIndex = (this.currentIndex + 1) % this.candidates.length;
        this.updateHighlight();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        this.currentIndex = (this.currentIndex - 1 + this.candidates.length) % this.candidates.length;
        this.updateHighlight();
        break;
      case 'Enter':
        this.selectCandidate(this.currentIndex);
        break;
      case 'Escape':
        this.cancel();
        break;
    }
  }

  private updateHighlight() {
    this.clones.forEach((clone, index) => {
      if (this.hasScrolled && this.hoveredIndex !== null) {
        // Hover-only mode: Only spotlight hovered image (others dim)
        if (index === this.hoveredIndex) {
          // Hovered: bright spotlight
          clone.style.filter = `
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.9))
            drop-shadow(0 0 40px rgba(255, 255, 255, 0.6))
            drop-shadow(0 0 80px rgba(255, 255, 255, 0.3))
          `;
          clone.style.opacity = '1';
        } else {
          // Not hovered: very dim
          clone.style.filter = `
            drop-shadow(0 0 5px rgba(255, 255, 255, 0.15))
          `;
          clone.style.opacity = '0.3';
        }
      } else {
        // Initial mode OR hover mode but not hovering anything: Show all
        if (index === this.currentIndex) {
          // Active: bright cinematic glow
          clone.style.filter = `
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.9))
            drop-shadow(0 0 40px rgba(255, 255, 255, 0.6))
            drop-shadow(0 0 80px rgba(255, 255, 255, 0.3))
          `;
          clone.style.opacity = '1';
        } else {
          // Inactive: subtle glow
          clone.style.filter = `
            drop-shadow(0 0 10px rgba(255, 255, 255, 0.4))
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.2))
          `;
          clone.style.opacity = '1';
        }
      }
    });
  }

  private selectCandidate(index: number) {
    const candidate = this.candidates[index];
    this.cleanup();
    this.onSelect(candidate);
  }

  private cancel() {
    this.cleanup();
  }

  private fadeOutAndExit() {
    // Prevent multiple fade-outs
    if (this.fadeOutTimeout) return;

    // Fade out overlay
    this.overlay.style.opacity = '0';

    // Directional fade-out with blur based on scroll direction
    const translateY = this.scrollDirection === 'down' ? '20px' :
                       this.scrollDirection === 'up' ? '-20px' : '0';

    this.clones.forEach(clone => {
      clone.style.transition = 'opacity 0.4s cubic-bezier(0.4, 0, 1, 1), transform 0.4s cubic-bezier(0.4, 0, 1, 1), filter 0.4s cubic-bezier(0.4, 0, 1, 1)';
      clone.style.opacity = '0';
      clone.style.transform = `translateY(${translateY}) scale(0.9)`;
      clone.style.filter = 'blur(12px)';  // More aggressive blur
    });

    // Wait for animation, then cleanup
    this.fadeOutTimeout = window.setTimeout(() => {
      this.cleanup();
    }, 300);
  }

  private cleanup() {
    // Clear timeout if exists
    if (this.fadeOutTimeout) {
      clearTimeout(this.fadeOutTimeout);
    }

    // Remove event listeners
    document.removeEventListener('keydown', this.handleKeydown, true);
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('resize', this.handleResize);

    // Remove clones
    this.clones.forEach(clone => clone.remove());

    // Remove overlay
    this.overlay.remove();
  }
}
