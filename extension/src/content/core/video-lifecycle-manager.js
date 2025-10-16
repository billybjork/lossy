/**
 * Video Lifecycle Manager - State machine for video detection health and persistence.
 *
 * State machine: idle → detecting → ready → error
 *
 * Features:
 * - Periodic health checks (video validity, adapter health)
 * - Persistent detection (retry until found)
 * - State change callbacks for event notification
 */
export class VideoLifecycleManager {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.state = 'idle'; // idle → detecting → ready → error
    this.videoElement = null;
    this.healthCheckInterval = null;
    this.persistentDetectionInterval = null;
    this.stateChangeCallbacks = [];
    this.options = {
      healthCheckInterval: options.healthCheckInterval || 5000,
      persistentDetectionInterval: options.persistentDetectionInterval || 5000,
      persistentDetectionMaxAttempts: options.persistentDetectionMaxAttempts || 20,
      signal: options.signal, // AbortSignal for cleanup
      ...options
    };

    // Setup AbortSignal listener if provided
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        console.log('[VideoLifecycle] AbortSignal received, stopping...');
        this.stop();
      });
    }
  }

  /**
   * Start lifecycle management.
   */
  async start() {
    if (this.state !== 'idle') {
      console.log('[VideoLifecycle] Already started, state:', this.state);
      return;
    }

    this.setState('detecting');

    try {
      this.videoElement = await this.adapter.detectVideo();

      if (this.videoElement) {
        console.log('[VideoLifecycle] Video detected, starting health checks');
        this.setState('ready');
        this.startHealthChecks();

        // CRITICAL FIX: Notify listeners when video is found immediately
        this.notifyStateChange('video_detected', { videoElement: this.videoElement });
      } else {
        console.warn('[VideoLifecycle] No video found, starting persistent detection');
        this.setState('error');
        this.startPersistentDetection();
      }
    } catch (error) {
      console.error('[VideoLifecycle] Detection failed:', error);
      this.setState('error');
      this.startPersistentDetection();
    }
  }

  /**
   * Periodic health checks (video validity, adapter health).
   */
  startHealthChecks() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.videoElement || !document.contains(this.videoElement)) {
        console.log('[VideoLifecycle] 🏥 Video element replaced, recovering...');
        this.setState('error');
        this.stop();
        this.start(); // Re-initialize
        return;
      }

      // Check if video is playable
      if (this.videoElement.error) {
        console.log('[VideoLifecycle] 🏥 Video error detected, recovering...');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // Check adapter health
      if (this.adapter.isHealthy && !this.adapter.isHealthy()) {
        console.log('[VideoLifecycle] 🏥 Adapter unhealthy, recovering...');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // All checks passed (only log occasionally to reduce noise)
      if (Math.random() < 0.1) { // Log 10% of the time
        console.log('[VideoLifecycle] 🏥 Health check passed');
      }
    }, this.options.healthCheckInterval);
  }

  /**
   * Persistent detection (retry until video found).
   */
  startPersistentDetection() {
    let attempts = 0;

    this.persistentDetectionInterval = setInterval(async () => {
      attempts++;
      console.log(`[VideoLifecycle] 🔄 Persistent detection attempt ${attempts}/${this.options.persistentDetectionMaxAttempts}`);

      if (attempts >= this.options.persistentDetectionMaxAttempts) {
        console.error('[VideoLifecycle] ❌ Persistent detection failed after max attempts');
        clearInterval(this.persistentDetectionInterval);
        this.persistentDetectionInterval = null;
        return;
      }

      try {
        this.videoElement = await this.adapter.detectVideo();

        if (this.videoElement) {
          console.log('[VideoLifecycle] ✅ Persistent detection succeeded!');
          clearInterval(this.persistentDetectionInterval);
          this.persistentDetectionInterval = null;
          this.setState('ready');
          this.startHealthChecks();

          // Notify listeners
          this.notifyStateChange('video_detected', { videoElement: this.videoElement });
        }
      } catch (error) {
        console.error('[VideoLifecycle] Persistent detection error:', error);
      }
    }, this.options.persistentDetectionInterval);
  }

  /**
   * Stop all monitoring.
   */
  stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.persistentDetectionInterval) {
      clearInterval(this.persistentDetectionInterval);
      this.persistentDetectionInterval = null;
    }

    this.setState('idle');
  }

  /**
   * State machine transitions.
   */
  setState(newState) {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    console.log(`[VideoLifecycle] State: ${oldState} → ${newState}`);
    this.notifyStateChange('state_changed', { oldState, newState });
  }

  /**
   * Register callback for state changes.
   */
  onStateChange(callback) {
    this.stateChangeCallbacks.push(callback);
  }

  notifyStateChange(event, data) {
    this.stateChangeCallbacks.forEach(cb => {
      try {
        cb(event, data);
      } catch (err) {
        console.error('[VideoLifecycle] Callback error:', err);
      }
    });
  }

  isReady() {
    return this.state === 'ready';
  }

  getVideoElement() {
    return this.videoElement;
  }

  destroy() {
    this.stop();
    this.stateChangeCallbacks = [];
  }
}
