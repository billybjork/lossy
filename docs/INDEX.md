# Lossy Documentation

**Voice-First Video Companion - Complete Technical Documentation**

Last Updated: 2025-10-17

---

## 📚 Documentation Structure

This documentation is organized into focused, non-overlapping guides. Read them in order for a complete understanding, or jump to specific sections as needed.

### Core Documentation

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[01_OVERVIEW.md](./01_OVERVIEW.md)** | Project goals, technology stack, features, success metrics | Start here - understand the "what" and "why" |
| **[02_PRINCIPLES.md](./02_PRINCIPLES.md)** | Development principles guiding architectural decisions | Understand the "why" behind design choices |
| **[03_ARCHITECTURE.md](./03_ARCHITECTURE.md)** | System design, components, data flow, architectural boundaries | Understand how everything fits together + integration rules |
| **[sprints/](./sprints/)** | Sprint-based implementation roadmap (6 focused sprints) | Ready to implement - follow sprint-by-sprint |
| **[04_LIVEVIEW_PATTERNS.md](./04_LIVEVIEW_PATTERNS.md)** | Phoenix LiveView in browser extensions | Implementing real-time UI components |
| **[05_BROWSERBASE_INTEGRATION.md](./05_BROWSERBASE_INTEGRATION.md)** | Automated note posting via Browserbase | Setting up automation system |
| **[TECHNICAL_REFERENCES.md](./TECHNICAL_REFERENCES.md)** | WASM inference, WebGPU, model caching patterns | Future implementation (WASM Whisper, CLIP) |

---

## 📖 Document Summaries

### 01_OVERVIEW.md
**What it covers:**
- The problem and solution
- Complete technology stack with rationale
- MVP features vs future enhancements
- Performance targets and success metrics
- Repository structure
- Privacy and data flow
- Key learnings applied from research

**Key sections:**
- Technology stack tables (Frontend, Backend, Automation)
- User experience flow diagram
- Performance targets table
- Success metrics (Technical, UX, Business)

---

### 02_PRINCIPLES.md
**What it covers:**
- Core development principles guiding all decisions
- Progressive Enhancement & Graceful Degradation
- Progressive Disclosure
- Self-Healing Systems
- Flexible Heuristics over Intricate Rules
- Declarative Design
- Principle interactions and decision framework
- Concrete examples from Lossy codebase

**Key sections:**
- Theoretical foundations for each principle
- Implementation patterns in Lossy
- Code examples (JavaScript and Elixir)
- Anti-patterns to avoid
- Decision framework for architectural choices

---

### 03_ARCHITECTURE.md
**What it covers:**
- Complete system architecture diagram
- Component responsibilities and boundaries
- Communication protocols (Channels, PubSub, REST)
- Three detailed data flow examples
- State management patterns
- Database schema design
- **Architectural boundaries and integration rules**
- **Database access patterns (extension never touches DB)**
- **Integration decision tree and anti-patterns**

**Key sections:**
- ASCII architecture diagram
- Extension components breakdown
- Backend components breakdown
- Voice note creation flow (step-by-step)
- Video context change flow
- Automated posting flow
- AgentSession state machine
- **Architectural Boundaries & Integration Rules**

---

### sprints/
**What it covers:**
- Sprint-based implementation roadmap (~2-3 weeks to MVP)
- Each sprint file is self-contained with goals, tasks, and testing
- Working software at end of each sprint
- Current status tracking and progress visibility
- Focused, actionable implementation steps

**Sprint files:**
- **[Sprint 00](./sprints/SPRINT_00_scaffolding.md)**: ✅ Project scaffolding (Complete)
- **[Sprint 01](./sprints/SPRINT_01_audio_streaming.md)**: 🚧 Audio capture + Phoenix Channels (In Progress)
- **[Sprint 02](./sprints/SPRINT_02_transcription.md)**: ⏳ OpenAI Whisper + GPT-4o structuring
- **[Sprint 03](./sprints/SPRINT_03_video_integration.md)**: ⏳ Video timestamp anchoring
- **[Sprint 07](./sprints/SPRINT_07_auto_posting.md)**: ⏳ Browserbase automation
- **[Sprint TBD](./sprints/planned/SPRINT_TBD_auth.md)**: ⏳ Authentication (Planned)
- **[Sprint TBD](./sprints/planned/SPRINT_TBD_polish.md)**: ⏳ UX polish (Planned)

**See:** [sprints/README.md](./sprints/README.md) for current status and sprint system overview

---

### 04_LIVEVIEW_PATTERNS.md
**What it covers:**
- How to use Phoenix LiveView in Chrome extensions
- Complete setup requirements (CSP, check_origin, auth)
- Side panel implementation with hooks
- Streaming patterns for efficient updates
- Context-aware rendering (current video)
- Bidirectional actions (click note → seek video)
- Service worker coordination
- Offline handling & reconnection
- Debugging tips

**Key sections:**
- Setup requirements checklist
- Complete side panel implementation (Elixir + JavaScript)
- Real-time streaming with `stream_insert/3`
- Phoenix hooks for client-side interactivity
- Connection state management
- Common patterns and gotchas

---

### 05_BROWSERBASE_INTEGRATION.md
**What it covers:**
- Three-phase integration strategy (Python bridge → Port → Pure Elixir)
- Oban worker setup for reliable posting
- Session management and auth flow
- Error handling and retry strategies
- Monitoring and observability
- Testing approach
- Production checklist

**Key sections:**
- Architecture overview (AgentSession → Oban → Python/Browserbase)
- Phase 1: `System.cmd()` bridge (fastest implementation)
- Phase 2: Port communication (better performance)
- Phase 3: Pure Elixir (future migration)
- Session management (create, reuse, expiry)
- Common errors and solutions
- Telemetry and monitoring

---


## 🔗 External Resources

### Official Documentation
- **Phoenix Framework**: https://hexdocs.pm/phoenix/
- **Phoenix LiveView**: https://hexdocs.pm/phoenix_live_view/
- **Chrome Extensions**: https://developer.chrome.com/docs/extensions/mv3/
- **Browserbase API**: https://docs.browserbase.com
- **Oban (Jobs)**: https://hexdocs.pm/oban/

### Research & References
- **WASM Whisper**: Transformers.js - https://huggingface.co/docs/transformers.js
- **ONNX Runtime Web**: https://onnxruntime.ai/docs/tutorials/web/
- **Playwright**: https://playwright.dev/python/
- **Stagehand**: https://github.com/browserbase/stagehand
