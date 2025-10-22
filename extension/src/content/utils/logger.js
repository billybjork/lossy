/**
 * Smart Logging Utility for Lossy Extension
 *
 * STRATEGY: Avoid console noise during regular browsing while preserving debuggability
 *
 * The extension runs on ALL pages (*\/*\/*) to provide immediate video detection when
 * the side panel is opened. However, this means it attempts video detection on pages
 * without videos (news sites, search engines, etc.), which would normally spam the
 * console with "no video found" warnings.
 *
 * SOLUTION: Context-aware logging that adapts to the user's intent:
 *
 * 1. SILENT MODE (default during casual browsing):
 *    - No console output when video detection fails on random pages
 *    - Extension works silently in the background
 *    - Clean console for users who aren't debugging
 *
 * 2. VERBOSE MODE (when user is actively using the extension):
 *    - Full logging when side panel is open
 *    - No automatic detection of DevTools (to avoid noise for developers who keep console open)
 *    - Helps debug issues when user is actually engaging with extension
 *
 * 3. ALWAYS LOG (critical errors):
 *    - Genuine errors (not "video not found", but actual failures)
 *    - Errors on known video platforms (YouTube, Vimeo, etc.)
 *    - Use console.error() for these
 *
 * USAGE:
 *   import { logger, setVerboseLogging } from './utils/logger.js';
 *
 *   // Instead of console.log():
 *   logger.debug('Video detection attempt', { attempt: 1 });
 *
 *   // Still use for real errors:
 *   logger.error('Failed to initialize adapter', error);
 *
 *   // Enable verbose mode when side panel opens:
 *   setVerboseLogging(true);
 */

/**
 * Global flag for verbose logging
 * Controlled by side panel state (panel_opened / panel_closed messages)
 */
let verboseLogging = false;

/**
 * Determine if verbose logging should be enabled
 *
 * STRATEGY: Only enable verbose mode when side panel is explicitly open.
 * This ensures console stays clean even for developers who keep DevTools open all day.
 *
 * If you want automatic verbose mode when DevTools is open, uncomment the code below.
 *
 * @returns {boolean} True if we should log debug-level messages
 */
function shouldLogVerbose() {
  // Only verbose if explicitly enabled (side panel is open)
  return verboseLogging;

  /* OPTIONAL: Uncomment to auto-enable verbose logging when DevTools is open

  // Auto-enable if DevTools console appears to be open
  if (!verboseLogging) {
    const threshold = 160; // DevTools adds significant height/width difference
    const heightDiff = window.outerHeight - window.innerHeight;
    const widthDiff = window.outerWidth - window.innerWidth;

    if (heightDiff > threshold || widthDiff > threshold) {
      return true; // DevTools likely open
    }
  }

  */
}

/**
 * Set verbose logging mode
 * Call this when side panel opens/closes
 *
 * @param {boolean} enabled - True to enable verbose logging
 */
export function setVerboseLogging(enabled) {
  verboseLogging = enabled;

  if (enabled) {
    console.log('[Lossy] Verbose logging enabled');
  }
}

/**
 * Logger object with context-aware methods
 *
 * Methods:
 * - debug(): Only logs in verbose mode (side panel open)
 * - info(): Only logs in verbose mode (side panel open)
 * - warn(): Only logs in verbose mode (side panel open)
 * - error(): ALWAYS logs (real errors should always be visible)
 */
export const logger = {
  /**
   * Debug-level logging (most verbose)
   * Use for: video detection attempts, state transitions, routine operations
   *
   * Only logs when side panel is open (verboseLogging = true)
   *
   * @param {string} message - Log message
   * @param {...any} args - Additional arguments to log
   */
  debug(message, ...args) {
    if (shouldLogVerbose()) {
      console.debug(message, ...args);
    }
  },

  /**
   * Info-level logging
   * Use for: successful operations, state changes, informational messages
   *
   * Only logs when side panel is open (verboseLogging = true)
   *
   * @param {string} message - Log message
   * @param {...any} args - Additional arguments to log
   */
  info(message, ...args) {
    if (shouldLogVerbose()) {
      console.info(message, ...args);
    }
  },

  /**
   * Warning-level logging
   * Use for: expected failures, recoverable issues, deprecations
   *
   * Only logs when side panel is open (verboseLogging = true)
   *
   * @param {string} message - Log message
   * @param {...any} args - Additional arguments to log
   */
  warn(message, ...args) {
    if (shouldLogVerbose()) {
      console.warn(message, ...args);
    }
  },

  /**
   * Error-level logging
   * Use for: genuine errors, critical failures, unexpected exceptions
   *
   * ALWAYS LOGS regardless of verbose mode
   * These are real problems that need attention
   *
   * @param {string} message - Error message
   * @param {...any} args - Additional arguments to log
   */
  error(message, ...args) {
    console.error(message, ...args);
  },
};

/**
 * Create a scoped logger with a prefix
 * Useful for identifying which component is logging
 *
 * @param {string} prefix - Prefix to add to all log messages
 * @returns {object} Logger object with prefixed methods
 *
 * @example
 * const log = createLogger('[VideoDetector]');
 * log.debug('Starting detection'); // => "[VideoDetector] Starting detection"
 */
export function createLogger(prefix) {
  return {
    debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args),
  };
}
