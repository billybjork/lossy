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
│   └── priv/repo/       # Database migrations
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

## 🔧 VS Code Setup

The `.vscode/settings.json` configures:
- ✅ ElixirLS pointing to `lossy/` directory
- ✅ Format on save for Elixir and JavaScript
- ✅ Recommended extensions
- ✅ Proper file exclusions for search/watch

Recommended extensions will be suggested automatically when you open the project.

## 🔥 Hot Reload

### Backend Application
- **Elixir code**: Auto-reloads on save (code_reloader enabled)
- **Database schema**: Run `mix ecto.migrate` after changes
- **Config changes**: Restart server

### Extension
- **JavaScript**: Webpack rebuilds automatically in watch mode (`npm run dev`)
- **HTML/Manifest**: Copied to dist/ automatically
- **To apply changes**: Click reload button in `chrome://extensions`

**Note**: Chrome extensions don't support true hot reload. You must manually reload the extension after webpack rebuilds.

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

## 🐛 Troubleshooting

### ElixirLS Not Working
- Check `.vscode/settings.json` has `"elixirLS.projectDir": "lossy"`
- Restart VS Code
- Run "ElixirLS: Restart" from VS Code command palette

### Database Connection Errors
```bash
# Check PostgreSQL is running
pg_isready

# Start PostgreSQL (macOS)
brew services start postgresql

# Start PostgreSQL (Linux)
sudo systemctl start postgresql
```

### Extension Not Loading
- Check `extension/dist/` directory exists and has files
- Run `npm run build` in extension directory
- Check Chrome DevTools console for errors

### Webpack Build Errors
```bash
cd extension
rm -rf node_modules dist
npm install
npm run build
```

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

Create `.env` files for sensitive config:

**`lossy/.env`** (not committed):
```bash
export DATABASE_URL="postgresql://user:pass@localhost/lossy_prod"
export SECRET_KEY_BASE="generate-with-mix-phx-gen-secret"
export OPENAI_API_KEY="sk-..."
export BROWSERBASE_API_KEY="..."
export BROWSERBASE_PROJECT_ID="..."
```

Load with: `source .env && mix phx.server`

## 🤝 Contributing

1. Check current phase in `docs/03_IMPLEMENTATION_PHASES.md`
2. Follow patterns in `docs/04_LIVEVIEW_PATTERNS.md`
3. Format code before committing:
   ```bash
   cd lossy && mix format
   cd extension && npm run format  # if prettier configured
   ```

## 📄 License

[Your License Here]
