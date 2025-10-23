/**
 * Shared settings helper for feature flags and user preferences.
 *
 * Sprint 11: Local-only transcription (no cloud fallback)
 * Sprint 08: Local Vision (SigLIP) feature flag
 * - Stored in chrome.storage.local for persistence across sessions
 * - Supports "auto", "force_local", "force_cloud", "disabled" modes for vision
 */

/**
 * Local Vision (SigLIP image encoder) feature flag values:
 * - "auto": Try local first, skip enrichment if unavailable (DEFAULT)
 * - "force_local": Only use local vision, fail if unavailable
 * - "force_cloud": Always use cloud vision API (bypass local)
 * - "disabled": Skip visual enrichment entirely
 */
export const LOCAL_VISION_MODES = {
  AUTO: 'auto',
  FORCE_LOCAL: 'force_local',
  FORCE_CLOUD: 'force_cloud',
  DISABLED: 'disabled',
};

const DEFAULT_SETTINGS = {
  features: {
    localVisionEnabled: LOCAL_VISION_MODES.AUTO,
    passiveModeEnabled: false, // Sprint 10: Default OFF per spec
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
 * Sprint 11: STT mode removed - all transcription is local-only (WebGPU or WASM via ONNX Runtime)
 */

/**
 * Reset settings to defaults.
 */
export async function resetSettings() {
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  console.log('[Settings] Reset to defaults:', DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

// ========================================
// Sprint 08: Local Vision Settings
// ========================================

/**
 * Get the current local vision mode.
 *
 * @returns {Promise<string>} One of LOCAL_VISION_MODES values
 */
export async function getLocalVisionMode() {
  const settings = await getSettings();
  return settings.features.localVisionEnabled;
}

/**
 * Set the local vision mode.
 *
 * @param {string} mode - One of LOCAL_VISION_MODES values
 */
export async function setLocalVisionMode(mode) {
  if (!Object.values(LOCAL_VISION_MODES).includes(mode)) {
    throw new Error(
      `Invalid local vision mode: ${mode}. Must be one of: ${Object.values(LOCAL_VISION_MODES).join(', ')}`
    );
  }

  return updateSettings({
    features: {
      localVisionEnabled: mode,
    },
  });
}

/**
 * Check if local vision should be attempted based on current mode.
 *
 * @returns {Promise<boolean>} True if local vision should be attempted
 */
export async function shouldUseLocalVision() {
  const mode = await getLocalVisionMode();

  // Skip local vision if explicitly forced to cloud or disabled
  return mode !== LOCAL_VISION_MODES.FORCE_CLOUD && mode !== LOCAL_VISION_MODES.DISABLED;
}

/**
 * Check if vision is enabled at all (not disabled).
 *
 * @returns {Promise<boolean>} True if vision features are enabled
 */
export async function isVisionEnabled() {
  const mode = await getLocalVisionMode();

  return mode !== LOCAL_VISION_MODES.DISABLED;
}

/**
 * Check if cloud vision fallback is allowed based on current mode.
 *
 * @returns {Promise<boolean>} True if cloud fallback is allowed
 */
export async function allowCloudVisionFallback() {
  const mode = await getLocalVisionMode();

  // Allow cloud fallback unless explicitly forced to local or disabled
  return mode !== LOCAL_VISION_MODES.FORCE_LOCAL && mode !== LOCAL_VISION_MODES.DISABLED;
}

// ========================================
// Sprint 10: Passive Mode Settings
// ========================================

/**
 * Get the current passive mode enabled state.
 *
 * @returns {Promise<boolean>} True if passive mode is enabled
 */
export async function getPassiveModeEnabled() {
  const settings = await getSettings();
  return settings.features.passiveModeEnabled ?? false; // Default OFF per Sprint 10 spec
}

/**
 * Set the passive mode enabled state.
 *
 * @param {boolean} enabled - True to enable passive mode
 */
export async function setPassiveModeEnabled(enabled) {
  return updateSettings({
    features: {
      passiveModeEnabled: Boolean(enabled),
    },
  });
}
