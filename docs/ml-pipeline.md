# ML Pipeline

This document covers all machine learning and computer vision decisions for Lossy's image processing pipeline.

## Local vs Cloud Inference

### Where Local Inference is Desirable

**Text Detection**:
- Reasonably small models (10-50MB when quantized)
- Good candidate for ONNX Runtime Web + WebGPU
- Benefits: low latency, no round trip, privacy, offline support

### Where Cloud Inference is Better (for now)

**Inpainting & Super-Resolution**:
- Heavier models (diffusion, LaMa, etc.)
- GPU-intensive; require significant VRAM
- Better to run on dedicated GPU infrastructure initially

### MVP Strategy

**Run ALL ML in the cloud** (Replicate):
- Simpler deployment and debugging
- Single round-trip for complete text detection
- Focus on getting core UX working first

**Roadmap**:
- **v2**: Move text detection to local (ONNX Runtime Web + WebGPU)
- **v3**: Explore local lightweight inpainting for small edits

This keeps concurrency and pipeline complexity in Elixir (where it's easier) early on.

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

**Use PaddleOCR/DBNet-based text detection in the cloud** (via Replicate or self-hosted).

**Output Format**:
- List of bounding boxes (quadrilaterals preferred for rotated text support)
- Each box: `[(x1,y1), (x2,y2), (x3,y3), (x4,y4)]` or simplified `{x, y, w, h}`

**Why**:
- Robust to web screenshots and mixed layouts
- Handles various text orientations
- Can inflate bounding boxes slightly for inpainting masks
- Accurate placement for text overlays

### Local Inference Path (v2)

Convert **DBNet with MobileNet backbone** to ONNX:
- Quantize to INT8 or FP16
- Run with ONNX Runtime Web + WebGPU/WASM in extension context
- Target: <100ms inference on modern hardware

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
- Image is very small (<500px) and detection fails or is unreliable
- User explicitly requests "HD mode" before editing

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
Detect Text (cloud) ─────────→ Create TextRegion records
     ↓
User edits region
     ↓
Inpaint region (LaMa) ────────→ Save inpainted_bg_path
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

See [Technology Stack](technology-stack.md) for platform decisions (Replicate vs fal.ai vs self-hosted).

### MVP: Replicate API

**Text Detection**:
- Use PaddleOCR model on Replicate
- Input: Image URL or base64
- Output: JSON list of bounding boxes

**Inpainting**:
- Use LaMa model on Replicate
- Input: Image + mask
- Output: Inpainted image

**Upscaling**:
- Use Real-ESRGAN model on Replicate
- Input: Image, scale factor
- Output: Upscaled image

### API Call Pattern (Elixir)

```elixir
# Pseudo-code
defmodule Lossy.ML.ReplicateClient do
  def detect_text(image_url) do
    HTTPoison.post(
      "https://api.replicate.com/v1/predictions",
      %{version: "paddleocr-version-id", input: %{image: image_url}},
      headers: [{"Authorization", "Token #{api_key}"}]
    )
  end

  def inpaint_region(image_url, mask_url) do
    HTTPoison.post(
      "https://api.replicate.com/v1/predictions",
      %{version: "lama-version-id", input: %{image: image_url, mask: mask_url}},
      headers: [{"Authorization", "Token #{api_key}"}]
    )
  end
end
```

---

## Performance Targets (MVP)

- **Text Detection**: <5 seconds for typical web image (~1920x1080)
- **Inpainting (per region)**: <3 seconds
- **Upscaling (4x)**: <10 seconds
- **Total time (single region edit)**: <20 seconds end-to-end

---

## Future Optimizations

1. **Local Text Detection** (v2)
   - Move to ONNX + WebGPU in browser
   - Target: <100ms detection
   - Eliminates one round-trip

2. **Batch Processing** (v2)
   - Inpaint multiple regions in single API call
   - Reduces overhead for optimistic mode

3. **Model Caching** (v3)
   - Cache detection results
   - Avoid re-detection if image unchanged

4. **Progressive Enhancement** (v3)
   - Show low-res preview immediately
   - Upgrade to HD in background

5. **Local Inpainting** (v4)
   - Lightweight inpainting model in browser
   - For small edits only
   - Fall back to cloud for complex cases

---

## Why These Choices?

1. **MVP Simplicity**: All cloud-based means consistent behavior, easier debugging
2. **Cost-Effective**: Pay-per-use APIs are cheap during development
3. **Proven Models**: PaddleOCR, LaMa, Real-ESRGAN are battle-tested
4. **Clear Upgrade Path**: Can swap models without changing architecture
5. **User Experience**: Order of operations optimized for speed and quality

This pipeline balances quality, speed, and cost for the MVP while maintaining flexibility for future improvements.
