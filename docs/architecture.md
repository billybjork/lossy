# Architecture

Lossy follows a clean separation of concerns with distinct components handling capture, processing, and editing.

## System Components

### 1. Browser Extension (TypeScript / Manifest V3)

**Responsibilities**:
- Keyboard shortcut and browser action handling
- DOM scanning to find candidate images
- Highlight/spotlight UI for image selection
- Element or region capture
- POST captured image (or URL + bounding box) to backend

**Philosophy**: Act as a thin "imperative shell" at the edges only. The extension handles capture only - all ML inference happens in the web app.

**Key Design Principles**:
- Keep extension code minimal and focused (capture only, no ML)
- Simple, focused modules for capture, overlay, and messaging
- Composition over complex inheritance

See [Extension Implementation Guide](implementation/extension.md) for details.

---

### 2. Backend (Elixir + Phoenix)

**Responsibilities**:
- Domain model and persistence
- Job orchestration for ML pipeline
- Integration with external inference services (Replicate)
- LiveView hosting for the editor interface

**Key Design Principles**:
- Leverage Elixir's concurrency model instead of complex async TypeScript
- Clean context modules for business logic
- Boundary code for external services (HTTP clients, file I/O, S3)
- Task.Supervisor for job management (upgrade to Oban later)

**APIs**:
- `POST /api/captures` - Accept image URL or file upload
- `GET /edit/:id` - LiveView editor page

---

### 3. Editor Frontend (Phoenix LiveView + JS Hooks)

**Responsibilities**:
- Display document and text regions
- Subscribe to processing job updates (via PubSub)
- Handle user interactions (click, edit, drag)
- Persist text changes
- **Local ML inference** (text detection, click-to-segment) via Web Worker

**Architecture**:
- **LiveView**: Holds authoritative document state, driven by events from user and pipeline
- **JS Hooks**: Handle canvas rendering, drag/resize, and fast keystroke handling
- **Web Worker**: ONNX Runtime with WebGPU/WASM for local ML inference
- **Philosophy**: "FP-flavored frontend" - central state + pure transforms, effects at edges

**Local ML Stack**:
- ONNX Runtime Web 1.23+ with WebGPU (WASM fallback)
- Text detection (DBNet/PP-OCRv3) runs automatically on page load
- Click-to-segment (EdgeSAM) with cached embeddings for fast iteration
- ~70MB models loaded lazily from `/models/` and `/wasm/`

**State Flow**:
```
User Interaction → JS Hook → LiveView (state update) → PubSub broadcast → All clients
                                                    ↓
                                              ML Pipeline Jobs (cloud)
       ↓
Web Worker (local ML) → Hook callback → pushEvent to LiveView
```

See [Editor Implementation Guide](implementation/editor.md) for details.

---

### 4. ML Inference Services

**Local (Web Worker)**:
- Text detection (DBNet/PP-OCRv3) - runs on page load
- Click-to-segment (EdgeSAM encoder + decoder) - runs on demand
- WebGPU with WASM fallback via ONNX Runtime Web

**Cloud (Replicate)**:
- Inpainting (LaMa) - remove original text from backgrounds
- Upscaling (Real-ESRGAN) - super-resolution for exports

See [ML Pipeline](ml-pipeline.md) for model choices.

---

## Data Flow

### Image Capture Flow
```
Web Page → Extension (capture) → POST /api/captures → Phoenix Backend
                                                            ↓
                                                    Save Document record
                                                            ↓
                                                    Redirect to Editor (LiveView)
                                                            ↓
                                                    Load image in browser
                                                            ↓
                                                    Run text detection (local, WebGPU)
                                                            ↓
                                                    Create DetectedRegion records
                                                            ↓
                                                    Display masks on canvas
```

### Text Edit Flow
```
User edits text → LiveView event → Update TextRegion.current_text
                                            ↓
                                    Enqueue inpainting job
                                            ↓
                                    Call LaMa model (Replicate)
                                            ↓
                                    Composite patch into working_image_path
                                            ↓
                                    Render new text onto image
                                            ↓
                                    Broadcast completion to LiveView
                                            ↓
                                    Update canvas display
```

### Export Flow
```
User clicks "Download" → Generate final composite image
                              ↓
                        Optional: Call Real-ESRGAN for upscaling
                              ↓
                        Return PNG to browser
                              ↓
                        Browser downloads or copies to clipboard
```

## Separation of Concerns

### Extension Layer
- **What**: DOM interaction, capture mechanics, UI overlays
- **Not What**: ML, complex state, business logic
- **Tools**: TypeScript, Web APIs, Chrome Extension APIs

### Backend Layer
- **What**: Domain model, orchestration, data persistence, job management
- **Not What**: UI rendering (except LiveView templates), DOM manipulation
- **Tools**: Elixir, Phoenix, Ecto, Task.Supervisor

### Editor Layer
- **What**: Real-time UI updates, canvas rendering, user interactions
- **Not What**: Business logic, direct ML integration
- **Tools**: LiveView, Phoenix PubSub, JS Hooks

### ML Layer
- **What**: Computer vision tasks (detection, segmentation, inpainting, upscaling)
- **Not What**: Application logic, data persistence
- **Tools**: ONNX Runtime Web (local), Replicate API (cloud), PP-OCRv3, EdgeSAM, LaMa, Real-ESRGAN

## Concurrency Model

### Extension
- Async only at boundaries (capture API calls, chrome APIs)
- Simple event-driven flow

### Backend
- Elixir processes for each ML job
- Task.Supervisor for job management
- PubSub for real-time updates to connected clients
- Later: Oban for robust queue management with retries

### Editor
- LiveView processes per connected client
- JS hooks for immediate UI feedback
- Server-side state as source of truth

## Scalability Considerations

### MVP (Current Focus)
- Single Phoenix server
- External ML inference (Replicate)
- Postgres for persistence
- Oban for job processing

### Future Optimization Paths
1. **Local Inpainting**: Lightweight inpainting model in browser for small edits
2. **CDN**: Serve processed images via CDN
3. **Caching**: Cache detection results, font guesses
4. **Horizontal Scaling**: Add more Phoenix nodes behind load balancer

## Why This Architecture?

1. **Simplicity**: Clear boundaries between components
2. **Extensibility**: Easy to add new layer types, processing steps, or features
3. **Performance**: Right-sized for MVP, clear path to scale
4. **Developer Experience**: Leverage Elixir's strengths for concurrency; keep frontend simple
5. **Cost-Effective**: Cloud ML for MVP, option to optimize later

See [Design Principles](design-principles.md) for the philosophical foundation of these choices.
