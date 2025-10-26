/**
 * Phoenix Authentication for Extension
 *
 * MILESTONE 0 COMPLETION: Token fetching and management for Phoenix channels.
 *
 * ARCHITECTURE:
 * 1. User logs in via browser (currently: dev-only /dev/auth page)
 * 2. Phoenix sets session cookie with user_id
 * 3. Extension reads cookie (same domain: localhost:4000)
 * 4. Extension fetches JWT token via POST /api/auth/extension_token
 * 5. Extension uses JWT to authenticate WebSocket connections
 *
 * CURRENT STATE (Sprint 15 - Testing):
 * - Minimal dev-only login page (/dev/auth) for testing
 * - Session-based auth for /api/auth/extension_token endpoint
 * - JWT tokens for channel authentication
 *
 * LONG-TERM PLAN (Post-Testing):
 * - Option 1: phx.gen.auth for production-ready session-based auth
 *   - Full user registration, email confirmation, password reset
 *   - ~800 LOC generated, maintained by developer
 *   - Standard Phoenix pattern, widely used
 *
 * - Option 2: Custom OAuth integration (Google, GitHub, etc.)
 *   - Using phx.gen.auth as base + OAuth library
 *   - Good for multi-provider scenarios
 *
 * - Option 3: Keep minimal session auth + build custom UI
 *   - Extension-focused, simpler UX
 *   - Less feature-complete than phx.gen.auth
 *
 * Decision: Defer to post-testing phase. Current minimal approach is
 * appropriate for development and testing the voice session refactor.
 *
 * See: docs/sprints/SPRINT_15_phoenix_responsibility_shift.md - Milestone 0
 */

const PHOENIX_URL = 'http://localhost:4000';
const TOKEN_STORAGE_KEY = 'phoenix_auth_token';
const DEVICE_ID_STORAGE_KEY = 'phoenix_device_id';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

/**
 * Get or generate a stable device ID for this extension installation.
 * Device ID is used to track which device a session belongs to.
 */
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);

  if (stored[DEVICE_ID_STORAGE_KEY]) {
    return stored[DEVICE_ID_STORAGE_KEY];
  }

  // Generate new device ID
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: deviceId });
  console.log('[PhoenixAuth] Generated new device ID:', deviceId);

  return deviceId;
}

/**
 * Fetch a fresh JWT token from Phoenix.
 *
 * Requires:
 * - User logged in via browser (session cookie set)
 * - Cookie accessible to extension (same domain)
 *
 * Returns: {token, expiresAt, features, minConfidence}
 * Throws: Error if not authenticated or request fails
 */
async function fetchToken() {
  const deviceId = await getOrCreateDeviceId();

  console.log('[PhoenixAuth] Fetching token from Phoenix...');

  const response = await fetch(`${PHOENIX_URL}/api/auth/extension_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include', // Important: send cookies
    body: JSON.stringify({
      device_id: deviceId,
      protocol_version: 2, // Request protocol v2 (voice events support)
    }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Not authenticated. Please log in at http://localhost:4000/dev/auth');
    }
    throw new Error(`Failed to get auth token: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  console.log('[PhoenixAuth] ✅ Token received:', {
    expiresAt: new Date(data.expires_at * 1000).toISOString(),
    protocol: data.protocol_version,
    features: data.features,
  });

  return {
    token: data.token,
    expiresAt: data.expires_at, // Unix timestamp
    protocolVersion: data.protocol_version,
    features: data.features,
    minConfidence: data.min_confidence,
  };
}

/**
 * Get cached token if valid, or fetch a new one.
 *
 * Token is considered valid if:
 * - It exists in storage
 * - Expiry is more than TOKEN_EXPIRY_BUFFER_MS in the future
 *
 * Otherwise, fetches and caches a fresh token.
 */
export async function getValidToken() {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const cachedToken = stored[TOKEN_STORAGE_KEY];

  // Check if cached token is still valid
  if (cachedToken) {
    const expiryTime = cachedToken.expiresAt * 1000; // Convert to milliseconds
    const bufferTime = Date.now() + TOKEN_EXPIRY_BUFFER_MS;

    if (expiryTime > bufferTime) {
      console.log('[PhoenixAuth] Using cached token (expires in', Math.round((expiryTime - Date.now()) / 1000), 'seconds)');
      return cachedToken;
    }

    console.log('[PhoenixAuth] Cached token expired or expiring soon, fetching new token');
  }

  // Fetch fresh token
  const tokenData = await fetchToken();

  // Cache for future use
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: tokenData });

  return tokenData;
}

/**
 * Clear cached token (e.g., after logout or auth error).
 */
export async function clearToken() {
  console.log('[PhoenixAuth] Clearing cached token');
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

/**
 * Get WebSocket connection params with authentication.
 *
 * Usage:
 *   const params = await getSocketParams();
 *   const socket = new Socket('ws://localhost:4000/socket', {params});
 *
 * Returns: {token: "jwt_here"}
 * Throws: Error if authentication fails
 */
export async function getSocketParams() {
  try {
    const tokenData = await getValidToken();
    return { token: tokenData.token };
  } catch (error) {
    console.error('[PhoenixAuth] ❌ Failed to get auth token:', error.message);
    throw error;
  }
}

/**
 * Check if user is authenticated (has valid token or can get one).
 *
 * Returns: true if authenticated, false otherwise
 * Does not throw - safe to call for status checks.
 */
export async function isAuthenticated() {
  try {
    await getValidToken();
    return true;
  } catch (error) {
    return false;
  }
}
