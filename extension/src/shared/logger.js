/**
 * Centralized Logging Utility
 *
 * Provides level-controlled logging with integration points for telemetry.
 *
 * Levels:
 * - DEBUG: Verbose logging gated by settings flag (off by default in production)
 * - INFO: Always on, non-critical informational messages
 * - WARN: Always on, warnings that should be tracked via telemetry
 * - ERROR: Always on, errors that should be tracked via telemetry
 *
 * Usage:
 *   import { logger, setDebugLogging } from './logger.js';
 *
 *   // Enable debug logging (typically from settings)
 *   setDebugLogging(true);
 *
 *   // Log messages with context
 *   logger.debug('VAD', 'Processing frame', frameData);
 *   logger.info('Passive', 'Session started');
 *   logger.warn('CircuitBreaker', 'Restart attempt', attemptCount);
 *   logger.error('Recording', error, 'Failed to start recording');
 */

let debugEnabled = false;

/**
 * Enable or disable DEBUG level logging.
 * Should be controlled by user settings.
 *
 * @param {boolean} enabled - Whether to enable debug logging
 */
export function setDebugLogging(enabled) {
  debugEnabled = enabled;
  console.log(`[Logger] Debug logging ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Get current debug logging state
 * @returns {boolean} Whether debug logging is enabled
 */
export function isDebugEnabled() {
  return debugEnabled;
}

/**
 * Centralized logger with level control
 */
export const logger = {
  /**
   * Debug level logging (verbose, gated by settings)
   * Only logs when debugEnabled is true
   *
   * @param {string} context - Context/module name (e.g., 'VAD', 'Passive', 'Recording')
   * @param {...any} args - Arguments to log
   */
  debug: (context, ...args) => {
    if (debugEnabled) {
      console.log(`[${context}]`, ...args);
    }
  },

  /**
   * Info level logging (always on)
   * For non-critical informational messages
   *
   * @param {string} context - Context/module name
   * @param {...any} args - Arguments to log
   */
  info: (context, ...args) => {
    console.log(`[${context}]`, ...args);
  },

  /**
   * Warning level logging (always on)
   * Warnings are logged to console and should be tracked via telemetry
   *
   * @param {string} context - Context/module name
   * @param {...any} args - Arguments to log
   */
  warn: (context, ...args) => {
    console.warn(`[${context}]`, ...args);
    // TODO: Call telemetryEmitter.warn(context, args)
    // This will preserve observability when DEBUG logging is disabled
  },

  /**
   * Error level logging (always on)
   * Errors are logged to console and should be tracked via telemetry
   *
   * @param {string} context - Context/module name
   * @param {Error} error - Error object
   * @param {...any} args - Additional context/arguments
   */
  error: (context, error, ...args) => {
    console.error(`[${context}]`, error, ...args);
    // TODO: Call telemetryEmitter.error(context, error, args)
    // This will preserve observability when DEBUG logging is disabled
  },
};
