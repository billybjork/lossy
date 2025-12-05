defmodule Lossy.Documents.Asset do
  @moduledoc """
  Schema for binary assets (images) associated with documents.

  Stores references to original, working, mask, inpainted, and export
  images with metadata and checksums for integrity verification.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "assets" do
    field :kind, Ecto.Enum, values: [:original, :working, :mask, :export]
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
    |> validate_inclusion(:kind, [:original, :working, :mask, :export])
  end
end
