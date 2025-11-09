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

**Philosophy**: Act as a thin "imperative shell" at the edges only. All complex logic lives in the backend.

**Key Design Principles**:
- Keep extension code minimal and focused
- No ML or heavy processing in the browser
- Simple, focused modules for capture, overlay, and messaging
- Composition over complex inheritance

See [Extension Implementation Guide](implementation/extension.md) for details.

---

### 2. Backend (Elixir + Phoenix)

**Responsibilities**:
- Domain model and persistence
- Job orchestration for ML pipeline
- Integration with external inference services (fal/Replicate)
- LiveView hosting for the editor interface

**Key Design Principles**:
- Leverage Elixir's concurrency model instead of complex async TypeScript
- Clean context modules for business logic
- Boundary code for external services (HTTP clients, file I/O, S3)
- Task.Supervisor for job management (upgrade to Oban later)

**APIs**:
- `POST /api/captures` - Accept image URL or file upload
- `GET /capture/:id` - LiveView editor page
- `POST /api/text_regions/:id/render` - Trigger inpainting + render for a region

See [Backend Implementation Guide](implementation/backend.md) for details.

---

### 3. Editor Frontend (Phoenix LiveView + JS Hooks)

**Responsibilities**:
- Display document and text regions
- Subscribe to processing job updates (via PubSub)
- Handle user interactions (click, edit, drag)
- Persist text changes

**Architecture**:
- **LiveView**: Holds authoritative document state, driven by events from user and pipeline
- **JS Hooks**: Handle canvas rendering, drag/resize, and fast keystroke handling
- **Philosophy**: "FP-flavored frontend" - central state + pure transforms, effects at edges

**State Flow**:
```
User Interaction → JS Hook → LiveView (state update) → PubSub broadcast → All clients
                                                    ↓
                                              ML Pipeline Jobs
```

See [Editor Implementation Guide](implementation/editor.md) for details.

---

### 4. ML Inference Services

**Responsibilities**:
- Text detection (find text regions in images)
- Inpainting (remove original text from backgrounds)
- Upscaling (super-resolution for higher quality exports)
- Font detection (optional, heuristic-based initially)

**Deployment Strategy**:
- **MVP**: All ML runs in the cloud (Replicate)
- **v2**: Move text detection to local (ONNX Runtime Web + WebGPU)
- **Later**: Consider self-hosted or fal.ai for performance-critical models

See [ML Pipeline](ml-pipeline.md) for model choices and [Technology Stack](technology-stack.md) for platform decisions.

---

## Data Flow

### Image Capture Flow
```
Web Page → Extension (capture) → POST /api/captures → Phoenix Backend
                                                            ↓
                                                    Save Document record
                                                            ↓
                                                    Enqueue text detection job
                                                            ↓
                                                    Call ML service (Replicate)
                                                            ↓
                                                    Create TextRegion records
                                                            ↓
                                                    Broadcast to LiveView
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
- **What**: Computer vision tasks (detection, inpainting, upscaling)
- **Not What**: Application logic, data persistence
- **Tools**: Replicate API, PaddleOCR, LaMa, Real-ESRGAN

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
- Simple Task.Supervisor for jobs

### Future Optimization Paths
1. **Local ML**: Move text detection to browser (WebGPU)
2. **Job Queue**: Upgrade to Oban for better queue management
3. **CDN**: Serve processed images via CDN
4. **Caching**: Cache detection results, font guesses
5. **Horizontal Scaling**: Add more Phoenix nodes behind load balancer

## Why This Architecture?

1. **Simplicity**: Clear boundaries between components
2. **Extensibility**: Easy to add new layer types, processing steps, or features
3. **Performance**: Right-sized for MVP, clear path to scale
4. **Developer Experience**: Leverage Elixir's strengths for concurrency; keep frontend simple
5. **Cost-Effective**: Cloud ML for MVP, option to optimize later

See [Design Principles](design-principles.md) for the philosophical foundation of these choices.
