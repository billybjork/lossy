defmodule Lossy.Documents.TextRegion do
  @moduledoc """
  Schema for detected text regions within a document.

  Stores bounding box, polygon, original/edited text, and styling
  information for text regions that can be inpainted and replaced.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "text_regions" do
    field :bbox, :map
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

    field :status, Ecto.Enum,
      values: [:detected, :inpainting, :rendered, :error],
      default: :detected

    field :editing_status, Ecto.Enum,
      values: [:idle, :inpainting_blank, :ready_to_edit, :rendering_text],
      default: :idle

    belongs_to :document, Lossy.Documents.Document
    belongs_to :inpainted_asset, Lossy.Documents.Asset

    timestamps()
  end

  def changeset(region, attrs) do
    region
    |> cast(attrs, [
      :document_id,
      :bbox,
      :polygon,
      :padding_px,
      :original_text,
      :current_text,
      :style_snapshot,
      :font_family,
      :font_weight,
      :font_size_px,
      :color_rgba,
      :alignment,
      :inpainted_asset_id,
      :z_index,
      :status,
      :editing_status
    ])
    |> validate_required([:document_id, :bbox])
    |> validate_number(:font_size_px, greater_than: 0)
    |> validate_inclusion(:alignment, [:left, :center, :right])
    |> validate_inclusion(:status, [:detected, :inpainting, :rendered, :error])
    |> validate_inclusion(:editing_status, [:idle, :inpainting_blank, :ready_to_edit, :rendering_text])
  end
end
