# Backend Implementation

This guide covers the implementation of the Lossy backend using Elixir and Phoenix.

## Goals

The backend is the "brains" of Lossy:
- Domain model and persistence
- Job orchestration for ML pipeline
- Integration with external inference services
- Real-time editor interface via LiveView

---

## Project Structure

```
lib/
├── lossy/
│   ├── accounts/                   # User management (future)
│   ├── documents/                  # Core domain context
│   │   ├── document.ex
│   │   ├── text_region.ex
│   │   ├── processing_job.ex
│   │   └── logic.ex                # Pure business logic
│   ├── assets/                     # Asset storage + helpers
│   │   ├── asset.ex
│   │   └── store.ex
│   ├── ml/                         # ML service integration
│   │   ├── fal_client.ex
│   │   ├── text_detection.ex
│   │   ├── inpainting.ex
│   │   └── upscaling.ex
│   ├── image_processing/           # Image manipulation
│   │   ├── compositor.ex
│   │   └── text_renderer.ex
│   └── repo.ex
├── lossy_web/
│   ├── controllers/
│   │   └── capture_controller.ex   # API endpoints
│   ├── live/
│   │   └── capture_live.ex         # Editor LiveView
│   ├── channels/                   # (if needed for future features)
│   └── router.ex
└── lossy.ex
```

---

## API Endpoints

### POST /api/captures

**Purpose**: Accept captured image from extension, create Document record, enqueue text detection.

**Request**:
```json
{
  "page_url": "https://example.com/page",
  "image_url": "https://example.com/image.jpg",  // OR
  "image_data": "data:image/png;base64,...",     // base64 data URL
  "bounding_rect": {
    "x": 0,
    "y": 0,
    "width": 800,
    "height": 600
  },
  "text_regions": [
    {
      "polygon": [{"x": 10, "y": 20}, ...],
      "bbox": {"x": 8, "y": 16, "w": 120, "h": 48}
    }
  ] // optional: supplied when the extension runs local detection
}
```

**Response**:
```json
{
  "id": "uuid",
  "status": "pending_detection"
}
```

If `text_regions` are supplied, the backend will persist them immediately and transition the document directly into the `:awaiting_edits` state without enqueueing the cloud detection job.

**Implementation** (`capture_controller.ex`):

```elixir
defmodule LossyWeb.CaptureController do
  use LossyWeb, :controller
  alias Lossy.Documents

  def create(conn, params) do
    with {:ok, document} <- Documents.create_capture(params),
         :ok <- Documents.enqueue_text_detection(document) do
      conn
      |> put_status(:created)
      |> json(%{id: document.id, status: document.status})
    else
      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _} -> msg end)
  end
end
```

### GET /capture/:id

**Purpose**: LiveView editor page (see [Editor Implementation](editor.md)).

### POST /api/text_regions/:id/render

**Purpose**: Trigger inpainting and text rendering for a specific region (optional API, can be done via LiveView events).

---

## Domain Context: Documents

**File**: `lib/lossy/documents.ex`

This is the main context module for the Document domain.

```elixir
defmodule Lossy.Documents do
  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Documents.{Document, TextRegion, ProcessingJob}

  ## Creating documents

  def create_capture(attrs) do
    %Document{}
    |> Document.changeset(attrs)
    |> Repo.insert()
  end

  ## Fetching documents

  def get_document(id) do
    Repo.get(Document, id)
    |> Repo.preload([:text_regions, :processing_jobs, :original_asset, :working_asset])
  end

  ## Text detection

  def enqueue_text_detection(%Document{} = document) do
    {:ok, job} = create_processing_job(%{
      document_id: document.id,
      subject_type: :document,
      type: :text_detection,
      status: :queued,
      payload: %{}
    })

    update_document_status(document, :queued_detection)

    # Spawn async task
    Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
      execute_text_detection(job)
    end)

    :ok
  end

  defp execute_text_detection(%ProcessingJob{} = job) do
    job = mark_job_running(job)
    document = get_document(job.document_id)
    update_document_status(document, :detecting)

    original_path = Lossy.Assets.local_path(document.original_asset)

    case Lossy.ML.TextDetection.detect(original_path) do
      {:ok, regions} ->
        Enum.each(regions, fn region_data ->
          create_text_region(%{
            document_id: document.id,
            bbox: region_data.bbox,
            status: :detected,
            current_text: region_data.text || "",
            font_family: "Inter",  # Default
            font_weight: 400,
            font_size_px: region_data.estimated_font_size || 16,
            color_rgba: "rgba(0,0,0,1)"
          })
        end)

        mark_job_done(job)
        update_document_status(document, :awaiting_edits)
        broadcast_document_updated(document)

      {:error, reason} ->
        mark_job_error(job, reason)
    end
  end

  ## Inpainting

  def inpaint_region(%TextRegion{} = region) do
    {:ok, job} = create_processing_job(%{
      document_id: region.document_id,
      subject_type: :text_region,
      text_region_id: region.id,
      type: :inpaint_region,
      status: :queued,
      payload: %{region_id: region.id}
    })

    Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
      execute_inpainting(job, region)
    end)

    :ok
  end

  defp execute_inpainting(%ProcessingJob{} = job, %TextRegion{} = region) do
    job = mark_job_running(job)
    document = get_document(region.document_id)
    update_text_region(region, %{status: :inpainting})

    # Calculate inpaint region (bbox + padding)
    inpaint_bbox = Logic.calculate_inpaint_region(region, 10)

    original_path = Lossy.Assets.local_path(document.original_asset)

    case Lossy.ML.Inpainting.inpaint(original_path, inpaint_bbox) do
      {:ok, inpainted_patch_path} ->
        # Update region
        {:ok, inpainted_asset} =
          Lossy.Assets.create_inpainted_patch(region, inpainted_patch_path, inpaint_bbox)

        update_text_region(region, %{
          inpainted_asset_id: inpainted_asset.id
        })

        # Composite into working image
        working_path = Lossy.Assets.local_path(document.working_asset)

        {:ok, updated_path} =
          Lossy.ImageProcessing.Compositor.composite_patch(
            working_path,
            inpainted_patch_path,
            inpaint_bbox
          )

        # Render new text
        {:ok, final_path} =
          Lossy.ImageProcessing.TextRenderer.render_text(
            updated_path,
            region
          )

        update_text_region(region, %{status: :rendered})
        {:ok, working_asset} = Lossy.Assets.replace_working(document, final_path)
        update_document(document, %{working_asset_id: working_asset.id})

        mark_job_done(job)
        broadcast_region_updated(region)

      {:error, reason} ->
        mark_job_error(job, reason)
    end
  end

  ## Broadcasting (PubSub)

  defp broadcast_document_updated(document) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  defp broadcast_region_updated(region) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{region.document_id}",
      {:region_updated, region}
    )
  end

  ## Helper functions

  defp create_processing_job(attrs), do: # ...
  defp create_text_region(attrs), do: # ...
  defp update_text_region(region, attrs), do: # ...
  defp update_document(document, attrs), do: # ...
  defp update_document_status(document, status), do: # ...
  defp mark_job_running(job), do: # ...
  defp mark_job_done(job), do: # ...
  defp mark_job_error(job, reason), do: # ...
end
```

---

## Schema Definitions

### Document Schema

**File**: `lib/lossy/documents/document.ex`

```elixir
defmodule Lossy.Documents.Document do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "documents" do
    field :source_url, :string
    field :capture_mode, Ecto.Enum, values: [:direct_asset, :screenshot]
    field :dimensions, :map
    field :metrics, :map, default: %{}
    field :status, Ecto.Enum, values: [:queued_detection, :detecting, :awaiting_edits, :rendering, :export_ready, :error]

    belongs_to :original_asset, Lossy.Documents.Asset
    belongs_to :working_asset, Lossy.Documents.Asset

    belongs_to :user, Lossy.Accounts.User
    has_many :text_regions, Lossy.Documents.TextRegion
    has_many :processing_jobs, Lossy.Documents.ProcessingJob

    timestamps()
  end

  def changeset(document, attrs) do
    document
    |> cast(attrs, [:source_url, :capture_mode, :dimensions, :metrics, :status, :user_id, :original_asset_id, :working_asset_id])
    |> validate_required([:source_url, :capture_mode, :original_asset_id])
    |> validate_inclusion(:capture_mode, [:direct_asset, :screenshot])
  end
end
```

### TextRegion Schema

**File**: `lib/lossy/documents/text_region.ex`

```elixir
defmodule Lossy.Documents.TextRegion do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "text_regions" do
    field :bbox, :map  # %{x: int, y: int, w: int, h: int}
    field :polygon, {:array, :map}
    field :padding_px, :integer, default: 10
    field :original_text, :string
    field :current_text, :string
    field :style_snapshot, :map, default: %{}
    field :font_family, :string, default: "Inter"
    field :font_weight, :integer, default: 400
    field :font_size_px, :integer, default: 16
    field :color_rgba, :string, default: "rgba(0,0,0,1)"
    field :alignment, Ecto.Enum, values: [:left, :center, :right], default: :left
    field :z_index, :integer, default: 0
    field :status, Ecto.Enum, values: [:detected, :inpainting, :rendered, :error], default: :detected

    belongs_to :inpainted_asset, Lossy.Documents.Asset

    belongs_to :document, Lossy.Documents.Document

    timestamps()
  end

  def changeset(region, attrs) do
    region
    |> cast(attrs, [:document_id, :bbox, :polygon, :padding_px, :original_text, :current_text,
                    :style_snapshot, :font_family, :font_weight, :font_size_px, :color_rgba,
                    :alignment, :inpainted_asset_id, :z_index, :status])
    |> validate_required([:document_id, :bbox])
    |> validate_number(:font_size_px, greater_than: 0)
    |> foreign_key_constraint(:document_id)
  end
end
```

### ProcessingJob Schema

**File**: `lib/lossy/documents/processing_job.ex`

```elixir
defmodule Lossy.Documents.ProcessingJob do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "processing_jobs" do
    field :type, Ecto.Enum, values: [:text_detection, :inpaint_region, :upscale_document, :font_guess]
    field :subject_type, Ecto.Enum, values: [:document, :text_region]
    field :payload, :map
    field :status, Ecto.Enum, values: [:queued, :running, :done, :error]
    field :attempts, :integer, default: 0
    field :max_attempts, :integer, default: 3
    field :locked_at, :utc_datetime
    field :error_message, :string

    belongs_to :document, Lossy.Documents.Document
    belongs_to :text_region, Lossy.Documents.TextRegion

    timestamps()
  end

  def changeset(job, attrs) do
    job
    |> cast(attrs, [:document_id, :text_region_id, :subject_type, :type, :payload, :status, :attempts, :max_attempts, :locked_at, :error_message])
    |> validate_required([:document_id, :subject_type, :type, :status])
    |> foreign_key_constraint(:document_id)
  end
end
```

---

## ML Service Integration

### fal.ai Client

**File**: `lib/lossy/ml/fal_client.ex`

```elixir
defmodule Lossy.ML.FalClient do
  @base_url "https://fal.run/fal-ai"

  def run_model(model_path, input) do
    api_key = Application.get_env(:lossy, :fal_api_key)

    HTTPoison.post(
      "#{@base_url}/#{model_path}",
      Jason.encode!(%{input: input}),
      [
        {"Authorization", "Key #{api_key}"},
        {"Content-Type", "application/json"}
      ]
    )
    |> handle_response()
  end

  defp handle_response({:ok, %HTTPoison.Response{status_code: 201, body: body}}) do
    {:ok, Jason.decode!(body)}
  end

  defp handle_response({:ok, %HTTPoison.Response{status_code: 200, body: body}}) do
    {:ok, Jason.decode!(body)}
  end

  defp handle_response({:error, reason}) do
    {:error, reason}
  end
end
```

### Text Detection Service

**File**: `lib/lossy/ml/text_detection.ex`

```elixir
defmodule Lossy.ML.TextDetection do
  alias Lossy.ML.FalClient

  @paddleocr_model "paddleocr"

  def detect(image_path) do
    input = %{image_url: image_path}

    with {:ok, result} <- FalClient.run_model(@paddleocr_model, input) do
      parse_detection_result(result)
    end
  end

  defp parse_detection_result(output) do
    regions = Enum.map(output, fn region_data ->
      %{
        bbox: %{
          x: region_data["box"][0],
          y: region_data["box"][1],
          w: region_data["box"][2] - region_data["box"][0],
          h: region_data["box"][3] - region_data["box"][1]
        },
        text: region_data["text"],
        estimated_font_size: estimate_font_size(region_data["box"])
      }
    end)

    {:ok, regions}
  end

  defp estimate_font_size([_x1, _y1, _x2, y2, _x3, y3 | _]) do
    round((y3 - y2) * 0.8)  # Approximate
  end
end
```

### Inpainting Service

**File**: `lib/lossy/ml/inpainting.ex`

```elixir
defmodule Lossy.ML.Inpainting do
  alias Lossy.ML.FalClient

  @lama_model "lama"

  def inpaint(image_path, bbox) do
    # Create mask image
    mask_path = create_mask(image_path, bbox)

    input = %{
      image_url: image_path,
      mask_url: mask_path
    }

    with {:ok, result} <- FalClient.run_model(@lama_model, input),
         {:ok, local_path} <- download_result(result["image"]["url"]) do
      {:ok, local_path}
    end
  end

  defp create_mask(image_path, bbox) do
    # Use ImageMagick via Mogrify to create a binary mask
    # White rectangle on black background

    # Get image dimensions
    # Create black image of same size
    # Draw white rectangle at bbox position
    # Save as mask.png

    # ... implementation using Mogrify ...
  end

  defp download_result(url), do: # Download file from URL and save locally
end
```

---

## Image Processing

### Compositor

**File**: `lib/lossy/image_processing/compositor.ex`

```elixir
defmodule Lossy.ImageProcessing.Compositor do
  import Mogrify

  def composite_patch(base_image_path, patch_path, bbox) do
    output_path = generate_temp_path("composited")

    %Mogrify.Image{path: base_image_path}
    |> composite(patch_path, geometry: "+#{bbox.x}+#{bbox.y}")
    |> save(path: output_path)

    {:ok, output_path}
  end

  defp generate_temp_path(prefix) do
    Path.join(System.tmp_dir!(), "#{prefix}_#{:rand.uniform(1_000_000)}.png")
  end
end
```

### Text Renderer

**File**: `lib/lossy/image_processing/text_renderer.ex`

```elixir
defmodule Lossy.ImageProcessing.TextRenderer do
  import Mogrify

  def render_text(image_path, %TextRegion{} = region) do
    output_path = generate_temp_path("text_rendered")

    %Mogrify.Image{path: image_path}
    |> custom("gravity", "NorthWest")
    |> custom("fill", region.color_rgba)
    |> custom("font", region.font_family)
    |> custom("pointsize", to_string(region.font_size_px))
    |> custom("annotate", "+#{region.bbox.x}+#{region.bbox.y} \"#{region.current_text}\"")
    |> save(path: output_path)

    {:ok, output_path}
  end

  defp generate_temp_path(prefix) do
    Path.join(System.tmp_dir!(), "#{prefix}_#{:rand.uniform(1_000_000)}.png")
  end
end
```

---

## Concurrency & Job Management

### Task Supervisor Setup

**File**: `lib/lossy/application.ex`

```elixir
defmodule Lossy.Application do
  use Application

  def start(_type, _args) do
    children = [
      Lossy.Repo,
      LossyWeb.Telemetry,
      {Phoenix.PubSub, name: Lossy.PubSub},
      LossyWeb.Endpoint,
      {Task.Supervisor, name: Lossy.TaskSupervisor}
    ]

    opts = [strategy: :one_for_one, name: Lossy.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

### Upgrading to Oban (Future)

When ready for production-grade job management:

1. Add Oban to `mix.exs`
2. Configure Oban queues
3. Create worker modules for each job type
4. Replace `Task.Supervisor.start_child` with `Oban.insert`

---

## Testing

### Context Tests

**File**: `test/lossy/documents_test.exs`

```elixir
defmodule Lossy.DocumentsTest do
  use Lossy.DataCase
  alias Lossy.Documents

  describe "create_capture/1" do
    test "creates a document with valid attributes" do
      attrs = %{
        source_url: "https://example.com",
        capture_mode: :direct_asset,
        original_asset_id: Ecto.UUID.generate()
      }

      assert {:ok, %Document{} = document} = Documents.create_capture(attrs)
      assert document.source_url == "https://example.com"
      assert document.status == :pending_detection
    end
  end

  # More tests...
end
```

### Integration Tests

Test full flow:
1. Create document
2. Enqueue detection (mock ML service)
3. Verify text regions created
4. Trigger inpainting
5. Verify working image updated

---

## Configuration

**File**: `config/config.exs`

```elixir
config :lossy,
  ecto_repos: [Lossy.Repo]

config :lossy, Lossy.Repo,
  database: "lossy_dev",
  username: "postgres",
  password: "postgres",
  hostname: "localhost"

# PubSub
config :lossy, Lossy.PubSub,
  name: Lossy.PubSub,
  adapter: Phoenix.PubSub.PG2

# ML Pipeline Settings
config :lossy, :ml_pipeline,
  pre_upscale_min_dimension: 500,
  pre_upscale_factor: 2.0,
  mask_padding_multiplier: 0.4,
  mask_padding_min: 6,
  mask_padding_max: 24,
  text_detection_confidence_threshold: 0.7,
  default_upscale_factor: 4,
  max_upscale_factor: 8

# Job Processing
config :lossy, :jobs,
  default_max_attempts: 3,
  retry_backoff_base_ms: 1000,
  retry_backoff_max_ms: 30_000,
  text_detection_timeout_ms: 60_000,
  inpainting_timeout_ms: 120_000,
  upscaling_timeout_ms: 180_000,
  allow_duplicate_jobs: false

# Asset Storage
config :lossy, :assets,
  storage_backend: Lossy.Storage.Local,
  local_base_path: "priv/static/uploads",
  max_upload_size_mb: 50,
  max_dimension_px: 8192,
  cleanup_working_assets_after_days: 30,
  cleanup_export_assets_after_days: 7

# Image Processing
config :lossy, :image_processing,
  warn_large_image_threshold: 4096,
  max_canvas_dimension: 8192,
  export_jpeg_quality: 90,
  export_png_compression: 6,
  default_font: "Inter",
  fallback_fonts: ["Roboto", "Arial", "sans-serif"]

# External Services (secrets via env vars)
config :lossy, :ml_services,
  fal_api_key: System.get_env("FAL_API_KEY")
```

**Accessing config in code**:

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

  defp clamp(value, min, max), do: value |> max(min) |> min(max)
end
```

**See also**: [Configuration Reference](../configuration.md) for complete documentation of all config values.

---

## Deployment Considerations

### Environment Variables
- `FAL_API_KEY`: API key for ML services
- `DATABASE_URL`: PostgreSQL connection string
- `SECRET_KEY_BASE`: Phoenix secret

### File Storage
- **Dev**: Local file system (`priv/static/uploads`)
- **Prod**: S3-compatible storage (configure ExAws or similar)

### Scaling
- Multiple Phoenix nodes with shared Postgres
- Use Oban with per-node queues
- Shared file storage (S3)

---

## Next Steps

See [Editor Implementation](editor.md) for LiveView details and [Roadmap](roadmap.md) for implementation phases.

### Asset Schema

**File**: `lib/lossy/documents/asset.ex`

```elixir
defmodule Lossy.Documents.Asset do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "assets" do
    field :kind, Ecto.Enum, values: [:original, :working, :mask, :inpainted_patch, :export]
    field :storage_uri, :string
    field :width, :integer
    field :height, :integer
    field :sha256, :string
    field :metadata, :map, default: %{}

    belongs_to :document, Lossy.Documents.Document

    timestamps()
  end

  def changeset(asset, attrs) do
    asset
    |> cast(attrs, [:document_id, :kind, :storage_uri, :width, :height, :sha256, :metadata])
    |> validate_required([:document_id, :kind, :storage_uri])
  end
end
```

Pair this with a dedicated module:

```elixir
defmodule Lossy.Assets do
  alias Lossy.Documents.{Asset, Document}

  def local_path(%Asset{storage_uri: "file://" <> path}), do: path
  def local_path(asset), do: Lossy.Storage.download(asset)

  def create_inpainted_patch(region, path, bbox) do
    # Persist metadata + dimensions
  end

  def replace_working(%Document{} = doc, path) do
    # Create/update working asset record and return it
  end
end
```
