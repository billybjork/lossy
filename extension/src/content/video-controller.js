/**
 * Generic video controller - works with any HTML5 video element.
 */
export class VideoController {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.lastReportedTime = -1;
    this.timeUpdateHandler = null;
    this.setupTimeTracking();
  }

  setupTimeTracking() {
    this.timeUpdateHandler = () => {
      const currentTime = this.videoElement.currentTime;

      // Only send updates every ~0.5s to avoid spam
      if (Math.abs(currentTime - this.lastReportedTime) >= 0.5) {
        this.lastReportedTime = currentTime;
        this.pushTimeUpdate(currentTime);
      }
    };

    this.videoElement.addEventListener('timeupdate', this.timeUpdateHandler);
  }

  pushTimeUpdate(time) {
    // Check if video duration is available (helps detect platform limitations)
    const duration = this.getDuration();
    const isTimecodeUnavailable = !duration || isNaN(duration);

    chrome.runtime
      .sendMessage({
        action: 'video_time_update',
        timestamp: time,
        timecodeUnavailable: isTimecodeUnavailable,
      })
      .catch(() => {
        // Side panel may not be open
      });
  }

  async getCurrentTime() {
    if (!this.videoElement) return null;

    // CRITICAL: Check if paused FIRST to avoid hanging
    // requestVideoFrameCallback never fires when video is paused
    if (this.videoElement.paused) {
      console.log('[VideoController] Video paused, using currentTime directly');
      return Promise.resolve(this.videoElement.currentTime);
    }

    // Use requestVideoFrameCallback for precision when playing
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      return new Promise((resolve) => {
        // CRITICAL: Timeout fallback in case callback doesn't fire
        const timeoutId = setTimeout(() => {
          console.warn(
            '[VideoController] requestVideoFrameCallback timed out, using currentTime fallback'
          );
          resolve(this.videoElement.currentTime);
        }, 100);

        this.videoElement.requestVideoFrameCallback((now, metadata) => {
          clearTimeout(timeoutId);
          resolve(metadata.mediaTime);
        });
      });
    }

    // Fallback for browsers without requestVideoFrameCallback
    return Promise.resolve(this.videoElement.currentTime);
  }

  pause() {
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();

      // Dispatch events to update platform UI
      this.videoElement.dispatchEvent(new Event('pause'));
      this.videoElement.dispatchEvent(new Event('paused'));
    }
  }

  play() {
    if (this.videoElement && this.videoElement.paused) {
      this.videoElement.play();

      // Dispatch events to update platform UI
      this.videoElement.dispatchEvent(new Event('play'));
      this.videoElement.dispatchEvent(new Event('playing'));
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
    if (this.timeUpdateHandler) {
      this.videoElement.removeEventListener('timeupdate', this.timeUpdateHandler);
      this.timeUpdateHandler = null;
    }
  }
}
