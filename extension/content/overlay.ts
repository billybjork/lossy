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
  private hoveredIndex: number | null = null;

  // Continuous scanning fields
  private trackedElements = new WeakSet<HTMLElement>();
  private mutationObserver?: MutationObserver;
  private idleCallbackId?: number;
  private scanTimeoutId?: number;
  private isScanning = false;
  private lastScanTime = 0;
  private readonly SCAN_THROTTLE_MS = 1000; // Max 1 scan per second

  constructor(candidates: CandidateImage[], onSelect: (candidate: CandidateImage) => void) {
    // Defensive cleanup: Remove any lingering overlay elements from previous sessions
    this.cleanupLingering();

    this.candidates = candidates;
    this.onSelect = onSelect;
    this.overlay = this.createOverlay();

    // Bind event handlers
    this.handleKeydown = (e: KeyboardEvent) => this.onKeydown(e);
    this.handleScroll = () => {
      // Track scroll for potential future use (currently unused)
    };
    this.handleResize = () => this.fadeOutAndExit();

    // Store initial scroll position
    this.lastScrollY = window.pageYOffset || document.documentElement.scrollTop;

    this.createClones();
    this.attachEventListeners();
    this.updateHighlight();

    // Initialize continuous scanning
    // First, track all initial candidates
    this.candidates.forEach(candidate => {
      this.trackedElements.add(candidate.element);
    });

    // Start watching for new images
    this.setupContinuousScanning();
  }

  private createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'lossy-capture-overlay';
    overlay.setAttribute('data-lossy-overlay', 'true');
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
    // Key insight: Measure ONCE, set position ONCE, never update during scroll.
    // position: absolute means document-relative, so these clones scroll naturally
    // with the page without any JavaScript intervention. This avoids layout thrashing,
    // floating-point drift, and gives us perfect 60fps scrolling for free.
    this.candidates.forEach((candidate, index) => {
      this.createSingleClone(candidate, index);
    });
  }

  private createSingleClone(candidate: CandidateImage, index: number) {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const rect = candidate.element.getBoundingClientRect();
    const clone = document.createElement('img');

    // Mark as Lossy clone for robust cleanup
    clone.setAttribute('data-lossy-clone', 'true');

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

    // Add hover handlers for single spotlight mode + scale effect
    clone.addEventListener('mouseenter', () => {
      this.hoveredIndex = index;
      // Grow slightly on hover
      clone.style.transform = 'scale(1.05)';
      this.updateHighlight();
    });

    clone.addEventListener('mouseleave', () => {
      // Return to normal size
      clone.style.transform = 'scale(1)';
      if (this.hoveredIndex === index) {
        this.hoveredIndex = null;
        this.updateHighlight();
      }
    });

    this.clones.push(clone);

    // Track the clone BEFORE appending to DOM to prevent race condition:
    // MutationObserver could fire immediately after appendChild and try to clone the clone
    // if it's not already tracked. Adding to WeakSet first closes this race condition window.
    this.trackedElements.add(clone);

    // Now safe to append - clone is already tracked
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
  }

  private scanForNewCandidates() {
    // Early exit if scanning has been stopped
    if (!this.isScanning) {
      return;
    }

    // Throttle: Only scan once per second
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_THROTTLE_MS) {
      return;
    }
    this.lastScanTime = now;

    // Find all current candidate images
    const allCandidates = findCandidateImages();

    // Filter out images we've already cloned
    const newCandidates = allCandidates.filter(
      candidate => !this.trackedElements.has(candidate.element)
    );

    // Early exit if no new candidates
    if (newCandidates.length === 0) {
      return;
    }

    // Add new candidates to our tracking
    newCandidates.forEach(candidate => {
      this.trackedElements.add(candidate.element);

      // Add to candidates array and create clone
      const index = this.candidates.length;
      this.candidates.push(candidate);
      this.createSingleClone(candidate, index);
    });
  }

  private setupContinuousScanning() {
    // Enable scanning
    this.isScanning = true;

    // Setup MutationObserver to watch for new img/picture elements
    this.mutationObserver = new MutationObserver((mutations) => {
      // Check if any mutations added new img or picture elements
      let hasNewImages = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement) {
              // Check if it's an img/picture or contains img/picture elements
              if (
                node.tagName === 'IMG' ||
                node.tagName === 'PICTURE' ||
                node.querySelector('img, picture')
              ) {
                hasNewImages = true;
                break;
              }
            }
          }
        }
        if (hasNewImages) break;
      }

      // If new images detected, scan for candidates
      if (hasNewImages) {
        this.scanForNewCandidates();
      }
    });

    // Start observing the entire document for new elements
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Setup periodic idle callback for edge cases (background-image changes, etc.)
    const scheduleIdleScan = () => {
      // Don't schedule if scanning has been stopped
      if (!this.isScanning) {
        return;
      }

      this.idleCallbackId = requestIdleCallback(() => {
        this.scanForNewCandidates();

        // Schedule next scan in 2-3 seconds (store the timeout ID)
        this.scanTimeoutId = window.setTimeout(() => {
          scheduleIdleScan();
        }, 2500);
      });
    };

    scheduleIdleScan();
  }

  private stopContinuousScanning() {
    // Stop scanning flag (prevents any pending callbacks from running)
    this.isScanning = false;

    // Disconnect MutationObserver
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = undefined;
    }

    // Cancel idle callback
    if (this.idleCallbackId) {
      cancelIdleCallback(this.idleCallbackId);
      this.idleCallbackId = undefined;
    }

    // Clear pending timeout
    if (this.scanTimeoutId) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = undefined;
    }
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
      if (this.hoveredIndex !== null) {
        // Single spotlight mode: Only spotlight hovered image (others dim)
        if (index === this.hoveredIndex) {
          // Hovered: subtle spotlight
          clone.style.filter = `
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.45))
            drop-shadow(0 0 40px rgba(255, 255, 255, 0.3))
            drop-shadow(0 0 80px rgba(255, 255, 255, 0.15))
          `;
          clone.style.opacity = '1';
        } else {
          // Not hovered: very dim
          clone.style.filter = `
            drop-shadow(0 0 5px rgba(255, 255, 255, 0.1))
          `;
          clone.style.opacity = '0.3';
        }
      } else {
        // Initial mode OR hover mode but not hovering anything: Show all
        if (index === this.currentIndex) {
          // Active: bright cinematic glow
          clone.style.filter = `
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.6))
            drop-shadow(0 0 40px rgba(255, 255, 255, 0.4))
            drop-shadow(0 0 80px rgba(255, 255, 255, 0.2))
          `;
          clone.style.opacity = '1';
        } else {
          // Inactive: subtle glow
          clone.style.filter = `
            drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))
            drop-shadow(0 0 20px rgba(255, 255, 255, 0.12))
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

  private cleanupLingering() {
    // Remove any lingering overlay elements from previous sessions
    // This is a "clean slate" approach - query DOM directly rather than relying on memory
    document.querySelectorAll('[data-lossy-clone="true"]').forEach(el => el.remove());
    document.querySelectorAll('[data-lossy-overlay="true"]').forEach(el => el.remove());
    // Also remove by ID as backup
    document.getElementById('lossy-capture-overlay')?.remove();
  }

  private cleanup() {
    // Clear timeout if exists
    if (this.fadeOutTimeout) {
      clearTimeout(this.fadeOutTimeout);
    }

    // Stop continuous scanning
    this.stopContinuousScanning();

    // Remove event listeners
    document.removeEventListener('keydown', this.handleKeydown, true);
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('resize', this.handleResize);

    // Robust cleanup: Query DOM directly for all our elements
    // This ensures we remove EVERYTHING, even if something escaped our tracking
    this.cleanupLingering();

    // Clear arrays for good measure
    this.clones = [];
    this.candidates = [];
  }
}
