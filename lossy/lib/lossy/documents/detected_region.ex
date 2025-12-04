defmodule Lossy.Documents.DetectedRegion do
  @moduledoc """
  Schema for detected regions within a document.

  Supports:
  - Text regions (from text detection)
  - Manual regions (from brush tool)

  Each region has a mask (stored as PNG) that defines the exact area
  to be inpainted, rather than just a bounding box.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @region_types [:text, :object, :manual]
  @statuses [:detected, :selected, :inpainting, :inpainted, :error]

  schema "detected_regions" do
    # Region type: "text" (from text detection), "object" (from SAM), "manual" (from brush)
    field :type, Ecto.Enum, values: @region_types, default: :object

    # Bounding box for quick hit-testing (x, y, w, h in pixels)
    field :bbox, :map

    # Path to mask PNG (binary mask for inpainting)
    field :mask_path, :string

    # Polygon outline for rendering (array of {x, y} points)
    field :polygon, {:array, :map}

    # Detection confidence (0.0 - 1.0)
    field :confidence, :float, default: 1.0

    # Flexible metadata (label, original_text for text regions, etc.)
    field :metadata, :map, default: %{}

    # Z-index for layering (higher = on top)
    field :z_index, :integer, default: 0

    # Processing status
    field :status, Ecto.Enum, values: @statuses, default: :detected

    belongs_to :document, Lossy.Documents.Document
    belongs_to :inpainted_asset, Lossy.Documents.Asset

    timestamps()
  end

  def changeset(region, attrs) do
    region
    |> cast(attrs, [
      :document_id,
      :type,
      :bbox,
      :mask_path,
      :polygon,
      :confidence,
      :metadata,
      :z_index,
      :status,
      :inpainted_asset_id
    ])
    |> validate_required([:document_id, :type])
    |> validate_number(:confidence, greater_than_or_equal_to: 0, less_than_or_equal_to: 1)
    |> validate_inclusion(:type, @region_types)
    |> validate_inclusion(:status, @statuses)
  end

  @doc """
  Creates a region from text detection output.
  """
  def from_text_detection(document_id, bbox, polygon, opts \\ []) do
    %__MODULE__{
      document_id: document_id,
      type: :text,
      bbox: bbox,
      polygon: polygon,
      confidence: Keyword.get(opts, :confidence, 1.0),
      metadata: %{
        original_text: Keyword.get(opts, :text, "")
      },
      z_index: Keyword.get(opts, :z_index, 0),
      status: :detected
    }
  end

  @doc """
  Creates a region from manual brush strokes.
  """
  def from_brush(document_id, mask_path, bbox) do
    %__MODULE__{
      document_id: document_id,
      type: :manual,
      bbox: bbox,
      mask_path: mask_path,
      confidence: 1.0,
      metadata: %{},
      z_index: 0,
      status: :detected
    }
  end
end
