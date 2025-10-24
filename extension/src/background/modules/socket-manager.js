/**
 * Socket Manager Module
 *
 * Responsibilities:
 * - Phoenix socket connection management
 * - Video channel lifecycle (join/reuse)
 * - Broadcast listener setup
 * - Channel state tracking
 *
 * Dependencies (injected):
 * - Socket: Phoenix Socket constructor
 */

// Dependencies (will be injected via init)
let Socket = null;

// Socket and channel state
let socket = null;
let videoChannel = null;
let broadcastsSetUp = false;

/**
 * Initialize socket manager with dependencies
 */
export function initSocketManager(deps) {
  Socket = deps.Socket;
}

/**
 * Get or create socket connection
 */
export function getOrCreateSocket() {
  if (!socket || !socket.isConnected()) {
    console.log('[SocketManager] Creating new socket connection');
    socket = new Socket('ws://localhost:4000/socket', {
      params: {},
    });
    socket.connect();
  }
  return socket;
}

/**
 * Get or create video channel (joins if not already joined)
 */
export async function getOrCreateVideoChannel() {
  // Ensure socket is connected
  getOrCreateSocket();

  // Reuse existing channel if available
  if (videoChannel) {
    console.log('[SocketManager] Reusing existing video channel');
    return videoChannel;
  }

  // Create and join new video channel
  console.log('[SocketManager] Creating new video channel');
  videoChannel = socket.channel('video:meta', {});

  await new Promise((resolve, reject) => {
    videoChannel
      .join()
      .receive('ok', () => {
        console.log('[SocketManager] Joined video channel');
        // Set up broadcast listeners
        setupVideoChannelBroadcasts();
        resolve();
      })
      .receive('error', (err) => {
        console.error('[SocketManager] Failed to join video channel:', err);
        reject(err);
      });
  });

  return videoChannel;
}

/**
 * Set up video channel broadcast listeners
 * Forwards video updates to side panel for real-time UI updates
 */
function setupVideoChannelBroadcasts() {
  // Only set up once to avoid duplicate listeners
  if (broadcastsSetUp || !videoChannel) {
    return;
  }

  console.log('[SocketManager] 📡 Setting up video channel broadcasts');

  // Listen for video_updated broadcasts
  videoChannel.on('video_updated', (payload) => {
    console.log('[SocketManager] 📡 Broadcast: video_updated', payload);
    // Forward to side panel
    chrome.runtime
      .sendMessage({
        type: 'channel_broadcast',
        event: 'video_updated',
        data: payload,
      })
      .catch(() => {
        // Silently ignore if side panel not open
      });
  });

  // Listen for video_queued broadcasts
  videoChannel.on('video_queued', (payload) => {
    console.log('[SocketManager] 📡 Broadcast: video_queued', payload);
    // Forward to side panel
    chrome.runtime
      .sendMessage({
        type: 'channel_broadcast',
        event: 'video_queued',
        data: payload,
      })
      .catch(() => {
        // Silently ignore if side panel not open
      });
  });

  broadcastsSetUp = true;
}

/**
 * Get current video channel (may be null)
 */
export function getVideoChannel() {
  return videoChannel;
}

/**
 * Get current socket (may be null)
 */
export function getSocket() {
  return socket;
}
