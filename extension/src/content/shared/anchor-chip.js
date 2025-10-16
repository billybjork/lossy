/**
 * Anchor chip overlay - shows timestamp when recording starts.
 * Positioned over video with pulsing animation.
 * Uses Shadow DOM for style isolation.
 */
export class AnchorChip {
  constructor(videoElement, anchorContainer = null) {
    this.videoElement = videoElement;
    this.anchorContainer = anchorContainer || videoElement.parentElement;
    this.container = null;
    this.shadowRoot = null;
    this.init();
  }

  init() {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'lossy-anchor-chip';
    this.container.style.position = 'absolute';
    this.container.style.top = '20px';
    this.container.style.left = '20px';
    this.container.style.zIndex = '9999';
    this.container.style.pointerEvents = 'none';
    this.container.style.display = 'none';

    // Attach shadow DOM
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        .anchor-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          background: rgba(220, 38, 38, 0.95);
          color: white;
          border-radius: 24px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.85; transform: scale(1.05); }
        }

        .anchor-icon {
          width: 8px;
          height: 8px;
          background: white;
          border-radius: 50%;
          animation: ping 2s infinite;
        }

        @keyframes ping {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.5); opacity: 0.7; }
        }

        .anchor-time {
          font-variant-numeric: tabular-nums;
        }
      </style>

      <div class="anchor-chip">
        <div class="anchor-icon"></div>
        <span class="anchor-time" id="timestamp">0:00</span>
      </div>
    `;

    // Append to anchor container
    if (this.anchorContainer) {
      this.anchorContainer.style.position = 'relative';
      this.anchorContainer.appendChild(this.container);
    }

    // Handle fullscreen
    this.handleFullscreen();
  }

  show(timestamp) {
    this.container.style.display = 'block';
    this.updateTimestamp(timestamp);
  }

  hide() {
    this.container.style.display = 'none';
  }

  updateTimestamp(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const timeString = `${minutes}:${secs.toString().padStart(2, '0')}`;

    const timeEl = this.shadowRoot.getElementById('timestamp');
    if (timeEl) {
      timeEl.textContent = timeString;
    }
  }

  handleFullscreen() {
    document.addEventListener('fullscreenchange', () => {
      const fullscreenEl = document.fullscreenElement;

      if (fullscreenEl) {
        // Move to fullscreen element
        fullscreenEl.appendChild(this.container);
        this.container.style.position = 'absolute';
      } else {
        // Move back to anchor container
        if (this.anchorContainer) {
          this.anchorContainer.appendChild(this.container);
        }
      }
    });
  }

  destroy() {
    if (this.container) {
      this.container.remove();
    }
  }
}
