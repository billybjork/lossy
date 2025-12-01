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
  private handleResize: () => void;
  private fadeOutTimeout?: number;
  private hoveredIndex: number | null = null;
  private selectedIndex: number | null = null;
  private cancelCallback?: () => void;
  private dismissCallback?: () => void;

  // Continuous scanning fields
  private trackedElements = new WeakSet<HTMLElement>();
  private mutationObserver?: MutationObserver;
  private intersectionObserver?: IntersectionObserver;
  private scanIntervalId?: number;
  private scrollDebounceId?: number;
  private handleScroll?: () => void;
  private isScanning = false;
  private lastScanTime = 0;
  private cloneListenersController = new AbortController();

  // Constants
  private readonly SCAN_THROTTLE_MS = 400; // Max scan frequency
  private readonly SCAN_INTERVAL_MS = 2500; // Periodic scan interval
  private readonly VIEWPORT_BUFFER = '1500px'; // Buffer zone around viewport
  private readonly SCROLL_DEBOUNCE_MS = 150; // Debounce for scroll-end scan
  private readonly Z_INDEX_OVERLAY = 2147483640; // Overlay layer z-index
  private readonly Z_INDEX_CLONE = 2147483641; // Clone layer z-index (above overlay)
  private readonly STAGGER_DELAY_MS = 60; // Delay between clone animations
  private readonly FADE_OUT_DURATION_MS = 300; // Fade out animation duration
  private readonly HERO_SCALE = 1.08; // Scale for selected image hero effect
  private readonly HERO_TRANSITION_MS = 350; // Hero animation duration
  private readonly DISMISS_DURATION_MS = 400; // Dismiss animation duration

  // Spotlight filter styles
  private readonly FILTER_HOVER_ACTIVE = `
    drop-shadow(0 0 20px rgba(255, 255, 255, 0.45))
    drop-shadow(0 0 40px rgba(255, 255, 255, 0.3))
    drop-shadow(0 0 80px rgba(255, 255, 255, 0.15))
  `;
  private readonly FILTER_HOVER_INACTIVE = `
    drop-shadow(0 0 5px rgba(255, 255, 255, 0.1))
  `;
  private readonly FILTER_KEYBOARD_ACTIVE = `
    drop-shadow(0 0 20px rgba(255, 255, 255, 0.6))
    drop-shadow(0 0 40px rgba(255, 255, 255, 0.4))
    drop-shadow(0 0 80px rgba(255, 255, 255, 0.2))
  `;
  private readonly FILTER_KEYBOARD_INACTIVE = `
    drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))
    drop-shadow(0 0 20px rgba(255, 255, 255, 0.12))
  `;
  private readonly FILTER_HERO = `
    drop-shadow(0 0 30px rgba(255, 255, 255, 0.7))
    drop-shadow(0 0 60px rgba(255, 255, 255, 0.5))
    drop-shadow(0 0 100px rgba(255, 255, 255, 0.3))
  `;

  constructor(candidates: CandidateImage[], onSelect: (candidate: CandidateImage) => void) {
    // Defensive cleanup: Remove any lingering overlay elements from previous sessions
    this.cleanupLingering();

    this.candidates = candidates;
    this.onSelect = onSelect;
    this.overlay = this.createOverlay();

    // Bind event handlers
    this.handleKeydown = (e: KeyboardEvent) => this.onKeydown(e);
    this.handleResize = () => this.fadeOutAndExit();

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
      z-index: ${this.Z_INDEX_OVERLAY};
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
      z-index: ${this.Z_INDEX_CLONE};
      cursor: pointer;
      transition: opacity 0.3s ease-out,
                  transform 0.3s ease-out,
                  filter 0.3s ease-out;
      pointer-events: auto;
      opacity: 0;
      transform: scale(1);
    `;

    // Add event listeners using AbortController for clean cleanup
    const signal = this.cloneListenersController.signal;

    // Add click handler
    clone.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectCandidate(index);
    }, { signal });

    // Add hover handlers for single spotlight mode + scale effect
    clone.addEventListener('mouseenter', () => {
      this.hoveredIndex = index;
      // Grow slightly on hover
      clone.style.transform = 'scale(1.05)';
      this.updateHighlight();
    }, { signal });

    clone.addEventListener('mouseleave', () => {
      // Return to normal size
      clone.style.transform = 'scale(1)';
      if (this.hoveredIndex === index) {
        this.hoveredIndex = null;
        this.updateHighlight();
      }
    }, { signal });

    this.clones.push(clone);

    // Track the clone BEFORE appending to DOM to prevent race condition:
    // MutationObserver could fire immediately after appendChild and try to clone the clone
    // if it's not already tracked. Adding to WeakSet first closes this race condition window.
    this.trackedElements.add(clone);

    // Now safe to append - clone is already tracked
    document.body.appendChild(clone);

    // Staggered fade-in animation (transition already set in cssText)
    setTimeout(() => {
      clone.style.opacity = '1';
    }, index * this.STAGGER_DELAY_MS);
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

    // Setup IntersectionObserver with buffer zone to catch images approaching viewport
    // This ensures images are spotted ~500px before entering viewport for immediate availability
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Only scan if any images entered the buffer zone
        const hasIntersecting = entries.some(entry => entry.isIntersecting);
        if (hasIntersecting) {
          this.scanForNewCandidates();
        }
      },
      {
        // Buffer zone: start watching images 500px before they enter viewport
        rootMargin: this.VIEWPORT_BUFFER,
        // Trigger on any intersection (entering buffer)
        threshold: 0
      }
    );

    // Observe all existing images
    document.querySelectorAll('img').forEach(img => {
      // Skip our own clones
      if (!img.hasAttribute('data-lossy-clone')) {
        this.intersectionObserver?.observe(img);
      }
    });

    // Setup MutationObserver to watch for new img/picture elements
    // When new images are added, add them to IntersectionObserver
    this.mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement) {
              // If it's an img element, observe it
              if (node.tagName === 'IMG' && !node.hasAttribute('data-lossy-clone')) {
                this.intersectionObserver?.observe(node);
              }
              // If it contains img elements, observe them
              node.querySelectorAll('img').forEach(img => {
                if (!img.hasAttribute('data-lossy-clone')) {
                  this.intersectionObserver?.observe(img);
                }
              });
            }
          }
        }
      }
    });

    // Start observing the entire document for new elements
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Setup periodic scanning for edge cases (background-image changes, etc.)
    // Use interval to avoid recursive pattern complexity
    this.scanIntervalId = window.setInterval(() => {
      if (!this.isScanning) return;
      requestIdleCallback(() => this.scanForNewCandidates());
    }, this.SCAN_INTERVAL_MS);

    // Setup scroll handler for responsive scanning during scroll
    // Debounced: triggers scan when scrolling stops
    this.handleScroll = () => {
      if (!this.isScanning) return;

      // Clear previous debounce
      if (this.scrollDebounceId) {
        clearTimeout(this.scrollDebounceId);
      }

      // Scan when scrolling stops
      this.scrollDebounceId = window.setTimeout(() => {
        this.scanForNewCandidates();
      }, this.SCROLL_DEBOUNCE_MS);
    };

    window.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  private stopContinuousScanning() {
    // Stop scanning flag (prevents any pending callbacks from running)
    this.isScanning = false;

    // Disconnect IntersectionObserver
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = undefined;
    }

    // Disconnect MutationObserver
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = undefined;
    }

    // Clear scan interval
    if (this.scanIntervalId) {
      clearInterval(this.scanIntervalId);
      this.scanIntervalId = undefined;
    }

    // Clear scroll debounce and remove listener
    if (this.scrollDebounceId) {
      clearTimeout(this.scrollDebounceId);
      this.scrollDebounceId = undefined;
    }
    if (this.handleScroll) {
      window.removeEventListener('scroll', this.handleScroll);
      this.handleScroll = undefined;
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
          clone.style.filter = this.FILTER_HOVER_ACTIVE;
          clone.style.opacity = '1';
        } else {
          clone.style.filter = this.FILTER_HOVER_INACTIVE;
          clone.style.opacity = '0.3';
        }
      } else {
        // Keyboard navigation mode: Show all with current highlighted
        if (index === this.currentIndex) {
          clone.style.filter = this.FILTER_KEYBOARD_ACTIVE;
          clone.style.opacity = '1';
        } else {
          clone.style.filter = this.FILTER_KEYBOARD_INACTIVE;
          clone.style.opacity = '1';
        }
      }
    });
  }

  private selectCandidate(index: number) {
    const candidate = this.candidates[index];
    this.transitionToSelected(index);
    this.onSelect(candidate);
    // Note: cleanup is NOT called here - overlay stays visible until dismiss() is called
  }

  private cancel() {
    // If we're in selected state (processing), notify caller to abort
    if (this.selectedIndex !== null) {
      this.cancelCallback?.();
    }
    this.cleanup();
  }

  private fadeOutAndExit() {
    // Prevent multiple fade-outs
    if (this.fadeOutTimeout) return;

    // If we're in selected state (processing), notify caller to abort
    if (this.selectedIndex !== null) {
      this.cancelCallback?.();
    }

    // Fade out overlay
    this.overlay.style.opacity = '0';

    // Fade-out with blur and slight scale
    this.clones.forEach(clone => {
      clone.style.transition = 'opacity 0.4s cubic-bezier(0.4, 0, 1, 1), transform 0.4s cubic-bezier(0.4, 0, 1, 1), filter 0.4s cubic-bezier(0.4, 0, 1, 1)';
      clone.style.opacity = '0';
      clone.style.transform = 'scale(0.9)';
      clone.style.filter = 'blur(12px)';
    });

    // Wait for animation, then cleanup
    this.fadeOutTimeout = window.setTimeout(() => {
      this.cleanup();
    }, this.FADE_OUT_DURATION_MS);
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

    // Abort all clone event listeners
    this.cloneListenersController.abort();

    // Remove global event listeners
    document.removeEventListener('keydown', this.handleKeydown, true);
    window.removeEventListener('resize', this.handleResize);

    // Robust cleanup: Query DOM directly for all our elements
    // This ensures we remove EVERYTHING, even if something escaped our tracking
    this.cleanupLingering();

    // Clear arrays for good measure
    this.clones = [];
    this.candidates = [];
  }

  /**
   * Set callback for when user cancels during processing (ESC pressed after selection)
   */
  public onCancel(callback: () => void): void {
    this.cancelCallback = callback;
  }

  /**
   * Set callback for when overlay is fully dismissed
   */
  public onDismiss(callback: () => void): void {
    this.dismissCallback = callback;
  }

  /**
   * Transition to "selected" state - hero animation in place
   * Selected image glows and scales slightly while others fade out.
   * Uses distance-based staggering for a smooth "ripple" effect.
   */
  private transitionToSelected(index: number): void {
    // Guard against multiple selections
    if (this.selectedIndex !== null) return;

    this.selectedIndex = index;

    // Stop scanning - no need to find more images
    this.stopContinuousScanning();

    // Get selected clone's center position for distance calculations
    const selectedClone = this.clones[index];
    const selectedRect = selectedClone.getBoundingClientRect();
    const selectedCenter = {
      x: selectedRect.left + selectedRect.width / 2,
      y: selectedRect.top + selectedRect.height / 2
    };

    // Calculate distances for all non-selected clones
    const distances: { index: number; distance: number }[] = [];
    this.clones.forEach((clone, i) => {
      if (i !== index) {
        const rect = clone.getBoundingClientRect();
        const center = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
        const distance = Math.hypot(center.x - selectedCenter.x, center.y - selectedCenter.y);
        distances.push({ index: i, distance });
      }
    });

    // Sort by distance (farthest first for stagger calculation)
    distances.sort((a, b) => b.distance - a.distance);

    // Calculate max distance for normalization
    const maxDistance = distances.length > 0 ? distances[0].distance : 1;

    // Animate selected clone immediately with hero effect
    selectedClone.style.transition = `
      opacity ${this.HERO_TRANSITION_MS}ms ease-out,
      transform ${this.HERO_TRANSITION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1),
      filter ${this.HERO_TRANSITION_MS}ms ease-out
    `;
    selectedClone.style.transform = `scale(${this.HERO_SCALE})`;
    selectedClone.style.filter = this.FILTER_HERO;
    selectedClone.style.opacity = '1';

    // Animate other clones with distance-based stagger
    // Closer images blur first, farther ones later (ripple outward from selection)
    const maxStaggerDelay = 200; // Max delay spread across all images
    distances.forEach(({ index: i, distance }) => {
      const clone = this.clones[i];
      // Farther images get more delay (blur later), closer images blur sooner
      const normalizedDistance = distance / maxDistance;
      const delay = normalizedDistance * maxStaggerDelay;

      setTimeout(() => {
        // Blur leads with a long, gentle transition
        // Opacity follows with a delay so you see the blur progress first
        // This creates a soft "dissolve" feel rather than an abrupt snap
        clone.style.transition = `
          filter 500ms cubic-bezier(0.2, 0, 0.2, 1),
          opacity 350ms cubic-bezier(0.4, 0, 0.2, 1) 120ms,
          transform 400ms cubic-bezier(0.4, 0, 0.2, 1)
        `;
        clone.style.transform = 'scale(0.95)';
        clone.style.filter = 'blur(8px)';
        clone.style.opacity = '0';
      }, delay);
    });

    // Slightly lighten overlay background
    this.overlay.style.background = 'rgba(0, 0, 0, 0.85)';
  }

  /**
   * Gracefully dismiss the overlay after processing is complete.
   * Called when editor tab opens or on error.
   */
  public dismiss(): void {
    // Prevent multiple dismissals
    if (this.fadeOutTimeout) return;

    // Fade out overlay
    this.overlay.style.transition = `opacity ${this.DISMISS_DURATION_MS}ms ease-out`;
    this.overlay.style.opacity = '0';

    // Animate selected clone (if any) or all clones
    this.clones.forEach((clone, i) => {
      clone.style.transition = `
        opacity ${this.DISMISS_DURATION_MS}ms ease-out,
        transform ${this.DISMISS_DURATION_MS}ms ease-out,
        filter ${this.DISMISS_DURATION_MS}ms ease-out
      `;

      if (this.selectedIndex !== null && i === this.selectedIndex) {
        // Selected image: scale down, blur, fade
        clone.style.transform = 'scale(0.9)';
        clone.style.filter = 'blur(12px)';
        clone.style.opacity = '0';
      } else if (this.selectedIndex === null) {
        // No selection (e.g., error case): fade all
        clone.style.opacity = '0';
        clone.style.transform = 'scale(0.9)';
        clone.style.filter = 'blur(12px)';
      }
      // Already-faded clones stay faded
    });

    // Wait for animation, then cleanup
    this.fadeOutTimeout = window.setTimeout(() => {
      this.cleanup();
      this.dismissCallback?.();
    }, this.DISMISS_DURATION_MS);
  }
}
