import { createLogger } from '../utils/logger.js';

// Smart logger that only outputs during verbose mode (side panel open or DevTools visible)
// to avoid console noise during casual browsing on non-video pages
const log = createLogger('[VideoLifecycle]');

/**
 * Video Lifecycle Manager - State machine for video detection health and persistence.
 *
 * State machine: idle → detecting → ready → error
 *
 * Features:
 * - Periodic health checks (video validity, adapter health)
 * - Persistent detection (retry until found)
 * - State change callbacks for event notification
 *
 * LOGGING STRATEGY:
 * - Uses smart logging to avoid console spam during casual browsing
 * - Extension runs on ALL pages (*\/*\/*), so "no video found" is EXPECTED behavior
 * - Verbose logging only when side panel is open or DevTools console is visible
 * - Critical errors (exceptions, callback failures) always logged via console.error
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
      ...options,
    };

    // Setup AbortSignal listener if provided
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        log.debug('AbortSignal received, stopping...');
        this.stop();
      });
    }
  }

  /**
   * Start lifecycle management.
   */
  async start() {
    if (this.state !== 'idle') {
      log.debug('Already started, state:', this.state);
      return;
    }

    this.setState('detecting');

    try {
      this.videoElement = await this.adapter.detectVideo();

      if (this.videoElement) {
        log.info('Video detected, starting health checks');
        this.setState('ready');
        this.startHealthChecks();

        // CRITICAL FIX: Notify listeners when video is found immediately
        this.notifyStateChange('video_detected', { videoElement: this.videoElement });
      } else {
        // This is EXPECTED on non-video pages during casual browsing
        // Only log in verbose mode to avoid console spam
        log.warn('No video found, starting persistent detection');
        this.setState('error');
        this.startPersistentDetection();
      }
    } catch (error) {
      // Real errors (exceptions) should always be visible
      log.error('Detection failed:', error);
      this.setState('error');
      this.startPersistentDetection();
    }
  }

  /**
   * Periodic health checks (video validity, adapter health).
   */
  startHealthChecks() {
    this.healthCheckInterval = setInterval(() => {
      // Check if video element is still valid
      // For mock video elements (e.g., YouTube iframe), check isConnected property
      // For real video elements, use document.contains()
      const isConnected = this.videoElement?.__isYouTubeIframe
        ? this.videoElement.isConnected &&
          this.videoElement.iframe &&
          document.contains(this.videoElement.iframe)
        : this.videoElement && document.contains(this.videoElement);

      if (!this.videoElement || !isConnected) {
        log.info('🏥 Video element replaced, recovering...');
        this.setState('error');
        this.stop();
        this.start(); // Re-initialize
        return;
      }

      // Check if video is playable (skip for mock elements)
      if (!this.videoElement.__isYouTubeIframe && this.videoElement.error) {
        log.info('🏥 Video error detected, recovering...');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // Check adapter health
      if (this.adapter.isHealthy && !this.adapter.isHealthy()) {
        log.info('🏥 Adapter unhealthy, recovering...');
        this.setState('error');
        this.stop();
        this.start();
        return;
      }

      // All checks passed (only log occasionally to reduce noise)
      if (Math.random() < 0.1) {
        // Log 10% of the time (and only in verbose mode)
        log.debug('🏥 Health check passed');
      }
    }, this.options.healthCheckInterval);
  }

  /**
   * Persistent detection (retry until video found).
   *
   * NOTE: This runs on ALL pages during casual browsing when no initial video is found.
   * It's EXPECTED to fail on non-video pages (news sites, search engines, etc.).
   * Logging is suppressed unless verbose mode is active to avoid console spam.
   */
  startPersistentDetection() {
    let attempts = 0;

    this.persistentDetectionInterval = setInterval(async () => {
      attempts++;
      log.debug(
        `🔄 Persistent detection attempt ${attempts}/${this.options.persistentDetectionMaxAttempts}`
      );

      if (attempts >= this.options.persistentDetectionMaxAttempts) {
        // This is EXPECTED on non-video pages - not an error
        // Only log in verbose mode to avoid console noise during casual browsing
        log.warn('❌ Persistent detection failed after max attempts');
        clearInterval(this.persistentDetectionInterval);
        this.persistentDetectionInterval = null;
        return;
      }

      try {
        this.videoElement = await this.adapter.detectVideo();

        if (this.videoElement) {
          log.info('✅ Persistent detection succeeded!');
          clearInterval(this.persistentDetectionInterval);
          this.persistentDetectionInterval = null;
          this.setState('ready');
          this.startHealthChecks();

          // Notify listeners
          this.notifyStateChange('video_detected', { videoElement: this.videoElement });
        }
      } catch (error) {
        // Real errors (exceptions) should always be visible
        log.error('Persistent detection error:', error);
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
    log.debug(`State: ${oldState} → ${newState}`);
    this.notifyStateChange('state_changed', { oldState, newState });
  }

  /**
   * Register callback for state changes.
   */
  onStateChange(callback) {
    this.stateChangeCallbacks.push(callback);
  }

  notifyStateChange(event, data) {
    this.stateChangeCallbacks.forEach((cb) => {
      try {
        cb(event, data);
      } catch (err) {
        // Callback errors are real bugs that should always be visible
        log.error('Callback error:', err);
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
