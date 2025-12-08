# Lossy

Edit text baked into any image on the web.

## What It Does

1. **Capture** - Browser extension grabs images from any webpage
2. **Detect** - ML finds text regions automatically (runs locally via WebGPU)
3. **Segment** - Click-to-select objects with EdgeSAM
4. **Edit** - Replace text, inpaint backgrounds (cloud)
5. **Export** - Download high-quality edited image

## Stack

- **Extension**: TypeScript, Manifest V3 (capture only)
- **Web App**: Elixir, Phoenix, LiveView
- **Local ML**: ONNX Runtime + WebGPU (text detection, segmentation)
- **Cloud ML**: Replicate (upscaling)
- **Database**: PostgreSQL

## Development

```bash
# Phoenix app
cd lossy
mix setup
mix phx.server

# Extension
cd extension
npm install
npm run dev
```

Load extension from `extension/dist` in Chrome/Edge.

## Docs

- [Architecture](docs/architecture.md) - System components
- [ML Pipeline](docs/ml-pipeline.md) - Model choices and performance
- [Data Model](docs/data-model.md) - Database schema
