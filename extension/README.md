# Chrome Extension

Voice-first video companion browser extension (MV3).

## Directory Structure

```
extension/
├── src/
│   ├── background/       # Service worker (manages connections, orchestrates audio)
│   ├── content/          # Content scripts (inject overlays into video pages)
│   ├── offscreen/        # Audio processing (mic access, WASM inference)
│   ├── popup/            # Popup UI (connects to LiveView)
│   ├── sidepanel/        # Side panel UI (connects to LiveView)
│   └── shared/           # Shared utilities
├── dist/                 # Built extension (webpack output)
├── public/               # Static assets (manifest, icons, models)
└── webpack.config.js     # Build configuration
```

## Architecture

**Client-side code that runs in browser:**
- Local HTML files load in extension context
- JavaScript bundles phoenix.js (via webpack)
- Connects to Phoenix backend via WebSocket for LiveView streaming
- Separate from backend assets (`lossy/assets/`)

**Current (Sprint 01-02):** Vanilla JS with basic audio streaming
**Future:** Full LiveView integration for real-time UI updates

See `../docs/03_LIVEVIEW_PATTERNS.md` for LiveView integration patterns.

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Production build
npm run build

# Load in Chrome
# 1. Go to chrome://extensions
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select extension/dist/
```
