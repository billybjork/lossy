defmodule Lossy.Documents.DetectedRegion do
  @moduledoc """
  Schema for detected regions within a document.

  Supports:
  - Text regions (from text detection)
  - Manual regions (from click-to-segment or brush tool)

  Each region has a mask (stored as PNG) that defines the exact area
  to be inpainted, rather than just a bounding box.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @region_types [:text, :manual, :object]
  @statuses [:detected, :inpainted, :error]

  schema "detected_regions" do
    # Region type: "text" (from text detection), "object" (from segmentation), "manual" (from click-to-segment)
    field :type, Ecto.Enum, values: @region_types, default: :manual

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

    timestamps()
  end

  def changeset(region, attrs) do
    region
    |> cast(attrs, [
      :type,
      :bbox,
      :mask_path,
      :polygon,
      :confidence,
      :metadata,
      :z_index,
      :status
    ])
    |> validate_required([:type])
    |> validate_number(:confidence, greater_than_or_equal_to: 0, less_than_or_equal_to: 1)
    |> validate_inclusion(:type, @region_types)
    |> validate_inclusion(:status, @statuses)
  end
end
