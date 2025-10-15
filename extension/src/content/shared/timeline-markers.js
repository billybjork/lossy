/**
 * Timeline markers overlay system.
 * Displays markers on video progress bar at note timestamps.
 * Uses Shadow DOM for style isolation.
 */
export class TimelineMarkers {
  constructor(videoElement, progressBarElement) {
    this.videoElement = videoElement;
    this.progressBar = progressBarElement;
    this.container = null;
    this.shadowRoot = null;
    this.markers = new Map(); // noteId → marker element
    this.clickCallback = null;
    this.init();
  }

  init() {
    if (!this.progressBar) {
      console.warn('[TimelineMarkers] No progress bar provided');
      return;
    }

    // Create marker container
    this.container = document.createElement('div');
    this.container.id = 'lossy-timeline-markers';
    this.container.style.position = 'absolute';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '100';

    // Attach shadow DOM
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        .marker {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 10px;
          height: 10px;
          background: #fbbf24;
          border: 2px solid #f59e0b;
          border-radius: 50%;
          cursor: pointer;
          pointer-events: auto;
          transition: transform 0.2s, background 0.2s, box-shadow 0.2s;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
          z-index: 10;
        }

        .marker:hover {
          transform: translate(-50%, -50%) scale(1.4);
          background: #fde047;
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.4);
        }

        .marker-tooltip {
          position: absolute;
          bottom: 120%;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          border-radius: 6px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 12px;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s;
          z-index: 1000;
        }

        .marker:hover .marker-tooltip {
          opacity: 1;
        }

        .marker-category {
          display: inline-block;
          padding: 2px 6px;
          background: #f59e0b;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          margin-right: 6px;
        }
      </style>
      <div id="markers-container"></div>
    `;

    // Append to progress bar (make relative if needed)
    if (window.getComputedStyle(this.progressBar).position === 'static') {
      this.progressBar.style.position = 'relative';
    }
    this.progressBar.appendChild(this.container);
  }

  addMarker({ id, timestamp, category, text }) {
    const duration = this.videoElement.duration;
    if (!duration || timestamp > duration) return;

    // Calculate position (percentage)
    const position = (timestamp / duration) * 100;

    // Create marker element
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.left = `${position}%`;
    marker.dataset.noteId = id;
    marker.dataset.timestamp = timestamp;

    // Add tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'marker-tooltip';
    tooltip.innerHTML = `
      <span class="marker-category">${category || 'note'}</span>
      ${this.truncate(text, 50)}
    `;
    marker.appendChild(tooltip);

    // Click handler
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.clickCallback) {
        this.clickCallback(id, timestamp);
      }
    });

    // Add to shadow DOM
    const markersContainer = this.shadowRoot.getElementById('markers-container');
    markersContainer.appendChild(marker);

    // Store reference
    this.markers.set(id, marker);
  }

  removeMarker(noteId) {
    const marker = this.markers.get(noteId);
    if (marker) {
      marker.remove();
      this.markers.delete(noteId);
    }
  }

  highlightMarker(noteId) {
    // Remove previous highlights
    this.markers.forEach(marker => {
      marker.style.background = '#fbbf24';
      marker.style.borderColor = '#f59e0b';
      marker.style.transform = 'translate(-50%, -50%) scale(1)';
    });

    // Highlight selected marker with pulsing animation
    const marker = this.markers.get(noteId);
    if (marker) {
      marker.style.background = '#22c55e'; // Green when clicked
      marker.style.borderColor = '#16a34a';
      marker.style.transform = 'translate(-50%, -50%) scale(1.5)';

      setTimeout(() => {
        marker.style.background = '#fbbf24';
        marker.style.borderColor = '#f59e0b';
        marker.style.transform = 'translate(-50%, -50%) scale(1)';
      }, 2000);
    }
  }

  onMarkerClick(callback) {
    this.clickCallback = callback;
  }

  truncate(text, maxLength) {
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }

  destroy() {
    if (this.container) {
      this.container.remove();
    }
    this.markers.clear();
  }
}
