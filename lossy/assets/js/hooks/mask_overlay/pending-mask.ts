/**
 * Pending Mask Manager
 *
 * Manages cleanup of pending mask resources.
 * Note: The actual rendering is handled inline in index.ts.
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
 * Manages pending mask cleanup
 */
export class PendingMaskManager {
  private pendingMaskElement: HTMLDivElement | null = null;
  private marchAntsLoopId: number | null = null;

  constructor(_config: PendingMaskConfig) {}

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.marchAntsLoopId !== null) {
      cancelAnimationFrame(this.marchAntsLoopId);
      this.marchAntsLoopId = null;
    }
    if (this.pendingMaskElement) {
      this.pendingMaskElement.remove();
      this.pendingMaskElement = null;
    }
  }
}
