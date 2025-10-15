/**
 * Generic video controller - works with any HTML5 video element.
 */
export class VideoController {
  constructor(videoElement) {
    this.videoElement = videoElement;
  }

  async getCurrentTime() {
    if (!this.videoElement) return null;

    // Use requestVideoFrameCallback for precision (Chrome 83+)
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      return new Promise((resolve) => {
        this.videoElement.requestVideoFrameCallback((now, metadata) => {
          resolve(metadata.mediaTime);
        });
      });
    }

    return Promise.resolve(this.videoElement.currentTime);
  }

  pause() {
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();
    }
  }

  play() {
    if (this.videoElement && this.videoElement.paused) {
      this.videoElement.play();
    }
  }

  seekTo(timestamp) {
    if (this.videoElement) {
      this.videoElement.currentTime = timestamp;
    }
  }

  getDuration() {
    return this.videoElement?.duration || 0;
  }

  destroy() {
    // Cleanup if needed
  }
}
