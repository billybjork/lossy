/**
 * Shared Constants for Passive Mode and VAD
 *
 * Centralized configuration for Voice Activity Detection and Passive Session behavior.
 * All tunable parameters are collected here for easy discovery and modification.
 *
 * For tuning guidance, see: docs/VAD_TUNING_GUIDE.md
 */

/**
 * VAD Configuration (Silero V5)
 *
 * These parameters control the speech detection state machine and timing behavior.
 * Frozen to prevent accidental mutation during runtime.
 */
export const VAD_CONFIG = Object.freeze({
  // Silero V5 detection thresholds (0.0-1.0 confidence range)
  START_THRESHOLD: 0.45, // Speech start confidence - lowered from 0.5 for faster reaction
  END_THRESHOLD: 0.40, // Silence detection confidence - raised from 0.35 for cleaner boundaries

  // Timing parameters (milliseconds)
  MIN_SPEECH_DURATION_MS: 250, // Minimum speech duration to trigger recording (reduced from 500ms)
  MIN_SILENCE_DURATION_MS: 2000, // Silence duration before ending speech (2s tolerance for pauses)
  MAX_SPEECH_DURATION_MS: 30000, // Absolute maximum speech duration (30s safety guard)

  // State machine tuning
  MIDDLE_ZONE_REVERT_THRESHOLD: 0.4, // Threshold for reverting to speech from maybe_silence (40% of silence period)
  STUCK_STATE_TIMEOUT_MS: 2000, // Force end if no high confidence detected for this duration
  EXTENDED_SILENCE_MULTIPLIER: 3, // Force end after MIN_SILENCE * this multiplier
});

/**
 * Passive Session Configuration
 *
 * Controls passive mode lifecycle, circuit breaker, and safety timeouts.
 * Frozen to prevent accidental mutation during runtime.
 */
export const PASSIVE_SESSION_CONFIG = Object.freeze({
  // Session timing
  COOLDOWN_MS: 500, // Cooldown period after speech_end before returning to observing
  AUTO_RESUME_DELAY_MS: 500, // Delay before auto-resuming paused video
  HEARTBEAT_INTERVAL_MS: 5000, // VAD health check interval

  // Circuit breaker (prevents infinite restart loops)
  MAX_RESTARTS: 3, // Maximum restart attempts before giving up
  RESET_WINDOW_MS: 60000, // Time window for restart count reset (1 minute)

  // Safety timeouts
  RECORDING_CONTEXT_TIMEOUT_MS: 5000, // Maximum time to wait for note_created event
  FIRST_SPEECH_TIMEOUT_MS: 10000, // Auto-stop if no speech detected (10s after session start)
  STALE_CONTEXT_THRESHOLD_MS: 2000, // Context age threshold for clearing stale contexts
});
