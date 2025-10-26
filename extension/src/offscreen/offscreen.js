/**
 * Offscreen Document - Audio Recording & Local Transcription
 *
 * Sprint 11: Local-only transcription
 * - Captures audio from microphone
 * - Buffers audio locally for local transcription
 * - Transcribes locally using Whisper via ONNX Runtime (WebGPU or WASM)
 * - No cloud fallback - 100% local processing
 *
 * Sprint 10: Voice mode audio detection (VAD)
 * - Runs Voice Activity Detection independently from recording
 * - Emits speech_start/speech_end events to service worker
 * - Supports energy-based and Silero ONNX detection
 */

import { loadWhisperModel, detectCapabilities, unloadModel, warmCache } from './whisper-loader.js';
import { enqueueGpuTask, JobPriority } from './gpu-job-queue.js';
import { SileroVAD } from './vad-detector.js';
import { VAD_CONFIG } from '../shared/shared-constants.js';
import { VadWorkletBridge } from './vad-worklet-bridge.js';

const TARGET_SAMPLE_RATE = 16000;

/**
 * Feature flag: AudioWorklet vs ScriptProcessor
 *
 * AudioWorklet (modern, Chrome 66+):
 *   - Runs in dedicated audio thread (better performance, no glitches)
 *   - Non-deprecated (ScriptProcessor removed in Chrome future)
 *   - Requires module loading (adds ~50ms initialization)
 *
 * ScriptProcessor (legacy, all Chrome):
 *   - Runs on main thread (can cause audio glitches under load)
 *   - Deprecated since 2014, may be removed in future Chrome versions
 *   - Simpler initialization
 *
 * Current behavior: Try AudioWorklet first, gracefully fall back to ScriptProcessor if it fails.
 * This provides best performance for modern browsers while maintaining compatibility.
 *
 * Decision: Keep fallback enabled (default: true)
 * Rationale: AudioWorklet support is excellent (Chrome 66+, Mar 2018), but fallback provides
 * safety net for edge cases (corp proxies blocking module loading, unusual browser configs).
 * Fallback code is minimal and tested. ScriptProcessor still works despite deprecation.
 */
const USE_AUDIO_WORKLET = true;

// Keep at least one minute of audio so we never overwrite long utterances
const RING_BUFFER_DURATION_MS = Math.max(
  VAD_CONFIG.MAX_SPEECH_DURATION_MS + VAD_CONFIG.PRE_ROLL_MS + VAD_CONFIG.POST_PAD_MS + 2000,
  60000
);

class CircularAudioBuffer {
  constructor(sampleRate, durationMs) {
    this.sampleRate = sampleRate;
    this.capacity = Math.ceil((sampleRate * durationMs) / 1000);
    this.buffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.waiters = new Set();
  }

  write(samples) {
    if (!samples || samples.length === 0) {
      return;
    }

    let idx = this.writeIndex;
    for (let i = 0; i < samples.length; i++) {
      this.buffer[idx] = samples[i];
      idx++;
      if (idx === this.capacity) {
        idx = 0;
      }
    }

    this.writeIndex = idx;
    this.totalSamples += samples.length;
    this.resolveWaiters();
  }

  getWritePosition() {
    return this.totalSamples;
  }

  getEarliestSample() {
    return Math.max(0, this.totalSamples - this.capacity);
  }

  async waitForSamples(targetSample, timeoutMs = Math.max(1500, VAD_CONFIG.POST_PAD_MS * 4)) {
    if (this.totalSamples >= targetSample) {
      return;
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        target: targetSample,
        resolve,
        reject,
        timeoutId: null,
      };

      if (Number.isFinite(timeoutMs)) {
        waiter.timeoutId = setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Timed out waiting for buffered audio'));
        }, timeoutMs);
      }

      this.waiters.add(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of Array.from(this.waiters)) {
      if (this.totalSamples >= waiter.target) {
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
        }
        waiter.resolve();
        this.waiters.delete(waiter);
      }
    }
  }

  read(startSample, endSample) {
    if (endSample <= startSample) {
      return new Float32Array(0);
    }

    const earliest = this.getEarliestSample();
    if (startSample < earliest) {
      console.warn(
        `[AudioRing] Requested start sample ${startSample} older than buffer (earliest ${earliest}) – clamping`
      );
      startSample = earliest;
    }

    if (endSample > this.totalSamples) {
      throw new Error(
        `[AudioRing] Requested end sample ${endSample} beyond write head ${this.totalSamples}`
      );
    }

    const length = endSample - startSample;
    const result = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const absoluteSample = startSample + i;
      const ringIndex = absoluteSample % this.capacity;
      result[i] = this.buffer[ringIndex];
    }
    return result;
  }

  reset() {
    this.writeIndex = 0;
    this.totalSamples = 0;
    for (const waiter of this.waiters) {
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      waiter.reject?.(new Error('Audio ring reset'));
    }
    this.waiters.clear();
    this.buffer.fill(0);
  }
}

function msToSamples(ms) {
  if (!ms) {
    return 0;
  }
  return Math.max(0, Math.round((ms / 1000) * TARGET_SAMPLE_RATE));
}

/**
 * Calculate audio level for waveform visualization.
 * Returns normalized value 0-255 (similar to AnalyserNode.getByteFrequencyData).
 *
 * @param {Float32Array} samples - Audio samples (-1.0 to 1.0 range)
 * @returns {number} Audio level 0-255
 */
function calculateAudioLevel(samples) {
  if (!samples || samples.length === 0) {
    return 0;
  }

  // Calculate RMS (Root Mean Square) for perceptually accurate level
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);

  // Convert to 0-255 range (matching AnalyserNode output)
  // Apply slight boost for better visualization
  const normalized = Math.min(255, Math.floor(rms * 255 * 3));
  return normalized;
}

// Shared audio capture state
let audioCaptureStream = null;
let audioCaptureContext = null;
let audioCaptureSource = null;
let audioWorkletBridge = null;
let audioProcessorNode = null;
let audioRingBuffer = null;
let ensureAudioCapturePromise = null;

// VAD state
let vadInstance = null;
let vadEnabled = false;

// Waveform visualization state
let lastAudioLevelSentAt = 0;
const AUDIO_LEVEL_INTERVAL_MS = 16; // ~60 FPS for smooth visualization

// Recording state
let currentRecording = null; // { startSample, startedAt }
let cachedCapabilities = null;
let capabilitiesLogged = false;

async function getCapabilities() {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  const capabilities = await detectCapabilities();
  cachedCapabilities = capabilities;
  return capabilities;
}

// Listen for commands from service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only handle messages targeted to offscreen or without a target
  if (message.target && message.target !== 'offscreen') {
    return false;
  }

  if (message.action === 'start_recording') {
    startRecording()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Offscreen: Failed to start recording:', error);
        const errorMessage =
          error.name === 'NotAllowedError'
            ? 'Microphone permission denied. Please grant permission when prompted.'
            : error.message || String(error);
        sendResponse({ success: false, error: errorMessage });
      });
    return true; // Keep channel open for async response
  }

  if (message.action === 'stop_recording') {
    stopRecording()
      .then((result) => {
        sendResponse({ success: true, ...result });
      })
      .catch((error) => {
        console.error('Offscreen: Failed to stop recording:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async transcription
  }

  if (message.action === 'warm_cache') {
    console.log('[Offscreen] Warming Whisper model cache...');
    warmCache()
      .then(() => {
        console.log('[Offscreen] Cache warmed successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Offscreen] Failed to warm cache:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Sprint 10: Start VAD
  if (message.action === 'start_vad') {
    startVAD(message.config)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Offscreen] Failed to start VAD:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Sprint 10: Stop VAD
  if (message.action === 'stop_vad') {
    stopVAD()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Offscreen] Failed to stop VAD:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Sprint 10: Reset VAD (clear state without stopping)
  if (message.action === 'reset_vad') {
    if (vadInstance) {
      vadInstance.reset();
      console.log('[VAD] State reset on demand');
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'VAD not running' });
    }
    return true;
  }

  // Sprint 10: Heartbeat
  if (message.action === 'heartbeat') {
    sendResponse({ alive: true, vadEnabled });
    return true;
  }
});

async function ensureAudioCapture() {
  if (audioCaptureContext && audioRingBuffer) {
    return;
  }

  if (ensureAudioCapturePromise) {
    return ensureAudioCapturePromise;
  }

  ensureAudioCapturePromise = (async () => {
    try {
      if (audioCaptureContext && audioRingBuffer) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioCaptureStream = stream;
      audioCaptureContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioCaptureSource = audioCaptureContext.createMediaStreamSource(stream);

      audioRingBuffer = new CircularAudioBuffer(TARGET_SAMPLE_RATE, RING_BUFFER_DURATION_MS);

      const sourceSampleRate = audioCaptureContext.sampleRate || TARGET_SAMPLE_RATE;
      const processSamples = (samples) => {
        if (!audioRingBuffer) {
          return;
        }
        const processed = resampleIfNeeded(samples, sourceSampleRate, TARGET_SAMPLE_RATE);
        if (!processed || processed.length === 0) {
          return;
        }
        audioRingBuffer.write(processed);
        if (vadInstance) {
          vadInstance.enqueueAudio(processed);
        }

        // Send audio level for waveform visualization
        const now = performance.now();
        if (now - lastAudioLevelSentAt >= AUDIO_LEVEL_INTERVAL_MS) {
          lastAudioLevelSentAt = now;
          const audioLevel = calculateAudioLevel(processed);
          chrome.runtime.sendMessage({
            action: 'audio_level',
            level: audioLevel,
          }).catch(() => {
            // Ignore errors if sidepanel is closed
          });
        }
      };

      if (USE_AUDIO_WORKLET) {
        const bridge = new VadWorkletBridge(audioCaptureContext, processSamples);
        try {
          await bridge.init(audioCaptureSource);
          audioWorkletBridge = bridge;
          audioProcessorNode = null;
          console.log('[Offscreen] AudioWorklet initialized for shared capture');
          return;
        } catch (error) {
          console.warn('[Offscreen] AudioWorklet init failed, falling back to ScriptProcessor:', error);
          try {
            bridge.disconnect();
          } catch (disconnectError) {
            console.warn('[Offscreen] Failed to disconnect partial AudioWorklet bridge:', disconnectError);
          }
          audioWorkletBridge = null;
        }
      }

      const bufferSize = 1024;
      const processor = audioCaptureContext.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(inputData.length);
        copy.set(inputData);
        processSamples(copy);
      };

      audioCaptureSource.connect(processor);
      processor.connect(audioCaptureContext.destination);
      audioProcessorNode = processor;
      console.log('[Offscreen] ScriptProcessor initialized for shared capture');
    } catch (error) {
      await teardownAudioCapture();
      throw error;
    }
  })()
    .finally(() => {
      ensureAudioCapturePromise = null;
    });

  return ensureAudioCapturePromise;
}

async function teardownAudioCapture() {
  if (audioWorkletBridge) {
    try {
      audioWorkletBridge.disconnect();
    } catch (error) {
      console.warn('[Offscreen] Failed to disconnect AudioWorklet bridge during teardown:', error);
    }
    audioWorkletBridge = null;
  }

  if (audioProcessorNode) {
    try {
      audioProcessorNode.disconnect();
    } catch (error) {
      console.warn('[Offscreen] Failed to disconnect ScriptProcessor during teardown:', error);
    }
    audioProcessorNode = null;
  }

  if (audioCaptureSource) {
    try {
      audioCaptureSource.disconnect();
    } catch (error) {
      console.warn('[Offscreen] Failed to disconnect capture source during teardown:', error);
    }
    audioCaptureSource = null;
  }

  if (audioCaptureContext) {
    try {
      await audioCaptureContext.close();
    } catch (error) {
      console.warn('[Offscreen] Failed to close AudioContext during teardown:', error);
    }
    audioCaptureContext = null;
  }

  if (audioCaptureStream) {
    audioCaptureStream.getTracks().forEach((track) => track.stop());
    audioCaptureStream = null;
  }

  if (audioRingBuffer) {
    audioRingBuffer.reset();
    audioRingBuffer = null;
  }
}

async function maybeTeardownAudioCapture() {
  if (vadEnabled || currentRecording) {
    return;
  }
  await teardownAudioCapture();
}

async function startRecording() {
  if (currentRecording) {
    console.log('[Offscreen] startRecording called while recording is already active');
    return;
  }

  const capabilities = await getCapabilities();
  if (!capabilitiesLogged) {
    console.log('[Offscreen] Device capabilities:', capabilities);
    capabilitiesLogged = true;
  }

  if (!capabilities.canUseLocal) {
    throw new Error('Local transcription unavailable - please ensure your browser supports WebAssembly');
  }

  await ensureAudioCapture();

  if (!audioRingBuffer) {
    throw new Error('Audio capture pipeline unavailable');
  }

  const preRollSamples = msToSamples(VAD_CONFIG.PRE_ROLL_MS);
  const writePosition = audioRingBuffer.getWritePosition();
  const earliest = audioRingBuffer.getEarliestSample();
  const startSample = Math.max(earliest, writePosition - preRollSamples);

  currentRecording = {
    startSample,
    startedAt: performance.now(),
  };

  console.log('[Offscreen] Recording window opened', {
    startSample,
    writePosition,
    preRollSamples,
    earliest,
  });
}

async function stopRecording() {
  if (!currentRecording) {
    console.warn('[Offscreen] stopRecording called with no active recording');
    return { success: false, error: 'No active recording' };
  }

  if (!audioRingBuffer) {
    console.warn('[Offscreen] stopRecording called without audio buffer');
    currentRecording = null;
    await maybeTeardownAudioCapture();
    return { success: false, error: 'Audio capture unavailable' };
  }

  const postPadSamples = msToSamples(VAD_CONFIG.POST_PAD_MS);
  const captureSnapshot = audioRingBuffer.getWritePosition();
  const targetEndSample = captureSnapshot + postPadSamples;

  try {
    await audioRingBuffer.waitForSamples(targetEndSample);
  } catch (error) {
    console.warn('[Offscreen] Post-pad wait interrupted:', error.message);
  }

  const finalWrite = audioRingBuffer.getWritePosition();
  const endSample = Math.min(finalWrite, targetEndSample);
  const earliest = audioRingBuffer.getEarliestSample();
  const startSample = Math.max(earliest, currentRecording.startSample);

  let audioSamples = null;
  try {
    audioSamples = audioRingBuffer.read(startSample, endSample);
  } catch (error) {
    console.error('[Offscreen] Failed to read audio ring buffer:', error);
    currentRecording = null;
    await maybeTeardownAudioCapture();
    return { success: false, error: error.message };
  }

  currentRecording = null;

  if (!audioSamples || audioSamples.length === 0) {
    await maybeTeardownAudioCapture();
    return { success: false, error: 'No audio captured' };
  }

  console.log('[Offscreen] Captured segment', {
    samples: audioSamples.length,
    durationMs: Math.round((audioSamples.length / TARGET_SAMPLE_RATE) * 1000),
  });

  try {
    const result = await transcribeLocally(audioSamples);
    await maybeTeardownAudioCapture();
    return {
      success: true,
      ...result,
    };
  } catch (error) {
    console.error('[Offscreen] Local transcription failed:', error);
    chrome.runtime.sendMessage({
      action: 'transcription_error',
      error: error.message,
      stack: error.stack,
    });

    await maybeTeardownAudioCapture();
    return {
      success: false,
      error: error.message,
      stack: error.stack,
    };
  }
}

/**
 * Detect Whisper hallucinations using multiple signals.
 *
 * Whisper models hallucinate when processing music, silence, or poor audio.
 * This function uses research-backed heuristics to detect and filter out
 * hallucinated transcripts before sending to backend.
 *
 * Detection signals:
 * 1. Compression ratio: Text length vs audio duration (>2.4 = hallucination)
 * 2. Repetitive patterns: Same words repeated excessively
 * 3. Zero-duration timestamps: Many chunks with identical start/end times
 * 4. Music markers: Whisper outputs ♪ or [Music] for non-speech
 *
 * @param {string} text - Transcribed text
 * @param {Array} chunks - Word-level timestamp chunks
 * @param {number} durationSeconds - Audio duration in seconds
 * @returns {Object} { isHallucination: boolean, reason: string, metrics: Object }
 */
function detectWhisperHallucination(text, chunks, durationSeconds) {
  const metrics = {};

  // Signal 1: Compression ratio
  // Normal speech: ~15 chars/sec. Hallucinations often exceed 2.4x normal
  const compressionRatio = text.length / (durationSeconds * 15);
  metrics.compressionRatio = compressionRatio;

  if (compressionRatio > 2.4) {
    return {
      isHallucination: true,
      reason: `High compression ratio: ${compressionRatio.toFixed(2)} (threshold: 2.4)`,
      metrics,
    };
  }

  // Signal 2: Repetitive patterns
  // Count unique vs total words. Hallucinations often repeat the same words
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 5) {
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    const repetitionRatio = words.length / uniqueWords.size;
    metrics.repetitionRatio = repetitionRatio;

    if (repetitionRatio > 3.0) {
      return {
        isHallucination: true,
        reason: `High repetition ratio: ${repetitionRatio.toFixed(2)} (threshold: 3.0)`,
        metrics,
      };
    }
  }

  // Signal 3: Zero-duration timestamps
  // Hallucinations often have many chunks with identical start/end times
  if (chunks && chunks.length > 0) {
    const zeroDurationChunks = chunks.filter(
      (c) => c.timestamp && c.timestamp[0] === c.timestamp[1]
    ).length;
    const zeroDurationRatio = zeroDurationChunks / chunks.length;
    metrics.zeroDurationRatio = zeroDurationRatio;

    if (zeroDurationRatio > 0.3) {
      return {
        isHallucination: true,
        reason: `High zero-duration chunks: ${(zeroDurationRatio * 100).toFixed(1)}% (threshold: 30%)`,
        metrics,
      };
    }
  }

  // Signal 4: Music/non-speech markers
  // Whisper outputs ♪, [Music], [Applause], etc. for non-speech audio
  const musicMarkers = /[♪♫]|\[Music\]|\[Applause\]|\[Laughter\]/i;
  if (musicMarkers.test(text)) {
    return {
      isHallucination: true,
      reason: 'Music or non-speech markers detected',
      metrics,
    };
  }

  // Signal 5: Very short text for long audio
  // If audio is >3s but text is <10 chars, likely silence misdetected as speech
  if (durationSeconds > 3 && text.trim().length < 10) {
    return {
      isHallucination: true,
      reason: `Text too short for audio duration: ${text.length} chars for ${durationSeconds.toFixed(1)}s`,
      metrics,
    };
  }

  return {
    isHallucination: false,
    reason: 'Passed all hallucination checks',
    metrics,
  };
}

/**
 * Transcribe audio locally using Whisper.
 *
 * Concatenates buffered audio chunks and runs through Whisper model.
 *
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeLocally(audioSamples) {
  const startTime = performance.now();

  if (!audioSamples || audioSamples.length === 0) {
    throw new Error('No audio samples provided for transcription');
  }

  const concatenated =
    audioSamples instanceof Float32Array ? audioSamples : new Float32Array(audioSamples);

  const durationSeconds = concatenated.length / TARGET_SAMPLE_RATE;
  console.log(`[Offscreen] Transcribing ${durationSeconds.toFixed(1)}s of audio`);

  // Get capability info for status reporting
  const capabilities = await getCapabilities();
  const device = capabilities.device || 'wasm';

  // Notify UI: transcription started
  chrome.runtime.sendMessage({
    action: 'transcription_status',
    stage: 'started',
    source: 'local',
    device: device,
  });

  // Enqueue transcription job in GPU queue
  const result = await enqueueGpuTask(
    'whisper',
    async () => {
      // Load Whisper model (uses cache if already loaded)
      const transcriber = await loadWhisperModel();

      console.log('[Offscreen] Transcriber ready, starting transcription...');

      // Transcribe with chunking
      // Note: Don't pass 'language' parameter for English-only models (whisper-tiny.en)
      // English-only models are hardcoded to English and don't support language selection
      const output = await transcriber(concatenated, {
        chunk_length_s: 15,
        stride_length_s: 5,
        return_timestamps: 'word',
      });

      console.log('[Offscreen] Transcription complete, output:', output);
      return output;
    },
    {
      priority: JobPriority.HIGH,
      timeout: 30000, // 30 second timeout
    }
  );

  const transcriptionTime = performance.now() - startTime;

  console.log(`[Offscreen] Local transcription complete in ${transcriptionTime.toFixed(0)}ms`);
  console.log(`[Offscreen] Transcript: "${result.text}"`);

  // Detect Whisper hallucination before sending to backend
  const hallucinationCheck = detectWhisperHallucination(
    result.text,
    result.chunks || [],
    durationSeconds
  );

  console.log(
    `[Offscreen] Hallucination check: ${hallucinationCheck.isHallucination ? 'FAILED' : 'PASSED'}`,
    hallucinationCheck
  );

  if (hallucinationCheck.isHallucination) {
    console.warn(
      `[Offscreen] Hallucination detected, discarding transcript: ${hallucinationCheck.reason}`
    );
    console.warn(`[Offscreen] Discarded text: "${result.text.slice(0, 100)}..."`);

    // Notify UI: hallucination detected
    chrome.runtime.sendMessage({
      action: 'transcription_status',
      stage: 'hallucination_detected',
      source: 'local',
      device: device,
      reason: hallucinationCheck.reason,
      metrics: hallucinationCheck.metrics,
    });

    return {
      text: '',
      chunks: [],
      hallucination: true,
      hallucinationReason: hallucinationCheck.reason,
      hallucinationMetrics: hallucinationCheck.metrics,
      transcriptionTimeMs: Math.round(transcriptionTime),
    };
  }

  // Notify UI: transcription completed
  chrome.runtime.sendMessage({
    action: 'transcription_status',
    stage: 'completed',
    source: 'local',
    device: device,
    timingMs: transcriptionTime,
  });

  // Send final transcript to service worker
  chrome.runtime.sendMessage({
    action: 'transcript_final',
    text: result.text,
    chunks: result.chunks || [],
    source: 'local',
    durationSeconds,
    transcriptionTimeMs: Math.round(transcriptionTime),
  });

  return {
    text: result.text,
    chunks: result.chunks || [],
    transcriptionTimeMs: Math.round(transcriptionTime),
  };
}

/**
 * Sprint 10: Start Voice Activity Detection
 *
 * Creates a separate audio stream for voice mode monitoring.
 * VAD runs independently from recording and emits events to service worker.
 *
 * @param {Object} config - VAD configuration from service worker
 */
async function startVAD(config = {}) {
  if (vadEnabled) {
    console.log('[VAD] Already running');
    return;
  }

  console.log('[VAD] Starting voice mode audio detection');

  try {
    await ensureAudioCapture();

    let lastMetricsSentAt = 0;
    const METRICS_INTERVAL_MS = 250;

    vadInstance = new SileroVAD({
      minSpeechDurationMs: config?.minSpeechDurationMs || VAD_CONFIG.MIN_SPEECH_DURATION_MS,
      minSilenceDurationMs: config?.minSilenceDurationMs || VAD_CONFIG.MIN_SILENCE_DURATION_MS,
      startThreshold: config?.sileroConfidence || VAD_CONFIG.START_THRESHOLD,
      endThreshold: config?.sileroNegativeThreshold || VAD_CONFIG.END_THRESHOLD,
      probSmoothingFrames: config?.probSmoothingFrames || VAD_CONFIG.PROB_SMOOTHING_FRAMES,
      silenceGateMs: config?.silenceGateMs || VAD_CONFIG.SILENCE_GATE_MS,
      onSpeechStart: (event) => {
        console.log('[VAD] Speech detected (confidence:', event.confidence.toFixed(3), ')');
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'voice_event',
          type: 'speech_start',
          data: {
            timestamp: event.timestamp,
            confidence: event.confidence,
            latencyMs: event.latencyMs,
            source: event.source,
          },
        });
      },
      onSpeechEnd: (event) => {
        console.log(
          '[VAD] Speech ended, duration:',
          event.duration.toFixed(0),
          'ms, confidence:',
          event.confidence.toFixed(3)
        );
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'voice_event',
          type: 'speech_end',
          data: {
            timestamp: event.timestamp,
            duration: event.duration,
            confidence: event.confidence,
            latencyMs: event.latencyMs,
            source: event.source,
          },
        });
      },
      onMetrics: (metrics) => {
        const now = performance.now();
        if (now - lastMetricsSentAt < METRICS_INTERVAL_MS) {
          return;
        }
        lastMetricsSentAt = now;
        console.log(
          '[VAD] Metrics',
          metrics.confidence.toFixed(3),
          `${metrics.latencyMs.toFixed(2)}ms`
        );
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'voice_event',
        type: 'metrics',
        data: {
          confidence: metrics.confidence,
          latencyMs: metrics.latencyMs,
          rawConfidence: metrics.rawConfidence,
          state: metrics.state,
          speechDurationMs: metrics.speechDurationMs,
          silenceDurationMs: metrics.silenceDurationMs,
        },
      });
      },
      onError: (error) => {
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'voice_event',
          type: 'error',
          data: {
            message: error.message,
            name: error.name || 'VADError',
          },
        });
      },
    });

    await vadInstance.loadModel();

    vadEnabled = true;
    console.log('[VAD] Voice mode detection active (shared capture)');
  } catch (error) {
    console.error('[VAD] Failed to start:', error);
    if (vadInstance) {
      vadInstance.destroy();
      vadInstance = null;
    }
    await maybeTeardownAudioCapture();

    // Notify service worker of failure
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'voice_event',
      type: 'error',
      data: {
        message: error.message,
        name: error.name,
      },
    });

    throw error;
  }
}

/**
 * Sprint 10: Stop Voice Activity Detection
 *
 * Cleans up VAD audio stream and resources.
 */
async function stopVAD() {
  if (!vadEnabled) {
    console.log('[VAD] Not running');
    return;
  }

  console.log('[VAD] Stopping voice mode detection');

  // Reset VAD instance
  if (vadInstance) {
    try {
      vadInstance.destroy();
    } catch (err) {
      console.warn('[VAD] Error during destroy:', err);
    }
    vadInstance = null;
  }

  vadEnabled = false;
  console.log('[VAD] Stopped');

  await maybeTeardownAudioCapture();
}

// Handle document visibility changes (for cleanup)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('[Offscreen] Document hidden, unloading models and stopping VAD');
    unloadModel(); // Whisper
    stopVAD(); // VAD cleanup
  }
});

function resampleIfNeeded(samples, fromRate, toRate) {
  if (!fromRate || !toRate || fromRate === toRate) {
    return samples;
  }

  if (fromRate < toRate) {
    // We avoid upsampling; fall back to original samples
    return samples;
  }

  return downsampleLinear(samples, fromRate, toRate);
}

function downsampleLinear(samples, fromRate, toRate) {
  const sampleRateRatio = fromRate / toRate;
  const newLength = Math.floor(samples.length / sampleRateRatio);
  if (!isFinite(sampleRateRatio) || newLength <= 0) {
    return samples;
  }

  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetSource = 0;

  while (offsetResult < newLength) {
    const nextOffsetSource = (offsetResult + 1) * sampleRateRatio;
    let accum = 0;
    let count = 0;

    const start = Math.floor(offsetSource);
    const end = Math.min(Math.floor(nextOffsetSource), samples.length);

    for (let i = start; i < end; i++) {
      accum += samples[i];
      count++;
    }

    if (count === 0) {
      const index = Math.min(Math.floor(offsetSource), samples.length - 1);
      accum = samples[index];
      count = 1;
    }

    result[offsetResult] = accum / count;
    offsetResult++;
    offsetSource = nextOffsetSource;
  }

  return result;
}
