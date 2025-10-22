# Sprint TBD: Emoji Chips - Text-Based Visual Feedback Tokens

**Status:** 📋 Planned (Deprioritized)
**Duration:** 2-3 days
**Owner:** Extension (client-side)
**Progress:** 0% - Concept refined, awaiting schedule
**Related Sprints:**
- ✅ Sprint 07 – Local Transcription (Whisper Tiny, offscreen infrastructure)
- ✅ Sprint 08 – GPT-4o Vision Integration (visual context enrichment)
- 🔜 Sprint 10 – Semantic Search (pgvector + embeddings)

---

## Goal

Implement real-time visual feedback "emoji chips" that appear during voice recording, using locally-generated transcription fragments to categorize user sentiment and feedback type. This provides instant visual confirmation to the user about what they're saying, without blocking the voice-to-text flow.

### Success Metrics

- 🎯 Emoji chip appears within 200ms of transcription fragment detection
- 🎯 Zero impact on voice recording latency (fully async)
- 🎯 Accurate categorization (≥70% match with user expectations)
- 📊 Smooth UX: chips fade in/out, don't obstruct video
- 🎯 Minimal compute overhead (tiny classifier or simple similarity matching)

---

## Vision

**User Experience:**
1. User starts recording feedback while watching video
2. As they speak, transcription fragments appear in real-time (from Whisper Tiny)
3. Small emoji chips appear near the video timeline or in corner based on what's being said
4. User says: "This section is perfect, I love it!"
5. Emoji chip 👍 or 🙌 appears, confirming the system detected positive sentiment
6. User says: "Hmm, this feels confusing"
7. Emoji chip 🤔 or ❓ appears
8. Creates confidence that the system understands context

**Technical Flow:**
```
Voice recording → Whisper Tiny transcription (fragments) →
Text classification/embedding matching → Display emoji chip →
Fade out after 3s or when category changes
```

**Non-goals:**
- ❌ Not using visual embeddings (SigLIP) - text-based only
- ❌ Not modifying note text (that's Sprint 08 "Refine with Vision")
- ❌ Not semantic search (that's Sprint 10 with pgvector)
- ❌ Not storing embeddings in database (keep it simple)

---

## Technical Approach

### Two Potential Implementations

**Option A: Tiny Classifier (Simplest, Start Here)**
- Use a lightweight text classification model (or even rule-based)
- Categories: positive, negative, neutral, questioning, technical
- Map directly to emoji sets
- Extremely fast, no embedding computation needed
- Example: keyword matching + sentiment analysis

**Option B: Pre-baked Emoji Vectors (More Sophisticated)**
- Pre-compute text embeddings for emoji category descriptions at extension startup
- Generate embeddings from custom prompts to load semantic meaning
- Example categories:
  - "love, perfect, great, yes, awesome" → 👍/🙌/❤️
  - "lol, funny, hilarious" → 😂
  - "hmm, confusing, unclear, what" → 🤔/❓
  - "too dark, grainy, blurry, quality issue" → 👎/🛠️
  - "cut this, remove, delete" → ✂️
  - "slow, boring, drag" → 🐌
  - "fast, rushed, quick" → ⏩
- Compute embedding for each incoming transcription fragment
- Cosine similarity matching against pre-baked emoji vectors
- Display emoji if confidence > threshold (e.g., 0.6)

**Recommended Path:** Start with Option A (tiny classifier), upgrade to Option B if accuracy isn't sufficient.

---

## Prerequisites

- ✅ Sprint 07 completed: Whisper Tiny running in browser, real-time transcription fragments available
- ✅ Offscreen document pattern established
- ✅ Transcription fragments accessible in content script context
- Feature flag: `features.emojiChipsEnabled` (default: false until ready)

---

## Technical Architecture

### Component Breakdown

**1. Emoji Category Definition** (`extension/src/shared/emoji-categories.js`)
- Predefined list of sentiment/feedback categories with emoji
- Examples:
  ```javascript
  export const EMOJI_CATEGORIES = [
    {
      id: 'positive',
      emoji: '👍',
      keywords: ['love', 'perfect', 'great', 'yes', 'awesome', 'excellent'],
      description: 'positive feedback, approval, satisfaction'
    },
    {
      id: 'funny',
      emoji: '😂',
      keywords: ['lol', 'funny', 'hilarious', 'haha'],
      description: 'humor, laughter'
    },
    {
      id: 'questioning',
      emoji: '🤔',
      keywords: ['hmm', 'confusing', 'unclear', 'what', 'why'],
      description: 'confusion, questioning, uncertainty'
    },
    {
      id: 'negative',
      emoji: '👎',
      keywords: ['bad', 'wrong', 'no', 'dislike', 'poor'],
      description: 'negative feedback, disapproval'
    },
    {
      id: 'technical_issue',
      emoji: '🛠️',
      keywords: ['dark', 'grainy', 'blurry', 'audio', 'quality', 'bug'],
      description: 'technical problems, quality issues'
    },
    {
      id: 'cut',
      emoji: '✂️',
      keywords: ['cut', 'remove', 'delete', 'trim'],
      description: 'edit suggestion, content removal'
    },
    {
      id: 'slow',
      emoji: '🐌',
      keywords: ['slow', 'boring', 'drag', 'too long'],
      description: 'pacing too slow'
    },
    {
      id: 'fast',
      emoji: '⏩',
      keywords: ['fast', 'rushed', 'quick', 'too quick'],
      description: 'pacing too fast'
    }
  ];
  ```
- Categories cover: sentiment, editing suggestions, technical issues, pacing

**2. Text Classification** (`extension/src/content/emoji-classifier.js`)

**Option A Implementation (Simple Classifier):**
```javascript
export class EmojiClassifier {
  constructor(categories) {
    this.categories = categories;
  }

  classify(text) {
    const lowerText = text.toLowerCase();
    const matches = [];

    for (const category of this.categories) {
      let score = 0;
      for (const keyword of category.keywords) {
        if (lowerText.includes(keyword)) {
          score += 1;
        }
      }
      if (score > 0) {
        matches.push({
          category,
          score,
          confidence: Math.min(score / 3, 1.0) // normalize
        });
      }
    }

    // Sort by score
    matches.sort((a, b) => b.score - a.score);

    // Return top match if confidence > 0.5
    if (matches.length > 0 && matches[0].confidence > 0.5) {
      return {
        emoji: matches[0].category.emoji,
        confidence: matches[0].confidence
      };
    }

    return null;
  }
}
```

**Option B Implementation (Embedding-Based):**
- Pre-compute embeddings for category descriptions at startup
- Use lightweight embedding model (e.g., `Xenova/all-MiniLM-L6-v2`)
- Store embeddings in memory (no database needed)
- Compute embedding for each transcription fragment
- Cosine similarity matching
- ~50ms latency per fragment

**3. Fragment Monitoring** (`extension/src/content/emoji-chip-monitor.js`)
- Listen to transcription fragment events from Whisper Tiny
- Pass each fragment to classifier
- Display emoji chip if classification confidence > threshold
- Debounce rapid fragments (e.g., only classify once per 2 seconds)

**Code Pattern:**
```javascript
export class EmojiChipMonitor {
  constructor(emojiChipRenderer) {
    this.renderer = emojiChipRenderer;
    this.classifier = new EmojiClassifier(EMOJI_CATEGORIES);
    this.lastClassification = 0;
    this.debounceMs = 2000;
  }

  start() {
    // Listen for transcription fragments
    window.addEventListener('transcription_fragment', (event) => {
      this.handleFragment(event.detail.text);
    });
  }

  handleFragment(text) {
    const now = Date.now();
    if (now - this.lastClassification < this.debounceMs) {
      return; // Debounce
    }

    const result = this.classifier.classify(text);
    if (result) {
      this.renderer.showChip(result.emoji, result.confidence);
      this.lastClassification = now;
    }
  }

  stop() {
    window.removeEventListener('transcription_fragment', this.handleFragment);
  }
}
```

**4. Emoji Chip Rendering** (`extension/src/content/overlays/emoji-chip.js`)
- Shadow DOM overlay (isolated from page styles)
- Position: Top-right corner of video or near timeline
- Animation: Fade in (200ms), hold (3s), fade out (500ms)
- Replace previous chip if new category detected within 3s

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

---

## Deliverables

### Frontend (Extension)
- [ ] Emoji category taxonomy (8-15 categories covering common feedback patterns)
- [ ] Text classifier (Option A: keyword-based OR Option B: embedding-based)
- [ ] Fragment monitoring (listen to Whisper Tiny transcription events)
- [ ] Emoji chip UI component (Shadow DOM, animations, positioning)
- [ ] Integration with recording lifecycle (start monitoring on mic press, stop on release)
- [ ] Feature flag toggle in settings
- [ ] Performance monitoring (classification latency, UI frame rate impact)

### Backend (Phoenix) - Not Required
- No backend changes needed for MVP
- All processing happens client-side
- Future: Could store emoji statistics for analytics

---

## Proposed Emoji Categories

Based on common voice feedback patterns:

### Sentiment
- 👍 Positive/approval
- 👎 Negative/disapproval
- ❤️ Love/strong positive
- 😂 Funny/humor
- 🤔 Questioning/confusion

### Editing Suggestions
- ✂️ Cut/remove content
- 🐌 Pacing too slow
- ⏩ Pacing too fast
- 🔀 Transition/reorder

### Technical Feedback
- 🛠️ Technical issue (quality, audio, etc.)
- 🌑 Too dark/lighting issue
- 🔊 Audio issue
- 📱 UI/interface feedback

---

## Technical Tasks

### Task 1: Define Emoji Category Taxonomy

**Files:** `extension/src/shared/emoji-categories.js` (NEW)

**Deliverable:**
- 8-15 emoji categories with keywords and descriptions
- Focus on sentiment and common video feedback patterns
- Test keywords against sample transcription fragments

### Task 2: Implement Simple Classifier

**Files:** `extension/src/content/emoji-classifier.js` (NEW)

**Approach:**
- Start with keyword matching + simple scoring
- Normalize confidence scores
- Threshold for display (>0.5)
- Test with real transcription fragments

**Future Enhancement:** Upgrade to embedding-based if accuracy insufficient

### Task 3: Fragment Monitoring

**Files:** `extension/src/content/emoji-chip-monitor.js` (NEW)

**Flow:**
1. Listen to `transcription_fragment` events from Whisper Tiny
2. Debounce rapid fragments (every 2s)
3. Pass fragment text to classifier
4. Display emoji if confidence > threshold
5. Stop monitoring when recording stops

**Integration Point:** Hook into existing Whisper Tiny transcription flow (Sprint 07)

### Task 4: Emoji Chip UI Component

**Files:**
- `extension/src/content/overlays/emoji-chip.js` (NEW)
- `extension/src/content/overlays/emoji-chip.css` (inline in Shadow DOM)

**Features:**
- Shadow DOM for isolation
- Configurable position (default: top-right of video)
- Smooth animations
- Auto-fade after 3s
- Replace on new classification

### Task 5: Integration with Recording Lifecycle

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

  // Start emoji chip monitoring
  if (!emojiChipRenderer) {
    emojiChipRenderer = new EmojiChipRenderer(videoElement);
  }
  if (!emojiChipMonitor) {
    emojiChipMonitor = new EmojiChipMonitor(emojiChipRenderer);
  }
  emojiChipMonitor.start();
}

// Stop recording
if (message.action === 'stop_recording') {
  // ... existing audio recording teardown ...

  // Stop emoji chip monitoring
  if (emojiChipMonitor) {
    emojiChipMonitor.stop();
  }
}
```

---

## Testing & Validation

### Unit Tests
- Classifier accuracy on sample phrases
- Emoji chip rendering timing (fade in/out)
- Debounce logic

### Integration Tests
- Full flow: transcription fragment → classification → display
- Performance impact on voice recording latency
- Multiple rapid fragments handling

### Manual QA Scenarios
1. **Positive Feedback:** Say "This is perfect, I love it" → Expect 👍 or ❤️
2. **Negative Feedback:** Say "This doesn't work" → Expect 👎
3. **Humor:** Say "Haha this is hilarious" → Expect 😂
4. **Confusion:** Say "Hmm, this feels confusing" → Expect 🤔 or ❓
5. **Technical:** Say "The video is too dark" → Expect 🌑 or 🛠️
6. **Edit Suggestion:** Say "Cut this section" → Expect ✂️
7. **Pacing:** Say "This drags on too long" → Expect 🐌
8. **No Match:** Say technical jargon → Expect no chip (confidence < threshold)

### Performance Validation
- Classification latency: ≤ 50ms (Option A), ≤ 100ms (Option B)
- No dropped voice frames during emoji processing
- Smooth video playback maintained

---

## Open Questions

1. **Classifier Approach:** Start with keyword-based (Option A) or go straight to embeddings (Option B)?
   - **Recommendation:** Option A first, iterate to Option B if needed

2. **Category Count:** 8 vs 15 categories?
   - **Recommendation:** Start with 8 core categories, expand based on usage

3. **Chip Placement:** Top-right corner vs. near timeline vs. user-configurable?
   - **Recommendation:** Top-right for MVP, make configurable later

4. **Confidence Threshold:** 0.5 vs 0.6?
   - **Recommendation:** 0.5 for MVP, tune based on false positive rate

5. **Debounce Interval:** 1s vs 2s vs 3s?
   - **Recommendation:** 2s, adjustable via feature flag

6. **Store Emoji History:** Should we track which emojis appeared during a note?
   - **Recommendation:** Not for MVP, defer to future sprint if valuable

---

## Success Criteria

Sprint is complete when:

- ✅ Emoji chips appear during recording based on transcription text
- ✅ Classification accuracy ≥70% on test phrases
- ✅ Zero impact on voice transcription latency
- ✅ Smooth UX: no jank, chips don't obstruct video
- ✅ Feature flag allows users to enable/disable
- ✅ Code documented and tested

---

## Why Text-Based Instead of Visual?

**Key Insights:**
1. **User speaks about what they see** - transcription already contains visual context implicitly
2. **Simpler implementation** - no need for SigLIP embeddings, frame capture, GPU coordination
3. **Lower latency** - keyword matching is <10ms vs 50-150ms for image embeddings
4. **Better privacy** - no frame capture needed, all processing on transcription text
5. **More actionable** - emojis reflect user intent/sentiment, not just visual content
6. **Already have the infrastructure** - Whisper Tiny transcription from Sprint 07

**When Visual Makes Sense:**
- Semantic search over historical notes (Sprint 10)
- Automated video quality analysis (future)
- Visual categorization without voice (not our use case)

**This Approach:**
- Focus on **user sentiment and feedback type** from voice
- Use transcription text that's already being generated
- Keep it simple, fast, and privacy-preserving

---

## Out of Scope (Future Sprints)

- **Sprint 10:** Semantic search using embeddings (pgvector)
- **Future:** User-defined emoji categories
- **Future:** Historical emoji timeline (show past chips on timeline scrubbing)
- **Future:** Visual-based emoji chips (if text-based insufficient)
- **Future:** Emoji chips during playback (not just recording)

---

## Notes

- This is a **refined concept** - deprioritized for now
- Focus on text-based approach using Whisper Tiny fragments
- Start with simple keyword classifier (Option A)
- Upgrade to embeddings (Option B) only if accuracy insufficient
- No backend changes required - fully client-side
- Privacy-first: all processing local, no frames captured
- Can revisit visual approach (SigLIP) if text-based doesn't meet goals

---

**Sprint created:** 2025-10-20
**Updated:** 2025-10-22 (pivoted to text-based approach, deprioritized)
**Status:** Planned (not scheduled)
**Estimated duration:** 2-3 days
