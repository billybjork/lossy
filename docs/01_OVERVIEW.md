# Voice-First Video Companion - Project Overview

**Last Updated:** 2025-10-14
**Status:** Pre-Implementation

---

## 🎯 Project Goal

Build a **voice-first browser extension** that captures natural speech while reviewing videos and automatically generates structured, time-coded feedback that gets applied to the video platform (Air, YouTube, Vimeo, etc.) via intelligent automation.

### The Problem

Video editors and reviewers waste time:
- Typing detailed feedback with precise timestamps
- Context-switching between video player and comment interface
- Losing flow state to write clear, actionable notes
- Managing feedback across multiple video versions

### The Solution

Speak naturally while watching. The system:
1. **Captures** your voice with sub-second visual feedback (emoji chips)
2. **Transcribes** speech to text locally (WASM-first, private by default)
3. **Structures** raw transcripts into clear, actionable notes (LLM)
4. **Anchors** feedback to exact video timestamps and frames
5. **Posts** automatically to the video platform (Browserbase automation)

---

## 🏗️ Technology Stack

### Frontend: Browser Extension (MV3)

| Component | Technology | Why |
|-----------|-----------|-----|
| **Extension Framework** | Chrome MV3 | Side Panel API, modern security |
| **UI - Popup** | Phoenix LiveView | Real-time agent progress streaming |
| **UI - Side Panel** | Phoenix LiveView | Persistent note list with live updates |
| **UI - Overlays** | Shadow DOM + Vanilla JS | On-video ghost comments, emoji chips |
| **Voice Capture** | MediaRecorder + VAD | @ricky0123/vad-web for speech detection |
| **Local STT** | Transformers.js (Whisper) | WebGPU → WASM → Cloud fallback |
| **Emoji Chips** (Planned) | Text classification | Keyword/embedding-based on transcription |
| **Bundler** | Webpack 5 | Local bundling of phoenix.js |

**Technology Fallback Hierarchy:**

*Transcription (STT):*
1. **Best**: Local WASM Whisper with WebGPU acceleration (Sprint 07)
2. **Good**: Local WASM Whisper with CPU (Sprint 07)
3. **Fallback**: OpenAI Whisper API (cloud)
4. **User preference**: Settings toggle for cloud vs local

*Emoji Chips (Text-based, Planned):*
1. **Best**: Keyword-based classification (<10ms, simple)
2. **Good**: Lightweight text embeddings (~50ms, more accurate)
3. **Fallback**: Skip emoji chips (not critical for core functionality)
4. **Decision**: Based on transcription fragment availability

*Memory Considerations:*
- Local Whisper: ~300MB model + ~200MB runtime
- Emoji chips: No additional models needed (uses transcription text)

### Backend: Phoenix/Elixir

| Component | Technology | Why |
|-----------|-----------|-----|
| **Web Framework** | Phoenix 1.7 | LiveView, Channels, PubSub |
| **Real-time** | Phoenix Channels | Binary WebSocket for audio streaming |
| **UI Framework** | Phoenix LiveView | Streaming timelines, reactive updates |
| **Agent State** | GenServer + PubSub | Supervised, observable sessions |
| **Database** | PostgreSQL | Structured storage, vector embeddings |
| **Background Jobs** | Oban | Note posting queue |
| **STT (cloud)** | OpenAI Whisper API | Cloud fallback/acceleration |
| **LLM** | OpenAI GPT-4o-mini | Note structuring, intent extraction |
| **Optional Local** | Rustler NIFs | whisper.cpp/llama.cpp acceleration |

### Computer Use: Local Browser Agent

| Component | Technology | Why |
|-----------|-----------|-----|
| **Primary** | Local Chrome (dedicated profile) | Already authenticated, zero latency |
| **Automation** | Playwright via CDP | Proven reliability, platform-specific selectors |
| **AI Fallback** | Gemini 2.5 Computer Use API | Vision-based navigation for complex/unknown UIs |
| **Auth Management** | Persistent Chrome profile | Cookies/localStorage persist across sessions |
| **Fallback** | Browserbase (optional) | Cloud posting when machine offline |
| **Platform Adapters** | Existing video/timeline finders | Reusable for selector discovery |

---

## 🎨 Key Features

### MVP (Milestone 1)

1. **Voice Capture & Transcription**
   - Push-to-talk in popup/side panel
   - Local Whisper transcription (WASM)
   - Real-time transcript display

2. **Ghost Comments**
   - LLM structures raw speech into clear notes
   - Pinned to video timestamp
   - "Scratch that" to cancel
   - Confidence-based opacity

3. **Side Panel Note List**
   - LiveView streaming updates
   - Filter by video/category/status
   - Click to seek video timestamp

4. **Automated Posting**
   - Queue high-confidence notes
   - Local browser agent with dedicated Chrome profile
   - Real-time status updates in side panel ("Logging in...", "Posted ✓")
   - "Summon" feature for MFA/user intervention

### Future Enhancements

- **Text-based Emoji Chips** (sentiment/feedback visualization from transcription)
- **Semantic Search** (pgvector + text embeddings for note retrieval)
- **Multi-note Merging** (consolidate nearby similar notes)
- **Voice Commands** ("scratch that", "post all", "undo")
- **Wake Word** (continuous listening mode)
- **Collaborative** (multi-user review sessions)

---

## 📊 Performance Targets

Based on blueprint and research:

| Metric | Target | Notes |
|--------|--------|-------|
| **Listening Indicator** | ≤100ms | Video pause + anchor display |
| **Emoji Chips (WASM)** | 300-600ms | CLIP inference on frame |
| **Emoji Chips (WebGPU)** | 50-150ms | GPU-accelerated |
| **Ghost Comment** | 0.8-1.3s | Transcription + LLM structuring |
| **Note Posting** | 5-10s | Browserbase automation |
| **Frame Capture** | 20-60ms | Grab → scale → WebP encode |

---

## 🎭 User Experience Flow

```
1. User clicks mic (popup or side panel)
   ↓
2. Video pauses, anchor chip shows timestamp
   ↓
3. User speaks: "The pacing here is too slow"
   ↓
4. [300ms] Emoji chip appears: 🐌 (pacing)
   ↓
5. [1.2s] Ghost comment appears: "Slow pacing - speed up"
   ↓
6. User can:
   - Say "scratch that" → cancels
   - Do nothing → auto-firms after 3s
   - Click "post" → queues for automation
   ↓
7. Background: Local browser agent posts to video platform
   ↓
8. Side panel updates in real-time: "🔒 Logging in" → "📤 Posting" → "✅ Posted"
```

---

## 🔒 Privacy & Data Flow

### Default: Local-First

```
Browser (WASM)                Backend (Cloud)
├── Audio capture            ├── Receives: transcript text only
├── STT (Whisper)           ├── Structures with LLM
├── Frame capture (CLIP)    ├── Stores: notes, timestamps
└── Emoji inference         └── Automation: Browserbase

❌ NO audio sent to cloud by default
✅ Only text + metadata + embeddings
```

### Optional: Cloud Acceleration

User can opt-in to send audio for:
- Higher quality STT (OpenAI Whisper API)
- Faster processing
- Advanced features (speaker diarization)

---

## 📁 Repository Structure

```
lossy/
├── docs/                          # 📚 Documentation (this directory)
│   ├── 01_OVERVIEW.md            # This file
│   ├── 02_PRINCIPLES.md          # Development principles
│   ├── 03_ARCHITECTURE.md        # System design
│   ├── sprints/                  # Sprint-based roadmap
│   ├── 04_LIVEVIEW_PATTERNS.md
│   ├── 06_COMPUTER_USE.md        # Local-first browser automation
│   └── advanced/
│       └── BROWSERBASE_FALLBACK.md  # Optional cloud fallback
│
├── lossy/                         # 🔥 Elixir/Phoenix application (@lossy namespace)
│   ├── lib/lossy/
│   │   ├── accounts/             # User management
│   │   ├── videos/               # Video & note storage
│   │   ├── agent/                # AgentSession GenServers
│   │   ├── inference/            # STT/LLM routing
│   │   └── automation/           # Browserbase integration
│   ├── lib/lossy_web/
│   │   ├── channels/             # Phoenix Channels
│   │   ├── live/                 # LiveView modules
│   │   └── controllers/          # REST API
│   └── priv/python/              # Existing Python agents
│
└── extension/                     # 🧩 Browser extension (MV3)
    ├── src/
    │   ├── background/           # Service worker
    │   ├── content/              # Content scripts + overlays
    │   ├── sidepanel/            # Side panel (LiveView client)
    │   ├── popup/                # Popup (LiveView client)
    │   └── shared/               # Phoenix client, utilities
    ├── public/
    │   └── models/               # ONNX models (cached)
    └── manifest.json
```

---

## 🚀 Success Metrics

### Technical

- ✅ Sub-second feedback (emoji chips)
- ✅ < 1.5s ghost comments
- ✅ 95%+ transcription accuracy (clear speech)
- ✅ 90%+ note posting success rate
- ✅ Zero manual timestamp entry

### User Experience

- ✅ Maintains flow state (no keyboard context switch)
- ✅ Clear visual feedback at every step
- ✅ Graceful degradation (works offline, slow networks)
- ✅ Undo/cancel at any point

### Business

- ✅ 10x faster feedback generation vs manual typing
- ✅ 100% time-coded notes (vs ~20% manual)
- ✅ Platform-agnostic (works on Air, YouTube, Vimeo, etc.)

---

## 🎓 Key Learnings Applied

From research and prototype:

1. **Local-first computer use** - User's authenticated browser, zero latency
2. **WASM-first transcription** - Privacy + speed (vs. cloud STT)
3. **LiveView for extension UI** - Real-time streaming perfect for agent progress
4. **Chained architecture** - OpenAI guidance, easier than realtime voice
5. **Persistent Chrome profile** - Auth persists, no credential management
6. **Platform adapters** - Reusable video/timeline element finders
7. **Phoenix Channels for binary** - Efficient audio streaming
8. **Side Panel > Popup** - Persistent UI for note list with status updates

---

## 📚 References

- **Research:** Conducted 2025-10-14 (WASM inference, LiveView patterns, etc.)
- **Archived docs:** See `docs/archive/` for blueprint and earlier implementation plans

---

## ⚡ Quick Start (After Implementation)

```bash
# Backend
cd lossy
mix deps.get
mix ecto.setup
mix phx.server

# Extension
cd extension
npm install
npm run build
# Load unpacked extension from extension/dist/
```

See `sprints/` for sprint-by-sprint implementation plan.
