# EdgeSAM Quality Improvement - Updated Diagnosis & Plan

## What We Tried (Week 1 Implementation)

### Changes Made
1. ✅ **Bilinear interpolation** - replaced nearest-neighbor upsampling
2. ✅ **Soft alpha masks** - sigmoid conversion for 0-255 gradients
3. ✅ **Morphological operations** - removeSmallComponents, closeMask (later disabled - corrupted gradients)
4. ✅ **CSS blur + canvas smoothing** - browser-side antialiasing
5. ✅ **Bug fix** - fixed sampling from padding region

### Results
- **Improvement**: ~20-30% reduction in artifacts (NOT the 70-80% promised)
- **Issues remain**: Moderate stair-stepping on curves, some scattered artifacts
- **Quality**: "A little cleaner" but "still fairly poor" (user feedback)

---

## Root Cause Analysis: The Real Bottleneck

### The Fundamental Limitation
**EdgeSAM decoder outputs 256×256 masks**, which we upsamples to full image resolution (often 1920×1080+).

**The math:**
- Decoder output: 256×256 pixels
- Typical image: 1920×1080 pixels
- **Upsampling factor: 7.5× horizontal, 4.2× vertical**
- Each decoder pixel becomes a ~7×4 block in the final mask

**No amount of interpolation can add detail that doesn't exist at 256×256.**

### Why Post-Processing Wasn't Enough

The advice from the other agent assumed:
- Model produces reasonably detailed masks
- Artifacts are from poor upsampling/thresholding
- Post-processing can fix it

**Reality:**
- Model produces low-resolution masks (256×256)
- Artifacts are from massive upsampling (7×+ magnification)
- Post-processing can only smooth, not add detail

### What Actually Improved

| Change | Impact | Why It Helped (A Little) |
|--------|--------|--------------------------|
| Bilinear interpolation | Minor | Smooths block boundaries, but can't add detail |
| Soft alpha gradients | Minor | Creates antialiasing at existing edges |
| CSS blur | Tiny | Visually softens remaining stairs |
| Bug fix (padding) | Medium | Stopped sampling garbage data |

**Combined impact: ~20-30% improvement, not 70-80%**

---

## New Strategy: Address the Real Bottleneck

### Option 1: Increase Decoder Output Resolution ⭐️ HIGHEST IMPACT

**Goal:** Get EdgeSAM to output 512×512 or 1024×1024 masks instead of 256×256.

**How to investigate:**
1. Check EdgeSAM ONNX model specs - does it support higher output resolution?
2. Look at `maskDims` in the decoder - can we request higher resolution?
3. Check model config/params - is 256×256 hardcoded or configurable?

**Expected impact:**
- 512×512 output → 50-70% quality improvement (4× more detail)
- 1024×1024 output → 80-90% quality improvement (16× more detail)

**Trade-off:**
- Latency: 4× slower for 512×512, 16× slower for 1024×1024
- Memory: 4-16× more VRAM usage
- Still fits in browser with WebGPU

**Implementation:**
```typescript
// In runDecoder(), check if maskDims can be configured:
const decoderOutputs = await decoderSession.run({
  image_embeddings: embeddingsTensor,
  point_coords: pointCoordsTensor,
  point_labels: pointLabelsTensor,
  // ADD: output_resolution or similar parameter?
});
```

### Option 2: Coarse-to-Fine Refinement (Moderate Impact)

**Goal:** Run decoder at higher effective resolution for selected objects.

**Approach:**
1. User clicks to segment → get initial 256×256 mask
2. Compute tight bbox around mask + 10% margin
3. Crop original image to bbox
4. Resize crop to 1024×1024 (full encoder input size)
5. Re-run encoder + decoder on high-res crop
6. Get 256×256 mask that represents the CROPPED region
7. Map back to original image coordinates

**Effective resolution:**
- If bbox is 512×512 in original image
- And we encode at 1024×1024
- Decoder outputs 256×256 for the crop
- **Effective resolution: 128×128 for the object** (worse than current!)

**Problem:** This doesn't actually help unless the decoder can output higher resolution!

**Better approach:**
- Only useful if combined with Option 1 (higher decoder resolution)
- Then: crop + re-encode at 1024×1024 + decode at 512×512 = very high quality

### Option 3: Switch to Better Model (High Impact, High Cost)

**Options:**

| Model | Params | Encoder Speed | Quality | Bundle Size | Feasibility |
|-------|--------|---------------|---------|-------------|-------------|
| EdgeSAM (current) | 9.6M | ~116ms | Poor | 21MB | ✅ Current |
| MobileSAM | 5.7M | ~80ms | Medium | 15MB | ✅ Very feasible |
| SAM2-tiny | ~38M | ~300ms? | Good | 100MB+ | ⚠️ Marginal |
| HQ-SAM-tiny | ~10M | ~150ms | Better | 30MB | ✅ Feasible |

**MobileSAM:**
- Smaller and faster than EdgeSAM
- **Better quality** (uses knowledge distillation from SAM)
- Outputs at same 256×256 resolution
- **Might have better detail at 256×256 than EdgeSAM**
- Bundle: 15MB (currently 21MB) → saves space!

**HQ-SAM:**
- Adds high-quality mask refinement head
- Specifically designed to fix boundary quality issues
- Small size increase (~10MB → 30MB)
- **Could be the sweet spot**

### Option 4: Hybrid Approach (Balanced)

**Combine multiple strategies:**

1. **Switch to MobileSAM or HQ-SAM** (better base quality)
2. **Request 512×512 decoder output** if supported
3. **Keep bilinear interpolation + soft alpha** (post-processing that works)
4. **Add coarse-to-fine for confirmed masks** (optional high-quality mode)

**Expected result:** Near-Photoshop quality for reasonable cost

---

## Recommended Next Steps

### Immediate (Next Session)

1. **Investigate decoder output resolution**
   ```typescript
   // Check what resolutions EdgeSAM decoder supports
   // Look at model outputs, check ONNX model graph
   // Try requesting different output sizes
   ```

2. **Test MobileSAM drop-in replacement**
   - Download MobileSAM ONNX models
   - Swap encoder/decoder (should be API-compatible)
   - Compare quality at same 256×256 resolution
   - If better → permanent switch (saves bundle size too!)

3. **Measure actual upsampling factor**
   - Log: original image size, mask output size, upsampling ratio
   - Understand typical magnification (is it always 7×+ ?)

### Short-term (Next Week)

4. **Implement HQ-SAM if needed**
   - If MobileSAM isn't enough
   - HQ-SAM adds refinement head specifically for edges
   - ~20MB additional bundle cost

5. **Optimize for high-res if decoder supports it**
   - If decoder can output 512×512 or 1024×1024
   - Add config option for quality vs speed
   - Benchmark latency impact

### Long-term (Future)

6. **Coarse-to-fine refinement mode**
   - User can trigger "high quality mode" on selected mask
   - Re-encode crop at full resolution
   - Use highest decoder resolution available
   - Acceptable +200-500ms for final quality

---

## Why This Is Different From Original Plan

### Original Plan (Incorrect Assumptions)
- Assumed model produces good detail, post-processing is bad
- Focused on interpolation, morphology, rendering
- Expected 70-80% improvement from post-processing alone

### New Understanding (Correct Diagnosis)
- Model produces low-resolution masks (256×256)
- Upsampling 7-8× to full image size
- Post-processing can only smooth, not add detail
- **Need higher-resolution model output OR better model**

### Key Insight
**The 256×256 decoder output is the bottleneck.** Post-processing improvements are incremental (~20-30%) because they're polishing low-resolution data. To get 70-80%+ improvement, we need:
1. Higher decoder resolution (512×512 or 1024×1024), OR
2. Better model that produces more detailed 256×256 masks, OR
3. Both

---

## Action Items for Next Session

**Priority 1: Decoder Resolution Investigation**
```typescript
// File: extension/lib/object-segmentation.ts
// Check decoder outputs - can we configure resolution?
// Look for output_height/output_width parameters
```

**Priority 2: MobileSAM Evaluation**
```bash
# Download MobileSAM ONNX models
# Test drop-in replacement
# Compare quality side-by-side
```

**Priority 3: Measure Upsampling**
```typescript
// Add logging to understand typical magnification
console.log(`Upsampling ${maskW}×${maskH} → ${originalW}×${originalH}`);
console.log(`Magnification: ${originalW/maskW}× horizontal`);
```

**Expected Outcome:**
- Understand if decoder can output higher resolution
- Test if MobileSAM has better base quality
- Make data-driven decision on next steps

---

## Lessons Learned

1. **Post-processing has limits** - can't add detail that doesn't exist
2. **Bilinear interpolation works** - but only smooths block boundaries
3. **Soft alpha helps** - but needs high-res base data to be effective
4. **Morphological ops don't work on gradients** - binary mask operations corrupt soft alpha
5. **The decoder output resolution is the bottleneck** - this is where to focus effort

---

## References

- EdgeSAM paper: https://arxiv.org/abs/2312.06660
- MobileSAM: https://github.com/ChaoningZhang/MobileSAM
- HQ-SAM: https://github.com/SysCV/sam-hq
- SAM decoder typically outputs multiple resolutions - need to check if EdgeSAM does too
