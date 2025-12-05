# ML Pipeline

This document covers all machine learning and computer vision decisions for Lossy's image processing pipeline.

## Local vs Cloud Inference

### Local (Web Worker)

**Text Detection** (DBNet/PP-OCRv3):
- ~2.3MB model, runs on page load
- ONNX Runtime Web with WebGPU (WASM fallback)
- <100ms inference on modern hardware

**Click-to-Segment** (EdgeSAM):
- Encoder: 21MB model, runs once to compute embeddings
- Decoder: 15MB model, runs per click (~80ms)
- Embeddings cached per document for fast iteration

### Cloud (Replicate)

**Inpainting** (LaMa):
- Remove original text from backgrounds
- GPU-intensive, ~1-3 seconds per region

**Upscaling** (Real-ESRGAN):
- Super-resolution for exports
- 4x upscaling, ~5-10 seconds

### Future

- Local lightweight inpainting for small edits

---

## Text Detection

**Goal**: Find where text is located in images. OCR (what the text says) is optional.

### Model Candidates

#### DBNet (Differentiable Binarization)
- Real-time arbitrary-shape scene text detector
- ONNX variants exist suitable for deployment
- Good balance of speed and accuracy
- Works well with rotated/curved text

#### PaddleOCR Detectors (PP-OCRv5 / server_det)
- Robust and widely used
- Strong detection quality on varied layouts
- Good for web screenshots with mixed text styles
- Well-maintained with active community

### MVP Choice

**Use PP-OCRv3/DBNet text detection locally in the web app** (via ONNX Runtime Web).

**Output Format**:
- List of bounding boxes (quadrilaterals preferred for rotated text support)
- Each box: `[(x1,y1), (x2,y2), (x3,y3), (x4,y4)]` or simplified `{x, y, w, h}`

**Why**:
- Robust to web screenshots and mixed layouts
- Handles various text orientations
- No cloud latency - runs instantly on page load
- Privacy-preserving - images don't leave the browser for detection

### Implementation

Text detection runs locally in the web app's Web Worker using ONNX Runtime with WebGPU (WASM fallback). The PP-OCRv3 model is served from `/models/det_v3.onnx`.

---

## Inpainting

**Goal**: Remove original text by filling in the background seamlessly.

### Model Candidates

#### LaMa (Resolution-robust Large Mask Inpainting)
- Designed to generalize to higher resolutions and large masks
- Works well up to ~2K resolution
- Fast inference (~1-3 seconds on GPU)
- Many open-source wrappers (lama-cleaner, etc.)
- **Best for**: Small to medium rectangular text masks

#### Diffusion-based Inpainting (SDXL, Inpaint-Anything)
- Higher quality and controllability
- Heavier and slower (10-30 seconds per image)
- Can handle complex contexts better
- **Best for**: Large areas or photo-realistic inpainting

### MVP Choice

**Use LaMa** (via Replicate or dedicated microservice).

**Input**:
- Image patch around text region
- Binary mask (expanded text bounding box with padding)

**Output**:
- Inpainted patch (same dimensions as input)

**Why**:
- Fast enough for interactive editing
- Good quality for text removal use case
- Lightweight enough to run on modest GPUs
- Well-suited for rectangular masks

**Integration**:
```
1. Extract region from original image (bbox + padding)
2. Create binary mask for text area
3. POST to LaMa endpoint
4. Receive inpainted patch
5. Composite patch back into working image
6. Render new text on top
```

**Mask Padding Strategy**:
Padding is calculated dynamically based on font size to balance context with precision:
```elixir
padding = clamp(font_size * multiplier, min, max)
# Default: multiplier=0.4, min=6px, max=24px
```

This ensures:
- Small text gets minimal padding (preserves details)
- Large headings get sufficient context (better inpainting)
- Never over-erases backgrounds

**Configuration**: Padding parameters are tunable. See [Configuration](configuration.md#ml-pipeline-settings) for details.

---

## Upscaling (Super-Resolution)

**Goal**: Enhance image quality when:
- Source image is small/low-resolution
- User wants high-quality export
- Screenshot captured at lower DPI

### Model Candidates

#### Real-ESRGAN
- Great speed/quality tradeoff
- Widely available via hosted APIs
- 2x or 4x upscaling
- ~5-10 seconds on GPU
- **Best for**: General purpose upscaling

#### SwinIR / Swin2SR
- Higher quality but slower
- Better at preserving fine details
- ~15-30 seconds on GPU
- **Best for**: Premium/professional quality

#### SDXL Upscalers (Crystal Clear XL)
- State-of-the-art quality
- Expensive and slower (30-60 seconds)
- **Best for**: Premium mode, large exports

### MVP Choice

**Use Real-ESRGAN** (cloud-hosted) as the default upscaler.

**Configuration**:
- 4x upscaling as default
- Apply to final composited image only

**Why**:
- Reliable and fast enough for MVP
- Well-tested and widely deployed
- Good cost/quality balance

---

## Font Detection/Approximation

**Goal**: Guess the font used in detected text regions to match the original style.

### Challenge

True visual font recognition (e.g., DeepFont) is a hard problem:
- Requires large labeled dataset
- Complex model training
- Limited to known font library
- Often inaccurate on distorted or stylized text

### Pragmatic MVP Strategy

**Don't aim for exact font detection.** Use heuristics + small classifier:

1. **Basic Classification**:
   - Detect serif vs sans-serif vs script
   - Use simple heuristic (stroke analysis) or tiny classifier

2. **Font Mapping**:
   - Map to curated set of open fonts:
     - Sans: Inter, Roboto, Open Sans
     - Serif: Lora, Playfair, Merriweather
     - Display: Bebas Neue, Oswald
     - Script: Dancing Script, Pacifico

3. **User Control**:
   - Default to a reasonable guess
   - Let user change font in UI (dropdown)
   - Remember user's choice per document

### Future Enhancement (v2+)

- Train or integrate a classifier: top-N closest fonts
- Use visual similarity (CNN embeddings)
- Cache font guesses per document to avoid recomputation
- OCR + font database lookup (if text is readable)

---

## Order of Operations

This defines the **correct sequence** for processing images in the pipeline.

### MVP Processing Order

For each captured document:

1. **Capture Original Image**
   - No upscaling yet
   - Store as `original_image_path`
   - Preserve original resolution

2. **Text Detection**
   - Run on original resolution
   - Faster and cheaper than processing upscaled images
   - Creates `TextRegion` records

3. **For Each Edited Region** (lazy mode):
   - User edits text → trigger inpainting
   - Inflate bounding box → create mask
   - **Inpaint background** at original resolution (LaMa)
   - Save inpainted patch to `inpainted_bg_path`
   - Composite patch into `working_image_path`

4. **Text Overlay Render**
   - Render new text at original resolution
   - Use specified font, size, color, alignment

5. **Optional Final Upscaling** (on export)
   - Upscale fully composited image (Real-ESRGAN)
   - Only if user requests HD export
   - Apply once to final output

### Why Upscale Last?

**Efficiency**:
- Detection and inpainting on smaller images are faster and cheaper
- Fewer GPU seconds consumed
- Lower API costs

**Quality**:
- Inpainting models work well at original resolution
- Text is re-rendered at target resolution, so it stays crisp
- Single upscaling pass at the end enhances the complete result
- Avoids multiple upscaling passes (which compound artifacts)

### When to Upscale First (Fallback)

Upscale **before** detection if:
- Image is very small (shortest dimension < configured threshold, default 500px) and detection may be unreliable
- User explicitly requests "HD mode" before editing

**Configuration**: The pre-upscale threshold is configurable via `config :lossy, :ml_pipeline, pre_upscale_min_dimension: 500`. See [Configuration](configuration.md) for details.

**Fallback Path**:
```
Upscale → Detect text on upscaled version
       → Inpaint on upscaled version
       → Render text
       → Export (no second upscaling)
```

---

## Processing Pipeline Diagram

### Lazy Mode (MVP)
```
Capture Image
     ↓
[Store original_image_path]
     ↓
Detect Text (local, WebGPU) ──→ Create DetectedRegion records
     ↓
User edits region
     ↓
Inpaint region (LaMa, cloud) ─→ Save inpainted result
     ↓
Composite patch into working_image_path
     ↓
Render new text
     ↓
[User clicks "Download"]
     ↓
Optional: Upscale (Real-ESRGAN)
     ↓
Export PNG
```

### Optimistic Mode (v2)
```
Capture Image
     ↓
Detect Text (cloud)
     ↓
Enqueue inpainting jobs for ALL regions (background)
     ↓
User edits region ─────────────→ Text renders instantly (background already inpainted)
     ↓
Export
```

---

## Model Hosting & Integration

See [Technology Stack](technology-stack.md) for platform decisions.

### MVP Architecture

**Text Detection** (Local):
- PP-OCRv3 model via ONNX Runtime Web
- Runs in browser Web Worker with WebGPU (WASM fallback)
- Input: Image data
- Output: JSON list of bounding boxes

**Click-to-Segment** (Local):
- EdgeSAM encoder + decoder via ONNX Runtime Web
- Runs in browser Web Worker
- Input: Image + click points
- Output: Binary mask

**Inpainting** (Cloud):
- LaMa model on Replicate
- Input: Image + mask
- Output: Inpainted image

**Upscaling** (Cloud):
- Real-ESRGAN model on Replicate
- Input: Image, scale factor
- Output: Upscaled image

---

## Performance Targets

- **Text Detection** (local): <100ms on WebGPU, <500ms on WASM
- **Click-to-Segment** (local): ~1s first click (encoder), ~80ms subsequent clicks
- **Inpainting (per region)**: <3 seconds
- **Upscaling (4x)**: <10 seconds
- **Total time (single region edit)**: <20 seconds end-to-end

---

## Future Optimizations

1. **Batch Processing**
   - Inpaint multiple regions in single API call
   - Reduces overhead for optimistic mode

2. **Model Caching**
   - Cache detection results
   - Avoid re-detection if image unchanged

3. **Progressive Enhancement**
   - Show low-res preview immediately
   - Upgrade to HD in background

4. **Local Inpainting**
   - Lightweight inpainting model in browser
   - For small edits only
   - Fall back to cloud for complex cases

---

## Why These Choices?

1. **Hybrid Architecture**: Local inference for fast feedback (detection, segmentation), cloud for heavy compute (inpainting)
2. **Privacy**: Images stay in browser for detection - only sent to cloud when user triggers inpainting
3. **Proven Models**: PP-OCRv3, EdgeSAM, LaMa, Real-ESRGAN are battle-tested
4. **Clear Upgrade Path**: Can swap models without changing architecture
5. **User Experience**: Instant detection feedback, cloud only for resource-intensive operations

This pipeline balances quality, speed, and cost while maintaining flexibility for future improvements.
