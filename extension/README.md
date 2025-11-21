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
├── lib/
│   └── dom-scanner.ts       # Image detection logic
├── manifest.json            # Extension manifest
├── vite.config.ts          # Vite configuration
└── dist/                   # Built extension (git-ignored)
```

## Architecture Decisions

### Image Selection Overlay (content/overlay.ts)

The overlay uses a **minimal, cinematic approach** that prioritizes simplicity and performance:

**Key Insight: Work With The Browser, Not Against It**

We tried complex position tracking (measuring `getBoundingClientRect()` on every scroll, updating positions continuously) which caused jitter and size drift. The solution was much simpler:

```typescript
// Measure ONCE at creation
const rect = element.getBoundingClientRect();
const scrollTop = window.pageYOffset;

// Set position ONCE (absolute positioning)
clone.style.top = `${rect.top + scrollTop}px`;
clone.style.left = `${rect.left + scrollLeft}px`;

// Then NEVER update positions during scroll!
// The browser handles scrolling naturally via position: absolute
```

**Why this works:**
- `position: absolute` positions elements relative to the **document**, not the viewport
- When you scroll, the viewport moves over the document
- Absolutely positioned elements scroll naturally **without JavaScript**
- Result: Zero layout thrashing, perfect stability, 60fps smooth

**Design Decisions:**

1. **Clone images instead of modifying originals**
   - Avoids stacking context issues (parent containers trap z-index)
   - Clean separation (original elements untouched)
   - Simple cleanup (just remove clones)

2. **No position tracking during scroll**
   - Measure once, never update
   - Let CSS handle scrolling naturally
   - Only update visual effects (glow, opacity)

3. **Cinematic transitions**
   - Spring bounce on entrance (`cubic-bezier(0.34, 1.56, 0.64, 1)`)
   - Staggered appearance (60ms delay between images)
   - Directional blur on exit (follows scroll direction)
   - Hover scale effect (105% on hover)

4. **Progressive disclosure UX**
   - Initially: All images spotlit
   - After scroll: Hover-only mode
   - Hovering one: Only that one bright, others dim
   - Not hovering: All bright again

**Performance:**
- Bundle: 5.5 kB (1.8 kB gzipped)
- Zero scroll jank (no `getBoundingClientRect()` in hot path)
- Hardware-accelerated transforms
- Fade out gracefully on scroll/resize (don't fight it)

**What We Learned:**
> "The best code is the code you don't write. Stop trying to track and update everything. Measure once, set position, then let the browser do its job."

## Debugging

- **Service Worker**: `chrome://extensions/` → click "service worker" link under your extension
- **Content Scripts**: Regular browser DevTools on any page
- **Console Logs**: Check both service worker console and page console depending on context
- **Overlay Issues**: Inspect cloned elements in DevTools (look for `position: absolute` elements with high z-index)
