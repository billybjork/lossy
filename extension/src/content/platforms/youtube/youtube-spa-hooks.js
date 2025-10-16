/**
 * YouTube SPA navigation hooks.
 * YouTube uses custom events for navigation instead of standard History API.
 */
export class YouTubeSpaHooks {
  /**
   * Set up YouTube-specific navigation detection.
   * @param {Function} onNavigate - Callback invoked on navigation
   * @returns {Function} - Cleanup function
   */
  static setup(onNavigate) {
    console.log('[YouTubeSpaHooks] Setting up YouTube navigation hooks');

    // YouTube fires this custom event on navigation
    const handleYtNavigate = (event) => {
      console.log('[YouTubeSpaHooks] yt-navigate-finish event detected');
      onNavigate(event);
    };

    window.addEventListener('yt-navigate-finish', handleYtNavigate);

    // Return cleanup function
    return () => {
      window.removeEventListener('yt-navigate-finish', handleYtNavigate);
      console.log('[YouTubeSpaHooks] Cleaned up YouTube navigation hooks');
    };
  }
}
