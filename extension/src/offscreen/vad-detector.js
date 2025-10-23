import * as ort from 'onnxruntime-web';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;
const HOP_SIZE = 160; // 10ms @ 16kHz
const HOP_MS = (HOP_SIZE / SAMPLE_RATE) * 1000;
const STATE_SIZE = 2 * 1 * 128;
const STATE_SHAPE = [2, 1, 128];

const MIN_SPEECH_DURATION_MS = 250; // Reduced from 500ms - faster reaction
const MIN_SILENCE_DURATION_MS = 2000; // Increased to 2s - more tolerance for pauses
const MAX_SPEECH_DURATION_MS = 30000; // 30 seconds absolute max
const START_THRESHOLD = 0.45; // Lowered from 0.5 - more sensitive to speech start
const END_THRESHOLD = 0.40; // Raised from 0.35 - tighter middle zone, cleaner end detection
const MIDDLE_ZONE_REVERT_THRESHOLD = 0.4; // Only revert in first 40% of silence period (800ms)
const STATE_SILENCE = 'silence';
const STATE_SPEECH = 'speech';
const STATE_MAYBE_SILENCE = 'maybe_silence';

/**
 * Silero VAD detector (WebAssembly via onnxruntime-web)
 */
export class SileroVAD {
  constructor(options = {}) {
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});
    this.onMetrics = options.onMetrics || (() => {});
    this.onError = options.onError || (() => {});

    this.startThreshold = options.startThreshold || START_THRESHOLD;
    this.endThreshold = options.endThreshold || END_THRESHOLD;
    this.minSpeechDurationMs = options.minSpeechDurationMs || MIN_SPEECH_DURATION_MS;
    this.minSilenceDurationMs = options.minSilenceDurationMs || MIN_SILENCE_DURATION_MS;

    this.session = null;
    this.stateTensor = null;
    this.sampleRateTensor = null;
    this.sampleQueue = [];
    this.processing = false;
    this.destroyed = false;

    this.state = STATE_SILENCE;
    this.speechDurationMs = 0;
    this.silenceDurationMs = 0;
    this.speechStartTimestamp = null;
    this.lastHighConfidenceTimestamp = null;

    this.metrics = {
      confidence: 0,
      latencyMs: 0,
    };
    this.debugLogged = false;
  }

  async loadModel() {
    if (this.session) {
      return;
    }

    try {
      // Configure ONNX runtime for MV3
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('onnx/');

      const modelUrl = chrome.runtime.getURL('models/silero_vad_v5.onnx');
      const response = await fetch(modelUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch Silero model (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      console.log('[VAD] Silero model bytes:', arrayBuffer.byteLength);
      const modelData = new Uint8Array(arrayBuffer);

      this.session = await ort.InferenceSession.create(modelData, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      this.resetState();
    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  enqueueAudio(audioData) {
    if (this.destroyed) {
      return;
    }

    for (let i = 0; i < audioData.length; i++) {
      this.sampleQueue.push(audioData[i]);
    }

    this.processQueue();
  }

  async processQueue() {
    if (this.processing || !this.session || this.sampleQueue.length < FRAME_SIZE) {
      return;
    }

    this.processing = true;

    try {
      while (!this.destroyed && this.sampleQueue.length >= FRAME_SIZE) {
        const frame = this.createFrame();

        const feeds = this.buildFeeds(frame);
        const inferenceStarted = performance.now();
        const results = await this.session.run(feeds);
        const latencyMs = performance.now() - inferenceStarted;

        if (!this.debugLogged) {
          console.log('[VAD] Silero outputs:', Object.keys(results));
          this.debugLogged = true;
        }

        const confidenceTensor = results.output || results.prob || results['output.0'];
        const stateTensor = results.stateN || results.state || results['state'];

        if (!confidenceTensor || !stateTensor) {
          console.warn('[VAD] Unexpected Silero output payload:', Object.keys(results));
          continue;
        }

        const confidence = confidenceTensor.data[0];
        this.stateTensor = new ort.Tensor('float32', stateTensor.data.slice(), STATE_SHAPE);

        // Update state first, then emit metrics with current state
        this.handleDetection(confidence, latencyMs);

        // Emit metrics after state update
        this.metrics = {
          confidence,
          latencyMs,
          state: this.state,
          speechDurationMs: this.speechDurationMs,
          silenceDurationMs: this.silenceDurationMs,
        };
        this.onMetrics(this.metrics);

        // Advance by hop size (10ms)
        this.sampleQueue.splice(0, HOP_SIZE);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.processing = false;
      if (!this.destroyed && this.sampleQueue.length >= FRAME_SIZE) {
        this.processQueue();
      }
    }
  }

  createFrame() {
    const frame = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      frame[i] = this.sampleQueue[i];
    }
    return frame;
  }

  buildFeeds(frame) {
    if (!this.stateTensor) {
      this.stateTensor = new ort.Tensor('float32', new Float32Array(STATE_SIZE), STATE_SHAPE);
    }
    if (!this.sampleRateTensor) {
      this.sampleRateTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(SAMPLE_RATE)]), [
        1,
      ]);
    }
    const frameTensor = new ort.Tensor('float32', frame, [1, FRAME_SIZE]);
    return {
      input: frameTensor,
      state: this.stateTensor,
      sr: this.sampleRateTensor,
    };
  }

  handleDetection(confidence, latencyMs) {
    const now = performance.now();

    // HIGH CONFIDENCE: >= 0.5
    if (confidence >= this.startThreshold) {
      if (this.state !== STATE_SPEECH) {
        this.state = STATE_SPEECH;
        this.speechDurationMs = 0;
        this.silenceDurationMs = 0;
        this.speechStartTimestamp = now;
        this.lastHighConfidenceTimestamp = now;
        this.onSpeechStart({
          confidence,
          latencyMs,
          timestamp: this.speechStartTimestamp,
          source: 'silero',
        });
        console.log('[VAD] Speech started, confidence:', confidence.toFixed(3));
      } else {
        this.lastHighConfidenceTimestamp = now;
      }

      this.speechDurationMs += HOP_MS;
      this.silenceDurationMs = 0;

      // Absolute max duration guard
      if (this.speechDurationMs >= MAX_SPEECH_DURATION_MS) {
        console.warn('[VAD] Forcing speech_end after max duration:', this.speechDurationMs);
        this.onSpeechEnd({
          confidence,
          latencyMs,
          timestamp: now,
          duration: this.speechDurationMs,
          source: 'silero',
          reason: 'max_duration',
        });
        this.resetSpeechTracking();
      }
      return;
    }

    // LOW CONFIDENCE: <= 0.40
    if (confidence <= this.endThreshold) {
      if (this.state === STATE_SPEECH || this.state === STATE_MAYBE_SILENCE) {
        if (this.state !== STATE_MAYBE_SILENCE) {
          this.state = STATE_MAYBE_SILENCE;
          console.log('[VAD] Entered maybe_silence, confidence:', confidence.toFixed(3));
        }

        this.silenceDurationMs += HOP_MS;
        if (this.silenceDurationMs >= this.minSilenceDurationMs) {
          const duration = this.speechDurationMs;

          if (this.speechStartTimestamp !== null) {
            console.log(
              '[VAD] Speech ended naturally, duration:',
              duration,
              'silence:',
              this.silenceDurationMs
            );
            this.onSpeechEnd({
              confidence,
              latencyMs,
              timestamp: now,
              duration,
              source: 'silero',
              reason: 'natural_end',
            });
          }
          this.resetSpeechTracking();
        }
      }
      return;
    }

    // MIDDLE ZONE: 0.40 < confidence < 0.45
    // Less aggressive reversion: only reset if we're early in the silence period
    if (this.state === STATE_MAYBE_SILENCE) {
      const silenceRevertThreshold = this.minSilenceDurationMs * MIDDLE_ZONE_REVERT_THRESHOLD;

      // Only revert to SPEECH if we haven't accumulated much silence yet
      if (this.silenceDurationMs < silenceRevertThreshold) {
        this.state = STATE_SPEECH;
        this.silenceDurationMs = 0;
        console.log(
          '[VAD] Reverted to speech from maybe_silence, confidence:',
          confidence.toFixed(3),
          'silence was:',
          this.silenceDurationMs.toFixed(0)
        );
      } else {
        // We're late in the silence period - continue accumulating
        // This prevents brief mid-confidence blips from resetting the counter
        this.silenceDurationMs += HOP_MS;
        console.log(
          '[VAD] Continuing silence accumulation in middle zone, confidence:',
          confidence.toFixed(3),
          'silence:',
          this.silenceDurationMs.toFixed(0)
        );
      }
    }

    if (this.state === STATE_SPEECH) {
      this.speechDurationMs += HOP_MS;

      // Force end if no high confidence for 2 seconds (stuck state guard)
      if (
        this.lastHighConfidenceTimestamp !== null &&
        now - this.lastHighConfidenceTimestamp >= 2000
      ) {
        console.warn('[VAD] Forcing speech_end: no high confidence for 2s (stuck state)');
        this.onSpeechEnd({
          confidence,
          latencyMs,
          timestamp: now,
          duration: this.speechDurationMs,
          source: 'silero',
          reason: 'stuck_state',
        });
        this.resetSpeechTracking();
      }
    }

    // FORCED END: Extended silence while in speech/maybe_silence
    if (
      (this.state === STATE_SPEECH || this.state === STATE_MAYBE_SILENCE) &&
      this.speechStartTimestamp !== null &&
      this.silenceDurationMs >= this.minSilenceDurationMs * 3
    ) {
      const duration = this.speechDurationMs;
      console.warn('[VAD] Forcing speech_end after extended silence:', this.silenceDurationMs);
      this.onSpeechEnd({
        confidence,
        latencyMs,
        timestamp: now,
        duration,
        source: 'silero',
        reason: 'forced_end',
      });
      this.resetSpeechTracking();
    }
  }

  resetSpeechTracking() {
    this.state = STATE_SILENCE;
    this.speechDurationMs = 0;
    this.silenceDurationMs = 0;
    this.speechStartTimestamp = null;
    this.lastHighConfidenceTimestamp = null;

    // REMOVED: Don't zero state tensor between utterances
    // Silero V5's RNN state should persist across speech segments
    // Only reset on explicit reset() calls (tab switch, session restart)
  }

  resetState() {
    this.stateTensor = new ort.Tensor('float32', new Float32Array(STATE_SIZE), STATE_SHAPE);
    this.sampleRateTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(SAMPLE_RATE)]), [1]);
    this.sampleQueue = [];
    this.processing = false;
    this.destroyed = false;
    this.resetSpeechTracking();
    console.log('[VAD] State tensor reset (full reset)');
  }

  reset() {
    this.resetState();
  }

  destroy() {
    this.destroyed = true;
    this.sampleQueue = [];
    this.session = null;
    this.stateTensor = null;
    this.sampleRateTensor = null;
    this.resetSpeechTracking();
  }
}
