/**
 * Passive Session State Management
 *
 * Pure state helpers for passive mode. No Chrome APIs, no side effects.
 * All functions are unit-testable and return new state objects.
 *
 * State machine:
 * idle → observing → recording → cooldown → observing
 *                               ↓
 *                             error
 */

import { PASSIVE_SESSION_CONFIG } from '../../shared/shared-constants.js';

const AUTO_PAUSE_DEFAULT = true;

/**
 * Initial passive session state
 */
export const initialPassiveState = {
  tabId: null,
  status: 'idle', // 'idle' | 'observing' | 'recording' | 'cooldown' | 'error'
  vadEnabled: false,
  lastStartAt: 0,
  vadConfig: null,

  // Persistent audio channel for passive mode
  socket: null,
  audioChannel: null,
  sessionId: null,

  // Recording context snapshot (captured atomically at speech_start)
  recordingContext: null, // { tabId, videoDbId, videoContext, timestamp, startedAt, autoPause }
  recordingContextTimeout: null,

  // Auto-start behavior timeouts
  firstSpeechTimeout: null,
  resumeTimeout: null,

  // Telemetry
  telemetry: {
    speechDetections: 0,
    ignoredShort: 0,
    ignoredCooldown: 0,
    ignoredPendingNote: 0,
    ignoredNoContext: 0,
    avgLatencyMs: 0,
    lastConfidence: 0,
    lastLatencyMs: 0,
    restartAttempts: 0,
    notesCreated: 0,
    startedAt: null,
  },

  settings: {
    autoPauseVideo: AUTO_PAUSE_DEFAULT,
    autoResumeDelayMs: PASSIVE_SESSION_CONFIG.AUTO_RESUME_DELAY_MS,
  },

  circuitBreaker: {
    state: 'closed',
    restartCount: 0,
    lastRestartAt: 0,
    maxRestarts: PASSIVE_SESSION_CONFIG.MAX_RESTARTS,
    resetWindowMs: PASSIVE_SESSION_CONFIG.RESET_WINDOW_MS,
  },

  heartbeatFailures: 0,
};

/**
 * Pure state reducers (no side effects)
 */

/**
 * Update passive session status
 * @param {object} state - Current state
 * @param {string} newStatus - New status value
 * @returns {object} New state
 */
export function updateStatus(state, newStatus) {
  return { ...state, status: newStatus };
}

/**
 * Update VAD enabled state
 * @param {object} state - Current state
 * @param {boolean} enabled - Whether VAD is enabled
 * @returns {object} New state
 */
export function updateVadEnabled(state, enabled) {
  return { ...state, vadEnabled: enabled };
}

/**
 * Update telemetry values
 * @param {object} state - Current state
 * @param {object} updates - Telemetry updates (partial)
 * @returns {object} New state
 */
export function updateTelemetry(state, updates) {
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      ...updates,
    },
  };
}

/**
 * Increment telemetry counter
 * @param {object} state - Current state
 * @param {string} counterName - Name of counter to increment
 * @returns {object} New state
 */
export function incrementTelemetryCounter(state, counterName) {
  return updateTelemetry(state, {
    [counterName]: (state.telemetry[counterName] || 0) + 1,
  });
}

/**
 * Reset telemetry to initial values
 * @param {object} state - Current state
 * @returns {object} New state
 */
export function resetTelemetry(state) {
  return {
    ...state,
    telemetry: {
      ...initialPassiveState.telemetry,
      startedAt: Date.now(),
    },
  };
}

/**
 * Update circuit breaker state
 * @param {object} state - Current state
 * @param {object} updates - Circuit breaker updates (partial)
 * @returns {object} New state
 */
export function updateCircuitBreaker(state, updates) {
  return {
    ...state,
    circuitBreaker: {
      ...state.circuitBreaker,
      ...updates,
    },
  };
}

/**
 * Increment circuit breaker restart count
 * @param {object} state - Current state
 * @returns {object} New state
 */
export function incrementRestartCount(state) {
  const now = Date.now();
  const { lastRestartAt, resetWindowMs, restartCount } = state.circuitBreaker;

  // Reset count if outside reset window
  if (now - lastRestartAt > resetWindowMs) {
    return updateCircuitBreaker(state, {
      restartCount: 1,
      lastRestartAt: now,
    });
  }

  return updateCircuitBreaker(state, {
    restartCount: restartCount + 1,
    lastRestartAt: now,
  });
}

/**
 * Check if circuit breaker should trip
 * @param {object} state - Current state
 * @returns {boolean} True if circuit should trip
 */
export function shouldTripCircuitBreaker(state) {
  return state.circuitBreaker.restartCount >= state.circuitBreaker.maxRestarts;
}

/**
 * Reset circuit breaker to initial state
 * @param {object} state - Current state
 * @returns {object} New state
 */
export function resetCircuitBreaker(state) {
  return updateCircuitBreaker(state, {
    state: 'closed',
    restartCount: 0,
    lastRestartAt: 0,
  });
}

/**
 * Trip circuit breaker
 * @param {object} state - Current state
 * @returns {object} New state
 */
export function tripCircuitBreaker(state) {
  return updateCircuitBreaker(state, {
    state: 'open',
  });
}
