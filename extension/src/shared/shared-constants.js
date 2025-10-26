/**
 * Shared Constants for Voice Mode and VAD
 *
 * Centralized configuration for Voice Activity Detection and Voice Mode Session behavior.
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
  START_THRESHOLD: 0.6, // Higher onset threshold paired with smoothing for stability
  END_THRESHOLD: 0.35, // Lower release threshold to widen hysteresis

  // Timing parameters (milliseconds)
  PRE_ROLL_MS: 500, // Audio to prepend before detected speech (captures early syllables)
  POST_PAD_MS: 120, // Audio to append after speech end (protects trailing consonants)
  MIN_SPEECH_DURATION_MS: 200, // Minimum speech duration to trigger recording
  MIN_SILENCE_DURATION_MS: 650, // Silence duration before ending speech
  MERGE_WITHIN_MS: 250, // Merge segments separated by short pauses
  MAX_SPEECH_DURATION_MS: 15000, // Absolute maximum speech duration (15s safety guard)

  // State machine tuning
  PROB_SMOOTHING_FRAMES: 5, // Sliding window size for confidence smoothing
  SILENCE_GATE_MS: 120, // Require consistent low confidence before accumulating silence
  MIDDLE_ZONE_REVERT_THRESHOLD: 0.4, // Threshold for reverting to speech from maybe_silence (40% of silence period)
  STUCK_STATE_TIMEOUT_MS: 2000, // Force end if no high confidence detected for this duration
  EXTENDED_SILENCE_MULTIPLIER: 3, // Force end after MIN_SILENCE * this multiplier
});

/**
 * Voice Mode Session Configuration
 *
 * Controls voice mode lifecycle, circuit breaker, and safety timeouts.
 * Frozen to prevent accidental mutation during runtime.
 */
export const VOICE_SESSION_CONFIG = Object.freeze({
  // Session timing
  COOLDOWN_MS: 500, // Cooldown period after speech_end before returning to observing
  AUTO_RESUME_DELAY_MS: 500, // Delay before auto-resuming paused video
  HEARTBEAT_INTERVAL_MS: 5000, // VAD health check interval

  // Circuit breaker (prevents infinite restart loops)
  MAX_RESTARTS: 3, // Maximum restart attempts before giving up
  RESET_WINDOW_MS: 60000, // Time window for restart count reset (1 minute)

  // Safety timeouts
  RECORDING_CONTEXT_TIMEOUT_MS: 5000, // Maximum time to wait for note_created event
  FIRST_SPEECH_TIMEOUT_MS: 10000, // Guard interval for first speech checks
  FIRST_SPEECH_GUARD_MAX_WAIT_MS: 180000, // Give users up to 3 minutes to navigate before auto-stop
  STALE_CONTEXT_THRESHOLD_MS: 2000, // Context age threshold for clearing stale contexts
});
