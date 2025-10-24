// Extension Side Panel JavaScript (extension/src/sidepanel/)
//
// Purpose: Client-side UI for extension side panel
//
// Architecture (Sprint 12):
// - Service Worker: Audio streaming via AudioChannel (chrome.runtime + Phoenix Channel)
// - Sidepanel: Notes subscription via NotesChannel (Phoenix Channel direct)
// - Chrome APIs: Tab management, recording controls, storage
//
// Data Flow:
// - Audio: Mic → Service Worker → AudioChannel → Phoenix → AgentSession
// - Notes: AgentSession → PubSub → NotesChannel → Sidepanel (this file)

import { getVoiceModeEnabled, setVoiceModeEnabled } from '../shared/settings.js';
import db from '../shared/db.js';

// Sprint 12: Phoenix Socket for direct notes subscription
import { Socket } from 'phoenix';

console.log('Side panel loaded');

let isRecording = false;
let currentVideoContext = null;
let displayedVideoDbId = null; // Track which video's notes are currently displayed
let loadingSessionId = 0; // Increment this to invalidate in-flight note requests
const notesCache = new Map(); // Persist notes per video to avoid flicker on reloads
const transcriptsClearDelayMs = 250;
let scheduledTranscriptClear = null;

const MAX_CACHED_NOTES_PER_VIDEO = 500;
const MAX_TOTAL_CACHED_NOTES = 5000;
const MAX_CACHED_VIDEOS = 200;

function normalizeNoteForCache(note, offset = 0) {
  if (!note) return null;
  const cachedAt = note.cached_at ?? Date.now() - offset;
  return {
    ...note,
    cached_at: cachedAt,
  };
}

async function persistNoteToIndexedDb(note) {
  if (!note?.id) return;

  try {
    await db.notes.put(note);
  } catch (err) {
    console.error('[IndexedDB] Failed to persist note:', err);
  }
}

async function replaceVideoNotesInIndexedDb(videoDbId, notes) {
  try {
    await db.transaction('rw', db.notes, async () => {
      await db.notes.where('video_id').equals(videoDbId).delete();
      if (notes.length > 0) {
        await db.notes.bulkPut(notes);
      }
    });
    enforceNoteLimits(videoDbId);
  } catch (err) {
    console.error('[IndexedDB] Failed to replace notes for video:', videoDbId, err);
  }
}

async function removeNoteFromIndexedDb(noteId) {
  if (!noteId) return;

  try {
    await db.notes.delete(noteId);
  } catch (err) {
    console.error('[IndexedDB] Failed to delete note:', noteId, err);
  }
}

async function loadNotesFromIndexedDb(videoDbId) {
  if (!videoDbId) return [];

  try {
    const stored = await db.notes.where('video_id').equals(videoDbId).toArray();
    return stored.sort((a, b) => (b.cached_at || 0) - (a.cached_at || 0));
  } catch (err) {
    console.error('[IndexedDB] Failed to load cached notes:', videoDbId, err);
    return [];
  }
}

function removeNoteFromMemoryCache(noteId, videoDbId) {
  if (videoDbId && notesCache.has(videoDbId)) {
    const filtered = notesCache.get(videoDbId).filter((note) => note.id !== noteId);
    notesCache.set(videoDbId, filtered);
    return;
  }

  for (const [vid, noteList] of notesCache.entries()) {
    const index = noteList.findIndex((note) => note.id === noteId);
    if (index >= 0) {
      const updated = [...noteList.slice(0, index), ...noteList.slice(index + 1)];
      notesCache.set(vid, updated);
      break;
    }
  }
}

async function pruneNotesForVideo(videoDbId) {
  const cached = notesCache.get(videoDbId);
  if (!cached || cached.length <= MAX_CACHED_NOTES_PER_VIDEO) {
    return;
  }

  const sorted = [...cached].sort((a, b) => (b.cached_at || 0) - (a.cached_at || 0));
  const keep = sorted.slice(0, MAX_CACHED_NOTES_PER_VIDEO);
  const toRemove = sorted.slice(MAX_CACHED_NOTES_PER_VIDEO);

  notesCache.set(videoDbId, keep);

  try {
    await db.notes.bulkDelete(toRemove.map((note) => note.id));
    console.log('[IndexedDB] Pruned', toRemove.length, 'notes for video', videoDbId);
  } catch (err) {
    console.error('[IndexedDB] Failed to prune notes for video:', videoDbId, err);
  }
}

async function pruneTotalNotes() {
  try {
    const count = await db.notes.count();
    if (count <= MAX_TOTAL_CACHED_NOTES) {
      return;
    }

    const overflow = count - MAX_TOTAL_CACHED_NOTES;
    const oldestNotes = await db.notes.orderBy('cached_at').limit(overflow).toArray();
    if (oldestNotes.length === 0) {
      return;
    }

    await db.notes.bulkDelete(oldestNotes.map((note) => note.id));

    oldestNotes.forEach((note) => {
      removeNoteFromMemoryCache(note.id, note.video_id);
    });

    console.log('[IndexedDB] Pruned', oldestNotes.length, 'oldest notes to enforce global limit');
  } catch (err) {
    console.error('[IndexedDB] Failed to prune global notes cache:', err);
  }
}

function enforceNoteLimits(videoDbId) {
  pruneNotesForVideo(videoDbId)
    .then(() => pruneTotalNotes())
    .catch((err) => {
      console.error('[IndexedDB] Failed to enforce note cache limits:', err);
    });
}

// Sprint 12: Phoenix connection for real-time notes
let notesSocket = null;
let notesChannel = null;
let pendingSubscription = null; // Video ID to subscribe to once socket connects

// Removed: Manual recording buttons (replaced by voice mode toggle in main UI)
// const recordBtn = document.getElementById('recordBtn');
// const pauseBtn = document.getElementById('pauseBtn');
// const waveformContainer = document.getElementById('waveformContainer');
const waveformContainerMain = document.getElementById('waveformContainerMain');
const statusEl = document.getElementById('status');
const transcriptsEl = document.getElementById('transcripts');
const videoTimestampEl = document.getElementById('videoTimestamp');

// Sprint 11: Transcription status elements (simplified for local-only)
const modeBadge = document.getElementById('modeBadge');
const timingInfo = document.getElementById('timingInfo');

// Sprint 10: Voice mode elements (Main UI)
const voiceStatusMain = document.getElementById('voiceStatusMain');
const voiceModeToggleMain = document.getElementById('voiceModeToggleMain');
const debugToggleBtn = document.getElementById('debugToggleBtn');
const voiceErrorMessage = document.getElementById('voiceErrorMessage');

// Sprint 10: Debug drawer elements
const debugDrawer = document.getElementById('debugDrawer');
const telemetrySpeech = document.getElementById('telemetrySpeech');
const telemetryShort = document.getElementById('telemetryShort');
const telemetryCooldown = document.getElementById('telemetryCooldown');
const telemetryLatency = document.getElementById('telemetryLatency');
const telemetryConfidence = document.getElementById('telemetryConfidence');
const telemetryRestarts = document.getElementById('telemetryRestarts');
const telemetryNotes = document.getElementById('telemetryNotes');
const telemetryUptime = document.getElementById('telemetryUptime');
const telemetryEventList = document.getElementById('telemetryEventList');
const telemetryCountersLabel = document.getElementById('telemetryCounters');
const refreshTelemetryBtn = document.getElementById('refreshTelemetryBtn');

// Initialize LiveWaveform
const waveformCanvas = document.getElementById('waveformCanvas');
let waveform = null;

// Telemetry buffering (WARN/ERROR feed)
const TELEMETRY_EVENT_LIMIT = 50;
const telemetryEventBuffer = [];
let telemetryCountersData = { warn: 0, error: 0 };
let telemetryHydrated = false;

updateTelemetryCountersLabel();

// LiveWaveform class (inline - will be bundled by webpack)
class LiveWaveform {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.options = {
      barWidth: options.barWidth || 3,
      barGap: options.barGap || 1,
      barColor: options.barColor || '#dc2626',
      height: options.height || 64,
      sensitivity: options.sensitivity || 1.2,
      fftSize: options.fftSize || 256,
      mode: options.mode || 'static',
      historySize: options.historySize || 60,
      ...options,
    };

    this.active = false;
    this.processing = false;
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.animationFrame = null;
    this.dataArray = null;
    this.history = [];
    this.mediaStream = null;

    this.setupCanvas();
  }

  setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = rect.width * dpr;
    this.canvas.height = this.options.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = this.options.height + 'px';

    this.ctx.scale(dpr, dpr);
  }

  async start() {
    if (this.active) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.options.fftSize;

      this.microphone = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.microphone.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);

      this.active = true;
      this.processing = false;
      this.history = [];

      this.draw();
    } catch (error) {
      console.error('Failed to start waveform:', error);
      throw error;
    }
  }

  stop() {
    if (!this.active) return;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.microphone) {
      this.microphone.disconnect();
      this.microphone = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.active = false;
    this.processing = false;

    this.clearCanvas();
  }

  setProcessing(processing) {
    this.processing = processing;
  }

  draw() {
    if (!this.active) return;

    this.animationFrame = requestAnimationFrame(() => this.draw());

    this.analyser.getByteFrequencyData(this.dataArray);

    this.clearCanvas();

    if (this.processing) {
      this.drawProcessingAnimation();
    } else if (this.options.mode === 'scrolling') {
      this.drawScrollingMode();
    } else {
      this.drawStaticMode();
    }
  }

  drawStaticMode() {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = this.options.height;

    const barCount = Math.floor(width / (this.options.barWidth + this.options.barGap));
    const step = Math.floor(this.dataArray.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const dataIndex = i * step;
      const value = this.dataArray[dataIndex] || 0;
      const barHeight = Math.max((value / 255) * height * this.options.sensitivity, 2);

      const x = i * (this.options.barWidth + this.options.barGap);
      const y = (height - barHeight) / 2;

      this.ctx.fillStyle = this.options.barColor;
      this.ctx.fillRect(x, y, this.options.barWidth, barHeight);
    }
  }

  drawScrollingMode() {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = this.options.height;

    const average = this.dataArray.reduce((sum, val) => sum + val, 0) / this.dataArray.length;
    const normalizedValue = average / 255;

    this.history.push(normalizedValue);
    if (this.history.length > this.options.historySize) {
      this.history.shift();
    }

    const barCount = Math.min(this.history.length, this.options.historySize);
    for (let i = 0; i < barCount; i++) {
      const value = this.history[barCount - 1 - i];
      const barHeight = Math.max(value * height * this.options.sensitivity, 2);

      const x = width - (i + 1) * (this.options.barWidth + this.options.barGap);
      const y = (height - barHeight) / 2;

      const opacity = 1 - (i / barCount) * 0.5;
      this.ctx.fillStyle = this.hexToRgba(this.options.barColor, opacity);
      this.ctx.fillRect(x, y, this.options.barWidth, barHeight);
    }
  }

  drawProcessingAnimation() {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = this.options.height;

    const time = Date.now() / 1000;
    const barCount = Math.floor(width / (this.options.barWidth + this.options.barGap));

    for (let i = 0; i < barCount; i++) {
      const barHeight = (Math.sin(time * 3 + i * 0.5) * 0.5 + 0.5) * height * 0.3;

      const x = i * (this.options.barWidth + this.options.barGap);
      const y = (height - barHeight) / 2;

      this.ctx.fillStyle = this.options.barColor;
      this.ctx.fillRect(x, y, this.options.barWidth, barHeight);
    }
  }

  clearCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, this.options.height);
  }

  hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

// Removed: Manual recording button and toggleRecording function (replaced by voice mode toggle in main UI)
// recordBtn.addEventListener('click', toggleRecording);
// pauseBtn.addEventListener('click', toggleRecording);

// Sprint 10: Debug drawer toggle button
debugToggleBtn.addEventListener('click', () => {
  toggleDebugDrawer();
});

if (refreshTelemetryBtn) {
  refreshTelemetryBtn.addEventListener('click', () => {
    fetchTelemetryHistory(TELEMETRY_EVENT_LIMIT);
  });
}

// Sprint 10: Voice mode toggle (Main UI)
voiceModeToggleMain.addEventListener('click', async () => {
  const isActive = voiceModeToggleMain.classList.contains('active');

  if (isActive) {
    // Disable voice mode
    try {
      await chrome.runtime.sendMessage({ action: 'stop_voice_session' });
      voiceModeToggleMain.classList.remove('active');
      updateVoiceStatus('idle');

      // Sprint 10: Persist state to chrome.storage
      await setVoiceModeEnabled(false);
      console.log('[Voice Mode] Voice mode disabled and saved to storage');
    } catch (err) {
      console.error('[Voice Mode] Failed to stop voice session:', err);
    }
  } else {
    // Enable voice mode
    try {
      await chrome.runtime.sendMessage({ action: 'start_voice_session' });
      voiceModeToggleMain.classList.add('active');
      updateVoiceStatus('observing');

      // Sprint 10: Persist state to chrome.storage
      await setVoiceModeEnabled(true);
      console.log('[Voice Mode] Voice mode enabled and saved to storage');
    } catch (err) {
      console.error('[Voice Mode] Failed to start voice session:', err);

      // Sprint 10: Show error in UI
      voiceModeToggleMain.classList.remove('active');
      updateVoiceStatus('error', null, err.message || 'Failed to start voice mode');

      // Don't persist the enabled state since it failed
      await setVoiceModeEnabled(false);
    }
  }
});

// Sprint 10: Toggle debug drawer visibility
function toggleDebugDrawer() {
  const isVisible = debugDrawer.classList.contains('visible');
  if (isVisible) {
    debugDrawer.classList.remove('visible');
    debugDrawer.classList.add('hidden');
  } else {
    debugDrawer.classList.remove('hidden');
    debugDrawer.classList.add('visible');
    hydrateTelemetryIfNeeded();
  }
}

// Sprint 10: Update voice mode status chip
function updateVoiceStatus(status, telemetry = null, errorMessage = null) {
  voiceStatusMain.className = `voice-status ${status}`;
  voiceStatusMain.textContent = status.charAt(0).toUpperCase() + status.slice(1);

  // Update telemetry if provided
  if (telemetry) {
    telemetrySpeech.textContent = telemetry.speechDetections || 0;
    telemetryShort.textContent = telemetry.ignoredShort || 0;
    telemetryCooldown.textContent = telemetry.ignoredCooldown || 0;
    telemetryLatency.textContent = `${Math.round(telemetry.avgLatencyMs || 0)}ms`;
    telemetryConfidence.textContent = Number.parseFloat(telemetry.lastConfidence ?? 0).toFixed(2);
    telemetryRestarts.textContent = telemetry.restartAttempts || 0;
    telemetryNotes.textContent = telemetry.notesCreated || 0;
    telemetryUptime.textContent = telemetry.uptime || '0s';
  }

  // Sprint 10: Show/hide error message
  if (status === 'error' && errorMessage) {
    voiceErrorMessage.textContent = getUserFriendlyErrorMessage(errorMessage);
    voiceErrorMessage.classList.remove('hidden');
  } else {
    voiceErrorMessage.classList.add('hidden');
  }

  // Update waveform visualization based on voice mode status
  if (status === 'observing' || status === 'recording' || status === 'cooldown') {
    // Start waveform when voice mode is active
    startWaveformVisualization();
  } else {
    // Stop waveform when voice mode is idle or error
    stopWaveformVisualization();
  }
}

// Sprint 10: Convert technical error messages to user-friendly ones
function getUserFriendlyErrorMessage(errorMessage) {
  const msg = errorMessage.toLowerCase();

  if (msg.includes('permission') || msg.includes('denied') || msg.includes('notallowed')) {
    return 'Microphone permission denied. Please allow microphone access and try again.';
  }

  if (msg.includes('notfound') || msg.includes('no device')) {
    return 'No microphone found. Please connect a microphone and try again.';
  }

  if (msg.includes('audiocontext') || msg.includes('webaudio')) {
    return 'Audio system unavailable. Your browser may not support this feature.';
  }

  if (msg.includes('onnx') || msg.includes('silero')) {
    return 'VAD initialization failed. Try disabling "Silero Boost" in debug drawer.';
  }

  // Generic fallback
  return `VAD initialization failed: ${errorMessage}`;
}

function hydrateTelemetryIfNeeded() {
  if (telemetryHydrated) {
    return;
  }
  fetchTelemetryHistory(TELEMETRY_EVENT_LIMIT);
}

async function fetchTelemetryHistory(limit = TELEMETRY_EVENT_LIMIT) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'get_telemetry_events',
      limit,
    });

    if (response?.events) {
      telemetryEventBuffer.length = 0;
      response.events.forEach((event) => telemetryEventBuffer.push(event));
      telemetryEventBuffer.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      trimTelemetryBuffer();
      renderTelemetryEvents();
    }

    if (response?.counters) {
      telemetryCountersData = {
        warn: response.counters.warn ?? telemetryCountersData.warn ?? 0,
        error: response.counters.error ?? telemetryCountersData.error ?? 0,
      };
      updateTelemetryCountersLabel();
    }

    telemetryHydrated = true;
  } catch (error) {
    console.error('[Telemetry] Failed to fetch telemetry history:', error);
  }
}

function handleIncomingTelemetryEvent(event) {
  if (!event || !event.id) {
    return;
  }

  appendTelemetryEvent(event);

  if (event.level && telemetryCountersData[event.level] != null) {
    telemetryCountersData[event.level] += 1;
    updateTelemetryCountersLabel();
  }

  telemetryHydrated = true;
}

function appendTelemetryEvent(event) {
  if (telemetryEventBuffer.some((existing) => existing.id === event.id)) {
    return;
  }

  telemetryEventBuffer.push(event);
  telemetryEventBuffer.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  trimTelemetryBuffer();
  renderTelemetryEvents();
}

function trimTelemetryBuffer() {
  const excess = telemetryEventBuffer.length - TELEMETRY_EVENT_LIMIT;
  if (excess > 0) {
    telemetryEventBuffer.splice(0, excess);
  }
}

function renderTelemetryEvents() {
  if (!telemetryEventList) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const eventsToRender = [...telemetryEventBuffer].reverse(); // newest first

  eventsToRender.forEach((event) => {
    const li = document.createElement('li');
    li.className = `telemetry-event level-${event.level ?? 'warn'}`;

    const levelClass = event.level === 'error' ? 'error' : 'warn';
    const timestamp = formatTelemetryTimestamp(event.timestamp);
    const sourceLabel = event.source ? event.source : 'extension';
    const message = formatTelemetryMessage(event);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'telemetry-event-meta';

    const levelSpan = document.createElement('span');
    levelSpan.className = `telemetry-event-level ${levelClass}`;
    levelSpan.textContent = (event.level || 'warn').toUpperCase();

    const contextSpan = document.createElement('span');
    contextSpan.className = 'telemetry-event-context';
    contextSpan.textContent = event.context || 'unknown';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'telemetry-event-time';
    timeSpan.textContent = timestamp;

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'telemetry-event-source';
    sourceSpan.textContent = sourceLabel;

    metaDiv.append(levelSpan, contextSpan, timeSpan, sourceSpan);

    const messageDiv = document.createElement('div');
    messageDiv.className = 'telemetry-event-message';
    messageDiv.textContent = message;

    li.append(metaDiv, messageDiv);

    fragment.appendChild(li);
  });

  telemetryEventList.replaceChildren(fragment);
}

function updateTelemetryCountersLabel() {
  if (!telemetryCountersLabel) {
    return;
  }

  const warnCount = telemetryCountersData.warn ?? 0;
  const errorCount = telemetryCountersData.error ?? 0;
  telemetryCountersLabel.textContent = `${warnCount} warn · ${errorCount} error`;
}

function formatTelemetryTimestamp(timestamp) {
  if (!timestamp) {
    return '--:--:--';
  }

  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (_err) {
    return String(timestamp);
  }
}

function formatTelemetryMessage(event) {
  if (!event || !event.payload) {
    return 'No additional details.';
  }

  const parts = [];
  const { payload } = event;

  if (payload.error) {
    const errorInfo = payload.error;
    const name = errorInfo.name || 'Error';
    const message = errorInfo.message || 'Unknown error';
    parts.push(`${name}: ${message}`);

    if (errorInfo.stack) {
      const firstLine = String(errorInfo.stack).split('\n')[0];
      parts.push(firstLine);
    }
  }

  if (Array.isArray(payload.args) && payload.args.length > 0) {
    parts.push(payload.args.map(formatTelemetryValue).join(' '));
  }

  if (parts.length === 0) {
    parts.push('No additional details.');
  }

  return parts.join('\n');
}

function formatTelemetryValue(value) {
  if (value == null) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(formatTelemetryValue).join(', ')}]`;
  }

  if (typeof value === 'object') {
    if (value.type === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }
    if (value.type === 'symbol') {
      return `[Symbol ${value.description || ''}]`;
    }
    if (value.summary || value.description) {
      return `[${value.summary || 'Object'}] ${value.description || ''}`.trim();
    }

    try {
      return JSON.stringify(value);
    } catch (_error) {
      return '[Object]';
    }
  }

  return String(value);
}

// Waveform visualization control for voice mode
async function startWaveformVisualization() {
  if (waveform) {
    // Already running
    return;
  }

  try {
    console.log('[Waveform] Starting visualization for voice mode');
    waveform = new LiveWaveform(waveformCanvas, {
      barColor: '#dc2626',
      sensitivity: 1.2,
      mode: 'static',
      height: 48, // Compact size for main UI
    });
    await waveform.start();

    // Add recording class to show waveform
    if (waveformContainerMain) {
      waveformContainerMain.classList.add('is-recording');
    }

    console.log('[Waveform] Visualization started');
  } catch (error) {
    console.error('[Waveform] Failed to start:', error);
    // Don't fail voice mode if waveform fails - it's just visual feedback
  }
}

function stopWaveformVisualization() {
  if (!waveform) {
    // Already stopped
    return;
  }

  try {
    console.log('[Waveform] Stopping visualization');
    waveform.stop();
    waveform = null;

    // Remove recording class to hide waveform
    if (waveformContainerMain) {
      waveformContainerMain.classList.remove('is-recording');
    }

    console.log('[Waveform] Visualization stopped');
  } catch (error) {
    console.error('[Waveform] Failed to stop:', error);
  }
}

// Initialize side panel
async function init() {
  console.log('[SidePanel] Initializing...');

  // Update site title immediately
  updateSiteTitle();

  // Request initial timestamp immediately (in parallel with detection)
  // This ensures timecode appears as fast as notes
  console.log('[SidePanel] Requesting initial timestamp...');
  chrome.runtime
    .sendMessage({ action: 'get_video_timestamp' })
    .catch(() => console.log('[SidePanel] Could not get initial timestamp'));

  // Always trigger fresh detection to ensure content script is alive
  // This handles the case where cached context exists but content script is orphaned
  console.log('[SidePanel] Triggering fresh video detection...');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'trigger_video_detection' });

    if (result?.success) {
      console.log('[SidePanel] ✅ Video detection completed successfully');

      // Wait a moment for detection to complete, then get context
      setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
          if (response.context) {
            currentVideoContext = response.context;
            console.log('[SidePanel] ✅ Video context available:', currentVideoContext);
          } else {
            console.log('[SidePanel] No video detected on this page');
          }
        } catch (err) {
          console.log('[SidePanel] Could not get video context:', err);
        }
      }, 2000); // Increased to 2s to allow detection to complete
    } else {
      console.log('[SidePanel] Video detection not available on this page');
    }
  } catch (err) {
    console.log('[SidePanel] Could not trigger video detection:', err.message);

    // Fallback: try to get cached context anyway (might work if content script is alive)
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
      if (response.context) {
        currentVideoContext = response.context;
        console.log('[SidePanel] Using cached video context:', currentVideoContext);
      }
    } catch (err2) {
      console.error('[SidePanel] Failed to get any video context:', err2);
    }
  }
}

// Listen for transcripts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'transcript') {
    const noteVideoId = message.data.video_id;

    if (noteVideoId) {
      const cacheResult = storeNoteInCache(noteVideoId, message.data);

      if (noteVideoId === displayedVideoDbId) {
        console.log('[SidePanel] 📝 Adding transcript for video', noteVideoId);
        addTranscript(message.data, { skipCache: true });
      } else if (cacheResult.added) {
        console.log('[SidePanel] 💾 Cached transcript for inactive video', noteVideoId);
      }
    } else {
      console.log('[SidePanel] ⚠️ Transcript missing video ID, skipping cache');
    }
  }

  // Listen for focus_note messages (from timeline marker clicks)
  if (message.action === 'focus_note') {
    highlightNote(message.noteId);
  }

  // Listen for tab changes
  // Phase 3: Removed 100ms debounce - TabManager already deduplicates,
  // and the debounce was causing Phoenix channel subscription to race with note broadcasts
  if (message.action === 'tab_changed') {
    console.log('[SidePanel] 🔄 TAB_CHANGED: Processing tab', message.tabId);
    handleTabChanged(message.tabId, message.videoContext);
  }

  // Clear UI when content script initializes (new video loading)
  if (message.action === 'clear_ui') {
    console.log('[SidePanel] 🧹 CLEAR_UI: Preparing for new video');

    // Cancel any existing scheduled clear
    cancelScheduledTranscriptClear();

    // Mark as loading but preserve content (notes will be replaced by tab_changed)
    markTranscriptsLoading({ preserveContent: true });

    // Invalidate state - tab_changed will set these correctly
    currentVideoContext = null;
    displayedVideoDbId = null;
    loadingSessionId++; // Invalidate any in-flight requests
    console.log('[SidePanel] 🧹 Loading session ID incremented to', loadingSessionId);

    // Schedule a fallback clear in case tab_changed doesn't arrive
    // This prevents notes from being stuck in "loading" state when navigating away from video pages
    // The 1 second delay gives tab_changed time to arrive and cancel this
    scheduleTranscriptClear(1000);
  }
});

async function handleTabChanged(tabId, videoContext) {
  console.log('[SidePanel] 🔄 TAB_CHANGED: Tab', tabId, 'with context:', videoContext);

  const newVideoDbId = videoContext?.videoDbId;
  const previousVideoDbId = displayedVideoDbId;
  const isSameVideo = previousVideoDbId === newVideoDbId;

  // Update state
  currentVideoContext = videoContext;
  cancelScheduledTranscriptClear();

  // Update site title for the new tab
  updateSiteTitle();

  // Privacy protection: Stop recording when switching to non-video tabs
  // But keep recording across video-to-video tab changes (seamless multi-video notes)
  if (previousVideoDbId && !newVideoDbId) {
    const isVoiceActive = voiceModeToggleMain.classList.contains('active');
    if (isVoiceActive) {
      console.log('[Voice Mode] Stopping recording - switched from video to non-video tab');
      try {
        await chrome.runtime.sendMessage({ action: 'stop_voice_session' });
        voiceModeToggleMain.classList.remove('active');
        updateVoiceStatus('idle');
        await setVoiceModeEnabled(false);
      } catch (err) {
        console.error('[Voice Mode] Failed to stop session on tab change:', err);
      }
    }
  }

  // If switching to a tab with a video
  if (newVideoDbId) {
    let hadCachedNotes = false;

    if (!isSameVideo) {
      hadCachedNotes = await renderNotesFromCache(newVideoDbId);
      if (hadCachedNotes) {
        console.log('[SidePanel] ♻️ Restored cached notes for video', newVideoDbId);
      }

      displayedVideoDbId = newVideoDbId;
    } else {
      displayedVideoDbId = newVideoDbId;
      const cachedNotes = notesCache.get(newVideoDbId);
      hadCachedNotes = !!(cachedNotes && cachedNotes.length > 0);
    }

    // Sprint 12: Subscribe to Phoenix Channel for this video's notes
    subscribeToVideoNotes(newVideoDbId);

    // Request current timestamp for the newly active tab
    // This also serves as a liveness check for the content script
    console.log('[SidePanel] 🔄 Requesting timestamp for new active tab');
    try {
      const timestampResult = await chrome.runtime.sendMessage({ action: 'get_video_timestamp' });

      // If content script isn't responding (success: false), we have stale cached context
      // but no live content script - need to trigger fresh detection
      if (timestampResult && timestampResult.success === false) {
        console.log(
          '[SidePanel] ⚠️ Content script not responding despite cached context - triggering detection'
        );

        // Show detecting status
        videoTimestampEl.textContent = 'Video: Detecting...';

        // Trigger fresh detection to initialize content script
        const detectionResult = await chrome.runtime.sendMessage({
          action: 'trigger_video_detection',
        });

        if (detectionResult?.success) {
          console.log('[SidePanel] ✅ Detection complete after finding stale context');
          // Wait for detection, then request timestamp again
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: 'get_video_timestamp' })
              .catch(() =>
                console.log('[SidePanel] Still could not get timestamp after detection')
              );
          }, 2000);
        }
      }
    } catch (err) {
      console.log('[SidePanel] Could not get timestamp for new tab:', err);
    }

    // Phase 3 FIX: Notes are now loaded via Phoenix NotesChannel.get_notes
    // (called inside subscribeToVideoNotes above). The old request_notes_for_sidepanel
    // handler was removed in Sprint 12 and would cause loading states to hang.
    // No additional loading logic needed here.
  } else {
    // No cached video context - trigger fresh detection on this tab
    console.log('[SidePanel] 🔍 No cached context for tab, triggering fresh detection...');

    // Clear notes and timestamp while we detect
    clearTranscriptsImmediately();
    finalizeTranscriptRender();
    displayedVideoDbId = null;
    loadingSessionId++;
    videoTimestampEl.textContent = 'Video: Detecting...';
    videoTimestampEl.classList.remove('active');

    try {
      // Trigger detection on the newly active tab
      const result = await chrome.runtime.sendMessage({ action: 'trigger_video_detection' });

      if (result?.success) {
        console.log('[SidePanel] ✅ Video detection completed on new tab');

        // Wait a moment, then get context and timestamp
        setTimeout(async () => {
          try {
            // Request timestamp immediately
            chrome.runtime
              .sendMessage({ action: 'get_video_timestamp' })
              .catch(() => console.log('[SidePanel] Could not get timestamp'));

            // Get video context
            const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_context' });
            if (response.context) {
              currentVideoContext = response.context;
              const videoDbId = response.context.videoDbId;
              console.log(
                '[SidePanel] ✅ Video context now available for switched tab:',
                videoDbId
              );

              // Load notes for this video
              if (videoDbId) {
                displayedVideoDbId = videoDbId;
                loadingSessionId++;

                // Sprint 12: Subscribe to Phoenix Channel for notes (replaces service worker relay)
                subscribeToVideoNotes(videoDbId);
              }
            } else {
              console.log('[SidePanel] No video detected on this tab');
              videoTimestampEl.textContent = 'Video: No video detected';
            }
          } catch (err) {
            console.log('[SidePanel] Could not get context after detection:', err);
            videoTimestampEl.textContent = 'Video: No video detected';
          }
        }, 2000);
      } else {
        console.log('[SidePanel] Video detection not available on this tab');
        videoTimestampEl.textContent = 'Video: No video detected';
      }
    } catch (err) {
      console.log('[SidePanel] Could not trigger detection:', err.message);
      videoTimestampEl.textContent = 'Video: No video detected';
    }
  }
}

function storeNoteInCache(videoDbId, noteData) {
  if (!videoDbId || !noteData) {
    return { added: false, count: 0 };
  }

  const normalized = normalizeNoteForCache(noteData);
  Object.assign(noteData, normalized); // Ensure caller sees cached metadata

  const existing = notesCache.get(videoDbId) || [];
  const existingIndex = existing.findIndex((note) => note.id === normalized.id);

  if (existingIndex >= 0) {
    const updated = [...existing];
    updated[existingIndex] = { ...updated[existingIndex], ...normalized };
    notesCache.set(videoDbId, updated);
    persistNoteToIndexedDb(updated[existingIndex]);
    enforceNoteLimits(videoDbId);
    return { added: false, count: updated.length };
  }

  const updated = [normalized, ...existing];
  notesCache.set(videoDbId, updated);
  persistNoteToIndexedDb(normalized);
  enforceNoteLimits(videoDbId);
  return { added: true, count: updated.length };
}

async function renderNotesFromCache(videoDbId) {
  cancelScheduledTranscriptClear();
  let cachedNotes = notesCache.get(videoDbId);

  if (!cachedNotes) {
    cachedNotes = await loadNotesFromIndexedDb(videoDbId);

    if (cachedNotes.length > 0) {
      notesCache.set(videoDbId, cachedNotes);
    }
  }

  if (!cachedNotes || cachedNotes.length === 0) {
    clearTranscriptsImmediately();
    finalizeTranscriptRender();
    return false;
  }

  const fragment = document.createDocumentFragment();
  cachedNotes.forEach((note) => {
    fragment.appendChild(buildNoteElement(note));
  });

  transcriptsEl.replaceChildren(fragment);
  finalizeTranscriptRender();
  return true;
}

// Note: Manual recording mode removed - waveform now driven by voice mode
function updateUI() {
  if (isRecording) {
    if (waveformContainerMain) {
      waveformContainerMain.classList.add('is-recording');
    }
    statusEl.classList.add('connected');
  } else {
    if (waveformContainerMain) {
      waveformContainerMain.classList.remove('is-recording');
    }
    statusEl.classList.remove('connected');
  }
}

async function updateSiteTitle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.title) {
      statusEl.textContent = tab.title;
    } else {
      statusEl.textContent = 'No page';
    }
  } catch (err) {
    console.log('[SidePanel] Could not get tab title:', err);
    statusEl.textContent = 'Unknown page';
  }
}

function addTranscript(data, options = {}) {
  const { skipCache = false, prepend = true } = options;

  if (!skipCache && data.video_id) {
    storeNoteInCache(data.video_id, data);
  }

  const existing = transcriptsEl.querySelector(`[data-note-id="${data.id}"]`);
  if (existing) {
    console.log('[SidePanel] ℹ️ Note', data.id, 'already displayed, updating content');
    updateNoteElement(existing, data);
    return;
  }

  const noteDiv = buildNoteElement(data);

  if (prepend && transcriptsEl.firstChild) {
    transcriptsEl.insertBefore(noteDiv, transcriptsEl.firstChild);
  } else {
    transcriptsEl.appendChild(noteDiv);
  }

  finalizeTranscriptRender();
}

// Sprint 08: Refine note with visual context using GPT-4o Vision
async function refineNoteWithVision(noteId, timestamp, button, noteElement) {
  console.log('[SidePanel] Refining note with vision', noteId, 'at timestamp', timestamp);

  // Disable button and show progress
  button.disabled = true;
  button.textContent = 'Capturing...';
  button.classList.add('is-loading');

  try {
    // Request frame capture and GPT-4o Vision refinement
    const response = await chrome.runtime.sendMessage({
      action: 'refine_note_with_vision',
      noteId: noteId,
      timestamp: timestamp,
    });

    if (response?.success) {
      button.textContent = 'Refining...';

      // Update note text in UI with refined version
      if (response.refinedText) {
        const noteTextEl = noteElement.querySelector('.note-text');
        if (noteTextEl) {
          // Remove confidence display if it exists
          const confidenceEl = noteTextEl.querySelector('.note-confidence');
          if (confidenceEl) {
            confidenceEl.remove();
          }
          noteTextEl.textContent = response.refinedText;
          console.log('[SidePanel] ✅ Updated note text in UI:', response.refinedText);
        }
      }

      button.textContent = '✓ Refined';
      button.classList.remove('is-loading');
      button.classList.add('success');

      // Reset after 2 seconds
      setTimeout(() => {
        button.textContent = 'Refine with Vision';
        button.classList.remove('success');
        button.disabled = false;
      }, 2000);
    } else {
      throw new Error(response?.error || 'Failed to refine note');
    }
  } catch (error) {
    console.error('[SidePanel] Failed to refine note:', error);
    button.textContent = '✗ Failed';
    button.classList.remove('is-loading');
    button.classList.add('error');

    // Reset after 3 seconds
    setTimeout(() => {
      button.textContent = 'Refine with Vision';
      button.classList.remove('error');
      button.disabled = false;
    }, 3000);
  }
}

function buildNoteElement(data) {
  const noteDiv = document.createElement('div');
  noteDiv.className = 'note-item';
  noteDiv.dataset.noteId = data.id;

  if (data.timestamp_seconds != null) {
    noteDiv.dataset.timestamp = data.timestamp_seconds;
  }

  // Add delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'note-delete';
  deleteBtn.innerHTML = '×';
  deleteBtn.title = 'Delete comment';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering note click
    deleteNote(data.id, data.video_id, noteDiv);
  });

  // Sprint 08: Add Refine with Vision button
  const refineBtn = document.createElement('button');
  refineBtn.className = 'note-clarify';
  refineBtn.textContent = 'Refine with Vision';
  refineBtn.title = 'Refine comment using GPT-4o Vision analysis of video frame';
  refineBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering note click
    refineNoteWithVision(data.id, data.timestamp_seconds, refineBtn, noteDiv);
  });

  const categoryDiv = document.createElement('div');
  categoryDiv.className = 'note-category';
  categoryDiv.textContent = data.category || 'note';

  let timestampDiv = null;
  if (data.timestamp_seconds != null) {
    timestampDiv = document.createElement('div');
    timestampDiv.className = 'note-timestamp';
    timestampDiv.textContent = formatTimestamp(data.timestamp_seconds);
  }

  const textP = document.createElement('div');
  textP.className = 'note-text';
  textP.textContent = data.text;

  if (data.confidence != null) {
    const confidenceDiv = document.createElement('div');
    confidenceDiv.className = 'note-confidence';
    confidenceDiv.textContent = `Confidence: ${Math.round(data.confidence * 100)}%`;
    textP.appendChild(confidenceDiv);
  }

  noteDiv.appendChild(deleteBtn);
  noteDiv.appendChild(refineBtn);
  noteDiv.appendChild(categoryDiv);
  if (timestampDiv) {
    noteDiv.appendChild(timestampDiv);
  }
  noteDiv.appendChild(textP);

  if (data.timestamp_seconds != null) {
    noteDiv.style.cursor = 'pointer';
    noteDiv.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'note_clicked',
        timestamp: data.timestamp_seconds,
      });

      highlightNote(data.id);
    });
  }

  return noteDiv;
}

function deleteNote(noteId, videoId, noteElement) {
  console.log('[SidePanel] Deleting note', noteId);

  // Add deleting class for transition
  noteElement.classList.add('deleting');

  // Wait for transition to complete before removing
  setTimeout(async () => {
    // Remove from DOM
    noteElement.remove();
    updateTranscriptEmptyState();

    // Remove from cache
    if (videoId && notesCache.has(videoId)) {
      const cachedNotes = notesCache.get(videoId);
      const updatedNotes = cachedNotes.filter((note) => note.id !== noteId);
      notesCache.set(videoId, updatedNotes);
      console.log('[SidePanel] Removed note from cache, remaining:', updatedNotes.length);
    }
    await removeNoteFromIndexedDb(noteId);

    // Send delete request to backend
    try {
      await chrome.runtime.sendMessage({
        action: 'delete_note',
        noteId: noteId,
      });
      console.log('[SidePanel] Note deleted successfully');
    } catch (err) {
      console.error('[SidePanel] Failed to delete note:', err);
    }
  }, 200); // Match the CSS transition duration
}

function updateNoteElement(element, data) {
  if (data.timestamp_seconds != null) {
    element.dataset.timestamp = data.timestamp_seconds;
  } else if (element.dataset.timestamp) {
    delete element.dataset.timestamp;
  }

  const categoryEl = element.querySelector('.note-category');
  if (categoryEl) {
    categoryEl.textContent = data.category || 'note';
  }

  const textEl = element.querySelector('.note-text');
  if (textEl) {
    textEl.textContent = data.text;

    if (data.confidence != null) {
      let confidenceEl = textEl.querySelector('.note-confidence');
      if (!confidenceEl) {
        confidenceEl = document.createElement('div');
        confidenceEl.className = 'note-confidence';
        textEl.appendChild(confidenceEl);
      }
      confidenceEl.textContent = `Confidence: ${Math.round(data.confidence * 100)}%`;
    }
  }

  const timestampEl = element.querySelector('.note-timestamp');
  if (timestampEl) {
    if (data.timestamp_seconds != null) {
      timestampEl.textContent = formatTimestamp(data.timestamp_seconds);
    } else {
      timestampEl.remove();
    }
  }

  finalizeTranscriptRender();
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function highlightNote(noteId) {
  // Remove previous highlights
  document.querySelectorAll('.note-item').forEach((el) => {
    el.classList.remove('highlighted');
  });

  // Highlight selected note
  const noteEl = document.querySelector(`[data-note-id="${noteId}"]`);
  if (noteEl) {
    noteEl.classList.add('highlighted');
    noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Remove highlight after 2 seconds
    setTimeout(() => {
      noteEl.classList.remove('highlighted');
    }, 2000);
  }
}

// Listen for timestamp updates (push-based, no polling)
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'video_timestamp_update') {
    // Check if timecode is unavailable (e.g., YouTube Shorts lazy-loading)
    if (message.timecodeUnavailable) {
      videoTimestampEl.textContent = 'Video: Timecode Unavailable';
      videoTimestampEl.classList.add('active');
      videoTimestampEl.classList.add('unavailable');
    } else if (message.timestamp != null) {
      videoTimestampEl.textContent = `Video: ${formatTimestamp(message.timestamp)}`;
      videoTimestampEl.classList.add('active');
      videoTimestampEl.classList.remove('unavailable');
    } else {
      videoTimestampEl.textContent = 'Video: No video detected';
      videoTimestampEl.classList.remove('active');
      videoTimestampEl.classList.remove('unavailable');
    }
  }
});

// Listen for tab updates to refresh site title
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only update if the title changed and this is the active tab
  if (changeInfo.title && tab.active) {
    updateSiteTitle();
  }
});

// Open persistent connection to notify service worker that panel is open
// This allows the service worker to track panel state and notify content scripts
const panelPort = chrome.runtime.connect({ name: 'sidepanel' });
console.log('[SidePanel] Opened connection to service worker');

panelPort.onMessage.addListener((message) => {
  if (message?.action === 'telemetry_event' && message.event) {
    handleIncomingTelemetryEvent(message.event);
  }
});

// Handle port disconnection (if needed in the future)
panelPort.onDisconnect.addListener(() => {
  console.log('[SidePanel] Port disconnected');
});

// Initialize
init();
updateUI();
updateTranscriptEmptyState();

function markTranscriptsLoading(options = {}) {
  const { preserveContent = false } = options;
  transcriptsEl.classList.add('is-loading');
  transcriptsEl.classList.remove('is-empty');

  if (!preserveContent) {
    transcriptsEl.replaceChildren();
    updateTranscriptEmptyState();
  }
}

function finalizeTranscriptRender() {
  transcriptsEl.classList.remove('is-loading');
  cancelScheduledTranscriptClear();
  updateTranscriptEmptyState();
}

function scheduleTranscriptClear(delay = transcriptsClearDelayMs) {
  cancelScheduledTranscriptClear();
  scheduledTranscriptClear = setTimeout(() => {
    transcriptsEl.replaceChildren();
    transcriptsEl.classList.remove('is-loading');
    updateTranscriptEmptyState();
    scheduledTranscriptClear = null;
  }, delay);
}

function cancelScheduledTranscriptClear() {
  if (scheduledTranscriptClear) {
    clearTimeout(scheduledTranscriptClear);
    scheduledTranscriptClear = null;
  }
}

function clearTranscriptsImmediately() {
  cancelScheduledTranscriptClear();
  transcriptsEl.replaceChildren();
  updateTranscriptEmptyState();
}

function updateTranscriptEmptyState() {
  const isEmpty = transcriptsEl.childElementCount === 0;
  transcriptsEl.classList.toggle('is-empty', isEmpty);
}

// Sprint 11: No mode management needed - always local-only
// timingInfo is set in HTML to "Local-only (WebGPU or WASM)"

// Listen for transcription status updates from service worker/offscreen
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'transcription_status') {
    updateTranscriptionStatus(message);
  }
});

// Sprint 10: Listen for voice mode status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'voice_status_update') {
    updateVoiceStatus(message.status, message.telemetry, message.errorMessage);

    // If error occurred, disable the toggle
    if (message.status === 'error') {
      voiceModeToggleMain.classList.remove('active');
      setVoiceModeEnabled(false).catch((err) => {
        console.error('[Voice Mode] Failed to update persisted state:', err);
      });
    }
  }
});

function updateTranscriptionStatus(status) {
  const { source, device, timingMs, stage } = status;

  // Update badge based on source and device
  if (stage === 'started') {
    if (source === 'local') {
      if (device === 'webgpu') {
        modeBadge.textContent = 'LOCAL (WebGPU)';
        modeBadge.className = 'mode-badge local-webgpu';
      } else {
        modeBadge.textContent = 'LOCAL (WASM)';
        modeBadge.className = 'mode-badge local-wasm';
      }
      timingInfo.textContent = 'Transcribing locally...';
    } else if (source === 'cloud') {
      modeBadge.textContent = 'CLOUD';
      modeBadge.className = 'mode-badge cloud';
      timingInfo.textContent = 'Transcribing via cloud...';
    }
  } else if (stage === 'completed') {
    if (timingMs != null) {
      const timeSeconds = (timingMs / 1000).toFixed(2);
      timingInfo.textContent = `Completed in ${timeSeconds}s (${source})`;
    }

    // Reset badge after 3 seconds
    setTimeout(() => {
      modeBadge.textContent = 'INACTIVE';
      modeBadge.className = 'mode-badge inactive';
    }, 3000);
  } else if (stage === 'fallback') {
    modeBadge.textContent = 'CLOUD (FALLBACK)';
    modeBadge.className = 'mode-badge cloud';
    timingInfo.textContent = `Local failed, using cloud fallback`;
  }
}

// Sprint 10: Initialize voice mode on load
// Auto-start only if user previously enabled voice mode in settings
async function initVoiceMode() {
  console.log('[Voice Mode] Checking persisted voice mode preference');

  try {
    const isEnabled = await getVoiceModeEnabled();

    if (!isEnabled) {
      console.log('[Voice Mode] Voice mode disabled in storage – leaving idle');
      voiceModeToggleMain.classList.remove('active');
      updateVoiceStatus('idle');
      await setVoiceModeEnabled(false);
      return;
    }

    console.log('[Voice Mode] Voice mode previously enabled – awaiting user confirmation to start');
    voiceModeToggleMain.classList.add('active');
    updateVoiceStatus('idle');
    // Previous setting remains true so the toggle reflects state; user must click to actually start.
  } catch (err) {
    console.error('[Voice Mode] Failed to auto-start voice session:', err);
    voiceModeToggleMain.classList.remove('active');
    updateVoiceStatus('idle');
    await setVoiceModeEnabled(false);
  }
}

initVoiceMode();

// ============================================================================
// Sprint 12: Phoenix Socket for Real-Time Notes
// ============================================================================

/**
 * Initialize Phoenix Socket connection for notes subscription.
 * This runs independently from the service worker's AudioChannel connection.
 * Phase 3: Added reconnection handling to prevent silent failures.
 */
function initNotesSocket() {
  console.log('[Notes] Initializing Phoenix Socket...');

  notesSocket = new Socket('ws://localhost:4000/socket', {
    params: {}, // TODO: Add auth token when auth is implemented (Sprint TBD)
  });

  notesSocket.onOpen(() => {
    console.log('[Notes] ✅ Connected to Phoenix');

    // Phase 3: Handle pending subscription from when socket was connecting
    if (pendingSubscription) {
      console.log('[Notes] Processing pending subscription:', pendingSubscription);
      const videoId = pendingSubscription;
      pendingSubscription = null;
      subscribeToVideoNotes(videoId);
      return;
    }

    // Phase 3: Re-subscribe to current video on reconnect
    // This ensures notes continue flowing after network drops
    if (displayedVideoDbId && !notesChannel) {
      console.log('[Notes] Re-subscribing to video after reconnect:', displayedVideoDbId);
      subscribeToVideoNotes(displayedVideoDbId);
    }
  });

  notesSocket.onError((error) => {
    console.error('[Notes] ❌ Socket error:', error);
  });

  notesSocket.onClose(() => {
    console.log('[Notes] Socket closed, will auto-reconnect');
    // Phoenix Socket has built-in reconnection logic
  });

  notesSocket.connect();
}

/**
 * Subscribe to notes for a specific video.
 * Automatically leaves previous channel before joining new one.
 * Phase 3: Queues subscription if socket is still connecting.
 */
function subscribeToVideoNotes(videoDbId) {
  if (!videoDbId) {
    console.log('[Notes] No video ID, skipping subscription');
    return;
  }

  if (!notesSocket) {
    console.warn('[Notes] Socket not initialized, cannot subscribe');
    return;
  }

  // Phase 3: If socket is still connecting, queue the subscription
  if (!notesSocket.isConnected()) {
    console.log('[Notes] Socket not connected yet, queueing subscription for:', videoDbId);
    pendingSubscription = videoDbId;
    // The onOpen callback will pick this up and call subscribeToVideoNotes again
    return;
  }

  // Leave old channel if exists
  if (notesChannel) {
    console.log('[Notes] Leaving previous channel');
    notesChannel.leave();
    notesChannel = null;
  }

  // Join new video's channel
  console.log(`[Notes] Joining channel for video: ${videoDbId}`);
  notesChannel = notesSocket.channel(`notes:video:${videoDbId}`, {});

  // Listen for real-time note_created events
  notesChannel.on('note_created', (note) => {
    console.log('[Notes] 📝 Received real-time note:', note);

    storeNoteInCache(note.video_id, note);

    // Only append if we're still viewing this video
    if (displayedVideoDbId === note.video_id) {
      addTranscript(note, { skipCache: true });
    } else {
      console.log('[Notes] Ignoring note for different video:', note.video_id);
    }
  });

  // Join channel and load existing notes
  notesChannel
    .join()
    .receive('ok', async () => {
      console.log(`[Notes] ✅ Joined channel for video: ${videoDbId}`);

      // Load existing notes from backend
      notesChannel
        .push('get_notes', { video_id: videoDbId })
        .receive('ok', async ({ notes }) => {
          console.log(`[Notes] 📚 Loaded ${notes.length} existing notes`);

          const normalizedNotes = notes.map((note, index) => normalizeNoteForCache(note, index));
          notesCache.set(videoDbId, normalizedNotes);
          await replaceVideoNotesInIndexedDb(videoDbId, normalizedNotes);

          if (displayedVideoDbId === videoDbId) {
            await renderNotesFromCache(videoDbId);
          }
        })
        .receive('error', (err) => {
          console.error('[Notes] ❌ Failed to get notes:', err);
        });
    })
    .receive('error', (err) => {
      console.error('[Notes] ❌ Failed to join channel:', err);
    });
}

// Initialize Phoenix Socket on load
initNotesSocket();

// ============================================================================
// Sprint 09: Video Library Management
// ============================================================================

let currentSection = 'notes';
let videoLibraryCache = [];

function normalizeVideoForCache(video, offset = 0) {
  if (!video?.id) return null;
  const cachedAt = video.cached_at ?? Date.now() - offset;
  return {
    ...video,
    cached_at: cachedAt,
  };
}

async function loadVideosFromIndexedDb() {
  try {
    const stored = await db.videos.toArray();
    return stored.sort((a, b) => (b.cached_at || 0) - (a.cached_at || 0));
  } catch (err) {
    console.error('[IndexedDB] Failed to load cached videos:', err);
    return [];
  }
}

async function upsertVideosInIndexedDb(videos) {
  if (!videos || videos.length === 0) {
    return;
  }

  try {
    await db.videos.bulkPut(videos);
    enforceVideoLimits();
  } catch (err) {
    console.error('[IndexedDB] Failed to persist videos:', err);
  }
}

async function pruneVideoCacheIfNeeded() {
  try {
    const count = await db.videos.count();
    if (count <= MAX_CACHED_VIDEOS) {
      return;
    }

    const overflow = count - MAX_CACHED_VIDEOS;
    const oldestVideos = await db.videos.orderBy('cached_at').limit(overflow).toArray();
    if (oldestVideos.length === 0) {
      return;
    }

    await db.videos.bulkDelete(oldestVideos.map((video) => video.id));
    const idsToRemove = new Set(oldestVideos.map((video) => video.id));
    videoLibraryCache = videoLibraryCache.filter((video) => !idsToRemove.has(video.id));

    console.log('[IndexedDB] Pruned', oldestVideos.length, 'videos from cache');
  } catch (err) {
    console.error('[IndexedDB] Failed to prune video cache:', err);
  }
}

function enforceVideoLimits() {
  pruneVideoCacheIfNeeded().catch((err) => {
    console.error('[IndexedDB] Failed to enforce video cache limits:', err);
  });
}

// Get DOM elements for library
const tabNotesBtn = document.getElementById('tabNotes');
const tabLibraryBtn = document.getElementById('tabLibrary');
const notesSection = document.getElementById('notesSection');
const librarySection = document.getElementById('librarySection');
const videoSearch = document.getElementById('videoSearch');
const statusFilter = document.getElementById('statusFilter');
const platformFilter = document.getElementById('platformFilter');
const videoList = document.getElementById('videoList');

// Tab switching
tabNotesBtn.addEventListener('click', () => switchSection('notes'));
tabLibraryBtn.addEventListener('click', () => switchSection('library'));

function switchSection(section) {
  currentSection = section;

  // Update tab buttons
  tabNotesBtn.classList.toggle('active', section === 'notes');
  tabLibraryBtn.classList.toggle('active', section === 'library');

  // Update section visibility
  notesSection.classList.toggle('hidden', section !== 'notes');
  librarySection.classList.toggle('hidden', section !== 'library');

  // Load library data if switching to library
  if (section === 'library') {
    loadVideoLibrary();
  }
}

// Load video library from backend
async function loadVideoLibrary() {
  const filters = {
    status: statusFilter.value || undefined,
    platform: platformFilter.value || undefined,
    search: videoSearch.value || undefined,
  };

  console.log('[Library] Loading videos (cache-first) with filters:', filters);
  let renderedFromCache = false;

  const cachedVideos = await loadVideosFromIndexedDb();
  if (cachedVideos.length > 0) {
    const filteredCached = applyVideoFilters(cachedVideos, filters);
    videoLibraryCache = filteredCached;
    renderVideoLibrary(filteredCached);
    renderedFromCache = true;
    console.log('[Library] Rendered from IndexedDB cache, refreshing in background...');
  } else {
    videoList.innerHTML = '<div class="empty-state">Loading videos...</div>';
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'list_videos',
      filters,
    });

    if (response.error) {
      console.error('[Library] Failed to load videos:', response.error);
      if (!renderedFromCache) {
        videoList.innerHTML = '<div class="empty-state">Failed to load videos</div>';
      }
      return;
    }

    const incomingVideos = response.videos || [];
    const normalizedVideos = incomingVideos
      .map((video, index) => normalizeVideoForCache(video, index))
      .filter(Boolean);

    await upsertVideosInIndexedDb(normalizedVideos);

    videoLibraryCache = applyVideoFilters(normalizedVideos, filters);
    renderVideoLibrary(videoLibraryCache);
    console.log('[Library] Updated list after backend sync');
  } catch (error) {
    console.error('[Library] Error loading videos:', error);
    if (!renderedFromCache) {
      videoList.innerHTML = '<div class="empty-state">Failed to load videos</div>';
    }
  }
}

function applyVideoFilters(videos, filters) {
  return videos.filter((video) => {
    if (filters.status && video.status !== filters.status) {
      return false;
    }

    if (filters.platform && video.platform !== filters.platform) {
      return false;
    }

    if (filters.search) {
      const query = filters.search.toLowerCase();
      const title = video.title?.toLowerCase() || '';
      const url = video.url?.toLowerCase() || '';
      if (!title.includes(query) && !url.includes(query)) {
        return false;
      }
    }

    return true;
  });
}

// Render video library list
function renderVideoLibrary(videos) {
  if (videos.length === 0) {
    videoList.innerHTML = '<div class="empty-state">No videos found</div>';
    return;
  }

  videoList.innerHTML = videos
    .map((video) => {
      const statusClass = video.status.replace('_', '-');
      const statusLabel = video.status.replace('_', ' ');

      return `
      <div class="video-item"
           data-video-id="${video.id}"
           data-status="${video.status}"
           data-url="${video.url}">
        <div class="video-thumbnail" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 24px;">
          ${getPlatformIcon(video.platform)}
        </div>
        <div class="video-info">
          <div class="video-title">${escapeHtml(video.title || 'Untitled Video')}</div>
          <div class="video-meta">
            <span class="video-platform">${escapeHtml(video.platform)}</span>
            ${video.note_count > 0 ? `<span class="video-notes-count">${video.note_count} note${video.note_count !== 1 ? 's' : ''}</span>` : ''}
            <span class="video-status-badge ${statusClass}">${statusLabel}</span>
          </div>
        </div>
      </div>
    `;
    })
    .join('');

  // Attach click handlers
  videoList.querySelectorAll('.video-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      const url = e.currentTarget.dataset.url;
      console.log('[Library] Opening video:', url);
      chrome.tabs.create({ url });

      // Switch to Notes tab to show the video's notes
      switchSection('notes');
    });
  });
}

// Get platform icon emoji
function getPlatformIcon(platform) {
  const icons = {
    youtube: '▶️',
    vimeo: '🎬',
    frame_io: '🎞️',
    iconik: '📹',
  };
  return icons[platform] || '🎥';
}

// HTML escape helper
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Filter event listeners
statusFilter.addEventListener('change', loadVideoLibrary);
platformFilter.addEventListener('change', loadVideoLibrary);

// Search with debounce
let searchTimeout;
videoSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadVideoLibrary();
  }, 300);
});

// Listen for video updates from service worker
// (Assuming service worker forwards channel broadcasts to side panel)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'channel_broadcast') {
    if (message.event === 'video_updated' || message.event === 'video_queued') {
      // Refresh library if currently viewing
      if (currentSection === 'library') {
        loadVideoLibrary();
      }
    }
  }
});

console.log('[Library] Video library UI initialized');
