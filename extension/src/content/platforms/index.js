/**
 * Platform adapter registry.
 * Automatically selects the appropriate adapter for the current page.
 */
export class PlatformRegistry {
  static adapters = [];

  /**
   * Register an adapter class.
   * @param {class} AdapterClass - Adapter class extending BasePlatformAdapter
   */
  static register(AdapterClass) {
    this.adapters.push(AdapterClass);
  }

  /**
   * Get the appropriate adapter for the current page.
   * Returns first adapter where canHandle() returns true.
   * @returns {Promise<BasePlatformAdapter>}
   */
  static async getAdapter() {
    console.log('[PlatformRegistry] Checking', this.adapters.length, 'registered adapters...');

    for (const AdapterClass of this.adapters) {
      try {
        if (AdapterClass.canHandle()) {
          console.log('[PlatformRegistry] ✅ Selected adapter:', AdapterClass.platformId);
          return new AdapterClass();
        }
      } catch (error) {
        console.warn('[PlatformRegistry] ⚠️ Adapter check failed:', AdapterClass.name, error);
      }
    }

    // Should never reach here if GenericAdapter is registered last
    console.error('[PlatformRegistry] ❌ No adapter found for current page');
    throw new Error('No suitable adapter found');
  }

  /**
   * Clear all registered adapters (useful for testing).
   */
  static clear() {
    this.adapters = [];
  }
}
