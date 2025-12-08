# Configuration

This document catalogs the current configuration settings in Lossy.

## Configuration Overview

**Backend (Elixir)**: Application settings and operational parameters
- Defined in: `lossy/config/config.exs`
- Production overrides: `lossy/config/runtime.exs` (via environment variables)
- Access via: `Application.get_env(:lossy, :key)`

**Extension (TypeScript)**: Currently hardcoded
- Backend URL: `http://localhost:4000` (hardcoded in service-worker.ts)
- No user-configurable settings yet

---

## Current Backend Configuration

### ML Pipeline Settings

Location: `lossy/config/config.exs`

```elixir
config :lossy, :ml_pipeline,
  # Pre-upscale: auto-upscale before detection when image is too small
  pre_upscale_min_dimension: 500,  # pixels
  pre_upscale_factor: 2.0,




  # Detection confidence threshold
  text_detection_confidence_threshold: 0.7,  # 0.0 - 1.0

  # Upscaling defaults
  default_upscale_factor: 4,
  max_upscale_factor: 8
```

### Job Processing (Oban)

```elixir
config :lossy, :jobs,
  # Retry behavior
  default_max_attempts: 3,
  retry_backoff_base_ms: 1000,    # exponential: 1s, 2s, 4s, 8s...
  retry_backoff_max_ms: 30_000,

  # Timeouts per job type
  text_detection_timeout_ms: 60_000,   # 1 minute

  upscaling_timeout_ms: 180_000,       # 3 minutes

  # Prevent duplicate job creation
  allow_duplicate_jobs: false
```

### Asset Storage

```elixir
config :lossy, :assets,
  # Currently using local filesystem only
  storage_backend: Lossy.Storage.Local,
  local_base_path: "priv/static/uploads",

  # Size/dimension limits
  max_upload_size_mb: 50,
  max_dimension_px: 8192,

  # Cleanup policies (not yet implemented)
  cleanup_working_assets_after_days: 30,
  cleanup_export_assets_after_days: 7
```

### Image Processing

```elixir
config :lossy, :image_processing,
  # Dimension thresholds
  warn_large_image_threshold: 4096,  # pixels
  max_canvas_dimension: 8192,

  # Export quality settings
  export_jpeg_quality: 90,  # 1-100
  export_png_compression: 6,  # 0-9

  # Font defaults
  default_font: "Inter",
  fallback_fonts: ["Roboto", "Arial", "sans-serif"]
```

---

## Environment Variables

### Required (Production)

Configured in `lossy/config/runtime.exs`:

```bash
# Database connection
DATABASE_URL=postgresql://user:pass@host:5432/lossy_prod

# Phoenix security
SECRET_KEY_BASE=very-long-secret-key-here

# Deployment
PHX_HOST=lossy.app
PHX_SERVER=true  # Enable server on startup
```

### Optional

```bash
# Database
POOL_SIZE=10          # DB connection pool size (default: 10)
ECTO_IPV6=true        # Enable IPv6 for database connection

# Server
PORT=4000             # HTTP port (default: 4000)
DNS_CLUSTER_QUERY=... # For cluster deployment
```

---

## Extension Configuration

### Development

Run with watch mode (auto-rebuilds on file changes):
```bash
cd extension
npm run dev
```

This keeps running and rebuilds when you save files. You'll still need to refresh your browser to see changes.

See `extension/README.md` for complete development setup.

### Backend URL

Currently hardcoded in `extension/background/service-worker.ts`:

```typescript
// Line 112, 136
const backendUrl = 'http://localhost:4000';
```

**Future**: Make this configurable with prod/dev environments.

---

## Future Configuration Additions

Settings we may want to add later:

### Extension User Preferences
- **Backend URL override**: Allow users to connect to custom backend instances
- **Overlay appearance**: Color, opacity, animation speed
- **Capture behavior**: Default mode (direct URL vs screenshot), image size filters
- **Debug mode**: Verbose logging in console

### Backend ML Services
- **External API keys**: For Replicate or other ML services
- **Model versions**: Pin specific model versions for stability
- **Fallback behavior**: What to do when external services are unavailable

### Backend Storage (S3)
- **S3 configuration**: Bucket, region, path prefix, credentials
- **Storage strategy**: When to use local vs cloud storage
- **CDN integration**: CloudFront or other CDN for asset delivery

### Advanced ML Tuning
- **Font configuration**: Enabled font list, font classifier settings
- **Performance modes**: Speed vs quality trade-offs
- **Batch processing**: Limits and queue priorities

---

## Accessing Configuration

### Backend Example

```elixir
# Get ML pipeline config
ml_config = Application.get_env(:lossy, :ml_pipeline)
threshold = ml_config[:pre_upscale_min_dimension]

# Get job timeout
job_config = Application.get_env(:lossy, :jobs)
timeout = job_config[:text_detection_timeout_ms]
```

### Testing Overrides

```elixir
# In test/test_helper.exs or individual test files
setup do
  Application.put_env(:lossy, :ml_pipeline, pre_upscale_min_dimension: 100)

  on_exit(fn ->
    Application.delete_env(:lossy, :ml_pipeline)
  end)
end
```

---

## See Also

- [ML Pipeline Documentation](ml-pipeline.md) - How these settings affect processing
- [Job System](implementation/backend.md) - Timeout and retry behavior in practice