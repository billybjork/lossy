/**
 * MaskOverlay Hook - Bounding Box Selection
 *
 * Positions bounding box overlays on detected regions.
 *
 * Features:
 * - Hover/click detection on mask elements
 * - Multi-select with Shift+click
 * - Drag-to-select (marquee selection)
 * - Keyboard shortcuts (Enter, Escape, Cmd+Z)
 */

export const MaskOverlay = {
  mounted() {
    this.container = this.el;
    this.hoveredMaskId = null;
    this.selectedMaskIds = new Set();

    // Drag selection state
    this.isDragging = false;
    this.dragStart = null;
    this.dragRect = null;
    this.dragShift = false;  // Track if shift was held at drag start

    // Get image dimensions from data attributes
    this.imageWidth = parseInt(this.el.dataset.imageWidth) || 0;
    this.imageHeight = parseInt(this.el.dataset.imageHeight) || 0;

    // Position masks once image is loaded
    const img = document.getElementById('editor-image');
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

    // Drag selection listeners
    this.container.addEventListener('mousedown', (e) => this.startDrag(e));
    this.mouseMoveHandler = (e) => this.updateDrag(e);
    this.mouseUpHandler = (e) => this.endDrag(e);
    document.addEventListener('mousemove', this.mouseMoveHandler);
    document.addEventListener('mouseup', this.mouseUpHandler);

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

  updated() {
    // LiveView DOM patching may replace mask elements, losing event listeners.
    // Re-attach listeners and reposition after any server-triggered re-render.
    this.positionMasks();
    this.attachMaskListeners();
    this.updateHighlight();
  },

  destroyed() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('mousemove', this.mouseMoveHandler);
    document.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.dragRect) this.dragRect.remove();
  },

  positionMasks() {
    const img = document.getElementById('editor-image');
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
  },

  // Drag selection methods
  createDragRect() {
    const rect = document.createElement('div');
    rect.className = 'drag-selection-rect';
    rect.style.cssText = `
      position: absolute;
      border: 1px dashed rgba(59, 130, 246, 0.8);
      background: rgba(59, 130, 246, 0.1);
      pointer-events: none;
      display: none;
      z-index: 1000;
    `;
    this.container.appendChild(rect);
    return rect;
  },

  startDrag(e) {
    // Only start drag on container background, not on masks
    if (e.target.classList.contains('mask-region')) return;
    if (e.button !== 0) return;  // Left click only

    const containerRect = this.container.getBoundingClientRect();
    this.dragStart = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top
    };
    this.dragShift = e.shiftKey;

    // Create rubber band element if needed
    if (!this.dragRect) {
      this.dragRect = this.createDragRect();
    }
  },

  updateDrag(e) {
    if (!this.dragStart) return;

    const containerRect = this.container.getBoundingClientRect();
    const currentX = e.clientX - containerRect.left;
    const currentY = e.clientY - containerRect.top;

    // Calculate distance to check if we should start showing the rect
    const dx = currentX - this.dragStart.x;
    const dy = currentY - this.dragStart.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Minimum drag distance threshold to avoid accidental drags
    if (distance < 5 && !this.isDragging) return;

    this.isDragging = true;

    // Calculate rectangle bounds
    const left = Math.min(this.dragStart.x, currentX);
    const top = Math.min(this.dragStart.y, currentY);
    const width = Math.abs(currentX - this.dragStart.x);
    const height = Math.abs(currentY - this.dragStart.y);

    // Update rubber band position
    this.dragRect.style.left = `${left}px`;
    this.dragRect.style.top = `${top}px`;
    this.dragRect.style.width = `${width}px`;
    this.dragRect.style.height = `${height}px`;
    this.dragRect.style.display = 'block';

    // Preview: highlight masks that intersect
    const rect = { left, top, right: left + width, bottom: top + height };
    const intersecting = this.getMasksInRect(rect);
    this.previewDragSelection(intersecting);
  },

  endDrag(e) {
    if (!this.dragStart) return;

    if (this.isDragging) {
      const containerRect = this.container.getBoundingClientRect();
      const currentX = e.clientX - containerRect.left;
      const currentY = e.clientY - containerRect.top;

      const left = Math.min(this.dragStart.x, currentX);
      const top = Math.min(this.dragStart.y, currentY);
      const width = Math.abs(currentX - this.dragStart.x);
      const height = Math.abs(currentY - this.dragStart.y);

      const rect = { left, top, right: left + width, bottom: top + height };
      const selected = this.getMasksInRect(rect);

      if (selected.length > 0) {
        // Update local selection
        if (this.dragShift) {
          selected.forEach(id => this.selectedMaskIds.add(id));
        } else {
          this.selectedMaskIds = new Set(selected);
        }

        // Push to server
        this.pushEvent("select_regions", {
          ids: selected,
          shift: this.dragShift
        });
      }

      this.updateHighlight();
    }

    // Reset drag state
    this.isDragging = false;
    this.dragStart = null;
    this.dragShift = false;
    if (this.dragRect) {
      this.dragRect.style.display = 'none';
    }
  },

  getMasksInRect(rect) {
    const masks = this.container.querySelectorAll('.mask-region');
    const containerRect = this.container.getBoundingClientRect();
    const result = [];

    masks.forEach(mask => {
      const maskRect = mask.getBoundingClientRect();

      // Convert to container-relative coordinates
      const maskLeft = maskRect.left - containerRect.left;
      const maskTop = maskRect.top - containerRect.top;
      const maskRight = maskLeft + maskRect.width;
      const maskBottom = maskTop + maskRect.height;

      // Check intersection (any overlap counts)
      if (!(rect.right < maskLeft || rect.left > maskRight ||
            rect.bottom < maskTop || rect.top > maskBottom)) {
        result.push(mask.dataset.maskId);
      }
    });

    return result;
  },

  previewDragSelection(intersectingIds) {
    const masks = this.container.querySelectorAll('.mask-region');
    const previewSet = new Set(intersectingIds);

    masks.forEach(mask => {
      const maskId = mask.dataset.maskId;
      const isIntersecting = previewSet.has(maskId);
      const isSelected = this.selectedMaskIds.has(maskId);

      mask.classList.remove('mask-hovered', 'mask-selected', 'mask-dimmed', 'mask-idle');

      if (isIntersecting || (this.dragShift && isSelected)) {
        mask.classList.add('mask-selected');
      } else {
        mask.classList.add('mask-dimmed');
      }
    });
  }
};
