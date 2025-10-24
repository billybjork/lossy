/**
 * Voice Session Manager
 *
 * Business logic for voice mode VAD session lifecycle.
 * Handles speech events, circuit breaker, heartbeat, auto-pause/resume.
 *
 * Dependencies (passed via init):
 * - voiceSession: Mutable state object
 * - tabManager: Tab manager instance
 * - Socket: Phoenix socket constructor
 * - Chrome APIs: Used directly
 *
 * Exports functions that service-worker delegates to.
 */

import { VAD_CONFIG, VOICE_SESSION_CONFIG } from '../../shared/shared-constants.js';
import {
  createRecordingContext,
  extractResumeInfo,
} from './recording-context-state.js';

// Module-level references (set via init)
let voiceSession = null;
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
export function initVoiceSessionManager(deps) {
  voiceSession = deps.voiceSession;
  tabManager = deps.tabManager;
  SocketConstructor = deps.Socket;
  sendMessageToTab = deps.sendMessageToTab;
  createOffscreenDocument = deps.createOffscreenDocument;
  ensureVideoContextForTab = deps.ensureVideoContextForTab;
}

/**
 * Reset voice session telemetry
 */
export function resetVoiceTelemetry() {
  voiceSession.telemetry.speechDetections = 0;
  voiceSession.telemetry.ignoredShort = 0;
  voiceSession.telemetry.ignoredCooldown = 0;
  voiceSession.telemetry.ignoredPendingNote = 0;
  voiceSession.telemetry.ignoredNoContext = 0;
  voiceSession.telemetry.avgLatencyMs = 0;
  voiceSession.telemetry.lastConfidence = 0;
  voiceSession.telemetry.lastLatencyMs = 0;
  voiceSession.telemetry.restartAttempts = 0;
  voiceSession.telemetry.notesCreated = 0;
  voiceSession.telemetry.startedAt = Date.now();
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

  const noteCount = voiceSession.telemetry.notesCreated || 0;
  const text = noteCount > 0 ? `${noteCount}` : '';
  chrome.action.setBadgeText({ text }).catch(() => {});

  let color = '#4b5563';
  if (voiceSession.status === 'recording') {
    color = '#dc2626';
  } else if (voiceSession.status === 'error') {
    color = '#b91c1c';
  } else if (voiceSession.status === 'observing') {
    color = '#22c55e';
  }

  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

/**
 * Broadcast voice mode status to sidepanel
 */
export function broadcastVoiceStatus({ errorMessage } = {}) {
  updateActionBadge();

  const telemetryPayload = {
    speechDetections: voiceSession.telemetry.speechDetections,
    ignoredShort: voiceSession.telemetry.ignoredShort,
    ignoredCooldown: voiceSession.telemetry.ignoredCooldown,
    ignoredPendingNote: voiceSession.telemetry.ignoredPendingNote,
    ignoredNoContext: voiceSession.telemetry.ignoredNoContext,
    avgLatencyMs: Math.round(voiceSession.telemetry.avgLatencyMs || 0),
    lastConfidence: voiceSession.telemetry.lastConfidence,
    lastLatencyMs: voiceSession.telemetry.lastLatencyMs,
    restartAttempts: voiceSession.telemetry.restartAttempts,
    notesCreated: voiceSession.telemetry.notesCreated,
    uptime: formatUptime(voiceSession.telemetry.startedAt),
  };

  chrome.runtime
    .sendMessage({
      action: 'voice_status_update',
      status: voiceSession.status,
      telemetry: telemetryPayload,
      errorMessage,
    })
    .catch(() => {
      // Sidepanel may not be open; ignore
    });
}

/**
 * Request video pause for voice mode recording
 */
async function requestVoicePause(tabId) {
  if (!voiceSession.settings.autoPauseVideo || !tabId) {
    return { wasPlaying: false };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'voice_pause_video',
    });
    return {
      wasPlaying: Boolean(response?.wasPlaying),
    };
  } catch (error) {
    console.warn('[Voice Mode] Failed to auto-pause video:', error.message);
    return { wasPlaying: false };
  }
}

/**
 * Schedule auto-resume of video after recording
 */
function scheduleVoiceResume(tabId, wasPlaying) {
  if (!voiceSession.settings.autoPauseVideo || !wasPlaying || !tabId) {
    return;
  }

  if (voiceSession.resumeTimeout) {
    clearTimeout(voiceSession.resumeTimeout);
    voiceSession.resumeTimeout = null;
  }

  voiceSession.resumeTimeout = setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'voice_resume_video',
      });
      console.log('[Voice Mode] Auto-resumed video after speech');
    } catch (error) {
      console.warn('[Voice Mode] Failed to auto-resume video:', error.message);
    } finally {
      voiceSession.resumeTimeout = null;
    }
  }, voiceSession.settings.autoResumeDelayMs);
}

/**
 * Clear voice mode resume timer
 */
function clearVoiceResumeTimer() {
  if (voiceSession.resumeTimeout) {
    clearTimeout(voiceSession.resumeTimeout);
    voiceSession.resumeTimeout = null;
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
  const breaker = voiceSession.circuitBreaker;
  if (breaker.state === 'open') {
    console.warn('[Voice Mode] Circuit breaker open, skipping VAD restart');
    return;
  }

  if (!voiceSession.vadConfig) {
    console.warn('[Voice Mode] VAD restart requested but no configuration available');
    return;
  }

  const now = Date.now();
  if (now - breaker.lastRestartAt > breaker.resetWindowMs) {
    breaker.restartCount = 0;
    breaker.state = 'closed';
  }

  if (breaker.restartCount >= breaker.maxRestarts) {
    breaker.state = 'open';
    voiceSession.status = 'error';
    voiceSession.vadEnabled = false;
    broadcastVoiceStatus({
      errorMessage:
        'VAD failed after multiple restart attempts. Please reload the extension or disable voice mode.',
    });
    return;
  }

  breaker.restartCount += 1;
  breaker.lastRestartAt = now;
  voiceSession.telemetry.restartAttempts = breaker.restartCount;

  const backoffMs = 1000 * breaker.restartCount;
  console.warn(
    `[Voice Mode] Attempting VAD restart (${breaker.restartCount}/${breaker.maxRestarts}) in ${backoffMs}ms`
  );
  await sleep(backoffMs);

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_vad',
    });
  } catch (error) {
    console.warn('[Voice Mode] stop_vad during restart failed:', error.message);
  }

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: voiceSession.vadConfig,
    });
    breaker.state = 'half-open';
    voiceSession.heartbeatFailures = 0;
    voiceSession.vadEnabled = true;
    voiceSession.status = 'observing';
    broadcastVoiceStatus();
    console.log('[Voice Mode] VAD restarted successfully');
  } catch (error) {
    console.error('[Voice Mode] VAD restart failed:', error);
  }
}

/**
 * Handle heartbeat failure
 */
export async function handleHeartbeatFailure(error) {
  voiceSession.heartbeatFailures += 1;
  console.warn(`[Voice Mode] Heartbeat failure #${voiceSession.heartbeatFailures}:`, error);
  await restartVADWithBackoff();
}

/**
 * Acknowledge successful heartbeat
 */
export function acknowledgeHeartbeatSuccess() {
  voiceSession.heartbeatFailures = 0;
  if (voiceSession.circuitBreaker.state === 'half-open') {
    voiceSession.circuitBreaker.state = 'closed';
  }
}

/**
 * Handle voice mode VAD events (speech_start, speech_end, metrics, error)
 * CRITICAL: Preserves recording context isolation for correct note routing
 */
export async function handleVoiceEvent(event) {
  if (!voiceSession.vadEnabled) {
    console.log('[Voice Mode] VAD disabled, ignoring event');
    return;
  }

  if (event.type === 'metrics') {
    const m = event.data || {};
    console.log(
      '[Voice Mode] VAD:',
      `state=${m.state || '?'}`,
      `conf=${(m.confidence ?? 0).toFixed(3)}`,
      `speech=${Math.round(m.speechDurationMs || 0)}ms`,
      `silence=${Math.round(m.silenceDurationMs || 0)}ms`,
      `lat=${(m.latencyMs ?? 0).toFixed(1)}ms`
    );
    voiceSession.telemetry.lastConfidence = m.confidence ?? 0;
    voiceSession.telemetry.lastLatencyMs = m.latencyMs ?? 0;
    acknowledgeHeartbeatSuccess();
    broadcastVoiceStatus();
    return;
  }

  const now = Date.now();

  if (event.type === 'speech_start' && voiceSession.status !== 'recording') {
    // Ignore if in cooldown
    if (voiceSession.status === 'cooldown') {
      voiceSession.telemetry.ignoredCooldown++;
      console.log('[Voice Mode] Ignored speech during cooldown');
      return;
    }

    // Check for stale recording context
    if (voiceSession.recordingContext) {
      const contextAge = Date.now() - voiceSession.recordingContext.startedAt;

      if (contextAge > VOICE_SESSION_CONFIG.STALE_CONTEXT_THRESHOLD_MS) {
        console.warn('[Voice Mode] Stale recording context (', contextAge, 'ms) - clearing and proceeding');
        voiceSession.recordingContext = null;
        if (voiceSession.recordingContextTimeout) {
          clearTimeout(voiceSession.recordingContextTimeout);
          voiceSession.recordingContextTimeout = null;
        }
      } else {
        // Still fresh, block to prevent context corruption
        voiceSession.telemetry.ignoredPendingNote++;
        console.log('[Voice Mode] Ignored speech - context age:', contextAge, 'ms (< 2s threshold)');
        return;
      }
    }

    const confidence = event.data?.confidence ?? 0;
    const latencyMs = event.data?.latencyMs ?? 0;
    console.log(
      '[Voice Mode] Speech detected (confidence:',
      confidence.toFixed(3),
      'latency:',
      latencyMs.toFixed(1),
      'ms)'
    );

    clearVoiceResumeTimer();

    // CRITICAL: Capture recording context atomically at speech_start
    const currentTabId = voiceSession.tabId;
    let currentVideoContext = tabManager ? tabManager.getVideoContext(currentTabId) : null;

    // Validate we have a video context - if not, try to hydrate it
    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Voice Mode] No video context for current tab, attempting refresh');
      currentVideoContext = await ensureVideoContextForTab(currentTabId);
    }

    if (!currentVideoContext || !currentVideoContext.videoDbId) {
      console.log('[Voice Mode] Still no video context after refresh, skipping speech segment');
      voiceSession.telemetry.ignoredNoContext++;
      return;
    }

    console.log('[Voice Mode] Captured recording context:', {
      tabId: currentTabId,
      videoDbId: currentVideoContext.videoDbId,
      video: currentVideoContext.title || currentVideoContext.videoId,
    });

    // Capture timestamp from the CURRENT tab
    let capturedTimestamp = null;
    if (!chrome?.runtime?.id) {
      console.log('[Voice Mode] Extension context invalidated, skipping timestamp capture');
    } else {
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(currentTabId, { action: 'get_timestamp' }),
          new Promise((resolve) => setTimeout(() => resolve({ success: false }), 1000)),
        ]);

        if (response && response.success && response.timestamp != null) {
          capturedTimestamp = response.timestamp;
          console.log('[Voice Mode] Captured timestamp:', capturedTimestamp);
        }
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          console.log('[Voice Mode] Extension context invalidated during timestamp capture');
        } else {
          console.log('[Voice Mode] Failed to capture timestamp:', err.message);
        }
      }
    }

    // Store the complete recording context (frozen for this utterance)
    voiceSession.recordingContext = createRecordingContext(
      currentTabId,
      currentVideoContext,
      capturedTimestamp,
      { wasPlaying: false }
    );

    voiceSession.status = 'recording';
    voiceSession.lastStartAt = now;
    voiceSession.telemetry.speechDetections++;
    voiceSession.telemetry.lastConfidence = confidence;
    voiceSession.telemetry.lastLatencyMs = latencyMs;

    if (voiceSession.settings.autoPauseVideo) {
      const pauseResult = await requestVoicePause(currentTabId);
      voiceSession.recordingContext.autoPause = pauseResult;
    }

    // Clear first speech timeout on first detection
    if (voiceSession.firstSpeechTimeout) {
      clearTimeout(voiceSession.firstSpeechTimeout);
      voiceSession.firstSpeechTimeout = null;
      console.log('[Voice Mode] First speech detected - cleared auto-stop timeout');
    }

    // Send timestamp to backend via persistent channel
    if (voiceSession.audioChannel && capturedTimestamp != null) {
      voiceSession.audioChannel
        .push('set_timestamp', { timestamp: capturedTimestamp })
        .receive('ok', () => {
          console.log('[Voice Mode] Timestamp sent to backend:', capturedTimestamp);
        })
        .receive('error', (err) => {
          console.error('[Voice Mode] Failed to send timestamp:', err);
        });
    }

    // Start recording in offscreen
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'start_recording',
      });
      console.log('[Voice Mode] Recording started successfully');
    } catch (error) {
      console.error('[Voice Mode] Failed to start recording:', error);
      if (voiceSession.recordingContext?.autoPause?.wasPlaying) {
        scheduleVoiceResume(currentTabId, true);
      }
      voiceSession.status = 'observing';
      voiceSession.recordingContext = null;
    }

    broadcastVoiceStatus();
  } else if (event.type === 'speech_end' && voiceSession.status === 'recording') {
    const duration = now - voiceSession.lastStartAt;
    const confidence = event.data?.confidence ?? voiceSession.telemetry.lastConfidence;
    const latencyMs = event.data?.latencyMs ?? voiceSession.telemetry.lastLatencyMs;
    const resumeInfo = extractResumeInfo(voiceSession.recordingContext);

    if (duration >= VAD_CONFIG.MIN_SPEECH_DURATION_MS) {
      console.log('[Voice Mode] Speech ended, duration:', duration, 'ms');

      // Transition immediately so UI reflects cooldown while transcription completes
      voiceSession.status = 'cooldown';
      broadcastVoiceStatus();

      // Stop recording in offscreen (may take time due to transcription)
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'stop_recording',
        });
        console.log('[Voice Mode] Recording stopped successfully');
      } catch (error) {
        console.error('[Voice Mode] Failed to stop recording:', error);
      }

      // Update telemetry
      const count = voiceSession.telemetry.speechDetections;
      if (count > 0) {
        voiceSession.telemetry.avgLatencyMs =
          (voiceSession.telemetry.avgLatencyMs * (count - 1) + latencyMs) / count;
      }
      voiceSession.telemetry.lastConfidence = confidence;
      voiceSession.telemetry.lastLatencyMs = latencyMs;

      // Enter cooldown - recording context is PRESERVED until note arrives
      setTimeout(() => {
        if (voiceSession.status === 'cooldown') {
          voiceSession.status = 'observing';
          console.log('[Voice Mode] Cooldown complete, resuming observation');
          broadcastVoiceStatus();
        }
      }, VOICE_SESSION_CONFIG.COOLDOWN_MS);

      // Set a safety timeout to clear stale context
      if (voiceSession.recordingContextTimeout) {
        clearTimeout(voiceSession.recordingContextTimeout);
      }
      voiceSession.recordingContextTimeout = setTimeout(() => {
        if (voiceSession.recordingContext) {
          const age = Date.now() - voiceSession.recordingContext.startedAt;
          console.warn('[Voice Mode] Recording context timeout after', age, 'ms - clearing');
          voiceSession.recordingContext = null;
          voiceSession.recordingContextTimeout = null;
        }
      }, VOICE_SESSION_CONFIG.RECORDING_CONTEXT_TIMEOUT_MS);

      scheduleVoiceResume(resumeInfo.tabId, resumeInfo.wasPlaying);
      // Broadcast once more to publish updated telemetry (status remains cooldown)
      broadcastVoiceStatus();
    } else {
      voiceSession.telemetry.ignoredShort++;
      console.log('[Voice Mode] Ignored short speech segment:', duration, 'ms');
      voiceSession.status = 'observing';
      // Clear recording context immediately for ignored segments
      voiceSession.recordingContext = null;
      if (voiceSession.recordingContextTimeout) {
        clearTimeout(voiceSession.recordingContextTimeout);
        voiceSession.recordingContextTimeout = null;
      }

      scheduleVoiceResume(resumeInfo.tabId, resumeInfo.wasPlaying);
      broadcastVoiceStatus();
    }
  } else if (event.type === 'error') {
    console.error('[Voice Mode] VAD error:', event.data);
    voiceSession.vadEnabled = false;
    voiceSession.status = 'error';
    voiceSession.circuitBreaker.state = 'open';

    // Clear recording context on error
    if (voiceSession.recordingContext) {
      voiceSession.recordingContext = null;
    }
    if (voiceSession.recordingContextTimeout) {
      clearTimeout(voiceSession.recordingContextTimeout);
      voiceSession.recordingContextTimeout = null;
    }

    stopVoiceSession();
    broadcastVoiceStatus({ errorMessage: event.data?.message });
  }
}

/**
 * Start voice mode session
 * Creates persistent audio channel and starts VAD
 */
export async function startVoiceSession() {
  console.log('[Voice Mode] Starting voice session');

  try {
    // Get active tab for video context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab');
    }

    voiceSession.tabId = tab.id;

    // Ensure offscreen document exists
    await createOffscreenDocument();

    // Create persistent socket and audio channel
    console.log('[Voice Mode] Creating persistent audio channel');
    voiceSession.sessionId = crypto.randomUUID();
    voiceSession.socket = new SocketConstructor('ws://localhost:4000/socket', {
      params: {},
    });
    voiceSession.socket.connect();

    // Get video context from TabManager
    const videoContext = tabManager ? tabManager.getVideoContext(tab.id) : null;

    // Create audio channel with video context
    voiceSession.audioChannel = voiceSession.socket.channel(
      `audio:${voiceSession.sessionId}`,
      {
        video_id: videoContext?.videoDbId,
        voice_mode: true,
      }
    );

    // Listen for note_created events on the persistent channel
    voiceSession.audioChannel.on('note_created', (payload) => {
      console.log('[Voice Mode] Received structured note:', payload.id);
      voiceSession.telemetry.notesCreated += 1;

      // CRITICAL: Route timeline marker to the tab where recording started
      const targetTabId = voiceSession.recordingContext?.tabId || voiceSession.tabId;

      if (targetTabId) {
        console.log('[Voice Mode] Routing timeline marker to recording tab:', targetTabId);
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
        console.warn('[Voice Mode] No target tab for timeline marker, note:', payload.id);
      }

      // Clear recording context now that note has been delivered
      if (voiceSession.recordingContext) {
        console.log('[Voice Mode] Clearing recording context after note delivery');
        voiceSession.recordingContext = null;

        if (voiceSession.recordingContextTimeout) {
          clearTimeout(voiceSession.recordingContextTimeout);
          voiceSession.recordingContextTimeout = null;
        }
      }

      broadcastVoiceStatus();
    });

    // Join the persistent channel
    await new Promise((resolve, reject) => {
      voiceSession.audioChannel
        .join()
        .receive('ok', () => {
          console.log('[Voice Mode] Persistent audio channel joined');
          resolve();
        })
        .receive('error', (err) => {
          console.error('[Voice Mode] Failed to join audio channel:', err);
          reject(err);
        });
    });

    voiceSession.vadConfig = {
      minSpeechDurationMs: VAD_CONFIG.MIN_SPEECH_DURATION_MS,
      minSilenceDurationMs: VAD_CONFIG.MIN_SILENCE_DURATION_MS,
      sileroConfidence: VAD_CONFIG.START_THRESHOLD,
      sileroNegativeThreshold: VAD_CONFIG.END_THRESHOLD,
    };

    // Start VAD in offscreen
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_vad',
      config: voiceSession.vadConfig,
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
    }, VOICE_SESSION_CONFIG.HEARTBEAT_INTERVAL_MS);

    voiceSession.vadEnabled = true;
    voiceSession.status = 'observing';
    resetVoiceTelemetry();
    broadcastVoiceStatus();
    console.log('[Voice Mode] Session active with persistent audio channel');

    // Auto-start behavior: Stop session if no speech detected
    voiceSession.firstSpeechTimeout = setTimeout(async () => {
      if (voiceSession.telemetry.speechDetections === 0) {
        console.log('[Voice Mode] No speech detected in first', VOICE_SESSION_CONFIG.FIRST_SPEECH_TIMEOUT_MS / 1000, 'seconds - auto-stopping');
        await stopVoiceSession();
      }
    }, VOICE_SESSION_CONFIG.FIRST_SPEECH_TIMEOUT_MS);
  } catch (error) {
    console.error('[Voice Mode] Failed to start session:', error);
    // Clean up on error
    if (voiceSession.audioChannel) {
      voiceSession.audioChannel.leave();
      voiceSession.audioChannel = null;
    }
    if (voiceSession.socket) {
      voiceSession.socket.disconnect();
      voiceSession.socket = null;
    }
    throw error;
  }
}

/**
 * Stop voice mode session
 * Tears down persistent audio channel and cleans up resources
 */
export async function stopVoiceSession() {
  console.log('[Voice Mode] Stopping voice session');

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
    console.log('[Voice Mode] Could not stop VAD (offscreen may be gone):', err.message);
  }

  // Tear down persistent audio channel
  if (voiceSession.audioChannel) {
    console.log('[Voice Mode] Leaving persistent audio channel');
    voiceSession.audioChannel.leave();
    voiceSession.audioChannel = null;
  }

  if (voiceSession.socket) {
    console.log('[Voice Mode] Disconnecting persistent socket');
    voiceSession.socket.disconnect();
    voiceSession.socket = null;
  }

  // Clear recording context to prevent stale routing
  if (voiceSession.recordingContext) {
    console.log('[Voice Mode] Clearing stale recording context');
    voiceSession.recordingContext = null;
  }

  // Clear any pending timeouts
  if (voiceSession.recordingContextTimeout) {
    clearTimeout(voiceSession.recordingContextTimeout);
    voiceSession.recordingContextTimeout = null;
  }

  if (voiceSession.firstSpeechTimeout) {
    clearTimeout(voiceSession.firstSpeechTimeout);
    voiceSession.firstSpeechTimeout = null;
  }

  clearVoiceResumeTimer();

  voiceSession.vadEnabled = false;
  voiceSession.status = 'idle';
  voiceSession.tabId = null;
  voiceSession.sessionId = null;
  voiceSession.circuitBreaker.state = 'closed';
  voiceSession.circuitBreaker.restartCount = 0;
  voiceSession.heartbeatFailures = 0;
  voiceSession.vadConfig = null;
  broadcastVoiceStatus();
  console.log('[Voice Mode] Session stopped and cleaned up');
}
