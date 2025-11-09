# Product Vision

## Goal & Scope

Ship a vertical slice of Lossy:

> From a random web page → grab an image → edit baked-in text → download final image

The MVP focuses on:
- Minimal but well-factored MV3 extension code
- Elixir/Phoenix as the "brains"
- A LiveView-based editor that's easy to extend later
- A clear, evolvable data model ("your data model is your destiny")

## Core User Flow

### 1. Trigger Capture
User clicks the Lossy extension icon or presses `Cmd+Shift+L` (or `Ctrl+Shift+L` on Windows/Linux).

### 2. Select Image
- The page dims
- All candidate images get a hover outline
- User clicks an image (or cycles with arrow keys) and presses Enter to confirm

### 3. Capture & Handoff
The extension:
- Tries to resolve a **direct image URL** (for `<img>` or `<picture>` elements)
- If not possible (canvas, background-image, etc.), takes a **region screenshot**
- Sends the image to the backend

### 4. Processing View
- A new tab opens at `https://lossy.app/capture/:id`
- LiveView shows:
  - The base image
  - "Finding text..." skeleton UI
  - Text boxes appear as soon as detection completes

### 5. Edit
- User clicks a text region → inline text editor appears
- On blur/Enter, Lossy:
  - Inpaints the background under that region
  - Renders updated text over it
  - Updates the preview

### 6. Export
- "Download PNG" button (and optionally "Copy to clipboard")
- Optional "Enhance (HD)" for upscaled output

## Product Modes

### Lazy Mode (MVP Default)
**Strategy**: Don't precompute everything.

- Detect text regions first
- Only inpaint/upscale the specific regions the user edits
- Optimizes for speed and resource efficiency during initial interaction

**Benefits**:
- Faster initial load
- Lower processing costs
- User can start editing immediately after text detection

### Optimistic Mode (v2)
**Strategy**: Precompute everything.

- Immediately enqueue jobs to inpaint **all** text regions
- Optionally guess fonts for all regions
- Maybe upscale the final output
- Editing feels instant when user starts typing

**Benefits**:
- Zero-latency editing experience
- Better for users who will edit multiple regions

## Design Goals

1. **Simplicity First**: Get the core flow working with minimal complexity
2. **Extensibility**: Architecture that supports future features (non-text layers, filters, shapes)
3. **Performance**: Balance between cloud processing power and local responsiveness
4. **User Experience**: Instant feedback, clear loading states, no surprises

## Future Capabilities (Post-MVP)

- Video editing support
- Non-text layers (stickers, shapes, filters)
- Collaborative editing
- Local ML inference for privacy and speed
- Advanced font matching
- Batch processing
- Project management and version history
