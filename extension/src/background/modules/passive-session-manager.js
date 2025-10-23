/**
 * Passive Session Manager
 *
 * Business logic for passive mode VAD session lifecycle.
 * Handles speech events, circuit breaker, heartbeat, auto-pause/resume.
 *
 * Dependencies (passed via init):
 * - passiveSession: Mutable state object
 * - tabManager: Tab manager instance
 * - Socket: Phoenix socket constructor
 * - Chrome APIs: Used directly
 *
 * Exports functions that service-worker delegates to.
 */

import { VAD_CONFIG, PASSIVE_SESSION_CONFIG } from '../../shared/shared-constants.js';
import {
  createRecordingContext,
  extractResumeInfo,
} from './recording-context-state.js';

// Module-level references (set via init)
let passiveSession = null;
let tabManager = null;
let SocketConstructor = null;
let heartbeatInterval = null;

// Helper dependencies (will be passed in or imported)
let sendMessageToTab = null;
let createOffscreenDocument = null;
let ensureVideoContextForTab = null;

/**
 * Initialize module with dependencies
 * Call this once at service worker startup
 */
export function initPassiveSessionManager(deps) {
  passiveSession = deps.passiveSession;
  tabManager = deps.tabManager;
  SocketConstructor = deps.Socket;
  sendMessageToTab = deps.sendMessageToTab;
  createOffscreenDocument = deps.createOffscreenDocument;
  ensureVideoContextForTab = deps.ensureVideoContextForTab;
}

/**
 * Reset passive session telemetry
 */
export function resetPassiveTelemetry() {
  passiveSession.telemetry.speechDetections = 0;
  passiveSession.telemetry.ignoredShort = 0;
  passiveSession.telemetry.ignoredCooldown = 0;
  passiveSession.telemetry.ignoredPendingNote = 0;
  passiveSession.telemetry.avgLatencyMs = 0;
  passiveSession.telemetry.lastConfidence = 0;
  passiveSession.telemetry.lastLatencyMs = 0;
  passiveSession.telemetry.restartAttempts = 0;
  passiveSession.telemetry.notesCreated = 0;
  passiveSession.telemetry.startedAt = Date.now();
}

/**
 * Format uptime for display
 */
function formatUptime(startedAt) {
  if (!startedAt) return '0s';
  const deltaMs = Date.now() - startedAt;
  const totalSeconds = Math.floor(deltaMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Update extension action badge
 */
function updateActionBadge() {
  if (!chrome?.action?.setBadgeText) {
    return;
  }

  const noteCount = passiveSession.telemetry.notesCreated || 0;
  const text = noteCount > 0 ? `${noteCount}` : '';
  chrome.action.setBadgeText({ text }).catch(() => {});

  let color = '#4b5563';
  if (passiveSession.status === 'recording') {
    color = '#dc2626';
  } else if (passiveSession.status === 'error') {
    color = '#b91c1c';
  } else if (passiveSession.status === 'observing') {
    color = '#22c55e';
  }

  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

/**
 * Broadcast passive status to sidepanel
 */
export function broadcastPassiveStatus({ errorMessage } = {}) {
  updateActionBadge();

  const telemetryPayload = {
    speechDetections: passiveSession.telemetry.speechDetections,
    ignoredShort: passiveSession.telemetry.ignoredShort,
    ignoredCooldown: passiveSession.telemetry.ignoredCooldown,
    ignoredPendingNote: passiveSession.telemetry.ignoredPendingNote,
    ignoredNoContext: passiveSession.telemetry.ignoredNoContext,
    avgLatencyMs: Math.round(passiveSession.telemetry.avgLatencyMs || 0),
    lastConfidence: passiveSession.telemetry.lastConfidence,
    lastLatencyMs: passiveSession.telemetry.lastLatencyMs,
    restartAttempts: passiveSession.telemetry.restartAttempts,
    notesCreated: passiveSession.telemetry.notesCreated,
    uptime: formatUptime(passiveSession.telemetry.startedAt),
  };

  chrome.runtime
    .sendMessage({
      action: 'passive_status_update',
      status: passiveSession.status,
      telemetry: telemetryPayload,
      errorMessage,
    })
    .catch(() => {
      // Sidepanel may not be open; ignore
    });
}

/**
 * Request video pause for passive recording
 */
async function requestPassivePause(tabId) {
  if (!passiveSession.settings.autoPauseVideo || !tabId) {
    return { wasPlaying: false };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'passive_pause_video',
    });
    return {
      wasPlaying: Boolean(response?.wasPlaying),
    };
  } catch (error) {
    console.warn('[Passive] Failed to auto-pause video:', error.message);
    return { wasPlaying: false };
  }
}

/**
 * Schedule auto-resume of video after recording
 */
function schedulePassiveResume(tabId, wasPlaying) {
  if (!passiveSession.settings.autoPauseVideo || !wasPlaying || !tabId) {
    return;
  }

  if (passiveSession.resumeTimeout) {
    clearTimeout(passiveSession.resumeTimeout);
    passiveSession.resumeTimeout = null;
  }

  passiveSession.resumeTimeout = setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'passive_resume_video',
      });
      console.log('[Passive] Auto-resumed video after speech');
    } catch (error) {
      console.warn('[Passive] Failed to auto-resume video:', error.message);
    } finally {
      passiveSession.resumeTimeout = null;
    }
  }, passiveSession.settings.autoResumeDelayMs);
}

/**
 * Clear passive resume timer
 */
function clearPassiveResumeTimer() {
  if (passiveSession.resumeTimeout) {
    clearTimeout(passiveSession.resumeTimeout);
    passiveSession.resumeTimeout = null;
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Restart VAD with exponential backoff and circuit breaker
 */
export async function restartVADWithBackoff() {
  const breaker = passiveSession.circuitBreaker;
  if (breaker.state === 'open') {
    console.warn('[Passive] Circuit breaker open, skipping VAD restart');
    return;
  }

  if (!passiveSession.vadConfig) {
    console.warn('[Passive] VAD restart requested but no configuration available');
    return;
  }

  const now = Date.now();
  if (now - breaker.lastRestartAt > breaker.resetWindowMs) {
    breaker.restartCount = 0;
    breaker.state = 'closed';
  }

  if (breaker.restartCount >= breaker.maxRestarts) {
    breaker.state = 'open';
    passiveSession.status = 'error';
    passiveSession.vadEnabled = false;
    broadcastPassiveStatus({
      errorMessage:
        'VAD failed after multiple restart attempts. Please reload the extension or disable passive mode.',
    });
    return;
  }

  breaker.restartCount += 1;
  breaker.lastRestartAt = now;
  passiveSession.telemetry.restartAttempts = breaker.restartCount;

  const backoffMs = 1000 * breaker.restartCount;
  console.warn(
    `[Passive] Attempting VAD restart (${breaker.restartCount}/${breaker.maxRestarts}) in ${backoffMs}ms`
  );
  await sleep(backoffMs);

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_vad',
    });
  } catch (error) {
    console.warn('[Passive] stop_vad during restart failed:', error.message);
  }

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: passiveSession.vadConfig,
    });
    breaker.state = 'half-open';
    passiveSession.heartbeatFailures = 0;
    passiveSession.vadEnabled = true;
    passiveSession.status = 'observing';
    broadcastPassiveStatus();
    console.log('[Passive] VAD restarted successfully');
  } catch (error) {
    console.error('[Passive] VAD restart failed:', error);
  }
}

/**
 * Handle heartbeat failure
 */
export async function handleHeartbeatFailure(error) {
  passiveSession.heartbeatFailures += 1;
  console.warn(`[Passive] Heartbeat failure #${passiveSession.heartbeatFailures}:`, error);
  await restartVADWithBackoff();
}

/**
 * Acknowledge successful heartbeat
 */
export function acknowledgeHeartbeatSuccess() {
  passiveSession.heartbeatFailures = 0;
  if (passiveSession.circuitBreaker.state === 'half-open') {
    passiveSession.circuitBreaker.state = 'closed';
  }
}

/**
 * Handle passive VAD events (speech_start, speech_end, metrics, error)
 * CRITICAL: Preserves recording context isolation for correct note routing
 */
export async function handlePassiveEvent(event) {
  if (!passiveSession.vadEnabled) {
    console.log('[Passive] VAD disabled, ignoring event');
    return;
  }

  if (event.type === 'metrics') {
    const m = event.data || {};
    console.log(
      '[Passive] VAD:',
      `state=${m.state || '?'}`,
      `conf=${(m.confidence ?? 0).toFixed(3)}`,
      `speech=${Math.round(m.speechDurationMs || 0)}ms`,
      `silence=${Math.round(m.silenceDurationMs || 0)}ms`,
      `lat=${(m.latencyMs ?? 0).toFixed(1)}ms`
    );
    passiveSession.telemetry.lastConfidence = m.confidence ?? 0;
    passiveSession.telemetry.lastLatencyMs = m.latencyMs ?? 0;
    acknowledgeHeartbeatSuccess();
    broadcastPassiveStatus();
    return;
  }

  const now = Date.now();

  if (event.type === 'speech_start' && passiveSession.status !== 'recording') {
    // Ignore if in cooldown
    if (passiveSession.status === 'cooldown') {
      passiveSession.telemetry.ignoredCooldown++;
      console.log('[Passive] Ignored speech during cooldown');
      return;
    }

    // Check for stale recording context
    if (passiveSession.recordingContext) {
      const contextAge = Date.now() - passiveSession.recordingContext.startedAt;

      if (contextAge > PASSIVE_SESSION_CONFIG.STALE_CONTEXT_THRESHOLD_MS) {
        console.warn('[Passive] Stale recording context (', contextAge, 'ms) - clearing and proceeding');
        passiveSession.recordingContext = null;
        if (passiveSession.recordingContextTimeout) {
          clearTimeout(passiveSession.recordingContextTimeout);
          passiveSession.recordingContextTimeout = null;
        }
      } else {
        // Still fresh, block to prevent context corruption
        passiveSession.telemetry.ignoredPendingNote++;
        console.log('[Passive] Ignored speech - context age:', contextAge, 'ms (< 2s threshold)');
        return;
      }
    }

    const confidence = event.data?.confidence ?? 0;
    const latencyMs = event.data?.latencyMs ?? 0;
    console.log(
      '[Passive] Speech detected (confidence:',
      confidence.toFixed(3),
      'latency:',
      latencyMs.toFixed(1),
      'ms)'
    );

    clearPassiveResumeTimer();

    // CRITICAL: Capture recording context atomically at speech_start
    const currentTabId = passiveSession.tabId;
    let currentVideoContext = tabManager ? tabManager.getVideoContext(currentTabId) : null;

    // Validate we have a video context - if not, try to hydrate it
    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Passive] No video context for current tab, attempting refresh');
      currentVideoContext = await ensureVideoContextForTab(currentTabId);
    }

    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Passive] Still no video context after refresh, skipping speech segment');
      passiveSession.telemetry.ignoredNoContext++;
      return;
    }

    console.log('[Passive] Captured recording context:', {
      tabId: currentTabId,
      videoDbId: currentVideoContext.videoDbId,
      video: currentVideoContext.title || currentVideoContext.videoId,
    });

    // Capture timestamp from the CURRENT tab
    let capturedTimestamp = null;
    if (!chrome?.runtime?.id) {
      console.log('[Passive] Extension context invalidated, skipping timestamp capture');
    } else {
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(currentTabId, { action: 'get_timestamp' }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
        ]);

        if (response && response.success && response.timestamp != null) {
          capturedTimestamp = response.timestamp;
          console.log('[Passive] Captured timestamp:', capturedTimestamp);
        }
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.log('[Passive] Extension context invalidated during timestamp capture');
        } else {
          console.log('[Passive] Failed to capture timestamp:', err.message);
        }
      }
    }

    // Store the complete recording context (frozen for this utterance)
    passiveSession.recordingContext = createRecordingContext(
      currentTabId,
      currentVideoContext,
      capturedTimestamp,
      { wasPlaying: false }
    );

    passiveSession.status = 'recording';
    passiveSession.lastStartAt = now;
    passiveSession.telemetry.speechDetections++;
    passiveSession.telemetry.lastConfidence = confidence;
    passiveSession.telemetry.lastLatencyMs = latencyMs;

    if (passiveSession.settings.autoPauseVideo) {
      const pauseResult = await requestPassivePause(currentTabId);
      passiveSession.recordingContext.autoPause = pauseResult;
    }

    // Clear first speech timeout on first detection
    if (passiveSession.firstSpeechTimeout) {
      clearTimeout(passiveSession.firstSpeechTimeout);
      passiveSession.firstSpeechTimeout = null;
      console.log('[Passive] First speech detected - cleared auto-stop timeout');
    }

    // Send timestamp to backend via persistent channel
    if (passiveSession.audioChannel && capturedTimestamp != null) {
      passiveSession.audioChannel
        .push('set_timestamp', { timestamp: capturedTimestamp })
        .receive('ok', () => {
          console.log('[Passive] Timestamp sent to backend:', capturedTimestamp);
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to send timestamp:', err);
        });
    }

    // Start recording in offscreen
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'start_recording',
      });
      console.log('[Passive] Recording started successfully');
    } catch (error) {
      console.error('[Passive] Failed to start recording:', error);
      if (passiveSession.recordingContext?.autoPause?.wasPlaying) {
        schedulePassiveResume(currentTabId, true);
      }
      passiveSession.status = 'observing';
      passiveSession.recordingContext = null;
    }

    broadcastPassiveStatus();
  } else if (event.type === 'speech_end' && passiveSession.status === 'recording') {
    const duration = now - passiveSession.lastStartAt;
    const confidence = event.data?.confidence ?? passiveSession.telemetry.lastConfidence;
    const latencyMs = event.data?.latencyMs ?? passiveSession.telemetry.lastLatencyMs;
    const resumeInfo = extractResumeInfo(passiveSession.recordingContext);

    if (duration >= VAD_CONFIG.MIN_SPEECH_DURATION_MS) {
      console.log('[Passive] Speech ended, duration:', duration, 'ms');

      // Stop recording in offscreen
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'stop_recording',
        });
        console.log('[Passive] Recording stopped successfully');
      } catch (error) {
        console.error('[Passive] Failed to stop recording:', error);
      }

      passiveSession.status = 'cooldown';

      // Update telemetry
      const count = passiveSession.telemetry.speechDetections;
      passiveSession.telemetry.avgLatencyMs =
        (passiveSession.telemetry.avgLatencyMs * (count - 1) + latencyMs) / count;
      passiveSession.telemetry.lastConfidence = confidence;
      passiveSession.telemetry.lastLatencyMs = latencyMs;

      // Enter cooldown - recording context is PRESERVED until note arrives
      setTimeout(() => {
        if (passiveSession.status === 'cooldown') {
          passiveSession.status = 'observing';
          console.log('[Passive] Cooldown complete, resuming observation');
          broadcastPassiveStatus();
        }
      }, PASSIVE_SESSION_CONFIG.COOLDOWN_MS);

      // Set a safety timeout to clear stale context
      if (passiveSession.recordingContextTimeout) {
        clearTimeout(passiveSession.recordingContextTimeout);
      }
      passiveSession.recordingContextTimeout = setTimeout(() => {
        if (passiveSession.recordingContext) {
          const age = Date.now() - passiveSession.recordingContext.startedAt;
          console.warn('[Passive] Recording context timeout after', age, 'ms - clearing');
          passiveSession.recordingContext = null;
          passiveSession.recordingContextTimeout = null;
        }
      }, PASSIVE_SESSION_CONFIG.RECORDING_CONTEXT_TIMEOUT_MS);

      schedulePassiveResume(resumeInfo.tabId, resumeInfo.wasPlaying);
    } else {
      passiveSession.telemetry.ignoredShort++;
      console.log('[Passive] Ignored short speech segment:', duration, 'ms');
      passiveSession.status = 'observing';
      // Clear recording context immediately for ignored segments
      passiveSession.recordingContext = null;
      if (passiveSession.recordingContextTimeout) {
        clearTimeout(passiveSession.recordingContextTimeout);
        passiveSession.recordingContextTimeout = null;
      }

      schedulePassiveResume(resumeInfo.tabId, resumeInfo.wasPlaying);
    }

    broadcastPassiveStatus();
  } else if (event.type === 'error') {
    console.error('[Passive] VAD error:', event.data);
    passiveSession.vadEnabled = false;
    passiveSession.status = 'error';
    passiveSession.circuitBreaker.state = 'open';

    // Clear recording context on error
    if (passiveSession.recordingContext) {
      passiveSession.recordingContext = null;
    }
    if (passiveSession.recordingContextTimeout) {
      clearTimeout(passiveSession.recordingContextTimeout);
      passiveSession.recordingContextTimeout = null;
    }

    stopPassiveSession();
    broadcastPassiveStatus({ errorMessage: event.data?.message });
  }
}

/**
 * Start passive session
 * Creates persistent audio channel and starts VAD
 */
export async function startPassiveSession() {
  console.log('[Passive] Starting passive session');

  try {
    // Get active tab for video context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab');
    }

    passiveSession.tabId = tab.id;

    // Ensure offscreen document exists
    await createOffscreenDocument();

    // Create persistent socket and audio channel
    console.log('[Passive] Creating persistent audio channel');
    passiveSession.sessionId = crypto.randomUUID();
    passiveSession.socket = new SocketConstructor('ws://localhost:4000/socket', {
      params: {},
    });
    passiveSession.socket.connect();

    // Get video context from TabManager
    const videoContext = tabManager ? tabManager.getVideoContext(tab.id) : null;

    // Create audio channel with video context
    passiveSession.audioChannel = passiveSession.socket.channel(
      `audio:${passiveSession.sessionId}`,
      {
        video_id: videoContext?.videoDbId,
        passive_mode: true,
      }
    );

    // Listen for note_created events on the persistent channel
    passiveSession.audioChannel.on('note_created', (payload) => {
      console.log('[Passive] Received structured note:', payload.id);
      passiveSession.telemetry.notesCreated += 1;

      // CRITICAL: Route timeline marker to the tab where recording started
      const targetTabId = passiveSession.recordingContext?.tabId || passiveSession.tabId;

      if (targetTabId) {
        console.log('[Passive] Routing timeline marker to recording tab:', targetTabId);
        sendMessageToTab(targetTabId, {
          action: 'note_created',
          data: {
            id: payload.id,
            text: payload.text,
            category: payload.category,
            timestamp_seconds: payload.timestamp_seconds,
          },
        });
      } else {
        console.warn('[Passive] No target tab for timeline marker, note:', payload.id);
      }

      // Clear recording context now that note has been delivered
      if (passiveSession.recordingContext) {
        console.log('[Passive] Clearing recording context after note delivery');
        passiveSession.recordingContext = null;

        if (passiveSession.recordingContextTimeout) {
          clearTimeout(passiveSession.recordingContextTimeout);
          passiveSession.recordingContextTimeout = null;
        }
      }

      broadcastPassiveStatus();
    });

    // Join the persistent channel
    await new Promise((resolve, reject) => {
      passiveSession.audioChannel
        .join()
        .receive('ok', () => {
          console.log('[Passive] Persistent audio channel joined');
          resolve();
        })
        .receive('error', (err) => {
          console.error('[Passive] Failed to join audio channel:', err);
          reject(err);
        });
    });

    passiveSession.vadConfig = {
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 2000,
      sileroConfidence: 0.45,
      sileroNegativeThreshold: 0.40,
    };

    // Start VAD in offscreen
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: passiveSession.vadConfig,
    });

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Start heartbeat
    heartbeatInterval = setInterval(async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'heartbeat',
        });
        if (response?.alive) {
          acknowledgeHeartbeatSuccess();
        }
      } catch (err) {
        await handleHeartbeatFailure(err);
      }
    }, PASSIVE_SESSION_CONFIG.HEARTBEAT_INTERVAL_MS);

    passiveSession.vadEnabled = true;
    passiveSession.status = 'observing';
    resetPassiveTelemetry();
    broadcastPassiveStatus();
    console.log('[Passive] Session active with persistent audio channel');

    // Auto-start behavior: Stop session if no speech detected
    passiveSession.firstSpeechTimeout = setTimeout(async () => {
      if (passiveSession.telemetry.speechDetections === 0) {
        console.log('[Passive] No speech detected in first', PASSIVE_SESSION_CONFIG.FIRST_SPEECH_TIMEOUT_MS / 1000, 'seconds - auto-stopping');
        await stopPassiveSession();
      }
    }, PASSIVE_SESSION_CONFIG.FIRST_SPEECH_TIMEOUT_MS);
  } catch (error) {
    console.error('[Passive] Failed to start session:', error);
    // Clean up on error
    if (passiveSession.audioChannel) {
      passiveSession.audioChannel.leave();
      passiveSession.audioChannel = null;
    }
    if (passiveSession.socket) {
      passiveSession.socket.disconnect();
      passiveSession.socket = null;
    }
    throw error;
  }
}

/**
 * Stop passive session
 * Tears down persistent audio channel and cleans up resources
 */
export async function stopPassiveSession() {
  console.log('[Passive] Stopping passive session');

  // Clear heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Stop VAD in offscreen
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_vad',
    });
  } catch (err) {
    console.log('[Passive] Could not stop VAD (offscreen may be gone):', err.message);
  }

  // Tear down persistent audio channel
  if (passiveSession.audioChannel) {
    console.log('[Passive] Leaving persistent audio channel');
    passiveSession.audioChannel.leave();
    passiveSession.audioChannel = null;
  }

  if (passiveSession.socket) {
    console.log('[Passive] Disconnecting persistent socket');
    passiveSession.socket.disconnect();
    passiveSession.socket = null;
  }

  // Clear recording context to prevent stale routing
  if (passiveSession.recordingContext) {
    console.log('[Passive] Clearing stale recording context');
    passiveSession.recordingContext = null;
  }

  // Clear any pending timeouts
  if (passiveSession.recordingContextTimeout) {
    clearTimeout(passiveSession.recordingContextTimeout);
    passiveSession.recordingContextTimeout = null;
  }

  if (passiveSession.firstSpeechTimeout) {
    clearTimeout(passiveSession.firstSpeechTimeout);
    passiveSession.firstSpeechTimeout = null;
  }

  clearPassiveResumeTimer();

  passiveSession.vadEnabled = false;
  passiveSession.status = 'idle';
  passiveSession.tabId = null;
  passiveSession.sessionId = null;
  passiveSession.circuitBreaker.state = 'closed';
  passiveSession.circuitBreaker.restartCount = 0;
  passiveSession.heartbeatFailures = 0;
  passiveSession.vadConfig = null;
  broadcastPassiveStatus();
  console.log('[Passive] Session stopped and cleaned up');
}
