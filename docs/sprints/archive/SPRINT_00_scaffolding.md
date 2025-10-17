# Sprint 00: Project Scaffolding

**Status:** ✅ Complete
**Duration:** 1 day
**Completed:** 2025-10-14

---

## Goal

Set up all project foundations: Phoenix backend, Chrome extension build system, database schema, and development tooling. Nothing functional yet, but clean structure ready for development.

---

## Prerequisites

- ✅ Elixir 1.15+ installed
- ✅ Phoenix 1.8+ installed
- ✅ PostgreSQL running
- ✅ Node.js 18+ installed
- ✅ Chrome browser

---

## Deliverables

- ✅ Phoenix application runs on :4000
- ✅ Database schema migration created and run
- ✅ Extension builds with webpack
- ✅ Extension loads in Chrome (shows blank sidepanel)
- ✅ VS Code workspace configured
- ✅ Git repository initialized
- ✅ README with setup instructions

---

## Technical Tasks

### 1. Phoenix Backend Setup

**Created:**
- Phoenix 1.8 application with LiveView
- Binary UUID primary keys
- Standard Phoenix directory structure

**Dependencies added:**
```elixir
{:phoenix, "~> 1.8.1"}
{:phoenix_live_view, "~> 1.1.0"}
{:ecto_sql, "~> 3.13"}
{:postgrex, ">= 0.0.0"}
{:oban, "~> 2.18"}
{:bcrypt_elixir, "~> 3.0"}
{:cors_plug, "~> 3.0"}
{:req, "~> 0.5"}  # HTTP client
{:credo, "~> 1.7", only: [:dev, :test]}
```

**Configuration:**
- Oban job queues: `automation` (3 workers), `default` (5 workers)
- Bandit web server adapter
- Precommit alias: `mix precommit` (compile, format, credo, test)

### 2. Database Schema

**Migration:** `20251015022805_create_initial_schema.exs`

**Tables created:**
- `users` - User accounts (ready for future auth)
- `videos` - Video metadata (platform, URL, duration)
- `notes` - Transcribed notes with status tracking
- `platform_connections` - Browserbase session management
- `agent_sessions` - Audio session state tracking
- `audio_chunks` - Temporary audio buffer storage
- `oban_jobs` - Background job queue

**Key design decisions:**
- Binary IDs throughout for distributed system compatibility
- Status enums for note lifecycle (ghost → firmed → posted)
- User foreign keys present but not enforced yet (for future auth)
- No pgvector extension added yet (deferred to CLIP sprint)

### 3. Chrome Extension Setup

**Structure created:**
```
extension/
├── src/
│   ├── background/service-worker.js
│   ├── sidepanel/sidepanel.{js,html}
│   ├── popup/popup.{js,html}
│   ├── content/content.js
│   └── offscreen/offscreen.{js,html}
├── public/
│   ├── icons/ (placeholder)
│   └── models/ (for future WASM)
├── manifest.json
├── webpack.config.js
└── package.json
```

**Build system:**
- Webpack 5 with Babel transpilation
- Dev watch mode: `npm run dev`
- Production build: `npm run build`
- Output: `dist/` directory

**Manifest v3 configuration:**
- Permissions: `sidePanel`, `storage`, `tabs`, `offscreen`
- Host permissions: YouTube, Vimeo, Air, localhost:4000
- CSP configured for WebSocket connections
- Service worker entry point

**Dependencies:**
```json
{
  "phoenix": "^1.7.0",
  "phoenix_live_view": "^0.20.0"
}
```

### 4. Development Tooling

**VS Code:**
- ElixirLS configured pointing to `lossy/` directory
- Format on save enabled
- Recommended extensions added
- Proper file exclusions

**Git:**
- Repository initialized
- `.gitignore` configured (node_modules, _build, deps, .env)
- Initial commit created

**Documentation:**
- README with quick start
- AGENTS.md with project guidelines
- Full docs/ directory structure

---

## Testing Checklist

- ✅ `mix phx.server` starts without errors
- ✅ Visit http://localhost:4000 shows Phoenix welcome
- ✅ `mix ecto.migrate` runs successfully
- ✅ `cd extension && npm run build` completes
- ✅ Extension loads in Chrome (chrome://extensions)
- ✅ Open side panel shows placeholder HTML
- ✅ No console errors in extension

---

## Files Created

### Backend
- `lossy/mix.exs` - Dependencies and project config
- `lossy/config/config.exs` - Oban and endpoint config
- `lossy/priv/repo/migrations/20251015022805_create_initial_schema.exs`
- `lossy/lib/lossy/application.ex` - Oban supervisor added
- `lossy/lib/lossy/repo.ex` - Database repo
- `lossy/lib/lossy_web/router.ex` - Basic routes
- `lossy/lib/lossy_web/endpoint.ex` - WebSocket endpoint

### Extension
- `extension/manifest.json` - MV3 manifest
- `extension/webpack.config.js` - Build configuration
- `extension/package.json` - npm scripts and deps
- `extension/src/background/service-worker.js` - Basic event listeners
- `extension/src/sidepanel/sidepanel.{html,js}` - Placeholder UI
- `extension/src/popup/popup.{html,js}` - Placeholder popup
- `extension/src/content/content.js` - Empty content script
- `extension/src/offscreen/offscreen.{html,js}` - Empty offscreen doc

### Documentation
- `README.md` - Setup and development guide
- `AGENTS.md` - Project guidelines for AI agents
- `docs/INDEX.md` - Documentation map
- `docs/01_OVERVIEW.md` - Goals and tech stack
- `docs/03_ARCHITECTURE.md` - System design
- `docs/04_LIVEVIEW_PATTERNS.md` - LiveView + Extension patterns
- `docs/05_BROWSERBASE_INTEGRATION.md` - Automation setup
- `docs/TECHNICAL_REFERENCES.md` - WASM, WebGPU, model caching

---

## Notes & Learnings

### Design Decisions

1. **No pgvector yet**: Deferred video_frames table's vector extension to future CLIP sprint to keep initial setup simple

2. **User table included**: Even though auth is deferred, keeping user table now prevents migration headaches later. All foreign keys present but not enforced.

3. **Oban from day one**: Better to have job queue infrastructure from start rather than retrofit later

4. **Binary IDs**: Using UUIDs throughout for future distributed system compatibility

5. **MV3 offscreen document**: Required for audio capture in service worker context

### Gotchas

- ElixirLS needs `"elixirLS.projectDir": "lossy"` in VS Code settings
- Extension CSP must explicitly allow `wss://localhost:4000`
- Webpack needs `noErrorOnMissing` for public/ directory
- Phoenix 1.8 uses Bandit adapter (not Cowboy)

### File Structure Notes

- `lossy/` - Backend (not `phoenix_backend/` as originally planned)
- `extension/` - Frontend (Chrome extension)
- `docs/` - All documentation
- Root level keeps both projects separate but related

### Timeline

- Actual time: ~2 hours (most time spent on documentation)
- Includes: scaffolding, deps, migration, webpack config, docs

---

## Next Sprint

👉 [Sprint 01 - Audio Streaming (No Auth)](./SPRINT_01_audio_streaming.md)

**Focus:** Get audio flowing from extension to backend without authentication layer
