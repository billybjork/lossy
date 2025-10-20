/**
 * Clarify Button - Test UI for Sprint 08
 *
 * Simple floating button to test frame capture + SigLIP embedding generation
 */

import { FrameCapturer } from '../core/frame-capturer.js';

export class ClarifyButton {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.button = null;
    this.frameCapturer = null;
    this.isProcessing = false;
  }

  /**
   * Render the button on the page
   */
  render() {
    // Create button element
    this.button = document.createElement('button');
    this.button.textContent = '🔍 Clarify Frame';
    this.button.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      padding: 12px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: all 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Hover effect
    this.button.addEventListener('mouseenter', () => {
      if (!this.isProcessing) {
        this.button.style.transform = 'translateY(-2px)';
        this.button.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
      }
    });

    this.button.addEventListener('mouseleave', () => {
      if (!this.isProcessing) {
        this.button.style.transform = 'translateY(0)';
        this.button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
      }
    });

    // Click handler
    this.button.addEventListener('click', () => this.handleClarify());

    // Add to page
    document.body.appendChild(this.button);

    console.log('[ClarifyButton] Button rendered');
  }

  /**
   * Handle Clarify button click
   */
  async handleClarify() {
    if (this.isProcessing) {
      console.log('[ClarifyButton] Already processing...');
      return;
    }

    this.isProcessing = true;
    this.updateButtonState('processing');

    try {
      // Step 1: Capture frame
      console.log('[ClarifyButton] Capturing frame...');
      this.updateButtonText('📸 Capturing...');

      if (!this.frameCapturer) {
        this.frameCapturer = new FrameCapturer(this.videoElement);
      }

      const { imageData, timestamp, dimensions } = await this.frameCapturer.captureCurrentFrame();

      console.log('[ClarifyButton] Frame captured:', {
        timestamp,
        dimensions,
        dataSize: imageData.data.length,
      });

      // Step 2: Send to offscreen for embedding generation
      console.log('[ClarifyButton] Generating embedding...');
      this.updateButtonText('🧠 Processing...');

      // Convert ImageData to serializable format
      const serializableImageData = {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height,
      };

      // Send to service worker (which relays to offscreen)
      const response = await chrome.runtime.sendMessage({
        action: 'generate_frame_embedding',
        imageData: serializableImageData,
        timestamp,
      });

      if (response?.success) {
        console.log('[ClarifyButton] Embedding generated successfully:', response);
        this.updateButtonState('success');
        this.updateButtonText('✅ Success!');

        // Reset after 2 seconds
        setTimeout(() => {
          this.updateButtonState('idle');
          this.updateButtonText('🔍 Clarify Frame');
          this.isProcessing = false;
        }, 2000);
      } else {
        throw new Error(response?.error || 'Unknown error');
      }
    } catch (error) {
      console.error('[ClarifyButton] Error:', error);
      this.updateButtonState('error');
      this.updateButtonText('❌ Failed');

      // Reset after 3 seconds
      setTimeout(() => {
        this.updateButtonState('idle');
        this.updateButtonText('🔍 Clarify Frame');
        this.isProcessing = false;
      }, 3000);
    }
  }

  /**
   * Update button visual state
   */
  updateButtonState(state) {
    switch (state) {
      case 'processing':
        this.button.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
        this.button.style.cursor = 'wait';
        break;
      case 'success':
        this.button.style.background = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';
        this.button.style.cursor = 'default';
        break;
      case 'error':
        this.button.style.background = 'linear-gradient(135deg, #eb3349 0%, #f45c43 100%)';
        this.button.style.cursor = 'default';
        break;
      case 'idle':
      default:
        this.button.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        this.button.style.cursor = 'pointer';
        break;
    }
  }

  /**
   * Update button text
   */
  updateButtonText(text) {
    this.button.textContent = text;
  }

  /**
   * Remove button from page
   */
  destroy() {
    if (this.button && this.button.parentNode) {
      this.button.parentNode.removeChild(this.button);
    }

    if (this.frameCapturer) {
      this.frameCapturer.destroy();
    }

    console.log('[ClarifyButton] Destroyed');
  }
}
