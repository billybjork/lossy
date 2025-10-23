/**
 * Recording Context State Management
 *
 * Pure functions for recording context capture and isolation.
 * Ensures notes/timestamps route to correct tab/video even if user switches tabs mid-recording.
 *
 * Critical for passive mode correctness:
 * - Context captured atomically at speech_start
 * - Preserved until note_created event arrives
 * - Stale contexts cleared after timeout to prevent memory leaks
 *
 * No Chrome APIs, no side effects - all unit-testable.
 */

import { PASSIVE_SESSION_CONFIG } from '../../shared/shared-constants.js';

/**
 * Create a recording context snapshot
 * Captures current tab, video, and timestamp for note routing
 *
 * @param {number} tabId - Active tab ID
 * @param {object} videoContext - Video context from tab manager
 * @param {number} timestamp - Video timestamp (seconds)
 * @param {object} autoPause - Auto-pause state { wasPlaying: boolean }
 * @returns {object} Recording context
 */
export function createRecordingContext(tabId, videoContext, timestamp, autoPause = {}) {
  return {
    tabId,
    videoDbId: videoContext?.videoDbId || null,
    videoContext,
    timestamp,
    startedAt: Date.now(),
    autoPause: {
      wasPlaying: autoPause.wasPlaying ?? false,
    },
  };
}

/**
 * Check if recording context is stale
 * Stale contexts should be cleared to prevent routing errors
 *
 * @param {object} context - Recording context
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {boolean} True if context is stale
 */
export function isContextStale(context, maxAgeMs = PASSIVE_SESSION_CONFIG.STALE_CONTEXT_THRESHOLD_MS) {
  if (!context || !context.startedAt) {
    return true;
  }
  return Date.now() - context.startedAt > maxAgeMs;
}

/**
 * Get context age in milliseconds
 * @param {object} context - Recording context
 * @returns {number} Age in milliseconds (or 0 if invalid)
 */
export function getContextAge(context) {
  if (!context || !context.startedAt) {
    return 0;
  }
  return Date.now() - context.startedAt;
}

/**
 * Check if context is valid for routing
 * @param {object} context - Recording context
 * @returns {boolean} True if context is valid
 */
export function isContextValid(context) {
  return (
    context &&
    context.tabId !== null &&
    context.videoDbId !== null &&
    context.videoContext &&
    !isContextStale(context)
  );
}

/**
 * Extract resume info from recording context
 * Used for auto-resume after recording ends
 *
 * @param {object} context - Recording context
 * @returns {object} Resume info { tabId, wasPlaying }
 */
export function extractResumeInfo(context) {
  if (!context) {
    return { tabId: null, wasPlaying: false };
  }

  return {
    tabId: context.tabId,
    wasPlaying: context.autoPause?.wasPlaying ?? false,
  };
}

/**
 * Clear recording context (returns null)
 * Used when context is no longer needed
 *
 * @returns {null}
 */
export function clearRecordingContext() {
  return null;
}
