# Lossy - Voice-First Video Companion

A browser extension for capturing voice feedback while reviewing videos, with automatic transcription and structured note generation.

## 🚀 Quick Start

### Initial Setup (First Time)

```bash
# Install backend dependencies
cd lossy
mix deps.get
mix ecto.setup  # Creates DB and runs migrations
cd ..

# Install extension dependencies and build
cd extension
npm install
npm run build
cd ..
```

### Development

**Terminal 1** - Backend server:
```bash
cd lossy
mix phx.server  # Runs at http://localhost:4000
```

**Terminal 2** - Extension webpack (watch mode):
```bash
cd extension
npm run dev  # Auto-rebuilds on file changes
```

**Load extension in Chrome**:
1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/dist` folder
5. After making extension changes, click the reload button in `chrome://extensions`

## 📁 Project Structure

```
code/
├── lossy/               # Backend application (Elixir/Phoenix)
│   ├── lib/lossy/       # Core business logic
│   ├── lib/lossy_web/   # Web layer (LiveView, Channels, API)
│   ├── priv/repo/       # Database migrations
│   └── priv/node/       # Node.js automation agents (Playwright)
├── extension/           # Chrome MV3 extension
│   ├── src/             # Source files
│   └── dist/            # Built extension (webpack output)
└── docs/                # Implementation guides
```

## 🛠️ Manual Commands

### Backend Application

```bash
cd lossy

# Install dependencies
mix deps.get

# Database operations
mix ecto.create
mix ecto.migrate
mix ecto.reset  # Drop, create, and migrate

# Start server
mix phx.server

# Start server with IEx (interactive shell)
iex -S mix phx.server

# Run tests
mix test

# Format code
mix format
```

### Extension

```bash
cd extension

# Install dependencies
npm install

# Build once (production)
npm run build

# Watch mode (development)
npm run dev

# The built extension will be in dist/
```

### Automation (Optional)

For automated note posting to video platforms:

```bash
cd lossy/priv/node

# Install Playwright dependencies
npm install

# Install Chromium browser
npx playwright install chromium

# Verify setup
node playwright_server.js
# (Should wait for input - press Ctrl+C to exit)
```

**Note:** Requires Browserbase API key set in `.env` (see Environment Variables section).

## 🎯 Development Workflow

### Typical Session

1. Start both servers (in separate terminals):
   ```bash
   cd lossy && mix phx.server           # Terminal 1
   cd extension && npm run dev           # Terminal 2
   ```

2. Make changes to code

3. **Backend changes**: Auto-reload (just refresh browser)

4. **Extension changes**:
   - Webpack auto-rebuilds (watch Terminal 2)
   - Click reload in `chrome://extensions` to apply

5. Test in browser

### Database Migrations

```bash
cd lossy

# Create new migration
mix ecto.gen.migration add_some_feature

# Edit priv/repo/migrations/TIMESTAMP_add_some_feature.exs

# Run migration
mix ecto.migrate

# Rollback last migration
mix ecto.rollback

# Reset database (drop, create, migrate, seed)
mix ecto.reset
```

## 🧪 Testing

```bash
# Backend tests
cd lossy
mix test

# Watch mode (auto-run on changes)
mix test.watch  # Requires mix_test_watch dependency

# Test specific file
mix test test/lossy/videos_test.exs

# Test with coverage
mix test --cover
```

## 📚 Documentation

See `docs/` directory for detailed guides:

- `01_PROJECT_OVERVIEW.md` - Project goals and tech stack
- `02_ARCHITECTURE.md` - System design and data flow
- `sprints/` - Sprint-by-sprint implementation roadmap
- `03_LIVEVIEW_PATTERNS.md` - LiveView in extensions
- `04_BROWSERBASE_INTEGRATION.md` - Automation setup
- `TECHNICAL_REFERENCES.md` - WASM, WebGPU, model caching

## 📦 Production Build

```bash
# Build backend release
cd lossy
MIX_ENV=prod mix release

# Build extension for production
cd extension
npm run build

# Extension will be in dist/ - zip for Chrome Web Store
cd dist && zip -r ../extension.zip . && cd ..
```

## 🔐 Environment Variables

Create a `.env` file in the **repo root** (`code/.env`) for configuration (not committed to git).

The `.env` file is automatically loaded by `lossy/config/runtime.exs` in development and test environments.

**`.env`** (in repo root):
```bash
# OpenAI API Configuration (Required)
# Get your API key from: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-proj-...

# Database Configuration (Production only)
# Development uses defaults from config/dev.exs:
#   - username: postgres
#   - password: postgres
#   - database: lossy_dev
# DATABASE_URL=postgresql://user:pass@localhost/lossy_prod

# Phoenix Secret Key Base (Production only)
# Generate with: mix phx.gen.secret
# SECRET_KEY_BASE=your-secret-key-base-here

# Phoenix Host (Production only)
# PHX_HOST=example.com

# Optional: Set to "true" to enable server mode
# PHX_SERVER=true

# Optional: Browserbase Integration (for automated posting)
# BROWSERBASE_API_KEY=...
# BROWSERBASE_PROJECT_ID=...
```

**Note:** No `export` needed - Phoenix loads variables directly from `.env` via `DotenvParser` in `runtime.exs`.