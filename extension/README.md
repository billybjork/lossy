# Chrome Extension Architecture

Voice-first video companion browser extension (MV3).

> **Setup & Development:** See [main README](../README.md) for installation and build instructions.

## Directory Structure

```
extension/
├── src/
│   ├── background/       # Service worker (manages connections, orchestrates audio)
│   ├── content/          # Content scripts (inject overlays into video pages)
│   ├── offscreen/        # Audio processing (mic access, WASM inference)
│   ├── popup/            # Popup UI (connects to LiveView)
│   ├── sidepanel/        # Side panel UI (connects to LiveView)
│   └── shared/           # Shared utilities (messaging, state)
├── dist/                 # Built extension (webpack output)
├── public/               # Static assets (manifest, icons, WASM models)
└── webpack.config.js     # Build configuration
```

## Architecture Overview

### Extension Context Isolation

The extension runs in **isolated browser contexts** with specific capabilities:

| Context | Capabilities | Use Case |
|---------|-------------|----------|
| **Background** (Service Worker) | Message routing, lifecycle management, no DOM access | Orchestrates communication between contexts |
| **Content Script** | DOM access on video pages, limited Chrome APIs | Injects UI overlays, detects video metadata |
| **Offscreen Document** | Audio APIs (getUserMedia), WASM execution | Captures microphone, runs local inference |
| **Popup/Side Panel** | Full Chrome extension APIs, own DOM | Connects to LiveView for real-time UI |

### Client-Side Phoenix Integration

**Key Concept:** Extension bundles Phoenix client libraries via webpack

- **Static HTML files** load in extension contexts (popup, sidepanel)
- **JavaScript bundles** include `phoenix.js` (LiveView socket client)
- **WebSocket connection** to backend (`ws://localhost:4000/live`)
- **Separate from backend assets** (`lossy/assets/`) - extension has its own build

**Current State (Sprint 01-02):**
- Vanilla JavaScript with basic audio streaming
- Direct WebSocket Channel for real-time transcription
- Manual DOM updates in content scripts

**Future (Sprint 03+):**
- Full LiveView integration for reactive UI
- Server-rendered components in popup/sidepanel
- LiveView events for note posting status

See [`../docs/03_LIVEVIEW_PATTERNS.md`](../docs/03_LIVEVIEW_PATTERNS.md) for LiveView integration patterns.

## Message Flow

```
Video Page (Content Script)
    ↓ (detects video metadata)
Background Service Worker
    ↓ (requests audio capture)
Offscreen Document
    ↓ (streams audio chunks)
Background Service Worker
    ↓ (forwards to backend)
Phoenix WebSocket Channel
    ↓ (transcription events)
Popup/Side Panel LiveView
    ↓ (UI updates)
User sees notes
```

## Key Files

| File | Purpose |
|------|---------|
| `public/manifest.json` | Chrome extension configuration (MV3) |
| `src/background/service-worker.js` | Message router, lifecycle orchestration |
| `src/content/video-detector.js` | Detects YouTube/Vimeo/Air videos, injects UI |
| `src/offscreen/audio-processor.js` | Microphone capture, WASM inference |
| `src/popup/index.html` | LiveView mount point for extension popup |
| `src/sidepanel/index.html` | LiveView mount point for side panel |
| `webpack.config.js` | Bundles Phoenix.js, compiles for multiple entry points |

## Development Notes

- **Hot reload:** Webpack rebuilds on changes, but Chrome requires manual extension reload
- **Debugging:** Each context has separate DevTools (inspect popup, background, etc.)
- **WASM models:** Stored in `public/models/`, loaded via `fetch()` in offscreen document
- **CSP restrictions:** Content Security Policy limits inline scripts (use webpack bundles)
