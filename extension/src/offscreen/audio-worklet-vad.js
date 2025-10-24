/**
 * AudioWorklet Processor for VAD Audio Frame Processing
 *
 * This processor runs in a separate audio rendering thread (AudioWorkletGlobalScope)
 * and handles real-time audio processing for Voice Activity Detection.
 *
 * Key features:
 * - Runs in dedicated audio thread for better performance
 * - Posts audio frames to main thread for VAD inference
 * - Non-blocking: doesn't interfere with audio playback
 *
 * Usage:
 *   await audioContext.audioWorklet.addModule('audio-worklet-vad.js');
 *   const node = new AudioWorkletNode(audioContext, 'vad-processor');
 */

class VadProcessor extends AudioWorkletProcessor {
  /**
   * Process audio frames
   * Called automatically by the audio rendering thread
   *
   * @param {Float32Array[][]} inputs - Input audio data (multi-channel)
   * @param {Float32Array[][]} outputs - Output audio data (unused, we're just monitoring)
   * @param {Object} parameters - Audio parameters (unused)
   * @returns {boolean} - true to keep processor alive
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];

    // Check if we have valid input
    if (!input || !input[0]) {
      return true; // Keep processor alive even without input
    }

    // Get audio data from first channel (mono)
    const audioData = input[0];

    // Copy the audio data to ensure it's not modified
    // (Float32Array is transferred, so we need a copy)
    const audioCopy = new Float32Array(audioData);

    // Post frame to main thread for VAD processing
    this.port.postMessage({
      type: 'audio_frame',
      frame: audioCopy,
    });

    return true; // Keep processor alive
  }
}

// Register the processor with the audio worklet global scope
registerProcessor('vad-processor', VadProcessor);
