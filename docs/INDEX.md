# Lossy Documentation

**Voice-First Video Companion - Complete Technical Documentation**

---

## 📚 Documentation Structure

This documentation is organized into focused, non-overlapping guides. Read them in order for a complete understanding, or jump to specific sections as needed.

### Core Documentation

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[01_OVERVIEW.md](./01_OVERVIEW.md)** | Project goals, technology stack, features, success metrics | Start here - understand the "what" and "why" |
| **[02_PRINCIPLES.md](./02_PRINCIPLES.md)** | Development principles guiding architectural decisions | Understand the "why" behind design choices |
| **[03_ARCHITECTURE.md](./03_ARCHITECTURE.md)** | System design, components, data flow, architectural boundaries | Understand how everything fits together + integration rules |
| **[04_AGENTIC_PRINCIPLES.md](./04_AGENTIC_PRINCIPLES.md)** | Agentic architecture, diffusion refinement, continuous observation | Understand intelligent agent behavior patterns |
| **[05_COMPUTER_USE.md](./05_COMPUTER_USE.md)** | Local browser automation with Playwright + Gemini Computer Use | Automated note posting via local agent |
| **[sprints/](./sprints/)** | Sprint-based implementation roadmap | Ready to implement - follow sprint-by-sprint |
| **[TECHNICAL_REFERENCES.md](./TECHNICAL_REFERENCES.md)** | WASM inference, WebGPU, model caching patterns | Implementation references for local ML |
| **[manual_tests/indexeddb_cache.md](./manual_tests/indexeddb_cache.md)** | Manual verification checklist for IndexedDB caching | Run after cache-related changes |
| **[advanced/BROWSERBASE_FALLBACK.md](./advanced/BROWSERBASE_FALLBACK.md)** | Cloud automation fallback via Browserbase | Optional when local agent unavailable |

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

### 04_AGENTIC_PRINCIPLES.md
**What it covers:**
- Transition from manual tools to intelligent companions
- Context-aware voice mode observation patterns
- Progressive evidence accumulation (speech, vision, user actions)
- Diffusion-style iterative refinement (global coherence)
- Frame capture rules and adaptive bandwidth management
- Holistic session reasoning across all notes
- Latency-budgeted work scheduling for UI responsiveness

**Key sections:**
- 6 core agentic principles with implementation patterns
- Diffusion vs autoregressive note generation
- Review state data structures (notes, relations, evidence)
- Energy function for quality optimization
- Controller policy for operation scheduling
- Agent lifecycle (activation → observation → refinement)
- Engineering implications (performance budgets, cost governors)

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
- **[Sprint TBD](./sprints/planned/SPRINT_TBD_auto_posting.md)**: ⏳ Browserbase automation (Planned)
- **[Sprint TBD](./sprints/planned/SPRINT_TBD_auth.md)**: ⏳ Authentication (Planned)
- **[Sprint TBD](./sprints/planned/SPRINT_TBD_polish.md)**: ⏳ UX polish (Planned)

**See:** [sprints/README.md](./sprints/README.md) for current status and sprint system overview

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
