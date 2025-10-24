/**
 * VAD Worklet Bridge
 *
 * Wrapper around AudioWorklet that mirrors the ScriptProcessor callback interface.
 * This allows the rest of offscreen.js to remain unchanged while we migrate
 * from deprecated ScriptProcessor to modern AudioWorklet.
 *
 * Key differences from ScriptProcessor:
 * - AudioWorklet runs in a separate thread (better performance)
 * - Requires explicit module loading before use
 * - Uses message passing instead of direct callbacks
 *
 * Usage:
 *   const bridge = new VadWorkletBridge(audioContext, (frame) => {
 *     vadInstance.enqueueAudio(frame);
 *   });
 *   await bridge.init(sourceNode);
 *   // ... later ...
 *   bridge.disconnect();
 */

export class VadWorkletBridge {
  /**
   * Create a new VAD worklet bridge
   *
   * @param {AudioContext} audioContext - The audio context to use
   * @param {Function} onAudioProcess - Callback for audio frames (mimics ScriptProcessor)
   */
  constructor(audioContext, onAudioProcess) {
    this.audioContext = audioContext;
    this.onAudioProcess = onAudioProcess;
    this.workletNode = null;
    this.sourceNode = null;
  }

  /**
   * Initialize the worklet bridge
   * Loads the worklet module and sets up the audio graph
   *
   * @param {MediaStreamAudioSourceNode} sourceNode - The audio source node
   */
  async init(sourceNode) {
    try {
      // Load the worklet module from the extension
      const workletUrl = chrome.runtime.getURL('offscreen/audio-worklet-vad.js');
      await this.audioContext.audioWorklet.addModule(workletUrl);

      console.log('[VadWorkletBridge] AudioWorklet module loaded successfully');

      // Create the worklet node
      this.workletNode = new AudioWorkletNode(this.audioContext, 'vad-processor');

      // Set up message handler for audio frames
      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio_frame') {
          // Call the callback with the audio frame (mimics ScriptProcessor.onaudioprocess)
          this.onAudioProcess(event.data.frame);
        }
      };

      // Connect the audio graph: source → worklet → destination
      this.sourceNode = sourceNode;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);

      console.log('[VadWorkletBridge] Audio graph connected successfully');
    } catch (error) {
      console.error('[VadWorkletBridge] Failed to initialize AudioWorklet:', error);
      throw error;
    }
  }

  /**
   * Disconnect and cleanup the worklet
   */
  disconnect() {
    try {
      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }

      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }

      console.log('[VadWorkletBridge] AudioWorklet disconnected');
    } catch (error) {
      console.error('[VadWorkletBridge] Error during disconnect:', error);
    }
  }
}
