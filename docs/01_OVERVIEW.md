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
| **Local STT** (Phase 6) | Transformers.js (Whisper) | WebGPU → WASM → Cloud fallback |
| **Local Vision** (Phase 7) | Transformers.js (SigLIP) | WebGPU → WASM → Skip fallback |
| **Bundler** | Webpack 5 | Local bundling of phoenix.js |

**Technology Fallback Hierarchy:**

*Transcription (STT):*
1. **Primary (MVP)**: OpenAI Whisper API (cloud)
2. **Phase 6**: Local WASM Whisper with WebGPU acceleration
3. **Fallback**: Auto-detect available RAM (<4GB → cloud, ≥4GB → local)
4. **User preference**: Settings toggle for cloud vs local

*Frame Analysis (CLIP/SigLIP for emoji chips):*
1. **Best**: WebGPU-accelerated SigLIP (50-150ms, Phase 7)
2. **Good**: WASM SigLIP (300-600ms, Phase 7)
3. **Fallback**: Skip emoji chips (not critical for MVP)
4. **Decision**: Check `navigator.gpu` support on init

*Memory Considerations:*
- Local Whisper: ~300MB model + ~200MB runtime
- Local SigLIP: ~100MB model
- Auto-fallback to cloud if available memory <4GB

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

### Automation: Browserbase

| Component | Technology | Why |
|-----------|-----------|-----|
| **Computer Use** | Browserbase API | Persistent browser sessions |
| **Automation** | Playwright + Stagehand | Traditional selectors + AI navigation |
| **Auth Management** | Browserbase Contexts | Persistent login state |
| **Language** | Python (existing) → Elixir | Port existing agents, gradual migration |

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
   - Browserbase automation
   - Status feedback in side panel

### Future Enhancements

- **Emoji Reasoning Tokens** (CLIP + late fusion)
- **Frame Analysis** (shot change detection, visual context)
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
7. Background: Browserbase posts to video platform
   ↓
8. Side panel updates: "Posted ✅"
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
│   └── 05_BROWSERBASE_INTEGRATION.md
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

1. **WASM-first, not cloud-first** - Privacy + speed
2. **LiveView for extension UI** - Real-time streaming perfect for agent progress
3. **Chained architecture** - OpenAI guidance, easier than realtime voice
4. **Browserbase Contexts** - Persistent auth, no credential storage
5. **Stagehand > selectors** - AI navigation more robust than brittle CSS
6. **Phoenix Channels for binary** - Efficient audio streaming
7. **Side Panel > Popup** - Persistent UI for note list

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
