/**
 * Shared settings helper for feature flags and user preferences.
 *
 * Sprint 07: Local STT feature flag
 * - Stored in chrome.storage.local for persistence across sessions
 * - Supports "auto", "force_local", "force_cloud" modes
 */

/**
 * Local STT (Speech-to-Text) feature flag values:
 * - "auto": Try local first, fall back to cloud if needed (DEFAULT)
 * - "force_local": Only use local transcription, fail if unavailable
 * - "force_cloud": Always use cloud transcription (bypass local)
 */
export const LOCAL_STT_MODES = {
  AUTO: 'auto',
  FORCE_LOCAL: 'force_local',
  FORCE_CLOUD: 'force_cloud',
};

const DEFAULT_SETTINGS = {
  features: {
    localSttEnabled: LOCAL_STT_MODES.AUTO,
  },
};

/**
 * Get current settings from chrome.storage.local.
 * Returns default settings if none exist.
 */
export async function getSettings() {
  try {
    const result = await chrome.storage.local.get('settings');

    if (!result.settings) {
      // No settings yet - return defaults
      return DEFAULT_SETTINGS;
    }

    // Merge with defaults to handle missing keys
    return {
      ...DEFAULT_SETTINGS,
      ...result.settings,
      features: {
        ...DEFAULT_SETTINGS.features,
        ...result.settings.features,
      },
    };
  } catch (err) {
    console.error('[Settings] Failed to get settings:', err);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Update settings in chrome.storage.local.
 * Merges with existing settings.
 */
export async function updateSettings(updates) {
  try {
    const current = await getSettings();

    const newSettings = {
      ...current,
      ...updates,
      features: {
        ...current.features,
        ...updates.features,
      },
    };

    await chrome.storage.local.set({ settings: newSettings });
    console.log('[Settings] Updated:', newSettings);

    return newSettings;
  } catch (err) {
    console.error('[Settings] Failed to update settings:', err);
    throw err;
  }
}

/**
 * Get the current local STT mode.
 *
 * @returns {Promise<string>} One of LOCAL_STT_MODES values
 */
export async function getLocalSttMode() {
  const settings = await getSettings();
  return settings.features.localSttEnabled;
}

/**
 * Set the local STT mode.
 *
 * @param {string} mode - One of LOCAL_STT_MODES values
 */
export async function setLocalSttMode(mode) {
  if (!Object.values(LOCAL_STT_MODES).includes(mode)) {
    throw new Error(`Invalid local STT mode: ${mode}. Must be one of: ${Object.values(LOCAL_STT_MODES).join(', ')}`);
  }

  return updateSettings({
    features: {
      localSttEnabled: mode,
    },
  });
}

/**
 * Check if local STT should be attempted based on current mode.
 *
 * @returns {Promise<boolean>} True if local STT should be attempted
 */
export async function shouldUseLocalStt() {
  const mode = await getLocalSttMode();

  // Only skip local STT if explicitly forced to cloud
  return mode !== LOCAL_STT_MODES.FORCE_CLOUD;
}

/**
 * Check if cloud fallback is allowed based on current mode.
 *
 * @returns {Promise<boolean>} True if cloud fallback is allowed
 */
export async function allowCloudFallback() {
  const mode = await getLocalSttMode();

  // Allow cloud fallback unless explicitly forced to local
  return mode !== LOCAL_STT_MODES.FORCE_LOCAL;
}

/**
 * Reset settings to defaults.
 */
export async function resetSettings() {
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  console.log('[Settings] Reset to defaults:', DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}
