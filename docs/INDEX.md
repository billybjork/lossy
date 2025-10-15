# Lossy Documentation

**Voice-First Video Companion - Complete Technical Documentation**

Last Updated: 2025-10-14

---

## 📚 Documentation Structure

This documentation is organized into focused, non-overlapping guides. Read them in order for a complete understanding, or jump to specific sections as needed.

### Core Documentation

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[01_PROJECT_OVERVIEW.md](./01_PROJECT_OVERVIEW.md)** | Project goals, technology stack, features, success metrics | Start here - understand the "what" and "why" |
| **[02_ARCHITECTURE.md](./02_ARCHITECTURE.md)** | System design, components, data flow diagrams | Understand how everything fits together |
| **[03_IMPLEMENTATION_PHASES.md](./03_IMPLEMENTATION_PHASES.md)** | 6-8 week phased build plan with code examples | Ready to implement - follow this roadmap |
| **[04_LIVEVIEW_PATTERNS.md](./04_LIVEVIEW_PATTERNS.md)** | Phoenix LiveView in browser extensions | Implementing real-time UI components |
| **[05_BROWSERBASE_INTEGRATION.md](./05_BROWSERBASE_INTEGRATION.md)** | Automated note posting via Browserbase | Setting up automation system |
| **[TECHNICAL_REFERENCES.md](./TECHNICAL_REFERENCES.md)** | WASM inference, WebGPU, model caching patterns | Phase 6-7 implementation (WASM Whisper, CLIP) |

---

## 📖 Document Summaries

### 01_PROJECT_OVERVIEW.md
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

### 02_ARCHITECTURE.md
**What it covers:**
- Complete system architecture diagram
- Component responsibilities and boundaries
- Communication protocols (Channels, PubSub, REST)
- Three detailed data flow examples
- State management patterns
- Database schema design

**Key sections:**
- ASCII architecture diagram
- Extension components breakdown
- Backend components breakdown
- Voice note creation flow (step-by-step)
- Video context change flow
- Automated posting flow
- AgentSession state machine

---

### 03_IMPLEMENTATION_PHASES.md
**What it covers:**
- 6-8 week phased implementation plan
- Each phase has: goals, deliverables, code examples, testing
- Working software at each phase (no "big bang" integration)
- Dependencies and blockers per phase
- Migration path from Python prototype

**Key sections:**
- **Phase 0 (Week 1)**: Project scaffolding
- **Phase 1 (Week 2)**: Auth + LiveView basics
- **Phase 2 (Week 3)**: Audio capture + streaming
- **Phase 3 (Week 4)**: STT + LLM structuring
- **Phase 4 (Week 5-6)**: Browserbase automation
- **Phase 5 (Week 7-8)**: Polish + content scripts

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
- Debugging tips

**Key sections:**
- Setup requirements checklist
- Complete side panel implementation (Elixir + JavaScript)
- Real-time streaming with `stream_insert/3`
- Phoenix hooks for client-side interactivity
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
