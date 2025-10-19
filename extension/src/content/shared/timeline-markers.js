/**
 * Timeline markers overlay system.
 * Displays markers on video progress bar at note timestamps.
 * Uses Shadow DOM for style isolation.
 */
export class TimelineMarkers {
  constructor(videoElement, progressBarElement, options = {}) {
    this.videoElement = videoElement;
    this.progressBar = progressBarElement;
    this.container = null;
    this.shadowRoot = null;
    this.markers = new Map(); // noteId → marker element
    this.markerData = new Map(); // noteId → marker data (for reflow)
    this.pendingMarkers = []; // Queue for markers that can't be added yet
    this.clickCallback = null;
    this.videoReady = false;
    this.cleanupFunctions = []; // Store cleanup functions for event listeners
    this.progressBarObserver = null;
    this.resizeObserver = null;
    this.options = options;
    this.pendingProcessTimer = null;
    this.durationWatcherAttached = false;
    this.isVisible = false; // Start hidden, show when panel opens

    this.cleanupFunctions.push(() => {
      if (this.pendingProcessTimer) {
        clearTimeout(this.pendingProcessTimer);
        this.pendingProcessTimer = null;
      }
    });

    // Setup AbortSignal listener if provided
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        console.log('[TimelineMarkers] AbortSignal received, destroying...');
        this.destroy();
      });
    }

    this.init();
    this.setupVideoReadyListener();
    this.setupProgressBarMonitoring();
  }

  init() {
    if (!this.progressBar) {
      console.warn('[TimelineMarkers] ⚠️ No progress bar provided');
      return;
    }

    console.log(
      '[TimelineMarkers] 🎯 Initializing timeline markers on progress bar:',
      this.progressBar
    );

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
        #markers-container {
          width: 100%;
          height: 100%;
        }

        #markers-container.hidden {
          display: none;
          pointer-events: none;
        }

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
      <div id="markers-container" class="hidden"></div>
    `;

    // Append to progress bar (make relative if needed)
    if (window.getComputedStyle(this.progressBar).position === 'static') {
      this.progressBar.style.position = 'relative';
    }
    this.progressBar.appendChild(this.container);
    console.log('[TimelineMarkers] 🎯 Shadow DOM container attached to progress bar');
  }

  /**
   * Setup listener to detect when video metadata is ready.
   * This is when video.duration becomes available.
   */
  setupVideoReadyListener() {
    // Check if duration is already available
    if (
      this.videoElement.duration &&
      !isNaN(this.videoElement.duration) &&
      this.videoElement.duration > 0
    ) {
      console.log('[TimelineMarkers] ✅ Video duration ready:', this.videoElement.duration);
      this.videoReady = true;
      this.processPendingMarkers();
      return;
    }

    console.log('[TimelineMarkers] ⏳ Waiting for video metadata (duration not ready yet)...');

    // Listen for loadedmetadata event
    const onMetadataLoaded = () => {
      console.log(
        '[TimelineMarkers] ✅ Video metadata loaded, duration:',
        this.videoElement.duration
      );
      this.videoReady = true;
      this.processPendingMarkers();
    };

    this.videoElement.addEventListener('loadedmetadata', onMetadataLoaded);
    this.cleanupFunctions.push(() => {
      this.videoElement.removeEventListener('loadedmetadata', onMetadataLoaded);
    });

    // Also listen for durationchange as a fallback
    const onDurationChange = () => {
      if (
        this.videoElement.duration &&
        !isNaN(this.videoElement.duration) &&
        this.videoElement.duration > 0
      ) {
        console.log('[TimelineMarkers] ✅ Video duration changed to:', this.videoElement.duration);
        this.videoReady = true;
        this.processPendingMarkers();
      }
    };

    this.videoElement.addEventListener('durationchange', onDurationChange);
    this.cleanupFunctions.push(() => {
      this.videoElement.removeEventListener('durationchange', onDurationChange);
    });

    // Timeout fallback - try to process pending markers after 5 seconds regardless
    const timeoutId = setTimeout(() => {
      if (!this.videoReady) {
        console.log(
          '[TimelineMarkers] ⏰ Timeout reached, attempting to process pending markers anyway'
        );
        this.videoReady = true;
        this.processPendingMarkers();
      }
    }, 5000);

    this.cleanupFunctions.push(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Process any markers that were queued while waiting for video to be ready.
   */
  processPendingMarkers() {
    if (!this.hasUsableDuration()) {
      console.log('[TimelineMarkers] ⏳ Duration still unavailable, keeping', this.pendingMarkers.length, 'markers pending');
      this.waitForUsableDuration();
      this.schedulePendingProcessing(200);
      return;
    }

    if (this.pendingMarkers.length === 0) {
      console.log('[TimelineMarkers] ℹ️ No pending markers to process');
      return;
    }

    console.log('[TimelineMarkers] 🔄 Processing', this.pendingMarkers.length, 'pending markers');
    const pending = [...this.pendingMarkers];
    this.pendingMarkers = [];

    pending.forEach((markerData) => {
      this.addMarker(markerData);
    });
  }

  addMarker({ id, timestamp, category, text }) {
    // Check if we already have this marker
    if (this.markers.has(id)) {
      console.log('[TimelineMarkers] ℹ️ Marker already exists:', id);
      return;
    }

    // If video isn't ready yet, queue this marker for later
    if (!this.videoReady || !this.hasUsableDuration()) {
      console.log(
        '[TimelineMarkers] ⏳ Video not ready, queuing marker:',
        id,
        'timestamp:',
        timestamp
      );
      this.queuePendingMarker({ id, timestamp, category, text });
      if (this.videoReady) {
        this.waitForUsableDuration();
        this.schedulePendingProcessing(100);
      }
      return;
    }

    const duration = this.videoElement.duration;

    // Validate timestamp
    if (timestamp > duration) {
      console.warn(
        '[TimelineMarkers] ⚠️ Marker timestamp exceeds video duration:',
        timestamp,
        '>',
        duration
      );
      return;
    }

    if (timestamp < 0) {
      console.warn('[TimelineMarkers] ⚠️ Invalid marker timestamp:', timestamp);
      return;
    }

    console.log('[TimelineMarkers] ➕ Adding marker:', id, 'at', timestamp, 'seconds');

    // Store marker data for reflow
    this.markerData.set(id, { id, timestamp, category, text });

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
    if (!markersContainer) {
      console.error('[TimelineMarkers] ❌ Markers container not found in shadow DOM');
      return;
    }

    markersContainer.appendChild(marker);

    // Store reference
    this.markers.set(id, marker);
    console.log(
      '[TimelineMarkers] ✅ Marker added successfully. Total markers:',
      this.markers.size
    );
  }

  removeMarker(noteId) {
    const marker = this.markers.get(noteId);
    if (marker) {
      marker.remove();
      this.markers.delete(noteId);
    }

    // Ensure marker cannot be resurrected
    if (this.markerData.has(noteId)) {
      this.markerData.delete(noteId);
    }

    if (this.pendingMarkers.length > 0) {
      this.pendingMarkers = this.pendingMarkers.filter((markerData) => markerData.id !== noteId);
    }

    console.log('[TimelineMarkers] ✅ Marker removed:', noteId);
  }

  highlightMarker(noteId) {
    // Remove previous highlights
    this.markers.forEach((marker) => {
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

  /**
   * Monitor progress bar for resize/replacement.
   */
  setupProgressBarMonitoring() {
    // ResizeObserver: Reflow markers on resize
    this.resizeObserver = new ResizeObserver(() => {
      console.log('[TimelineMarkers] Progress bar resized, reflowing markers');
      this.reflowAllMarkers();
    });
    this.resizeObserver.observe(this.progressBar);

    this.cleanupFunctions.push(() => {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
    });

    // MutationObserver: Reattach if progress bar replaced
    this.progressBarObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Check if our container was removed
          if (!document.contains(this.container)) {
            console.log('[TimelineMarkers] Container removed, reattaching...');
            this.reattach();
          }
        }
      }
    });

    this.progressBarObserver.observe(this.progressBar.parentElement || document.body, {
      childList: true,
      subtree: true,
    });

    this.cleanupFunctions.push(() => {
      if (this.progressBarObserver) {
        this.progressBarObserver.disconnect();
        this.progressBarObserver = null;
      }
    });
  }

  /**
   * Reflow all markers (recalculate positions).
   */
  reflowAllMarkers() {
    const duration = this.videoElement.duration;
    if (!duration || isNaN(duration) || duration === 0) {
      console.warn('[TimelineMarkers] Cannot reflow, duration not available');
      return;
    }

    this.markerData.forEach((data, id) => {
      const marker = this.markers.get(id);
      if (marker) {
        const position = (data.timestamp / duration) * 100;
        marker.style.left = `${position}%`;
      }
    });

    console.log('[TimelineMarkers] Reflowed', this.markers.size, 'markers');
  }

  /**
   * Reattach shadow DOM after container removal.
   */
  reattach() {
    if (!document.contains(this.progressBar)) {
      console.error('[TimelineMarkers] Progress bar no longer in DOM, cannot reattach');
      return;
    }

    // Remove old container
    if (this.container && this.container.parentElement) {
      this.container.remove();
    }

    // Recreate container and shadow DOM
    this.init();

    // Re-render all markers from data
    const markerDataCopy = new Map(this.markerData);
    this.markers.clear();
    this.markerData.clear();

    markerDataCopy.forEach((data) => {
      this.addMarker(data);
    });

    console.log('[TimelineMarkers] Reattached with', this.markers.size, 'markers');
  }

  clearAll() {
    console.log('[TimelineMarkers] 🧹 Clearing all markers. Current count:', this.markers.size);

    // Remove all marker elements from DOM
    this.markers.forEach((marker) => marker.remove());
    // Clear the maps
    this.markers.clear();
    this.markerData.clear();
    // Clear pending markers too
    this.pendingMarkers = [];

    console.log('[TimelineMarkers] ✅ All markers cleared');
  }

  /**
   * Show timeline markers (when side panel opens).
   */
  show() {
    if (this.isVisible) return;

    const markersContainer = this.shadowRoot?.getElementById('markers-container');
    if (markersContainer) {
      markersContainer.classList.remove('hidden');
      this.isVisible = true;
      console.log('[TimelineMarkers] 👁️ Markers visible');
    }
  }

  /**
   * Hide timeline markers (when side panel closes).
   */
  hide() {
    if (!this.isVisible) return;

    const markersContainer = this.shadowRoot?.getElementById('markers-container');
    if (markersContainer) {
      markersContainer.classList.add('hidden');
      this.isVisible = false;
      console.log('[TimelineMarkers] 🙈 Markers hidden');
    }
  }

  truncate(text, maxLength) {
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }

  destroy() {
    console.log('[TimelineMarkers] 🧹 Destroying timeline markers');

    // Run all cleanup functions (remove event listeners, clear timeouts)
    this.cleanupFunctions.forEach((cleanup) => {
      try {
        cleanup();
      } catch (err) {
        console.warn('[TimelineMarkers] Cleanup function error:', err);
      }
    });
    this.cleanupFunctions = [];

    if (this.pendingProcessTimer) {
      clearTimeout(this.pendingProcessTimer);
      this.pendingProcessTimer = null;
    }

    // Remove DOM elements
    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    // Clear all state
    this.markers.clear();
    this.markerData.clear();
    this.pendingMarkers = [];
    this.shadowRoot = null;
    this.clickCallback = null;
    this.durationWatcherAttached = false;

    console.log('[TimelineMarkers] ✅ Destroyed');
  }

  hasUsableDuration() {
    const duration = this.videoElement.duration;
    return Number.isFinite(duration) && duration > 0;
  }

  queuePendingMarker(markerData) {
    this.pendingMarkers = this.pendingMarkers.filter((marker) => marker.id !== markerData.id);
    this.pendingMarkers.push(markerData);
  }

  schedulePendingProcessing(delay = 0) {
    if (this.pendingProcessTimer) {
      return;
    }

    this.pendingProcessTimer = setTimeout(() => {
      this.pendingProcessTimer = null;
      if (!this.videoReady || this.pendingMarkers.length === 0) {
        return;
      }

      if (!this.hasUsableDuration()) {
        this.waitForUsableDuration();
        this.schedulePendingProcessing(200);
        return;
      }

      this.processPendingMarkers();
    }, delay);
  }

  waitForUsableDuration() {
    if (this.durationWatcherAttached) {
      return;
    }

    const checkDuration = () => {
      if (this.hasUsableDuration()) {
        this.durationWatcherAttached = false;
        this.videoElement.removeEventListener('timeupdate', checkDuration);
        this.videoElement.removeEventListener('loadeddata', checkDuration);
        this.processPendingMarkers();
      }
    };

    this.durationWatcherAttached = true;
    this.videoElement.addEventListener('timeupdate', checkDuration);
    this.videoElement.addEventListener('loadeddata', checkDuration);

    this.cleanupFunctions.push(() => {
      this.videoElement.removeEventListener('timeupdate', checkDuration);
      this.videoElement.removeEventListener('loadeddata', checkDuration);
      this.durationWatcherAttached = false;
    });
  }
}
