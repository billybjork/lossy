/**
 * Offscreen Document - Audio Recording & Local Transcription
 *
 * Sprint 11: Local-only transcription
 * - Captures audio from microphone
 * - Buffers audio locally for local transcription
 * - Transcribes locally using Whisper via ONNX Runtime (WebGPU or WASM)
 * - No cloud fallback - 100% local processing
 *
 * Sprint 10: Passive audio detection (VAD)
 * - Runs Voice Activity Detection independently from recording
 * - Emits speech_start/speech_end events to service worker
 * - Supports energy-based and Silero ONNX detection
 */

import { loadWhisperModel, detectCapabilities, unloadModel, warmCache } from './whisper-loader.js';
import { enqueueGpuTask, JobPriority } from './gpu-job-queue.js';
import { SileroVAD } from './vad-detector.js';
import { VAD_CONFIG, PASSIVE_SESSION_CONFIG } from '../shared/shared-constants.js';
import { VadWorkletBridge } from './vad-worklet-bridge.js';

const TARGET_SAMPLE_RATE = 16000;

// Feature flag: Use AudioWorklet instead of deprecated ScriptProcessor
// Can be disabled to fallback to ScriptProcessor if issues arise
const USE_AUDIO_WORKLET = true;

let mediaRecorder = null;
let audioContext = null;
let audioBuffer = []; // Float32Array chunks for local transcription

// Sprint 10: VAD state
let vadInstance = null;
let vadAudioContext = null;
let vadAudioStream = null;
let vadEnabled = false;

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

async function startRecording() {
  try {
    // Always use local transcription (WebGPU or WASM via ONNX Runtime)
    console.log('[Offscreen] Using local-only transcription');

    // Detect capabilities
    const capabilities = await detectCapabilities();
    console.log('[Offscreen] Device capabilities:', capabilities);

    if (!capabilities.canUseLocal) {
      throw new Error(
        'Local transcription unavailable - please ensure your browser supports WebAssembly'
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1, // Mono
        sampleRate: 16000, // 16kHz for Whisper
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create AudioContext for Float32 audio (for ONNX transcription)
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);

    // Create ScriptProcessor to capture raw audio samples
    const bufferSize = 4096;
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (event) => {
      // Copy input buffer (Float32Array)
      const inputData = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      audioBuffer.push(copy);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    // Simple MediaRecorder for basic state management (not used for buffering)
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 16000,
    });

    audioBuffer = [];

    // Store processor for cleanup
    mediaRecorder._audioProcessor = processor;
    mediaRecorder._audioSource = source;

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };

    mediaRecorder.onstop = function () {
      stream.getTracks().forEach((track) => track.stop());

      // Cleanup audio processor (use 'this' instead of 'mediaRecorder' to avoid null reference)
      if (this._audioProcessor) {
        this._audioProcessor.disconnect();
        this._audioSource.disconnect();
      }
    };

    // Start recording with 1-second chunks
    mediaRecorder.start(1000);
  } catch (error) {
    console.error('[Offscreen] Failed to start recording:', error);
    throw error;
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return { localTranscription: false };
  }

  mediaRecorder.stop();
  mediaRecorder = null;

  // Close AudioContext
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  // Attempt local transcription if audio was captured
  if (audioBuffer.length > 0) {
    console.log(`[Offscreen] Transcribing locally (${audioBuffer.length} chunks)`);

    try {
      const result = await transcribeLocally();
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      console.error('[Offscreen] Local transcription failed:', error);
      console.error('[Offscreen] Error stack:', error.stack);
      console.error('[Offscreen] Error type:', error.constructor.name);

      // No cloud fallback - show error to user
      chrome.runtime.sendMessage({
        action: 'transcription_error',
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        error: error.message,
        stack: error.stack,
      };
    } finally {
      // Clear audio buffer
      audioBuffer = [];
    }
  } else {
    console.warn('[Offscreen] No audio captured');
    return { success: false, error: 'No audio captured' };
  }
}

/**
 * Transcribe audio locally using Whisper.
 *
 * Concatenates buffered audio chunks and runs through Whisper model.
 *
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeLocally() {
  const startTime = performance.now();

  // Concatenate all audio chunks into single Float32Array
  const totalLength = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
  const concatenated = new Float32Array(totalLength);

  let offset = 0;
  for (const chunk of audioBuffer) {
    concatenated.set(chunk, offset);
    offset += chunk.length;
  }

  const durationSeconds = concatenated.length / 16000;
  console.log(`[Offscreen] Transcribing ${durationSeconds.toFixed(1)}s of audio`);

  // Get capability info for status reporting
  const capabilities = await detectCapabilities();
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
 * Creates a separate audio stream for passive monitoring.
 * VAD runs independently from recording and emits events to service worker.
 *
 * @param {Object} config - VAD configuration from service worker
 */
async function startVAD(config = {}) {
  if (vadEnabled) {
    console.log('[VAD] Already running');
    return;
  }

  console.log('[VAD] Starting passive audio detection');

  try {
    // Request microphone access
    vadAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Create audio context for VAD
    vadAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = vadAudioContext.createMediaStreamSource(vadAudioStream);

    // Initialize HybridVAD with callbacks
    let lastMetricsSentAt = 0;
    const METRICS_INTERVAL_MS = 250;

    vadInstance = new SileroVAD({
      minSpeechDurationMs: config?.minSpeechDurationMs || VAD_CONFIG.MIN_SPEECH_DURATION_MS,
      minSilenceDurationMs: config?.minSilenceDurationMs || VAD_CONFIG.MIN_SILENCE_DURATION_MS,
      startThreshold: config?.sileroConfidence || VAD_CONFIG.START_THRESHOLD,
      endThreshold: config?.sileroNegativeThreshold || VAD_CONFIG.END_THRESHOLD,
      onSpeechStart: (event) => {
        console.log('[VAD] Speech detected (confidence:', event.confidence.toFixed(3), ')');
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'passive_event',
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
          action: 'passive_event',
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
          action: 'passive_event',
          type: 'metrics',
          data: {
            confidence: metrics.confidence,
            latencyMs: metrics.latencyMs,
          },
        });
      },
      onError: (error) => {
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'passive_event',
          type: 'error',
          data: {
            message: error.message,
            name: error.name || 'VADError',
          },
        });
      },
    });

    await vadInstance.loadModel();

    // Use AudioWorklet (modern) or fallback to ScriptProcessor (deprecated)
    if (USE_AUDIO_WORKLET) {
      console.log('[VAD] Using AudioWorklet for audio processing');

      // Create AudioWorklet bridge
      const workletBridge = new VadWorkletBridge(vadAudioContext, (audioFrame) => {
        if (!vadInstance) return;

        const sourceSampleRate = vadAudioContext.sampleRate || TARGET_SAMPLE_RATE;
        const processed = resampleIfNeeded(audioFrame, sourceSampleRate, TARGET_SAMPLE_RATE);
        if (processed && processed.length > 0) {
          vadInstance.enqueueAudio(processed);
        }
      });

      // Initialize and connect the worklet
      await workletBridge.init(source);

      // Store bridge for cleanup
      vadInstance._audioBridge = workletBridge;
      vadInstance._audioSource = source;
    } else {
      console.log('[VAD] Using ScriptProcessor (deprecated) for audio processing');

      // Fallback: Create ScriptProcessor to feed audio to VAD
      const bufferSize = 1024;
      const processor = vadAudioContext.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (event) => {
        if (!vadInstance) return;

        const inputData = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(inputData.length);
        copy.set(inputData);

        const sourceSampleRate = vadAudioContext.sampleRate || TARGET_SAMPLE_RATE;
        const processed = resampleIfNeeded(copy, sourceSampleRate, TARGET_SAMPLE_RATE);
        if (processed && processed.length > 0) {
          vadInstance.enqueueAudio(processed);
        }
      };

      source.connect(processor);
      processor.connect(vadAudioContext.destination);

      // Store processor for cleanup
      vadInstance._audioProcessor = processor;
      vadInstance._audioSource = source;
    }

    vadEnabled = true;
    console.log('[VAD] Passive detection active (mode: silero)');
  } catch (error) {
    console.error('[VAD] Failed to start:', error);

    // Clean up on failure
    if (vadAudioStream) {
      vadAudioStream.getTracks().forEach((track) => track.stop());
      vadAudioStream = null;
    }
    if (vadAudioContext) {
      await vadAudioContext.close();
      vadAudioContext = null;
    }

    // Notify service worker of failure
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'passive_event',
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

  console.log('[VAD] Stopping passive detection');

  // Cleanup audio processor or worklet bridge
  if (vadInstance?._audioBridge) {
    // AudioWorklet cleanup
    vadInstance._audioBridge.disconnect();
  } else if (vadInstance?._audioProcessor) {
    // ScriptProcessor cleanup (fallback)
    vadInstance._audioProcessor.disconnect();
    vadInstance._audioSource.disconnect();
  }

  // Stop audio stream
  if (vadAudioStream) {
    vadAudioStream.getTracks().forEach((track) => track.stop());
    vadAudioStream = null;
  }

  // Close audio context
  if (vadAudioContext) {
    await vadAudioContext.close();
    vadAudioContext = null;
  }

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
