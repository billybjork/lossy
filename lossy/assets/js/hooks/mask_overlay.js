/**
 * MaskOverlay Hook - CSS Drop-Shadow Spotlight Effect
 *
 * Positions mask images over the capture and applies CSS drop-shadow filters
 * for a cinematic spotlight glow effect (matching the extension's overlay.ts).
 *
 * Features:
 * - CSS drop-shadow filters for smooth, GPU-accelerated glow
 * - Hover/click detection on mask elements
 * - Multi-select with Shift+click
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z)
 */

export const MaskOverlay = {
  mounted() {
    this.container = this.el;
    this.hoveredMaskId = null;
    this.selectedMaskIds = new Set();

    // Get image dimensions from data attributes
    this.imageWidth = parseInt(this.el.dataset.imageWidth) || 0;
    this.imageHeight = parseInt(this.el.dataset.imageHeight) || 0;

    // Position masks once image is loaded
    const img = document.getElementById('capture-image');
    if (img) {
      if (img.complete) {
        this.positionMasks();
      } else {
        img.addEventListener('load', () => this.positionMasks());
      }

      // Reposition on resize
      this.resizeObserver = new ResizeObserver(() => this.positionMasks());
      this.resizeObserver.observe(img);
    }

    // Attach event listeners to mask elements
    this.attachMaskListeners();

    // Keyboard events for shortcuts
    this.keydownHandler = (e) => this.handleKeydown(e);
    document.addEventListener('keydown', this.keydownHandler);

    // Listen for mask updates from server (e.g., after undo or inpainting)
    this.handleEvent("masks_updated", ({masks}) => {
      // Clear local selection to stay in sync with server state
      // Server clears selection on undo/inpaint completion
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;

      // Masks are re-rendered by LiveView, just reposition and reattach
      requestAnimationFrame(() => {
        this.positionMasks();
        this.attachMaskListeners();
        this.updateHighlight();
      });
    });

    // Listen for explicit selection clear from server
    this.handleEvent("clear_selection", () => {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.updateHighlight();
    });

    // Initial highlight state
    this.updateHighlight();
  },

  destroyed() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this.keydownHandler);
  },

  positionMasks() {
    const img = document.getElementById('capture-image');
    if (!img) return;

    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth || this.imageWidth || displayWidth;
    const naturalHeight = img.naturalHeight || this.imageHeight || displayHeight;

    // Scale factor from original image to displayed size
    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;

    // Position each mask element
    const masks = this.container.querySelectorAll('.mask-region');
    masks.forEach(mask => {
      const x = parseFloat(mask.dataset.bboxX) || 0;
      const y = parseFloat(mask.dataset.bboxY) || 0;
      const w = parseFloat(mask.dataset.bboxW) || 0;
      const h = parseFloat(mask.dataset.bboxH) || 0;

      // Scale to display coordinates
      mask.style.left = `${x * scaleX}px`;
      mask.style.top = `${y * scaleY}px`;
      mask.style.width = `${w * scaleX}px`;
      mask.style.height = `${h * scaleY}px`;
    });
  },

  attachMaskListeners() {
    const masks = this.container.querySelectorAll('.mask-region');
    masks.forEach(mask => {
      const maskId = mask.dataset.maskId;

      // Remove old listeners (in case of re-render)
      mask.onmouseenter = null;
      mask.onmouseleave = null;
      mask.onclick = null;

      // Hover handlers
      mask.onmouseenter = () => {
        this.hoveredMaskId = maskId;
        this.updateHighlight();
      };

      mask.onmouseleave = () => {
        if (this.hoveredMaskId === maskId) {
          this.hoveredMaskId = null;
          this.updateHighlight();
        }
      };

      // Click handler
      mask.onclick = (e) => {
        e.stopPropagation();
        const shift = e.shiftKey;

        // Update local selection state
        if (shift) {
          if (this.selectedMaskIds.has(maskId)) {
            this.selectedMaskIds.delete(maskId);
          } else {
            this.selectedMaskIds.add(maskId);
          }
        } else {
          this.selectedMaskIds = new Set([maskId]);
        }

        // Push event to server
        this.pushEvent("select_region", { id: maskId, shift: shift });
        this.updateHighlight();
      };
    });
  },

  handleKeydown(e) {
    // Only handle if no input is focused
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Enter = inpaint selected
    if (e.key === 'Enter' && this.selectedMaskIds.size > 0) {
      e.preventDefault();
      this.pushEvent("inpaint_selected", {});
    }

    // Escape = deselect all
    if (e.key === 'Escape') {
      this.selectedMaskIds = new Set();
      this.hoveredMaskId = null;
      this.pushEvent("deselect_all", {});
      this.updateHighlight();
    }

    // Cmd+Z (Mac) or Ctrl+Z (Win) = undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.pushEvent("undo", {});
    }

    // Cmd+Shift+Z (Mac) or Ctrl+Shift+Z (Win) = redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      this.pushEvent("redo", {});
    }
  },

  updateHighlight() {
    const masks = this.container.querySelectorAll('.mask-region');
    const hasSelection = this.selectedMaskIds.size > 0;
    const hasHover = this.hoveredMaskId !== null;

    masks.forEach(mask => {
      const maskId = mask.dataset.maskId;
      const isHovered = maskId === this.hoveredMaskId;
      const isSelected = this.selectedMaskIds.has(maskId);

      // Remove all state classes
      mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

      // Apply appropriate class
      if (isSelected) {
        mask.classList.add('mask-selected');
      } else if (isHovered) {
        mask.classList.add('mask-hovered');
      } else if (hasSelection || hasHover) {
        mask.classList.add('mask-dimmed');
      } else {
        mask.classList.add('mask-idle');
      }
    });

    // Update cursor on container
    this.container.style.cursor = hasHover ? 'pointer' : 'crosshair';
  }
};
