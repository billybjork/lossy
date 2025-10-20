/**
 * Frame Capturer - Canvas-based video frame capture
 *
 * Sprint 08 - Task 2: Frame Capture Module
 *
 * Features:
 * - Precise frame capture using requestVideoFrameCallback
 * - Canvas resize to 224×224 (SigLIP input size)
 * - Timestamp synchronization
 * - CORS error handling
 * - Integration with video-controller.js pattern
 */

export class FrameCapturer {
  /**
   * Create a FrameCapturer instance.
   *
   * @param {HTMLVideoElement} videoElement - Video element to capture from
   * @param {Object} options - Options
   * @param {number} options.targetWidth - Target width (default: 224)
   * @param {number} options.targetHeight - Target height (default: 224)
   * @param {boolean} options.preserveAspectRatio - Preserve video aspect ratio (default: false)
   * @param {number} options.maxWidth - Max width when preserving aspect ratio (default: 1024)
   */
  constructor(videoElement, options = {}) {
    this.videoElement = videoElement;
    this.preserveAspectRatio = options.preserveAspectRatio || false;
    this.maxWidth = options.maxWidth || 1024;

    if (this.preserveAspectRatio) {
      // Calculate dimensions preserving aspect ratio
      const videoWidth = this.videoElement.videoWidth;
      const videoHeight = this.videoElement.videoHeight;
      const aspectRatio = videoWidth / videoHeight;

      if (videoWidth > this.maxWidth) {
        this.targetWidth = this.maxWidth;
        this.targetHeight = Math.round(this.maxWidth / aspectRatio);
      } else {
        this.targetWidth = videoWidth;
        this.targetHeight = videoHeight;
      }
    } else {
      this.targetWidth = options.targetWidth || 224;
      this.targetHeight = options.targetHeight || 224;
    }

    // Create offscreen canvas for frame capture
    // Use OffscreenCanvas if available (better performance)
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(this.targetWidth, this.targetHeight);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.targetWidth;
      this.canvas.height = this.targetHeight;
    }

    // willReadFrequently: true optimizes for repeated getImageData calls
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    console.log(
      `[FrameCapturer] Initialized for ${this.targetWidth}x${this.targetHeight} capture` +
        (this.preserveAspectRatio ? ' (aspect ratio preserved)' : '')
    );
  }

  /**
   * Capture current video frame.
   *
   * Uses requestVideoFrameCallback for precise timing synchronization.
   *
   * @returns {Promise<{imageData: ImageData, timestamp: number, dimensions: Object}>}
   * @throws {Error} If video not ready or CORS error
   */
  async captureCurrentFrame() {
    return new Promise((resolve, reject) => {
      // Check video readyState
      if (this.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        reject(new Error('Video not ready (readyState < HAVE_CURRENT_DATA)'));
        return;
      }

      // CRITICAL: requestVideoFrameCallback only fires when video is PLAYING
      // If paused, use immediate capture instead
      if (this.videoElement.paused) {
        console.log('[FrameCapturer] Video paused, using immediate capture');
        this._captureImmediate()
          .then(resolve)
          .catch(reject);
        return;
      }

      // Check if requestVideoFrameCallback is supported
      if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        // Fallback: capture immediately
        console.warn(
          '[FrameCapturer] requestVideoFrameCallback not supported, using immediate capture'
        );
        this._captureImmediate()
          .then(resolve)
          .catch(reject);
        return;
      }

      // Use requestVideoFrameCallback for precise timing when playing
      this.videoElement.requestVideoFrameCallback((now, metadata) => {
        try {
          const result = this._drawFrameToCanvas(metadata.mediaTime);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Capture frame at specific timestamp.
   *
   * Seeks to target timestamp, waits for seeked event, then captures.
   *
   * @param {number} timestampSeconds - Target timestamp in seconds
   * @param {Object} options - Options
   * @param {boolean} options.restoreTime - Restore original time after capture (default: false)
   * @returns {Promise<{imageData: ImageData, timestamp: number, dimensions: Object}>}
   */
  async captureFrameAtTimestamp(timestampSeconds, options = {}) {
    const { restoreTime = false } = options;

    const originalTime = this.videoElement.currentTime;

    console.log(`[FrameCapturer] Seeking to ${timestampSeconds}s for frame capture`);

    // Seek to target timestamp
    this.videoElement.currentTime = timestampSeconds;

    // Wait for seek complete
    await new Promise((resolve) => {
      const onSeeked = () => {
        this.videoElement.removeEventListener('seeked', onSeeked);
        resolve();
      };
      this.videoElement.addEventListener('seeked', onSeeked, { once: true });

      // Timeout safety (in case seeked never fires)
      setTimeout(() => {
        this.videoElement.removeEventListener('seeked', onSeeked);
        resolve();
      }, 2000);
    });

    // Capture frame at new position
    const frame = await this.captureCurrentFrame();

    // Restore original time if requested
    if (restoreTime && originalTime !== timestampSeconds) {
      this.videoElement.currentTime = originalTime;
    }

    return frame;
  }

  /**
   * Immediate capture (fallback for browsers without requestVideoFrameCallback).
   *
   * @private
   */
  async _captureImmediate() {
    const timestamp = this.videoElement.currentTime;
    return this._drawFrameToCanvas(timestamp);
  }

  /**
   * Draw current video frame to canvas and extract ImageData.
   *
   * @param {number} timestamp - Video timestamp
   * @returns {{imageData: ImageData, timestamp: number, dimensions: Object}}
   * @throws {Error} If CORS error or canvas operation fails
   * @private
   */
  _drawFrameToCanvas(timestamp) {
    try {
      // Draw video frame to canvas (scales to targetWidth × targetHeight)
      this.ctx.drawImage(
        this.videoElement,
        0, // sx
        0, // sy
        this.videoElement.videoWidth, // sWidth
        this.videoElement.videoHeight, // sHeight
        0, // dx
        0, // dy
        this.targetWidth, // dWidth
        this.targetHeight // dHeight
      );

      // Get image data
      const imageData = this.ctx.getImageData(0, 0, this.targetWidth, this.targetHeight);

      return {
        imageData,
        timestamp,
        dimensions: {
          original: {
            width: this.videoElement.videoWidth,
            height: this.videoElement.videoHeight,
          },
          resized: {
            width: this.targetWidth,
            height: this.targetHeight,
          },
        },
      };
    } catch (error) {
      // CORS errors or other canvas security issues
      if (error.name === 'SecurityError') {
        throw new Error(
          `CORS policy prevents frame capture from video source: ${this.videoElement.currentSrc}`
        );
      }

      throw error;
    }
  }

  /**
   * Batch capture multiple frames at specified timestamps.
   *
   * @param {number[]} timestamps - Array of timestamps in seconds
   * @param {Object} options - Options
   * @param {boolean} options.restoreTime - Restore original time after capture (default: true)
   * @returns {Promise<Array>} Array of frame capture results
   */
  async captureFramesAtTimestamps(timestamps, options = {}) {
    const { restoreTime = true } = options;

    const originalTime = this.videoElement.currentTime;
    const frames = [];

    for (const timestamp of timestamps) {
      try {
        const frame = await this.captureFrameAtTimestamp(timestamp, {
          restoreTime: false,
        });
        frames.push({ success: true, frame });
      } catch (error) {
        console.error(`[FrameCapturer] Failed to capture frame at ${timestamp}s:`, error);
        frames.push({ success: false, error: error.message, timestamp });
      }
    }

    // Restore original time after all captures
    if (restoreTime) {
      this.videoElement.currentTime = originalTime;
    }

    return frames;
  }

  /**
   * Convert current canvas to base64 JPEG.
   *
   * @param {number} quality - JPEG quality (0-1, default: 0.9)
   * @returns {Promise<string>} Base64 encoded JPEG (without data:image/jpeg;base64, prefix)
   */
  async canvasToBase64(quality = 0.9) {
    console.log('[FrameCapturer] Converting canvas to base64...', {
      isOffscreen: this.canvas instanceof OffscreenCanvas,
      canvasType: this.canvas.constructor.name,
    });

    try {
      // For OffscreenCanvas, convert to Blob then to base64
      if (this.canvas instanceof OffscreenCanvas) {
        console.log('[FrameCapturer] Using OffscreenCanvas.convertToBlob');
        const blob = await this.canvas.convertToBlob({
          type: 'image/jpeg',
          quality: quality,
        });

        console.log('[FrameCapturer] Blob created, size:', blob.size);

        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            console.log('[FrameCapturer] FileReader completed');
            // Remove data:image/jpeg;base64, prefix
            const base64 = reader.result.split(',')[1];
            console.log('[FrameCapturer] Base64 length:', base64.length);
            resolve(base64);
          };
          reader.onerror = (error) => {
            console.error('[FrameCapturer] FileReader error:', error);
            reject(error);
          };
          reader.readAsDataURL(blob);
        });
      } else {
        // For regular canvas, use toDataURL
        console.log('[FrameCapturer] Using regular canvas.toDataURL');
        const dataUrl = this.canvas.toDataURL('image/jpeg', quality);
        // Remove data:image/jpeg;base64, prefix
        const base64 = dataUrl.split(',')[1];
        console.log('[FrameCapturer] Base64 length:', base64.length);
        return base64;
      }
    } catch (error) {
      console.error('[FrameCapturer] Failed to convert canvas to base64:', error);
      throw error;
    }
  }

  /**
   * Check if frame capture is available for current video.
   *
   * @returns {boolean} True if capture is available
   */
  canCapture() {
    return (
      this.videoElement &&
      this.videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      this.videoElement.videoWidth > 0 &&
      this.videoElement.videoHeight > 0
    );
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.canvas = null;
    this.ctx = null;
    this.videoElement = null;

    console.log('[FrameCapturer] Destroyed');
  }
}

/**
 * Create a FrameCapturer instance for a video element.
 *
 * @param {HTMLVideoElement} videoElement - Video element
 * @param {Object} options - Options
 * @returns {FrameCapturer} FrameCapturer instance
 */
export function createFrameCapturer(videoElement, options = {}) {
  if (!videoElement || !(videoElement instanceof HTMLVideoElement)) {
    throw new Error('Invalid video element');
  }

  return new FrameCapturer(videoElement, options);
}
