# Lossy Browser Extension

Capture images from any webpage for editing in Lossy. The extension handles capture only - all ML inference runs in the web app.

## Development

```bash
cd extension
npm run dev      # Watch mode (rebuilds on save)
npm run build    # Production build
```

### Loading in Chrome/Edge

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist`

## How It Works

1. User activates capture (toolbar icon or `Cmd+Shift+L`)
2. Content script shows overlay with detected images
3. User selects an image or region
4. Service worker POSTs to `localhost:4000/api/captures`
5. Editor opens in new tab

## Debugging

- **Service Worker**: `chrome://extensions/` → click "service worker" link
- **Content Scripts**: Browser DevTools on any page
