# Lossy Browser Extension

## Development

### Watch Mode

Run the dev watcher (rebuilds automatically on file changes):

```bash
cd extension
npm run dev
```

This keeps running and rebuilds whenever you save a file.

### Loading the Extension

Load the extension once in your browser:

#### Chrome/Edge
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `extension/dist` directory

#### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select any file in the `extension/dist` directory

### Development Workflow

1. **Start once**: `npm run dev` (leave running)
2. **Edit** your TypeScript files
3. **Save** - Vite rebuilds automatically (watch terminal for "✓ built in XXms")
4. **Refresh** your browser page to see changes

No need to run `npm run build` repeatedly!

### Building for Production

```bash
npm run build
```

This creates an optimized build without sourcemaps in the `dist` directory.

## Project Structure

```
extension/
├── background/
│   └── service-worker.ts    # Background service worker (MV3)
├── content/
│   ├── content.ts           # Content script injected into pages
│   └── overlay.ts           # UI overlay for image selection
├── manifest.json            # Extension manifest
├── vite.config.ts          # Vite configuration
└── dist/                   # Built extension (git-ignored)
```

## Debugging

- **Service Worker**: `chrome://extensions/` → click "service worker" link under your extension
- **Content Scripts**: Regular browser DevTools on any page
- **Console Logs**: Check both service worker console and page console depending on context
