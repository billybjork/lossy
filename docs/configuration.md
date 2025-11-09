# Configuration

This document catalogs all configurable values in Lossy and where they're defined.

## Configuration Strategy

**Backend (Elixir)**: Primary source of truth for operational and ML settings
- Defined in: `config/config.exs`, `config/dev.exs`, `config/prod.exs`
- Overridden by: Environment variables
- Access via: `Application.get_env(:lossy, :key)`

**Extension (TypeScript)**: User-facing preferences and feature flags
- Stored in: `chrome.storage.sync` (synced across devices)
- UI: Settings page accessible from extension popup
- Fallbacks: Hardcoded defaults in extension code

**Environment Variables**: Secrets and deployment-specific overrides
- API keys, database URLs, storage credentials
- Override any Elixir config value at runtime

---

## Backend Configuration

### ML Pipeline Settings

```elixir
config :lossy, :ml_pipeline,
  # Pre-upscale threshold: auto-upscale before detection when image is too small
  pre_upscale_min_dimension: 500,  # pixels
  pre_upscale_factor: 2.0,

  # Mask padding: dynamic padding around text regions for inpainting
  mask_padding_multiplier: 0.4,  # multiply by font_size
  mask_padding_min: 6,           # pixels
  mask_padding_max: 24,          # pixels

  # Detection confidence
  text_detection_confidence_threshold: 0.7,  # 0.0 - 1.0

  # Model defaults
  default_upscale_factor: 4,
  max_upscale_factor: 8
```

**Usage**:
```elixir
defmodule Lossy.ML.Config do
  def pre_upscale_threshold do
    Application.get_env(:lossy, :ml_pipeline)[:pre_upscale_min_dimension]
  end

  def calculate_mask_padding(font_size) do
    ml_config = Application.get_env(:lossy, :ml_pipeline)
    padding = font_size * ml_config[:mask_padding_multiplier]
    clamp(padding, ml_config[:mask_padding_min], ml_config[:mask_padding_max])
  end
end
```

### Job Processing

```elixir
config :lossy, :jobs,
  # Retry behavior
  default_max_attempts: 3,
  retry_backoff_base_ms: 1000,    # exponential: 1s, 2s, 4s, 8s...
  retry_backoff_max_ms: 30_000,

  # Timeouts
  text_detection_timeout_ms: 60_000,   # 1 minute
  inpainting_timeout_ms: 120_000,      # 2 minutes
  upscaling_timeout_ms: 180_000,       # 3 minutes

  # Idempotency
  allow_duplicate_jobs: false  # check for existing jobs before spawning
```

### Asset Storage

```elixir
config :lossy, :assets,
  # Storage backend
  storage_backend: Lossy.Storage.Local,  # or Lossy.Storage.S3

  # Local storage (dev/test)
  local_base_path: "priv/static/uploads",

  # S3 storage (production)
  s3_bucket: "lossy-assets-prod",
  s3_region: "us-west-2",
  s3_path_prefix: "documents",

  # Limits
  max_upload_size_mb: 50,
  max_dimension_px: 8192,

  # Cleanup
  cleanup_working_assets_after_days: 30,
  cleanup_export_assets_after_days: 7
```

### Image Processing

```elixir
config :lossy, :image_processing,
  # Dimension warnings/limits
  warn_large_image_threshold: 4096,  # pixels
  max_canvas_dimension: 8192,

  # Quality settings
  export_jpeg_quality: 90,  # 1-100
  export_png_compression: 6,  # 0-9

  # Text rendering
  default_font: "Inter",
  fallback_fonts: ["Roboto", "Arial", "sans-serif"]
```

### Font Configuration

```elixir
config :lossy, :fonts,
  # Font library path
  fonts_dir: "priv/static/fonts",

  # Curated subset (50-100 families)
  enabled_fonts: [
    # Sans-serif
    "Inter", "Roboto", "Open Sans", "Lato", "Montserrat",
    # Serif
    "Lora", "Merriweather", "Playfair Display", "PT Serif",
    # Display
    "Bebas Neue", "Oswald", "Raleway",
    # Script
    "Dancing Script", "Pacifico", "Great Vibes"
  ],

  # Font estimation
  use_font_classifier: false,  # MVP: use heuristics only
  font_classifier_confidence_threshold: 0.6
```

### External Services

```elixir
# Secrets via environment variables
config :lossy, :ml_services,
  replicate_api_key: System.get_env("REPLICATE_API_KEY"),
  fal_api_key: System.get_env("FAL_API_KEY"),

  # Model versions (update these when models change)
  paddleocr_version: "version-id-here",
  lama_version: "version-id-here",
  real_esrgan_version: "version-id-here"
```

---

## Extension Configuration

### Feature Flags

Stored in `chrome.storage.sync`, accessible from settings page:

```typescript
interface ExtensionConfig {
  // Detection
  enableLocalDetection: boolean;      // Default: false
  localDetectionConfidence: number;   // Default: 0.7

  // UI preferences
  overlayOpacity: number;             // Default: 0.45 (0-1)
  highlightColor: string;             // Default: "#3B82F6"

  // Capture behavior
  minImageSize: number;               // Default: 100 (pixels)
  preferDirectUrls: boolean;          // Default: true
  captureDevicePixelRatio: boolean;   // Default: true

  // Performance
  maxCandidateImages: number;         // Default: 100
  screenshotQuality: number;          // Default: 0.92 (0-1)
}
```

**Default values** (`extension/lib/config.ts`):

```typescript
export const DEFAULT_CONFIG: ExtensionConfig = {
  enableLocalDetection: false,
  localDetectionConfidence: 0.7,
  overlayOpacity: 0.45,
  highlightColor: "#3B82F6",
  minImageSize: 100,
  preferDirectUrls: true,
  captureDevicePixelRatio: true,
  maxCandidateImages: 100,
  screenshotQuality: 0.92
};

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.sync.get('lossyConfig');
  return { ...DEFAULT_CONFIG, ...stored.lossyConfig };
}
```

### Backend API Endpoint

```typescript
// Development
const API_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://lossy.app'
  : 'http://localhost:4000';
```

---

## Environment Variables

### Required (Production)

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/lossy_prod

# Phoenix
SECRET_KEY_BASE=very-long-secret-key-here
PHX_HOST=lossy.app

# ML Services
REPLICATE_API_KEY=r8_...
FAL_API_KEY=fal_...

# Asset Storage (when using S3)
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=lossy-assets-prod
```

### Optional (Development)

```bash
# Override defaults
ML_PIPELINE_PRE_UPSCALE_THRESHOLD=600
JOBS_MAX_ATTEMPTS=5
ASSETS_MAX_UPLOAD_SIZE_MB=100

# Enable debug features
LOSSY_DEBUG_ML_REQUESTS=true
LOSSY_LOG_LEVEL=debug
```

---

## Configuration Validation

### Backend Startup Validation

Add to `lib/lossy/application.ex`:

```elixir
defmodule Lossy.Application do
  def start(_type, _args) do
    # Validate critical config before starting
    validate_config!()

    # ... rest of start logic
  end

  defp validate_config! do
    unless Application.get_env(:lossy, :ml_services)[:replicate_api_key] do
      raise "REPLICATE_API_KEY is required"
    end

    # Validate dimension limits make sense
    ml_config = Application.get_env(:lossy, :ml_pipeline)
    if ml_config[:pre_upscale_min_dimension] > ml_config[:warn_large_image_threshold] do
      Logger.warning("Pre-upscale threshold is larger than warning threshold")
    end
  end
end
```

### Extension Config Validation

Validate user input in settings page:

```typescript
function validateConfig(config: Partial<ExtensionConfig>): ValidationResult {
  const errors = [];

  if (config.overlayOpacity && (config.overlayOpacity < 0 || config.overlayOpacity > 1)) {
    errors.push('Overlay opacity must be between 0 and 1');
  }

  if (config.minImageSize && config.minImageSize < 50) {
    errors.push('Minimum image size must be at least 50 pixels');
  }

  return { valid: errors.length === 0, errors };
}
```

---

## Config Hot-Reloading (Future)

For production systems, consider:
- **Backend**: Use a config provider (e.g., Consul, etcd) and reload on change
- **Extension**: Listen for `chrome.storage.onChanged` to update behavior without restart
- **Feature flags**: Remote config service (LaunchDarkly, Unleash) for A/B testing

---

## Testing Overrides

Override config in tests:

**ExUnit**:
```elixir
setup do
  # Override for this test
  Application.put_env(:lossy, :ml_pipeline, pre_upscale_min_dimension: 100)

  on_exit(fn ->
    # Restore original
    Application.delete_env(:lossy, :ml_pipeline)
  end)
end
```

**Jest** (extension):
```typescript
import { setConfig } from '../lib/config';

beforeEach(() => {
  setConfig({ minImageSize: 50 }); // Override for test
});
```

---

## Configuration Best Practices

1. **Sensible defaults**: Every config value should have a reasonable default
2. **Documentation**: Add comments explaining what each value does and valid ranges
3. **Validation**: Fail fast on invalid config rather than silently using bad values
4. **Secrets management**: Never commit API keys or passwords; use environment variables
5. **User-facing vs. operational**: User preferences go in extension storage; operational settings in backend config
6. **Avoid over-configuration**: Don't expose every constant; only values that realistically need tuning

---

## Config Change Log

Track when and why config values change:

| Date | Config | Old Value | New Value | Reason |
|------|--------|-----------|-----------|--------|
| 2024-01 | `pre_upscale_min_dimension` | - | 500 | Initial threshold based on testing |
| TBD | `mask_padding_multiplier` | - | 0.4 | Balance between context and precision |

---

## See Also

- [ML Pipeline](ml-pipeline.md) - How thresholds are used in practice
- [Backend Implementation](implementation/backend.md) - Where config is accessed
- [Extension Implementation](implementation/extension.md) - User settings UI
