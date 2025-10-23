/**
 * Platform adapter bootstrap.
 * Imports and registers all platform adapters in priority order.
 */
import { PlatformRegistry } from './index.js';
import { YouTubeAdapter } from './youtube/youtube-adapter.js';
import { FrameioAdapter } from './frameio/frameio-adapter.js';
import { VimeoAdapter } from './vimeo/vimeo-adapter.js';
import { AirAdapter } from './air/air-adapter.js';
import { WipsterAdapter } from './wipster/wipster-adapter.js';
import { IconikAdapter } from './iconik/iconik-adapter.js';
import { TikTokAdapter } from './tiktok/tiktok-adapter.js';
import { GenericAdapter } from './generic/generic-adapter.js';

// Register adapters in priority order
// Platform-specific adapters first, GenericAdapter LAST (catch-all)
PlatformRegistry.register(YouTubeAdapter);
PlatformRegistry.register(FrameioAdapter);
PlatformRegistry.register(VimeoAdapter);
PlatformRegistry.register(AirAdapter);
PlatformRegistry.register(WipsterAdapter);
PlatformRegistry.register(IconikAdapter);
PlatformRegistry.register(TikTokAdapter);
PlatformRegistry.register(GenericAdapter); // Always last (includes Google Drive)

console.log('[Bootstrap] Registered', PlatformRegistry.adapters.length, 'platform adapters');
