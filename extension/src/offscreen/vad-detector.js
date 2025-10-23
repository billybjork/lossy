/**
 * Voice Activity Detection (VAD) - Sprint 10
 *
 * Two-tier detection strategy:
 * 1. WebRTC/Energy Baseline: Fast RMS energy threshold (always available)
 * 2. Silero ONNX: ML-based detection (optional, capability-dependent)
 *
 * Emits speech_start/speech_end events via callback.
 */

// VAD configuration from Sprint 10 spec
const MIN_SPEECH_DURATION_MS = 500;
const MIN_SILENCE_DURATION_MS = 500;
const ENERGY_THRESHOLD = 0.02;
const SILERO_CONFIDENCE_THRESHOLD = 0.5;

// Frame size for Silero (10ms chunks at 16kHz = 160 samples)
const SILERO_FRAME_SIZE = 160;

/**
 * Energy-based VAD detector (baseline)
 */
export class EnergyVAD {
  constructor(options = {}) {
    this.energyThreshold = options.energyThreshold || ENERGY_THRESHOLD;
    this.minSpeechDurationMs = options.minSpeechDurationMs || MIN_SPEECH_DURATION_MS;
    this.minSilenceDurationMs = options.minSilenceDurationMs || MIN_SILENCE_DURATION_MS;
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});

    // State machine
    this.state = 'silence'; // 'silence' | 'speech' | 'maybe_silence'
    this.speechStartTime = null;
    this.silenceStartTime = null;
  }

  /**
   * Process audio chunk and detect speech activity.
   *
   * @param {Float32Array} audioData - Audio samples [-1.0, 1.0]
   * @returns {Object} Detection result with energy and state
   */
  processAudio(audioData) {
    const energy = this.calculateRMSEnergy(audioData);
    const isSpeech = energy > this.energyThreshold;
    const now = performance.now();

    // State machine transitions
    switch (this.state) {
      case 'silence':
        if (isSpeech) {
          this.state = 'speech';
          this.speechStartTime = now;
          this.onSpeechStart({ energy, timestamp: now, source: 'energy' });
        }
        break;

      case 'speech':
        if (!isSpeech) {
          // Transition to maybe_silence (wait for MIN_SILENCE_DURATION_MS)
          this.state = 'maybe_silence';
          this.silenceStartTime = now;
        }
        break;

      case 'maybe_silence':
        if (isSpeech) {
          // False alarm - back to speech
          this.state = 'speech';
          this.silenceStartTime = null;
        } else if (now - this.silenceStartTime >= this.minSilenceDurationMs) {
          // Confirmed silence
          const speechDuration = this.silenceStartTime - this.speechStartTime;

          if (speechDuration >= this.minSpeechDurationMs) {
            // Valid speech segment
            this.onSpeechEnd({
              energy,
              timestamp: now,
              duration: speechDuration,
              source: 'energy',
            });
          } else {
            console.log(
              `[VAD] Ignored short speech segment: ${speechDuration.toFixed(0)}ms`
            );
          }

          this.state = 'silence';
          this.speechStartTime = null;
          this.silenceStartTime = null;
        }
        break;
    }

    return { energy, isSpeech, state: this.state };
  }

  /**
   * Calculate RMS (Root Mean Square) energy of audio signal.
   *
   * @param {Float32Array} audioData - Audio samples
   * @returns {number} RMS energy [0.0, 1.0]
   */
  calculateRMSEnergy(audioData) {
    let sum = 0;
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i] * audioData[i];
    }
    return Math.sqrt(sum / audioData.length);
  }

  /**
   * Reset VAD state (e.g., when stopping recording).
   */
  reset() {
    this.state = 'silence';
    this.speechStartTime = null;
    this.silenceStartTime = null;
  }
}

/**
 * Silero VAD detector (ML-based, optional upgrade)
 *
 * TODO Sprint 10 Phase 2: Implement Silero ONNX integration
 */
export class SileroVAD {
  constructor(options = {}) {
    this.confidenceThreshold = options.confidenceThreshold || SILERO_CONFIDENCE_THRESHOLD;
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});

    this.model = null;
    this.state = 'silence';
    this.speechStartTime = null;
    this.silenceStartTime = null;
  }

  async loadModel() {
    // TODO: Implement Silero model loading (Phase 2)
    throw new Error('Silero VAD not yet implemented');
  }

  processAudio(audioData) {
    // TODO: Implement Silero inference (Phase 2)
    throw new Error('Silero VAD not yet implemented');
  }

  reset() {
    this.state = 'silence';
    this.speechStartTime = null;
    this.silenceStartTime = null;
  }
}

/**
 * Hybrid VAD coordinator.
 *
 * Uses energy baseline by default, upgrades to Silero if available.
 */
export class HybridVAD {
  constructor(options = {}) {
    this.useSilero = options.useSilero || false;
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});

    // Create energy VAD (always available)
    this.energyVAD = new EnergyVAD({
      energyThreshold: options.energyThreshold,
      minSpeechDurationMs: options.minSpeechDurationMs,
      minSilenceDurationMs: options.minSilenceDurationMs,
      onSpeechStart: this.onSpeechStart,
      onSpeechEnd: this.onSpeechEnd,
    });

    // Silero VAD (optional)
    this.sileroVAD = null;
  }

  async init() {
    if (this.useSilero) {
      try {
        this.sileroVAD = new SileroVAD({
          confidenceThreshold: SILERO_CONFIDENCE_THRESHOLD,
          onSpeechStart: this.onSpeechStart,
          onSpeechEnd: this.onSpeechEnd,
        });
        await this.sileroVAD.loadModel();
        console.log('[VAD] Silero model loaded successfully');
      } catch (error) {
        console.warn('[VAD] Silero initialization failed, using energy-only:', error);
        this.sileroVAD = null;
      }
    }
  }

  processAudio(audioData) {
    // Use Silero if available, otherwise fall back to energy
    if (this.sileroVAD) {
      return this.sileroVAD.processAudio(audioData);
    } else {
      return this.energyVAD.processAudio(audioData);
    }
  }

  reset() {
    this.energyVAD.reset();
    if (this.sileroVAD) {
      this.sileroVAD.reset();
    }
  }

  getMode() {
    return this.sileroVAD ? 'silero' : 'energy';
  }
}
