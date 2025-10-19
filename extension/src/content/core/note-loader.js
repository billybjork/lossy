/**
 * Note Loader - Single state machine for note loading with deduplication.
 *
 * Consolidates three overlapping retry systems:
 * - Watchdog (deleted)
 * - Exponential backoff retry (deleted)
 * - Manual retry (consolidated here)
 *
 * Features:
 * - Request deduplication (per videoDbId)
 * - Session tracking (cancel on navigation)
 * - Retry with exponential backoff (consolidated)
 * - State machine (idle → loading → loaded → failed)
 */
export class NoteLoader {
  constructor() {
    this.state = 'idle'; // idle | loading | loaded | failed
    this.videoDbId = null;
    this.loadPromise = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.sessionId = 0; // Increment on each video change
  }

  /**
   * Load notes for a video (deduplicated).
   */
  async loadNotes(videoDbId) {
    // Deduplication: if already loading this video, return existing promise
    if (this.state === 'loading' && this.videoDbId === videoDbId && this.loadPromise) {
      console.log('[NoteLoader] Already loading notes for', videoDbId);
      return this.loadPromise;
    }

    // If switching videos, reset state
    if (this.videoDbId !== videoDbId) {
      this.reset();
      this.videoDbId = videoDbId;
      this.sessionId++;
    }

    this.state = 'loading';
    this.loadPromise = this._loadNotesInternal(videoDbId);

    return this.loadPromise;
  }

  async _loadNotesInternal(videoDbId) {
    const currentSession = this.sessionId;

    try {
      console.log(
        '[NoteLoader] 📝 Requesting notes for video:',
        videoDbId,
        'session:',
        currentSession
      );

      const response = await chrome.runtime.sendMessage({
        action: 'request_notes',
        videoDbId: videoDbId,
        sessionId: currentSession,
      });

      // Check if session is still valid (user didn't navigate away)
      if (this.sessionId !== currentSession) {
        console.log(
          '[NoteLoader] ⚠️ Session invalidated (was',
          currentSession,
          'now',
          this.sessionId,
          ')'
        );
        throw new Error('Session invalidated');
      }

      if (response.error) {
        throw new Error(response.error);
      }

      this.state = 'loaded';
      this.retryCount = 0;
      console.log('[NoteLoader] ✅ Notes loaded successfully');

      return response;
    } catch (error) {
      console.error('[NoteLoader] Failed to load notes:', error);

      // Retry with exponential backoff
      if (this.retryCount < this.maxRetries && this.sessionId === currentSession) {
        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);

        console.log(`[NoteLoader] 🔄 Retry ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

        await new Promise((resolve) => setTimeout(resolve, delay));

        // Verify session still valid before retrying
        if (this.sessionId === currentSession) {
          return this._loadNotesInternal(videoDbId);
        }
      }

      this.state = 'failed';
      throw error;
    }
  }

  reset() {
    this.state = 'idle';
    this.videoDbId = null;
    this.loadPromise = null;
    this.retryCount = 0;
  }

  invalidateSession() {
    this.sessionId++;
    console.log('[NoteLoader] Session invalidated, now:', this.sessionId);
  }

  isLoading() {
    return this.state === 'loading';
  }

  isLoaded() {
    return this.state === 'loaded';
  }
}
