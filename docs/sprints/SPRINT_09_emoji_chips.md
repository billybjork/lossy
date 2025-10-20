# Sprint 09: Emoji Chips - Visual Feedback Tokens

**Status:** 🟡 Planning (Not Started)
**Duration:** 3-5 days
**Owner:** Extension (primarily client-side)
**Progress:** 0% - Rough plan, to be refined
**Related Sprints:**
- ✅ Sprint 08 – GPT-4o Vision Integration (cloud-based note refinement)
- ✅ Sprint 07 – Local Transcription (offscreen document patterns, model loading)
- 🔜 Sprint 10 – Semantic Search (pgvector + embeddings)
- 🔜 Sprint TBD – Real-time Voice Feedback (wake word, continuous listening)

---

## Goal

Implement real-time visual feedback "emoji chips" that appear during video recording/playback, using locally-generated SigLIP embeddings to categorize what's happening on screen. This provides instant visual context to the user about the video content they're commenting on, without blocking the voice-to-text flow.

### Success Metrics

- 🎯 Emoji chip appears within 200ms of visual change detection
- 🎯 Background embedding generation ≤ 150ms (WebGPU)
- 🎯 No impact on voice recording latency (fully async)
- 🎯 Accurate categorization (≥70% match with user expectations)
- 📊 Smooth UX: chips fade in/out, don't obstruct video

---

## Vision

**User Experience:**
1. User starts recording feedback while watching video
2. As video plays, small emoji chips appear near the video timeline or in corner
3. Chips show visual context: 🎨 (color grading), 📊 (charts/data), 💬 (text overlays), 🎬 (editing cuts)
4. User speaks: "This section feels too dark"
5. Visual chip 🌑 confirms the system detected dark visuals
6. Creates confidence that the system understands context

**Technical Flow:**
```
Video playing → Background frame capture (every 2s) → SigLIP embedding →
Similarity matching vs. predefined categories → Display top emoji chip →
Fade out after 3s or when category changes
```

**Non-goals (for Sprint 09):**
- ❌ Not using embeddings to modify note text (that's Sprint 08 "Refine with Vision")
- ❌ Not semantic search (that's Sprint 10 with pgvector)
- ❌ Not continuous visual monitoring during playback (only during active recording)

---

## Prerequisites

- ✅ Sprint 07 completed: Offscreen document pattern established, WebGPU capability detection
- ✅ Sprint 08 completed: FrameCapturer module available (with 224x224 mode for embeddings)
- ✅ GPU coordination pattern: Prevent concurrent Whisper + SigLIP operations
- Feature flag: `features.emojiChipsEnabled` (default: true)

---

## SigLIP Model Integration

**Important:** Sprint 08 pivoted from local SigLIP embeddings to GPT-4o Vision API. Sprint 09 is the **first sprint** to implement local SigLIP embedding generation in the browser.

### Model Details

- **Model:** `Xenova/clip-vit-base-patch32` (SigLIP variant from Hugging Face)
- **Input:** 224×224 RGB images OR text descriptions
- **Output:** 768-dimensional embeddings (L2-normalized)
- **Size:** ~350MB (vision + text encoders)
- **Runtime:** WebGPU (preferred) or WASM (fallback)

### Offscreen Document Loading Pattern

Following Sprint 07's Whisper pattern, SigLIP will load in the offscreen document:

**File:** `extension/src/offscreen/siglip-worker.js` (NEW)

```javascript
import { pipeline, env } from '@huggingface/transformers';

// Configure for extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let visionModel = null;
let textModel = null;
let isLoading = false;

/**
 * Load SigLIP vision and text encoders.
 * Called on extension startup or first use.
 */
export async function loadSigLIPModels() {
  if (visionModel && textModel) {
    console.log('[SigLIP] Models already loaded');
    return { success: true };
  }

  if (isLoading) {
    console.log('[SigLIP] Models currently loading, skipping duplicate request');
    return { success: false, reason: 'already_loading' };
  }

  isLoading = true;

  try {
    console.log('[SigLIP] Loading vision encoder...');
    visionModel = await pipeline(
      'image-feature-extraction',
      'Xenova/clip-vit-base-patch32',
      { device: 'webgpu' }  // Will auto-fallback to WASM if WebGPU unavailable
    );

    console.log('[SigLIP] Loading text encoder...');
    textModel = await pipeline(
      'feature-extraction',
      'Xenova/clip-vit-base-patch32',
      { device: 'webgpu' }
    );

    console.log('[SigLIP] ✅ Models loaded successfully');
    isLoading = false;
    return { success: true };
  } catch (error) {
    console.error('[SigLIP] ❌ Failed to load models:', error);
    isLoading = false;
    return { success: false, error: error.message };
  }
}

/**
 * Generate image embedding from ImageData.
 * @param {ImageData} imageData - 224x224 RGB image data
 * @returns {Promise<{embedding: Float32Array}>}
 */
export async function generateImageEmbedding(imageData) {
  if (!visionModel) {
    throw new Error('SigLIP vision model not loaded');
  }

  console.log('[SigLIP] Generating image embedding...');
  const startTime = performance.now();

  const output = await visionModel(imageData, {
    pooling: 'mean',
    normalize: true,
  });

  const embedding = output.data; // Float32Array (768 dimensions)
  const latency = performance.now() - startTime;

  console.log(`[SigLIP] ✅ Image embedding generated in ${latency.toFixed(0)}ms`);

  return { embedding: Array.from(embedding), latency };
}

/**
 * Generate text embedding from category description.
 * @param {string} text - Category description
 * @returns {Promise<{embedding: Float32Array}>}
 */
export async function generateTextEmbedding(text) {
  if (!textModel) {
    throw new Error('SigLIP text model not loaded');
  }

  console.log('[SigLIP] Generating text embedding for:', text);
  const startTime = performance.now();

  const output = await textModel(text, {
    pooling: 'mean',
    normalize: true,
  });

  const embedding = output.data;
  const latency = performance.now() - startTime;

  console.log(`[SigLIP] ✅ Text embedding generated in ${latency.toFixed(0)}ms`);

  return { embedding: Array.from(embedding), latency };
}

/**
 * Unload models to free memory.
 */
export async function unloadSigLIPModels() {
  visionModel = null;
  textModel = null;
  console.log('[SigLIP] Models unloaded');
}
```

### GPU Coordination Strategy

**Challenge:** Prevent concurrent Whisper + SigLIP operations (both use WebGPU).

**Solution:** Client-side job queue in service worker (simpler than backend Oban queue).

**File:** `extension/src/background/gpu-coordinator.js` (NEW)

```javascript
/**
 * Simple client-side GPU job queue to prevent concurrent model operations.
 *
 * Priority:
 * - HIGH: Whisper transcription (never block voice)
 * - LOW: SigLIP embeddings (skip if queue busy)
 */
class GPUCoordinator {
  constructor() {
    this.isWhisperBusy = false;
    this.isSigLIPBusy = false;
  }

  /**
   * Request GPU access for Whisper transcription.
   * Always granted (highest priority).
   */
  async requestWhisper(fn) {
    while (this.isWhisperBusy || this.isSigLIPBusy) {
      await this.sleep(50); // Wait for GPU to be free
    }

    this.isWhisperBusy = true;
    try {
      return await fn();
    } finally {
      this.isWhisperBusy = false;
    }
  }

  /**
   * Request GPU access for SigLIP embedding generation.
   * Skipped if Whisper is busy (low priority).
   */
  async requestSigLIP(fn) {
    if (this.isWhisperBusy || this.isSigLIPBusy) {
      console.log('[GPUCoordinator] SigLIP skipped (GPU busy with Whisper)');
      return { skipped: true };
    }

    this.isSigLIPBusy = true;
    try {
      return await fn();
    } finally {
      this.isSigLIPBusy = false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const gpuCoordinator = new GPUCoordinator();
```

### Capability Detection

Detect WebGPU availability on extension startup:

```javascript
// In service-worker.js
chrome.runtime.onInstalled.addListener(async () => {
  const hasWebGPU = await detectWebGPU();

  await chrome.storage.local.set({
    capabilities: {
      webgpu: hasWebGPU,
      fallback: hasWebGPU ? 'none' : 'wasm',
    },
  });

  console.log(`[Capabilities] WebGPU: ${hasWebGPU ? 'Available' : 'Not available (will use WASM)'}`);
});

async function detectWebGPU() {
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'detect_webgpu',
  });

  return response?.hasWebGPU || false;
}
```

---

## Technical Architecture

### Component Breakdown

**1. Emoji Category Definition** (`extension/src/shared/emoji-categories.js`)
- Predefined list of visual categories with emoji, description, and keywords
- Examples:
  ```javascript
  {
    emoji: '🎨',
    category: 'color_grading',
    description: 'color grading, color correction, saturation, hue',
    textEmbedding: null // Populated at extension startup
  }
  ```
- Categories cover: editing, visual effects, UI elements, composition, lighting, text, motion

**2. Category Embedding Precomputation** (Extension Startup)
- On extension install/update, generate text embeddings for all categories
- Store embeddings in `chrome.storage.local` for fast access
- Use SigLIP text encoder (same model as vision encoder)
- Invalidate cache when model version changes

**3. Background Frame Monitoring** (`extension/src/content/emoji-chip-monitor.js`)
- Only active during recording (triggered by mic button)
- Captures frame every 2 seconds (configurable interval)
- Sends to offscreen for embedding generation (non-blocking)
- Compares embedding to category embeddings (cosine similarity)
- Displays emoji chip if confidence > 0.6

**4. Emoji Chip Rendering** (`extension/src/content/overlays/emoji-chip.js`)
- Shadow DOM overlay (isolated from page styles)
- Position: Top-right corner of video or near timeline
- Animation: Fade in (200ms), hold (3s), fade out (500ms)
- Replace previous chip if new category detected within 3s

**5. GPU Job Queue Integration**
- Priority: LOW (never blocks voice transcription)
- Skip frame if queue busy (Whisper has priority)
- Degrade gracefully: no chip displayed if can't process in time

---

## Deliverables

### Frontend (Extension)
- [ ] SigLIP model loading in offscreen document (vision + text encoders)
- [ ] GPU coordination queue (prevent Whisper + SigLIP conflicts)
- [ ] Emoji category taxonomy (15-25 categories covering common video feedback scenarios)
- [ ] Category text embedding precomputation on extension startup
- [ ] Background frame capture scheduler (interval-based, pauses when not recording)
- [ ] Similarity matching algorithm (cosine similarity with threshold)
- [ ] Emoji chip UI component (Shadow DOM, animations, positioning)
- [ ] Integration with recording lifecycle (start monitoring on mic press, stop on release)
- [ ] Feature flag toggle in settings
- [ ] Performance monitoring (embedding latency, UI frame rate impact)

### Backend (Phoenix) - Optional for Sprint 09
- [ ] Database migration: Add `visual_embedding` field to notes table (pgvector extension)
- [ ] Store embeddings alongside notes for future semantic search (Sprint 10)
- [ ] Note: Embedding storage is optional for Sprint 09 MVP - can defer to Sprint 10

**Database Schema (for reference):**

Sprint 08 already added `visual_context` field to notes:

```elixir
# lossy/lib/lossy/videos/note.ex

field :visual_context, :map
# Format: %{
#   embedding: [768 floats],      # SigLIP embedding (added in Sprint 09)
#   timestamp: float,              # Video timestamp when captured
#   source: "local" | "cloud",     # Always "local" for Sprint 09
#   device: "webgpu" | "wasm",     # Inference runtime
#   emoji_category: string         # Matched emoji category ID
# }

field :enrichment_source, :string, default: "none"
# Updated in Sprint 09 to include "siglip_local"
# Values: "none" | "siglip_local" | "siglip_cloud" | "gpt4o_vision" | "manual"
```

**Note:** Sprint 09 can store embeddings in `visual_context` JSON field. Sprint 10 will migrate to dedicated `pgvector` column for efficient similarity search.

---

## Proposed Emoji Categories

Based on common video feedback patterns:

### Visual & Composition
- 🎨 Color grading/correction
- 🌅 Lighting/exposure
- 📐 Framing/composition
- 🔍 Focus/sharpness
- 🌊 Motion blur/camera movement

### Editing & Transitions
- ✂️ Cut/edit point
- 🔀 Transition effect
- ⏩ Pacing/speed
- 🎞️ B-roll/cutaway

### UI & Graphics
- 💬 Text overlay/subtitle
- 📊 Chart/graph/data visualization
- 🎯 Call-to-action/button
- 🖼️ Lower third/graphic

### Audio/Visual Sync
- 🔊 Audio waveform visible
- 🎵 Music/soundtrack
- 🎤 Person speaking (on camera)

### Technical
- 📱 Screen recording/demo
- 💻 Code/terminal
- 🖱️ Cursor/pointer visible

### Sentiment/Style
- 😊 Positive/upbeat visuals
- 😐 Neutral/corporate
- 🌑 Dark/moody

---

## Technical Tasks

### Task 1: Define Emoji Category Taxonomy

**Files:** `extension/src/shared/emoji-categories.js` (NEW)

**Deliverable:**
```javascript
export const EMOJI_CATEGORIES = [
  {
    id: 'color_grading',
    emoji: '🎨',
    label: 'Color Grading',
    description: 'vibrant colors, saturation, color correction, grading, hue shift',
  },
  {
    id: 'lighting',
    emoji: '🌅',
    label: 'Lighting',
    description: 'bright lighting, exposure, highlights, shadows, contrast',
  },
  // ... 15-25 total categories
];
```

**Decision points:**
- How many categories? (Recommendation: Start with 15, expand based on usage)
- Which categories are most useful for video feedback?
- Should we allow user-defined categories later?

### Task 2: Precompute Category Text Embeddings

**Files:**
- `extension/src/offscreen/emoji-category-loader.js` (NEW)
- `extension/src/background/service-worker.js` (MODIFY - trigger on install)

**Flow:**
1. Extension installs/updates
2. Service worker triggers SigLIP model download + category embedding generation
3. Offscreen loads SigLIP text model (downloads ~350MB on first run)
4. Batch process all category descriptions
5. Store embeddings in `chrome.storage.local`
6. Cache invalidation on model version change

**Model Preloading Pattern (from Sprint 08):**

Following the pattern established in Sprint 08 (commit 11ea3bd), preload SigLIP models on extension install to avoid latency on first use:

```javascript
// In service-worker.js
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('[Install] Preloading SigLIP models...');

    // Create offscreen document if not exists
    await ensureOffscreenDocument();

    // Trigger model download + category embedding generation
    await preloadSigLIPModels();
  }
});

async function preloadSigLIPModels() {
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'preload_siglip_models',
    });

    if (response?.success) {
      console.log('[Install] ✅ SigLIP models preloaded');
      await precomputeCategoryEmbeddings();
    }
  } catch (error) {
    console.error('[Install] ❌ Failed to preload SigLIP:', error);
    // Non-fatal: models will download on first use instead
  }
}
```

**Benefits:**
- No latency on first emoji chip display
- User sees "Installing extension..." progress in Chrome
- Models cached in browser storage for future sessions

**Code Pattern:**
```javascript
// Triggered on extension install
chrome.runtime.onInstalled.addListener(async () => {
  await precomputeCategoryEmbeddings();
});

async function precomputeCategoryEmbeddings() {
  const cached = await chrome.storage.local.get('categoryEmbeddings');

  if (cached.categoryEmbeddings?.version === CURRENT_MODEL_VERSION) {
    console.log('[EmojiChips] Using cached category embeddings');
    return;
  }

  console.log('[EmojiChips] Computing category embeddings...');

  // Send to offscreen for processing
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'compute_category_embeddings',
    categories: EMOJI_CATEGORIES,
  });

  // Store in cache
  await chrome.storage.local.set({
    categoryEmbeddings: {
      version: CURRENT_MODEL_VERSION,
      embeddings: response.embeddings,
      timestamp: Date.now(),
    },
  });
}
```

### Task 3: Background Frame Monitoring

**Files:** `extension/src/content/emoji-chip-monitor.js` (NEW)

**Lifecycle:**
- Start: User presses mic button (recording starts)
- Stop: User releases mic button (recording stops)
- Interval: Capture frame every 2 seconds (configurable)

**Integration with existing code:**
- Hook into `AudioRecorder` lifecycle
- Use existing `FrameCapturer` for frame capture
- Send to offscreen via service worker

**Code Pattern:**
```javascript
export class EmojiChipMonitor {
  constructor(videoElement, emojiChipRenderer) {
    this.videoElement = videoElement;
    this.renderer = emojiChipRenderer;
    this.intervalId = null;
    this.isActive = false;
  }

  start() {
    if (this.isActive) return;

    this.isActive = true;
    console.log('[EmojiChips] Starting background monitoring');

    // Immediate first capture
    this.captureAndAnalyze();

    // Then every 2 seconds
    this.intervalId = setInterval(() => {
      this.captureAndAnalyze();
    }, 2000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isActive = false;
    console.log('[EmojiChips] Stopped background monitoring');
  }

  async captureAndAnalyze() {
    try {
      // Capture frame at 224x224 (SigLIP input size)
      // NOTE: This is different from GPT-4o Vision which uses preserveAspectRatio mode
      const capturer = new FrameCapturer(this.videoElement, {
        targetWidth: 224,
        targetHeight: 224,
        preserveAspectRatio: false,  // SigLIP expects square input
      });
      const { imageData, timestamp } = await capturer.captureCurrentFrame();

      // Send to background for processing (non-blocking)
      chrome.runtime.sendMessage({
        action: 'analyze_frame_for_emoji',
        imageData,
        timestamp,
      }, (response) => {
        if (response?.emoji) {
          this.renderer.showChip(response.emoji, response.confidence);
        }
      });

      capturer.destroy();
    } catch (error) {
      console.warn('[EmojiChips] Frame capture failed:', error);
      // Don't stop monitoring, just skip this frame
    }
  }
}
```

### Task 4: Similarity Matching & Category Selection

**Files:** `extension/src/offscreen/emoji-matcher.js` (NEW)

**Algorithm:**
1. Receive frame embedding from SigLIP vision encoder
2. Load cached category text embeddings
3. Compute cosine similarity between frame embedding and each category embedding
4. Return top match if confidence > 0.6
5. Optional: Return top 2 if both > 0.5 (show multiple chips)

**Code Pattern:**
```javascript
export async function matchEmojiCategory(frameEmbedding) {
  // Load cached category embeddings
  const { categoryEmbeddings } = await chrome.storage.local.get('categoryEmbeddings');

  if (!categoryEmbeddings) {
    console.warn('[EmojiMatcher] No cached category embeddings');
    return null;
  }

  // Compute similarities
  const similarities = categoryEmbeddings.embeddings.map((catEmb, idx) => ({
    category: EMOJI_CATEGORIES[idx],
    similarity: cosineSimilarity(frameEmbedding, catEmb),
  }));

  // Sort by similarity
  similarities.sort((a, b) => b.similarity - a.similarity);

  const topMatch = similarities[0];

  if (topMatch.similarity > 0.6) {
    return {
      emoji: topMatch.category.emoji,
      label: topMatch.category.label,
      confidence: topMatch.similarity,
    };
  }

  return null; // No confident match
}

function cosineSimilarity(embA, embB) {
  // Assumes embeddings are already L2-normalized
  let dotProduct = 0;
  for (let i = 0; i < embA.length; i++) {
    dotProduct += embA[i] * embB[i];
  }
  return dotProduct;
}
```

### Task 5: Emoji Chip UI Component

**Files:**
- `extension/src/content/overlays/emoji-chip.js` (NEW)
- `extension/src/content/overlays/emoji-chip.css` (NEW)

**Design:**
- Shadow DOM for style isolation
- Position: Top-right corner of video (or configurable)
- Size: 40x40px emoji + optional label
- Animation: Fade in (200ms) → Hold (3s) → Fade out (500ms)
- Stacking: If new chip before old fades, replace immediately

**Code Pattern:**
```javascript
export class EmojiChipRenderer {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.shadowRoot = this.createShadowRoot();
    this.currentChip = null;
    this.fadeTimeout = null;
  }

  createShadowRoot() {
    const container = document.createElement('div');
    container.id = 'lossy-emoji-chip-container';
    const shadow = container.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      .emoji-chip {
        position: absolute;
        top: 16px;
        right: 16px;
        font-size: 32px;
        padding: 8px;
        background: rgba(0, 0, 0, 0.7);
        border-radius: 8px;
        animation: fadeIn 200ms ease-out;
        z-index: 10000;
      }

      .emoji-chip.fading {
        animation: fadeOut 500ms ease-out forwards;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: scale(0.8); }
        to { opacity: 1; transform: scale(1); }
      }

      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    shadow.appendChild(style);

    document.body.appendChild(container);
    return shadow;
  }

  showChip(emoji, confidence) {
    // Clear previous chip
    if (this.currentChip) {
      this.currentChip.remove();
    }
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
    }

    // Create new chip
    const chip = document.createElement('div');
    chip.className = 'emoji-chip';
    chip.textContent = emoji;
    chip.title = `Confidence: ${(confidence * 100).toFixed(0)}%`;

    this.shadowRoot.appendChild(chip);
    this.currentChip = chip;

    // Auto-fade after 3 seconds
    this.fadeTimeout = setTimeout(() => {
      chip.classList.add('fading');
      setTimeout(() => chip.remove(), 500);
    }, 3000);
  }

  destroy() {
    if (this.currentChip) {
      this.currentChip.remove();
    }
    this.shadowRoot.host.remove();
  }
}
```

### Task 6: Integration with Recording Lifecycle

**Files:** `extension/src/content/universal.js` (MODIFY)

**Hook points:**
- Start emoji monitoring when recording starts
- Stop emoji monitoring when recording stops
- Ensure cleanup on page navigation

**Code Pattern:**
```javascript
// In universal.js, near audio recording lifecycle

let emojiChipMonitor = null;
let emojiChipRenderer = null;

// Start recording
if (message.action === 'start_recording') {
  // ... existing audio recording setup ...

  // Sprint 09: Start emoji chip monitoring
  if (!emojiChipRenderer) {
    emojiChipRenderer = new EmojiChipRenderer(videoElement);
  }
  if (!emojiChipMonitor) {
    emojiChipMonitor = new EmojiChipMonitor(videoElement, emojiChipRenderer);
  }
  emojiChipMonitor.start();
}

// Stop recording
if (message.action === 'stop_recording') {
  // ... existing audio recording teardown ...

  // Sprint 09: Stop emoji chip monitoring
  if (emojiChipMonitor) {
    emojiChipMonitor.stop();
  }
}
```

---

## Testing & Validation

### Unit Tests
- Cosine similarity calculation accuracy
- Category embedding caching/invalidation
- Emoji chip rendering timing (fade in/out)

### Integration Tests
- Full flow: frame capture → embedding → matching → display
- GPU queue coordination (ensure Whisper has priority)
- Performance impact on voice recording latency

### Manual QA Scenarios
1. **Color Grading:** Play video with vibrant colors → Expect 🎨
2. **Charts/Data:** Play video with dashboard/graphs → Expect 📊
3. **Text Overlays:** Play video with subtitles → Expect 💬
4. **Dark Scene:** Play video with low lighting → Expect 🌑
5. **No Match:** Play abstract/ambiguous video → Expect no chip (confidence < 0.6)

### Performance Validation
- Frame capture + embedding + matching: ≤ 200ms total (WebGPU)
- No dropped voice frames during emoji processing
- Smooth video playback (60 FPS maintained)

---

## Open Questions

1. **Category Count:** Start with 15 or go full 25? (Recommendation: 15, iterate)

2. **Chip Placement:** Top-right corner vs. near timeline vs. user-configurable? (Recommendation: Start top-right, make configurable in Sprint 10)

3. **Multiple Chips:** Show top 2 matches if both >0.5 confidence? (Recommendation: Single chip only for MVP, reduce visual noise)

4. **Confidence Threshold:** 0.6 vs. 0.5 vs. 0.7? (Recommendation: 0.6, tune based on user feedback)

5. **Frame Capture Interval:** 2s vs. 1s vs. 3s? (Recommendation: 2s, configurable via feature flag)

6. **Emoji vs. Text Labels:** Pure emoji or emoji + text label? (Recommendation: Emoji only for MVP, add text on hover)

---

## Success Criteria

Sprint 09 is complete when:

- ✅ Emoji chips appear during recording with <200ms latency
- ✅ Categorization accuracy ≥70% on test video set
- ✅ Zero impact on voice transcription latency
- ✅ Smooth UX: no jank, chips don't obstruct video
- ✅ Feature flag allows users to disable if desired
- ✅ Code documented and tested

---

## Out of Scope (Future Sprints)

- **Sprint 10:** Semantic search using embeddings (pgvector)
- **Sprint 11:** User-defined emoji categories
- **Sprint 12:** Historical emoji timeline (show past chips on timeline scrubbing)
- **Sprint 13:** Emoji chips during playback (not just recording)

---

## Sprint 08 vs Sprint 09: Visual Intelligence Comparison

Understanding the architectural split between cloud-based vision (Sprint 08) and local embeddings (Sprint 09):

| Aspect | Sprint 08 (GPT-4o Vision) | Sprint 09 (SigLIP Embeddings) |
|--------|--------------------------|------------------------------|
| **Purpose** | Note text refinement with visual details | Visual categorization (emoji chips) |
| **Trigger** | Manual (user clicks "Refine with Vision" button) | Automatic (background during recording) |
| **Processing** | Cloud API (OpenAI GPT-4o Vision) | Local browser (WebGPU/WASM) |
| **Frame Quality** | High (1024px max, aspect ratio preserved, 95% JPEG) | Low (224×224 square, optimized for embeddings) |
| **Input Format** | Base64 JPEG sent to API | ImageData processed locally |
| **Output** | Refined text from LLM (string) | 768-dim embedding vector (Float32Array) |
| **Latency** | 1-2s (network + API processing) | 50-150ms (local WebGPU) |
| **Cost** | ~$0.01-0.03 per frame (OpenAI API) | Free (local compute) |
| **Privacy** | ⚠️ Sends frames to cloud (explicit opt-in) | ✅ Fully local (no data leaves browser) |
| **Frequency** | Once per note (on demand) | Every 2s during recording |
| **Use Case** | Specific, detailed feedback enhancement | Quick visual context awareness |
| **Model** | GPT-4o Vision API (OpenAI) | SigLIP `clip-vit-base-patch32` (Hugging Face) |
| **Storage** | Text stored in `note.text` field | Embedding stored in `note.visual_context` JSON |

**Key Insight:** These features are **complementary**, not alternatives:
- **Sprint 08 (GPT-4o Vision):** High-quality, human-readable refinement when precision matters
- **Sprint 09 (SigLIP):** Fast, automatic categorization for real-time visual awareness

**Why the split?**

During Sprint 08, we discovered that standard LLM APIs (GPT-4o, Claude, Gemini) **cannot accept pre-computed embeddings** as input - they require actual images. This led to the architectural decision:
1. Use cloud Vision APIs for text generation (Sprint 08)
2. Use local embeddings for categorization/search (Sprint 09)

See `docs/sprints/SPRINT_08_siglip_vision.md` for full context on this architectural pivot.

---

## Notes

- This is a **rough plan** to be refined before Sprint 09 starts
- **Important:** Sprint 08 no longer includes SigLIP - Sprint 09 is the first implementation
- GPU queue coordination is critical - emoji chips must never block voice
- Privacy: All processing local (no cloud), consistent with architecture principles
- Frame capture at 224×224 (different from Sprint 08's aspect ratio preservation)

---

**Sprint created:** 2025-10-20
**Updated:** 2025-10-20 (after Sprint 08 pivot)
**Estimated start:** After Sprint 08 completion
**Estimated duration:** 3-5 days
