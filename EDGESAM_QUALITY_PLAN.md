# EdgeSAM Quality Improvement Plan

## Current State

- **Model**: EdgeSAM 3x (encoder: 21MB, decoder: 15MB)
- **Architecture**: ONNX Runtime in Web Worker with WebGPU
- **Output**: 256×256 masks upsampled to image resolution
- **Issue**: Stair-stepping and artifacts on curves due to 7-8× upsampling

## Root Cause

EdgeSAM decoder outputs 256×256 masks regardless of input size. For a 1920×1080 image, each decoder pixel becomes a ~7×4 block. Post-processing (bilinear interpolation, soft alpha) can smooth but cannot add detail.

## Options to Evaluate

### 1. MobileSAM (Recommended First)

- **Why**: Smaller (15MB), faster, potentially better quality at 256×256
- **How**: Drop-in replacement - same API as EdgeSAM
- **Test**: Compare quality side-by-side on same images

```bash
# Get MobileSAM ONNX models
# Swap encoder/decoder in lossy/assets/js/ml/object-segmentation.ts
```

### 2. SAM2-Tiny

- **Why**: Latest architecture, better quality
- **Trade-off**: Larger (~100MB), slower (~300ms)
- **Test**: Evaluate if quality gain justifies size/speed cost

### 3. HQ-SAM

- **Why**: Adds refinement head specifically for edge quality
- **Trade-off**: ~30MB total, ~150ms
- **Test**: If MobileSAM insufficient, this targets our exact problem

### 4. Higher Decoder Resolution

- **Investigate**: Can EdgeSAM/MobileSAM output 512×512?
- **If yes**: 4× more detail, ~4× slower
- **Check**: Model ONNX graph for configurable output size

## Next Steps

1. **Download MobileSAM ONNX** and test as drop-in replacement
2. **Measure quality** on representative images (curved edges, fine details)
3. **Benchmark performance** (encoder time, decoder time, total)
4. **Decide**: MobileSAM if good enough, else HQ-SAM or SAM2-tiny

## Files

- `lossy/assets/js/ml/object-segmentation.ts` - SAM encoder/decoder logic
- `lossy/assets/js/ml/sessions.ts` - ONNX session management
- `lossy/priv/static/models/` - Model files

## References

- [MobileSAM](https://github.com/ChaoningZhang/MobileSAM)
- [HQ-SAM](https://github.com/SysCV/sam-hq)
- [SAM2](https://github.com/facebookresearch/segment-anything-2)
