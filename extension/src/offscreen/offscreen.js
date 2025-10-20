/**
 * Offscreen Document - Audio Recording & Local Transcription + Vision
 *
 * Sprint 07: Hybrid local/cloud transcription
 * - Captures audio from microphone
 * - Sends chunks to backend (for cloud fallback)
 * - Buffers audio locally for local transcription
 * - Transcribes locally using Whisper (if enabled)
 * - Falls back to cloud if local fails
 *
 * Sprint 08: Visual intelligence via SigLIP
 * - Generates frame embeddings from ImageData
 * - Coordinates with Whisper via GPU job queue
 * - Sends embeddings to backend for note enrichment
 */

import {
  loadWhisperModel,
  detectCapabilities,
  unloadModel,
  warmCache,
} from './whisper-loader.js';
import {
  loadSigLIPModel,
  generateEmbedding,
  detectCapabilities as detectVisionCapabilities,
  unloadModel as unloadVisionModel,
  warmCache as warmVisionCache,
} from './siglip-loader.js';
import { enqueueGpuTask, JobPriority } from './gpu-job-queue.js';
import { LOCAL_STT_MODES, LOCAL_VISION_MODES } from '../shared/settings.js';

let mediaRecorder = null;
let audioContext = null;
let recordedChunks = [];
let audioBuffer = []; // Float32Array chunks for local transcription
let localTranscriptionEnabled = false;
let currentSttMode = LOCAL_STT_MODES.AUTO; // Default mode

// Sprint 08: Vision state
let localVisionEnabled = false;
let currentVisionMode = LOCAL_VISION_MODES.AUTO; // Default mode

// Listen for commands from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted to offscreen or without a target
  if (message.target && message.target !== 'offscreen') {
    return false;
  }

  if (message.action === 'start_recording') {
    // Receive STT mode from service worker
    if (message.sttMode) {
      currentSttMode = message.sttMode;
      console.log('[Offscreen] STT mode set to:', currentSttMode);
    }

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

  // Sprint 08: Frame embedding generation
  if (message.action === 'generate_embedding') {
    handleGenerateEmbedding(message)
      .then((result) => {
        sendResponse({ success: true, ...result });
      })
      .catch((error) => {
        console.error('[Offscreen] Embedding generation failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }

  // Sprint 08: Warm vision model cache
  if (message.action === 'warm_vision_cache') {
    console.log('[Offscreen] Warming SigLIP model cache...');
    warmVisionCache()
      .then(() => {
        console.log('[Offscreen] Vision cache warmed successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Offscreen] Failed to warm vision cache:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

async function startRecording() {
  try {
    // Check if local transcription should be used based on mode passed from service worker
    localTranscriptionEnabled = currentSttMode !== LOCAL_STT_MODES.FORCE_CLOUD;
    console.log('[Offscreen] Using STT mode:', currentSttMode);
    console.log('[Offscreen] Local transcription enabled:', localTranscriptionEnabled);

    if (localTranscriptionEnabled) {
      // Detect capabilities
      const capabilities = await detectCapabilities();
      console.log('[Offscreen] Device capabilities:', capabilities);

      if (!capabilities.canUseLocal) {
        console.warn('[Offscreen] Local transcription unavailable, will use cloud fallback');
        localTranscriptionEnabled = false;
      }
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

    // Prefer WebM/Opus for OpenAI Whisper API (cloud fallback)
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 16000,
    });

    recordedChunks = [];
    audioBuffer = [];

    // If local transcription enabled, create AudioContext for Float32 audio
    if (localTranscriptionEnabled) {
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

      // Store processor for cleanup
      mediaRecorder._audioProcessor = processor;
      mediaRecorder._audioSource = source;
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        // Always send to backend for cloud fallback
        event.data.arrayBuffer().then((buffer) => {
          chrome.runtime.sendMessage({
            action: 'audio_chunk',
            data: Array.from(new Uint8Array(buffer)),
            mimeType: mimeType,
            size: buffer.byteLength,
          });
        });
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };

    mediaRecorder.onstop = function() {
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

  // Attempt local transcription if enabled and audio was captured
  if (localTranscriptionEnabled && audioBuffer.length > 0) {
    console.log(`[Offscreen] Attempting local transcription (${audioBuffer.length} chunks)`);

    try {
      const result = await transcribeLocally();
      return {
        localTranscription: true,
        success: true,
        ...result,
      };
    } catch (error) {
      console.error('[Offscreen] Local transcription failed:', error);
      console.error('[Offscreen] Error stack:', error.stack);
      console.error('[Offscreen] Error type:', error.constructor.name);

      // Notify service worker to fall back to cloud (unless forced local-only)
      const canFallback = currentSttMode !== LOCAL_STT_MODES.FORCE_LOCAL;

      chrome.runtime.sendMessage({
        action: 'transcript_fallback_required',
        reason: error.message,
        canFallback,
      });

      return {
        localTranscription: true,
        success: false,
        error: error.message,
        stack: error.stack,
        fallback: canFallback,
      };
    } finally {
      // Clear audio buffer
      audioBuffer = [];
    }
  } else {
    console.log('[Offscreen] Skipping local transcription (cloud only)');
    return { localTranscription: false };
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
 * Generate frame embedding using SigLIP.
 *
 * Sprint 08: Visual intelligence
 *
 * @param {Object} message - Message with imageData, timestamp, sessionId
 * @returns {Promise<Object>} Embedding result
 */
async function handleGenerateEmbedding(message) {
  const { imageData, timestamp, sessionId, visionMode } = message;

  // Update vision mode if provided
  if (visionMode) {
    currentVisionMode = visionMode;
    console.log('[Offscreen] Vision mode set to:', currentVisionMode);
  }

  // Check if vision should be enabled
  localVisionEnabled = currentVisionMode !== LOCAL_VISION_MODES.DISABLED;

  if (!localVisionEnabled) {
    throw new Error('Local vision is disabled');
  }

  // Check if local vision should be attempted
  const shouldUseLocal =
    currentVisionMode !== LOCAL_VISION_MODES.FORCE_CLOUD &&
    currentVisionMode !== LOCAL_VISION_MODES.DISABLED;

  if (!shouldUseLocal) {
    throw new Error('Vision mode set to cloud only');
  }

  console.log(`[Offscreen] Generating embedding for frame at ${timestamp}s`);

  const startTime = performance.now();

  // Check capabilities
  const capabilities = await detectVisionCapabilities();
  const device = capabilities.device || 'wasm';

  if (!capabilities.canUseLocal) {
    const canFallback = currentVisionMode !== LOCAL_VISION_MODES.FORCE_LOCAL;
    console.warn('[Offscreen] Local vision unavailable');

    chrome.runtime.sendMessage({
      action: 'vision_fallback_required',
      reason: 'Local vision unavailable',
      canFallback,
    });

    throw new Error('Local vision unavailable');
  }

  // Notify UI: embedding generation started
  chrome.runtime.sendMessage({
    action: 'embedding_status',
    stage: 'started',
    source: 'local',
    device: device,
    timestamp,
  });

  // Convert ImageData array back to ImageData object
  const reconstructedImageData = new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );

  // Enqueue embedding job in GPU queue (lower priority than Whisper)
  const embedding = await enqueueGpuTask(
    'siglip',
    async () => {
      console.log('[Offscreen] Generating embedding...');
      return await generateEmbedding(reconstructedImageData);
    },
    {
      priority: JobPriority.NORMAL, // Lower than Whisper (HIGH)
      timeout: 10000, // 10 second timeout
    }
  );

  const embeddingTime = performance.now() - startTime;

  console.log(
    `[Offscreen] Embedding generated in ${embeddingTime.toFixed(0)}ms (${embedding.length} dims)`
  );

  // Notify UI: embedding completed
  chrome.runtime.sendMessage({
    action: 'embedding_status',
    stage: 'completed',
    source: 'local',
    device: device,
    timestamp,
    timingMs: embeddingTime,
  });

  // Send embedding to service worker for relay to backend
  chrome.runtime.sendMessage({
    action: 'embedding_ready',
    embedding: Array.from(embedding), // Convert Float32Array to regular array for JSON
    timestamp,
    sessionId,
    source: 'local',
    device,
    embeddingTimeMs: Math.round(embeddingTime),
  });

  return {
    embedding: Array.from(embedding),
    embeddingTimeMs: Math.round(embeddingTime),
    device,
  };
}

// Handle document visibility changes (for cleanup)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('[Offscreen] Document hidden, unloading models');
    unloadModel(); // Whisper
    unloadVisionModel(); // SigLIP
  }
});
