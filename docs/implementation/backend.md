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
│   ├── ml/                         # ML service integration
│   │   ├── replicate_client.ex
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
  }
}
```

**Response**:
```json
{
  "id": "uuid",
  "status": "pending_detection"
}
```

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
    |> Repo.preload([:text_regions, :processing_jobs])
  end

  ## Text detection

  def enqueue_text_detection(%Document{} = document) do
    {:ok, job} = create_processing_job(%{
      document_id: document.id,
      type: :text_detection,
      status: :queued,
      payload: %{}
    })

    # Spawn async task
    Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
      execute_text_detection(job)
    end)

    :ok
  end

  defp execute_text_detection(%ProcessingJob{} = job) do
    job = mark_job_running(job)
    document = get_document(job.document_id)

    case Lossy.ML.TextDetection.detect(document.original_image_path) do
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
        update_document_status(document, :ready)
        broadcast_document_updated(document)

      {:error, reason} ->
        mark_job_error(job, reason)
    end
  end

  ## Inpainting

  def inpaint_region(%TextRegion{} = region) do
    {:ok, job} = create_processing_job(%{
      document_id: region.document_id,
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

    # Calculate inpaint region (bbox + padding)
    inpaint_bbox = Logic.calculate_inpaint_region(region, 10)

    case Lossy.ML.Inpainting.inpaint(document.original_image_path, inpaint_bbox) do
      {:ok, inpainted_patch_path} ->
        # Update region
        update_text_region(region, %{
          inpainted_bg_path: inpainted_patch_path,
          status: :inpainted
        })

        # Composite into working image
        {:ok, working_path} = Lossy.ImageProcessing.Compositor.composite_patch(
          document.working_image_path,
          inpainted_patch_path,
          inpaint_bbox
        )

        # Render new text
        {:ok, final_path} = Lossy.ImageProcessing.TextRenderer.render_text(
          working_path,
          region
        )

        update_text_region(region, %{status: :rendered})
        update_document(document, %{working_image_path: final_path})

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
    field :image_source, Ecto.Enum, values: [:direct_url, :screenshot]
    field :original_image_path, :string
    field :working_image_path, :string
    field :status, Ecto.Enum, values: [:pending_detection, :ready, :error]

    belongs_to :user, Lossy.Accounts.User
    has_many :text_regions, Lossy.Documents.TextRegion
    has_many :processing_jobs, Lossy.Documents.ProcessingJob

    timestamps()
  end

  def changeset(document, attrs) do
    document
    |> cast(attrs, [:source_url, :image_source, :original_image_path, :working_image_path, :status, :user_id])
    |> validate_required([:source_url, :image_source, :original_image_path])
    |> validate_inclusion(:image_source, [:direct_url, :screenshot])
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
    field :padding_px, :integer, default: 10
    field :original_text, :string
    field :current_text, :string
    field :font_family, :string, default: "Inter"
    field :font_weight, :integer, default: 400
    field :font_size_px, :integer, default: 16
    field :color_rgba, :string, default: "rgba(0,0,0,1)"
    field :alignment, Ecto.Enum, values: [:left, :center, :right], default: :left
    field :inpainted_bg_path, :string
    field :z_index, :integer, default: 0
    field :status, Ecto.Enum, values: [:detected, :inpainted, :rendered], default: :detected

    belongs_to :document, Lossy.Documents.Document

    timestamps()
  end

  def changeset(region, attrs) do
    region
    |> cast(attrs, [:document_id, :bbox, :padding_px, :original_text, :current_text,
                    :font_family, :font_weight, :font_size_px, :color_rgba, :alignment,
                    :inpainted_bg_path, :z_index, :status])
    |> validate_required([:document_id, :bbox, :current_text])
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
    field :payload, :map
    field :status, Ecto.Enum, values: [:queued, :running, :done, :error]
    field :error_message, :string

    belongs_to :document, Lossy.Documents.Document

    timestamps()
  end

  def changeset(job, attrs) do
    job
    |> cast(attrs, [:document_id, :type, :payload, :status, :error_message])
    |> validate_required([:document_id, :type, :status])
    |> foreign_key_constraint(:document_id)
  end
end
```

---

## ML Service Integration

### Replicate Client

**File**: `lib/lossy/ml/replicate_client.ex`

```elixir
defmodule Lossy.ML.ReplicateClient do
  @api_url "https://api.replicate.com/v1/predictions"

  def create_prediction(version_id, input) do
    api_key = Application.get_env(:lossy, :replicate_api_key)

    HTTPoison.post(
      @api_url,
      Jason.encode!(%{version: version_id, input: input}),
      [
        {"Authorization", "Token #{api_key}"},
        {"Content-Type", "application/json"}
      ]
    )
    |> handle_response()
  end

  def get_prediction(prediction_id) do
    api_key = Application.get_env(:lossy, :replicate_api_key)

    HTTPoison.get(
      "#{@api_url}/#{prediction_id}",
      [{"Authorization", "Token #{api_key}"}]
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
  alias Lossy.ML.ReplicateClient

  @paddleocr_version "version-id-here"

  def detect(image_path) do
    input = %{image: image_path}

    with {:ok, prediction} <- ReplicateClient.create_prediction(@paddleocr_version, input),
         {:ok, result} <- await_completion(prediction["id"]) do
      parse_detection_result(result)
    end
  end

  defp await_completion(prediction_id, attempts \\ 0) do
    if attempts > 60, do: {:error, :timeout}

    {:ok, prediction} = ReplicateClient.get_prediction(prediction_id)

    case prediction["status"] do
      "succeeded" -> {:ok, prediction["output"]}
      "failed" -> {:error, prediction["error"]}
      _ ->
        Process.sleep(1000)
        await_completion(prediction_id, attempts + 1)
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
  alias Lossy.ML.ReplicateClient

  @lama_version "version-id-here"

  def inpaint(image_path, bbox) do
    # Create mask image
    mask_path = create_mask(image_path, bbox)

    input = %{
      image: image_path,
      mask: mask_path
    }

    with {:ok, prediction} <- ReplicateClient.create_prediction(@lama_version, input),
         {:ok, result_url} <- await_completion(prediction["id"]),
         {:ok, local_path} <- download_result(result_url) do
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

  defp await_completion(prediction_id), do: # Similar to text detection
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
        image_source: :direct_url,
        original_image_path: "/path/to/image.jpg"
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
  ecto_repos: [Lossy.Repo],
  replicate_api_key: System.get_env("REPLICATE_API_KEY")

config :lossy, Lossy.Repo,
  database: "lossy_dev",
  username: "postgres",
  password: "postgres",
  hostname: "localhost"

# PubSub
config :lossy, Lossy.PubSub,
  name: Lossy.PubSub,
  adapter: Phoenix.PubSub.PG2

# File uploads
config :lossy, :uploads_dir, "priv/static/uploads"
```

---

## Deployment Considerations

### Environment Variables
- `REPLICATE_API_KEY`: API key for ML services
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
