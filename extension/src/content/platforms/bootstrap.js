/**
 * Platform adapter bootstrap.
 * Imports and registers all platform adapters in priority order.
 */
import { PlatformRegistry } from './index.js';
import { YouTubeAdapter } from './youtube/youtube-adapter.js';
import { FrameioAdapter } from './frameio/frameio-adapter.js';
import { VimeoAdapter } from './vimeo/vimeo-adapter.js';
import { GenericAdapter } from './generic/generic-adapter.js';

// Register adapters in priority order
// Platform-specific adapters first, GenericAdapter LAST (catch-all)
PlatformRegistry.register(YouTubeAdapter);
PlatformRegistry.register(FrameioAdapter);
PlatformRegistry.register(VimeoAdapter);
// Future adapters will be registered here:
// PlatformRegistry.register(AirAdapter);
PlatformRegistry.register(GenericAdapter); // Always last

console.log('[Bootstrap] Registered', PlatformRegistry.adapters.length, 'platform adapters');
