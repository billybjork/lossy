# Technical References

**Last Updated:** 2025-10-20

---

## Overview

This document contains essential code patterns and technical details extracted from research. Reference these when implementing Phases 6-7 (WASM inference, CLIP emoji tokens).

---

## 0. Chrome Extension Manifest V3 CSP Requirements for Transformers.js

### The Problem

Chrome Manifest V3 extensions **cannot load remotely hosted code from CDNs**. This causes Transformers.js to fail when trying to load ONNX Runtime WASM files from `https://cdn.jsdelivr.net`:

```
Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/ort-wasm-simd-threaded.jsep.mjs
```

Even adding CDN URLs to `content_security_policy.script-src` results in "Insecure CSP value" errors, as MV3 only permits: `'self'`, `'wasm-unsafe-eval'`, and `'none'`.

### The Solution: Bundle WASM Files Locally

#### 1. Webpack Configuration

Copy ONNX Runtime WASM files from `node_modules` to your extension's dist folder:

```javascript
// webpack.config.js
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  plugins: [
    new CopyPlugin({
      patterns: [
        // Copy ONNX Runtime WASM files for local bundling
        {
          from: 'node_modules/onnxruntime-web/dist/*.wasm',
          to: 'onnx/[name][ext]',
        },
        {
          from: 'node_modules/onnxruntime-web/dist/*.mjs',
          to: 'onnx/[name][ext]',
        },
      ],
    }),
  ],
};
```

#### 2. Configure Transformers.js to Use Local WASM

```javascript
// offscreen/whisper-loader.js (or wherever you load Transformers.js)
const { pipeline, env } = await import('@huggingface/transformers');

// CRITICAL: Point to bundled local WASM files
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('onnx/');

// Required workaround for Chrome extension threading bug
env.backends.onnx.wasm.numThreads = 1;

console.log('[WhisperLoader] ONNX Runtime configured for local WASM:', env.backends.onnx.wasm.wasmPaths);
```

#### 3. Manifest.json Configuration

**CSP (Content Security Policy):**
```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' ws://localhost:4000 https://huggingface.co https://cdn-lfs.huggingface.co https://*.huggingface.co https://*.hf.co"
  }
}
```

**Notes:**
- `'wasm-unsafe-eval'` is **required** for WebAssembly execution
- No CDN URLs in `script-src` (MV3 disallows them)
- HuggingFace URLs in `connect-src` are still needed to download model weights
- **DO NOT** include `https://cdn.jsdelivr.net` in `script-src`

**Web Accessible Resources:**
```json
{
  "web_accessible_resources": [
    {
      "resources": ["dist/*", "onnx/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

#### 4. Required WASM Files (Bundled Size)

After webpack build, you'll have:
- `onnx/ort-wasm-simd-threaded.jsep.wasm` (20.6 MB) - WebGPU version
- `onnx/ort-wasm-simd-threaded.jsep.mjs` (43 KB) - WebGPU module loader
- `onnx/ort-wasm-simd-threaded.wasm` (10.6 MB) - WASM fallback
- `onnx/ort-wasm-simd-threaded.mjs` (20 KB) - WASM module loader
- Various `ort.*.mjs` helper modules

**Total bundled size:** ~32 MB of WASM files (acceptable for Chrome Web Store)

### References

- Issue #1248: Transformers.js in chrome extension fails to execute remote code
- Issue #839: Extension rejected from Chrome Web Store for "including remotely hosted code"
- Medium: "🤗 Transformers.js + ONNX Runtime WebGPU in Chrome extension" by Wei Lu

---

## 1. WebGPU Detection & Fallback

```javascript
// Detect WebGPU availability
async function getExecutionProvider() {
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        return 'webgpu';
      }
    } catch (e) {
      console.warn('WebGPU not available:', e);
    }
  }
  return 'wasm';
}
```

**Browser Support (2025):**
- Chrome 113+, Edge 113+ (full support)
- Chrome 121+ for FP16 (3x faster than FP32)
- Firefox: behind flag
- Safari: Technology Preview

---

## 2. Transformers.js Setup for SigLIP/CLIP

### Recommended Models

For 384-512px frames, use:
- `Xenova/siglip-base-patch16-384` (recommended)
- `Xenova/siglip-base-patch16-512` (higher quality)
- `Xenova/siglip-base-patch16-224` (fastest)

### Basic Setup

```javascript
import {
  AutoProcessor,
  SiglipVisionModel,
  SiglipTextModel,
  AutoTokenizer
} from '@huggingface/transformers';

// Initialize with automatic WebGPU/WASM fallback
async function initializeModels() {
  const device = await getExecutionProvider();
  const dtype = device === 'webgpu' ? 'fp16' : 'int8';

  const [processor, visionModel, tokenizer, textModel] = await Promise.all([
    AutoProcessor.from_pretrained('Xenova/siglip-base-patch16-384'),
    SiglipVisionModel.from_pretrained('Xenova/siglip-base-patch16-384', {
      device: device,
      dtype: dtype
    }),
    AutoTokenizer.from_pretrained('Xenova/siglip-base-patch16-384'),
    SiglipTextModel.from_pretrained('Xenova/siglip-base-patch16-384', {
      device: device,
      dtype: dtype
    })
  ]);

  return { processor, visionModel, tokenizer, textModel, device, dtype };
}
```

### Performance Expectations

| Hardware | Image (384px) | Text (32 tokens) | Total |
|----------|---------------|------------------|-------|
| RTX 3060/M1 Max (WebGPU) | 50-100ms | 10-20ms | 60-120ms |
| Integrated GPU (WebGPU) | 150-300ms | 20-40ms | 170-340ms |
| CPU (WASM + INT8) | 500-1500ms | 100-300ms | 600-1800ms |

---

## 3. Complete Dual Encoder Implementation

```javascript
class DualEncoderEmbedding {
  constructor() {
    this.visionModel = null;
    this.textModel = null;
    this.processor = null;
    this.tokenizer = null;
    this.device = 'webgpu';
    this.dtype = 'fp16';
  }

  async initialize(modelName = 'Xenova/siglip-base-patch16-384') {
    // Detect WebGPU
    if (!('gpu' in navigator)) {
      this.device = 'wasm';
      this.dtype = 'int8';
    }

    // Load models in parallel
    const [processor, visionModel, tokenizer, textModel] = await Promise.all([
      AutoProcessor.from_pretrained(modelName),
      SiglipVisionModel.from_pretrained(modelName, {
        device: this.device,
        dtype: this.dtype
      }),
      AutoTokenizer.from_pretrained(modelName),
      SiglipTextModel.from_pretrained(modelName, {
        device: this.device,
        dtype: this.dtype
      })
    ]);

    this.processor = processor;
    this.visionModel = visionModel;
    this.tokenizer = tokenizer;
    this.textModel = textModel;
  }

  async getImageEmbedding(imageSource) {
    const startTime = performance.now();

    // Load image (from URL, File, Canvas, Blob, or video frame)
    const image = await RawImage.read(imageSource);

    // Preprocess
    const imageInputs = await this.processor(image);

    // Generate embedding
    const { pooler_output } = await this.visionModel(imageInputs);

    console.log(`Image embedding took ${(performance.now() - startTime).toFixed(1)}ms`);

    // Return as normalized array
    return this.normalizeEmbedding(Array.from(pooler_output.data));
  }

  async getTextEmbedding(text) {
    const startTime = performance.now();

    // Tokenize (automatically truncates to 64 tokens)
    const textInputs = this.tokenizer(text, {
      padding: 'max_length',
      truncation: true,
      max_length: 64
    });

    // Generate embedding
    const { pooler_output } = await this.textModel(textInputs);

    console.log(`Text embedding took ${(performance.now() - startTime).toFixed(1)}ms`);

    return this.normalizeEmbedding(Array.from(pooler_output.data));
  }

  async getTextEmbeddings(texts) {
    // Batch process multiple texts (more efficient)
    const textInputs = this.tokenizer(texts, {
      padding: 'max_length',
      truncation: true,
      max_length: 64
    });

    const { pooler_output } = await this.textModel(textInputs);

    // Split batch embeddings
    const embeddingDim = pooler_output.data.length / texts.length;
    return texts.map((_, i) => {
      const start = i * embeddingDim;
      const end = start + embeddingDim;
      return this.normalizeEmbedding(Array.from(pooler_output.data.slice(start, end)));
    });
  }

  normalizeEmbedding(embedding) {
    // L2 normalization for cosine similarity
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / norm);
  }

  cosineSimilarity(embedding1, embedding2) {
    // For normalized embeddings, cosine similarity is just dot product
    return embedding1.reduce((sum, val, i) => sum + val * embedding2[i], 0);
  }
}
```

### Usage Example: Video Frame + Emoji Categories

```javascript
// Initialize embedder
const embedder = new DualEncoderEmbedding();
await embedder.initialize();

// Emoji categories (compute text embeddings once at startup)
const emojiCategories = [
  { emoji: '⏩', text: 'fast pacing' },
  { emoji: '🐌', text: 'slow pacing' },
  { emoji: '✂️', text: 'cut transition' },
  { emoji: '🎨', text: 'color grading' },
  { emoji: '💡', text: 'lighting' },
  { emoji: '🔊', text: 'audio level' },
  { emoji: '🎵', text: 'music' },
  { emoji: '📝', text: 'text overlay' }
];

const categoryTexts = emojiCategories.map(c => c.text);
const textEmbeddings = await embedder.getTextEmbeddings(categoryTexts);

// Capture video frame and match
async function analyzeFrame(videoElement) {
  // Capture frame to canvas
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, 384, 384);

  // Convert to blob
  const blob = await new Promise(resolve =>
    canvas.toBlob(resolve, 'image/jpeg', 0.95)
  );

  // Get image embedding
  const imageEmb = await embedder.getImageEmbedding(blob);

  // Find top matches
  const scores = textEmbeddings.map((textEmb, i) => ({
    emoji: emojiCategories[i].emoji,
    category: emojiCategories[i].text,
    score: embedder.cosineSimilarity(imageEmb, textEmb)
  }));

  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, 2); // Return top 2 matches
}
```

---

## 4. Model Caching Patterns

### Cache API (Recommended for Models)

```javascript
async function loadModelWithCache(modelName) {
  const cacheName = 'onnx-models-v1';
  const cache = await caches.open(cacheName);

  // Try cache first
  const cachedResponse = await cache.match(modelName);
  if (cachedResponse) {
    return await cachedResponse.arrayBuffer();
  }

  // Download and cache
  const response = await fetch(modelName);
  await cache.put(modelName, response.clone());
  return await response.arrayBuffer();
}
```

### IndexedDB (For Binary Model Data)

```javascript
async function saveModelToIndexedDB(modelName, modelData) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ModelCache', 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('models')) {
        db.createObjectStore('models');
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(['models'], 'readwrite');
      const store = transaction.objectStore('models');
      store.put(modelData, modelName);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };

    request.onerror = () => reject(request.error);
  });
}

async function loadModelFromIndexedDB(modelName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ModelCache', 1);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(['models'], 'readonly');
      const store = transaction.objectStore('models');
      const getRequest = store.get(modelName);

      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    };

    request.onerror = () => reject(request.error);
  });
}
```

### Progress Indicator

```javascript
async function loadModelWithProgress(url, onProgress) {
  const response = await fetch(url);
  const contentLength = +response.headers.get('Content-Length');

  let loaded = 0;
  const reader = response.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;

    if (onProgress) {
      onProgress(loaded / contentLength);
    }
  }

  // Concatenate chunks
  const allChunks = new Uint8Array(loaded);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }

  return allChunks.buffer;
}
```

---

## 5. Web Worker Pattern (Non-blocking Inference)

### Main Thread

```javascript
// main.js
const worker = new Worker('embedding-worker.js', { type: 'module' });

function getEmbedding(imageData) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();

    worker.addEventListener('message', function handler(e) {
      if (e.data.id === id) {
        worker.removeEventListener('message', handler);
        resolve(e.data.embedding);
      }
    });

    worker.postMessage({ id, imageData });
  });
}

// Usage
const videoFrame = captureVideoFrame();
const embedding = await getEmbedding(videoFrame);
```

### Worker Thread

```javascript
// embedding-worker.js
import { DualEncoderEmbedding } from './embedding.js';

let embedder = null;

self.addEventListener('message', async (e) => {
  // Lazy initialize
  if (!embedder) {
    embedder = new DualEncoderEmbedding();
    await embedder.initialize();
    self.postMessage({ type: 'ready' });
  }

  const { id, imageData } = e.data;
  const embedding = await embedder.getImageEmbedding(imageData);

  self.postMessage({ id, embedding });
});
```

---

## 6. Video Frame Capture (Efficient)

```javascript
// Capture frame from video element
async function captureVideoFrame(videoElement, targetSize = 384) {
  return new Promise((resolve) => {
    videoElement.requestVideoFrameCallback(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');

      // Draw video frame (maintains aspect ratio)
      ctx.drawImage(videoElement, 0, 0, targetSize, targetSize);

      // Convert to blob (WebP for smaller size)
      canvas.toBlob(blob => resolve(blob), 'image/webp', 0.85);
    });
  });
}
```

---

## 7. Whisper Integration (Phase 6)

### Transformers.js Whisper

```javascript
import { pipeline } from '@huggingface/transformers';

// Initialize Whisper pipeline
const transcriber = await pipeline(
  'automatic-speech-recognition',
  'Xenova/whisper-tiny.en',
  {
    device: 'webgpu',  // Falls back to WASM automatically
    dtype: 'fp16'
  }
);

// Transcribe audio
async function transcribeAudio(audioData) {
  const startTime = performance.now();

  const result = await transcriber(audioData, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: 'word'
  });

  console.log(`Transcription took ${(performance.now() - startTime).toFixed(1)}ms`);

  return {
    text: result.text,
    chunks: result.chunks
  };
}
```

**Expected Performance:**
- WebGPU: 100-300ms for 5s audio
- WASM: 500-2000ms for 5s audio

---

## 8. Model Quantization Guide

### Quantization Options

| Format | Size | Speed | Accuracy | Use Case |
|--------|------|-------|----------|----------|
| FP32 | 100% | 1x | 100% | Not recommended |
| FP16 | 50% | 2-3x | 99.9% | **WebGPU (recommended)** |
| INT8 | 25% | 3-4x | 98-99% | **WASM fallback** |
| Q4 | 12.5% | 4-5x | 95-97% | Very constrained |

### Transformers.js Quantization

```javascript
// Automatically selects best quantization per device
const model = await SiglipVisionModel.from_pretrained(
  'Xenova/siglip-base-patch16-384',
  {
    device: 'webgpu',
    dtype: 'fp16'  // or 'fp32', 'int8', 'q4'
  }
);
```

---

## 9. Key Architecture Decisions

### For Phase 6 (WASM Whisper):
1. Use **Transformers.js** (not raw ONNX Runtime Web) - simpler API
2. Initialize in **offscreen document** (MV3 requirement for Web Workers)
3. WebGPU first, WASM fallback automatic
4. Keep cloud Whisper API as backup for accuracy

### For Phase 7 (CLIP Emoji Tokens):
1. Use **SigLIP-base-patch16-384** (better than CLIP per Google research)
2. Pre-compute text embeddings for emoji categories at startup
3. Run inference in **Web Worker** to avoid blocking UI
4. Capture frames at 224-384px (balance speed/quality)
5. Cache text embeddings, only compute image embeddings on demand

---

## 10. Performance Optimization Checklist

- [ ] **Preload models** on extension install, not first use
- [ ] **Use Cache API** or IndexedDB for model storage
- [ ] **Batch text embeddings** when possible (single inference for multiple texts)
- [ ] **Process on Web Workers** to keep UI responsive
- [ ] **WebGPU detection** with automatic WASM fallback
- [ ] **FP16 quantization** for WebGPU (3x faster than FP32)
- [ ] **INT8 quantization** for WASM fallback
- [ ] **Monitor latency** with performance.now() and adjust strategy
- [ ] **Frame skipping** if processing lags behind real-time

---

## 11. Useful Links

### Documentation
- **Transformers.js**: https://huggingface.co/docs/transformers.js/
- **ONNX Runtime Web**: https://onnxruntime.ai/docs/tutorials/web/
- **WebGPU Guide**: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html

### Models
- **Xenova Models**: https://huggingface.co/Xenova
- **ONNX Community**: https://huggingface.co/onnx-community

### Examples
- **WebGPU Benchmark**: https://huggingface.co/spaces/Xenova/webgpu-embedding-benchmark
- **Transformers.js Examples**: https://github.com/huggingface/transformers.js-examples

---

## 12. Sprint 07: Local Transcription Feature Flags

### Manual Override Procedure

#### Extension Settings (Client-Side)

The extension stores the local STT preference in `chrome.storage.local`:

```javascript
import { setLocalSttMode, LOCAL_STT_MODES } from './src/shared/settings.js';

// Default: Auto (try local, fall back to cloud)
await setLocalSttMode(LOCAL_STT_MODES.AUTO);

// Force local only (fail if unavailable)
await setLocalSttMode(LOCAL_STT_MODES.FORCE_LOCAL);

// Force cloud only (bypass local)
await setLocalSttMode(LOCAL_STT_MODES.FORCE_CLOUD);
```

**Via DevTools Console (chrome-extension context):**
```javascript
// Get current settings
chrome.storage.local.get('settings', (result) => console.log(result));

// Force cloud transcription
chrome.storage.local.set({
  settings: {
    features: {
      localSttEnabled: 'force_cloud'
    }
  }
});

// Reset to auto
chrome.storage.local.set({
  settings: {
    features: {
      localSttEnabled: 'auto'
    }
  }
});
```

#### Backend Configuration (Server-Side)

Add to `.env` file (in repo root):

```bash
# Local STT Configuration
# Set to "false" to disable local transcription server-side
# Default: "true" (accepts client-supplied transcripts)
LOCAL_STT_ENABLED=true
```

**Production Override:**
```bash
# Disable local STT in production
LOCAL_STT_ENABLED=false mix phx.server
```

**Runtime Check (IEx):**
```elixir
# Check if local STT is enabled
Application.get_env(:lossy, :local_stt_enabled)
# => true

# Temporarily disable (does not persist)
Application.put_env(:lossy, :local_stt_enabled, false)
```

### Debugging Local Transcription

**Enable verbose logging in offscreen document:**
```javascript
// In extension/src/offscreen/offscreen.js
localStorage.setItem('debug_whisper', 'true');

// Disable
localStorage.removeItem('debug_whisper');
```

**Check transcription source in backend logs:**
```bash
# Backend will log:
[info] [session_abc123] Transcription source: :local
[info] [session_abc123] Transcription source: :cloud
```

**Monitor circuit breaker state:**
```elixir
# In IEx console
alias Lossy.Inference.CircuitBreaker

# Check failure count for a device
CircuitBreaker.get_failure_count("device_fingerprint_xyz")

# Reset circuit breaker
CircuitBreaker.reset("device_fingerprint_xyz")
```

---

## When to Reference This Document

- **Sprint 07 (Complete)**: Local Whisper transcription with cloud fallback - see [archive](./sprints/archive/SPRINT_07_local_transcription.md)
- **Sprint 08 (Complete)**: GPT-4o Vision integration - see [archive](./sprints/archive/SPRINT_08_siglip_vision.md)
- **Sprint TBD (Planned)**: Text-based emoji chips - see [planned](./sprints/planned/SPRINT_TBD_emoji_chips.md)
- **Performance tuning**: When optimizing inference speed
- **Debugging**: WebGPU/WASM fallback issues, local/cloud routing
- **Feature flag management**: Enabling/disabling local STT
