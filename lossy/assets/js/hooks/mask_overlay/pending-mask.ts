/**
 * Pending Mask Manager
 *
 * Manages the pending mask preview with marching ants animation:
 * - Creates and positions the pending mask overlay
 * - Animates the marching ants border effect
 * - Handles confirmation and cancellation
 *
 * Extracted from MaskOverlay to reduce complexity.
 */

import type { MaskData } from './types';

export interface PendingMaskConfig {
  container: HTMLElement;
  onConfirm: (mask: MaskData) => void;
  onCancel: () => void;
}

/**
 * Manages pending mask display and animation
 */
export class PendingMaskManager {
  private pendingMask: MaskData | null = null;
  private pendingMaskElement: HTMLDivElement | null = null;
  private marchAntsOffset = 0;
  private marchAntsLoopId: number | null = null;

  constructor(private config: PendingMaskConfig) {}

  /**
   * Check if there's a pending mask
   */
  hasPendingMask(): boolean {
    return this.pendingMask !== null;
  }

  /**
   * Get the current pending mask data
   */
  getPendingMask(): MaskData | null {
    return this.pendingMask;
  }

  /**
   * Create a new pending mask with marching ants animation
   */
  create(maskData: MaskData): void {
    this.pendingMask = maskData;
    this.createPendingMaskElement();
    this.startMarchingAntsAnimation();
  }

  /**
   * Confirm the pending mask
   */
  confirm(): void {
    if (!this.pendingMask) return;

    const mask = this.pendingMask;
    this.cancel(); // Clean up first
    this.config.onConfirm(mask);
  }

  /**
   * Cancel the pending mask
   */
  cancel(): void {
    this.stopMarchingAntsAnimation();
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
      this.pendingMaskElement = null;
    }
    this.pendingMask = null;
    this.config.onCancel();
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stopMarchingAntsAnimation();
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
      this.pendingMaskElement = null;
    }
    this.pendingMask = null;
  }

  // ============ Private Methods ============

  private createPendingMaskElement(): void {
    const jsContainer = document.getElementById('js-overlay-container');
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!jsContainer || !this.pendingMask || !img) return;

    // Remove any existing one
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
    }

    const el = document.createElement('div');
    el.className = 'pending-mask-container';
    el.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 60;
      filter: drop-shadow(0 0 10px rgba(59, 130, 246, 0.3));
    `;

    const canvas = document.createElement('canvas');
    canvas.className = 'pending-mask-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    el.appendChild(canvas);

    // Size canvas drawing buffer to match the displayed image size
    const dpr = window.devicePixelRatio || 1;
    canvas.width = img.clientWidth * dpr;
    canvas.height = img.clientHeight * dpr;

    this.pendingMaskElement = el;
    jsContainer.appendChild(el);
  }

  private startMarchingAntsAnimation(): void {
    this.stopMarchingAntsAnimation(); // Ensure no multiple loops
    this.marchAntsOffset = 0;
    let frameCount = 0;

    const animationLoop = () => {
      if (!this.pendingMask) {
        this.stopMarchingAntsAnimation();
        return;
      }

      frameCount++;
      if (frameCount % 3 === 0) { // Update offset every 3 frames to slow it down
        this.marchAntsOffset = (this.marchAntsOffset + 1) % 10;
        this.drawPendingMask();
      }

      this.marchAntsLoopId = requestAnimationFrame(animationLoop);
    };

    this.drawPendingMask(); // Draw immediately to prevent flicker
    this.marchAntsLoopId = requestAnimationFrame(animationLoop);
  }

  private stopMarchingAntsAnimation(): void {
    if (this.marchAntsLoopId !== null) {
      cancelAnimationFrame(this.marchAntsLoopId);
      this.marchAntsLoopId = null;
    }
  }

  private async drawPendingMask(): Promise<void> {
    if (!this.pendingMask || !this.pendingMaskElement) return;

    const canvas = this.pendingMaskElement.querySelector('.pending-mask-canvas') as HTMLCanvasElement | null;
    const img = document.getElementById('editor-image') as HTMLImageElement | null;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maskImg = new Image();
    maskImg.onload = () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = maskImg.width;
      tempCanvas.height = maskImg.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;

      tempCtx.drawImage(maskImg, 0, 0);
      const imageData = tempCtx.getImageData(0, 0, maskImg.width, maskImg.height);
      const contours = this.findAllContours(imageData);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (contours.length === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const scaleX = img.clientWidth / maskImg.width;
      const scaleY = img.clientHeight / maskImg.height;
      const avgScale = Math.sqrt(scaleX * scaleY);

      ctx.save();
      ctx.scale(dpr, dpr);

      // Draw marquee-style selection for all disconnected regions
      for (const contour of contours) {
        if (contour.length < 3) continue; // Need at least 3 points for a closed shape

        const path = new Path2D();
        path.moveTo(contour[0].x * scaleX, contour[0].y * scaleY);
        for (let i = 1; i < contour.length; i++) {
          path.lineTo(contour[i].x * scaleX, contour[i].y * scaleY);
        }
        path.closePath();

        // 1. Blue fill (matches marquee)
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fill(path);

        // 2. Solid black outline for contrast (1px)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1 / avgScale; // Maintain 1px perceived width
        ctx.lineJoin = 'round';
        ctx.stroke(path);

        // 3. Blue dashed border (2px) - animated layer
        ctx.strokeStyle = 'rgb(59, 130, 246)';
        ctx.lineWidth = 2 / avgScale; // Maintain 2px perceived width
        ctx.setLineDash([6, 4]); // Dash pattern: 6px dash, 4px gap
        ctx.lineDashOffset = -this.marchAntsOffset;
        ctx.stroke(path);
      }

      ctx.restore();
    };
    maskImg.src = this.pendingMask.mask_png;
  }

  /**
   * Find all contours in a mask from ImageData
   * Supports disconnected regions (e.g., separate letters)
   */
  private findAllContours(imageData: ImageData): Array<Array<{ x: number; y: number }>> {
    const { width, height, data } = imageData;
    const visited = new Uint8Array(width * height);
    const contours: Array<Array<{ x: number; y: number }>> = [];

    // Flood fill to find each connected component
    const floodFill = (startX: number, startY: number): Array<{ x: number; y: number }> => {
      const stack: [number, number][] = [[startX, startY]];
      const pixels: Array<{ x: number; y: number }> = [];

      while (stack.length > 0) {
        const [x, y] = stack.pop()!;
        const idx = y * width + x;

        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (visited[idx] || data[idx * 4 + 3] === 0) continue;

        visited[idx] = 1;
        pixels.push({ x, y });

        stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
      }

      return pixels;
    };

    // Find boundary pixels for a component
    const findBoundary = (pixels: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
      const boundary: Array<{ x: number; y: number }> = [];
      const pixelSet = new Set(pixels.map(p => `${p.x},${p.y}`));

      for (const { x, y } of pixels) {
        // Check if this pixel has a neighbor that's outside the component
        const isEdge =
          x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          !pixelSet.has(`${x - 1},${y}`) ||
          !pixelSet.has(`${x + 1},${y}`) ||
          !pixelSet.has(`${x},${y - 1}`) ||
          !pixelSet.has(`${x},${y + 1}`);

        if (isEdge) {
          boundary.push({ x, y });
        }
      }

      return boundary;
    };

    // Find all connected components
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!visited[idx] && data[idx * 4 + 3] > 0) {
          const componentPixels = floodFill(x, y);
          if (componentPixels.length > 10) { // Ignore very small regions
            const boundary = findBoundary(componentPixels);
            if (boundary.length > 0) {
              contours.push(boundary);
            }
          }
        }
      }
    }

    return contours;
  }
}
