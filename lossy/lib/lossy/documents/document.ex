defmodule Lossy.Documents.Document do
  @moduledoc """
  Schema for documents with detection and inpainting workflow.

  Simplified lifecycle:
    :loading → :ready

  Includes edit history for undo/redo functionality.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Lossy.Documents.HistoryEntry

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @valid_statuses [
    # Initial state, image being fetched
    :loading,
    # Image loaded, ready for editing
    :ready,

    # Something went wrong
    :error
  ]

  schema "documents" do
    field :source_url, :string
    field :capture_mode, Ecto.Enum, values: [:direct_asset, :screenshot]
    field :width, :integer
    field :height, :integer
    field :status, Ecto.Enum, values: @valid_statuses, default: :loading
    field :source, Ecto.Enum, values: [:extension, :upload], default: :extension

    # Human-readable identifier: lossy-YYYYMMDD-NNN
    field :name, :string
    # Extracted hostname from source_url (e.g., "nytimes.com")
    field :source_domain, :string

    # History for undo/redo
    embeds_many :history, HistoryEntry, on_replace: :delete
    field :history_index, :integer, default: 0

    belongs_to :original_asset, Lossy.Documents.Asset
    belongs_to :working_asset, Lossy.Documents.Asset

    # Detected regions (text, manual brush)
    has_many :detected_regions, Lossy.Documents.DetectedRegion

    timestamps()
  end

  def changeset(document, attrs) do
    document
    |> cast(attrs, [
      :source_url,
      :capture_mode,
      :width,
      :height,
      :original_asset_id,
      :working_asset_id,
      :status,
      :history_index,
      :name,
      :source_domain,
      :source
    ])
    |> cast_embed(:history, with: &HistoryEntry.changeset/2)
    |> validate_required([:capture_mode])
    |> validate_inclusion(:capture_mode, [:direct_asset, :screenshot])
    |> validate_inclusion(:status, @valid_statuses)
    |> validate_inclusion(:source, [:extension, :upload])
  end

  @doc """
  Adds a history entry and updates the history index.
  Truncates any "future" history if we've undone and are making a new change.
  """
  def add_history_entry(document, entry) do
    # Truncate history at current index (discard redo stack)
    current_history = Enum.take(document.history || [], document.history_index)
    new_history = current_history ++ [entry]

    document
    |> changeset(%{
      history: Enum.map(new_history, &Map.from_struct/1),
      history_index: length(new_history)
    })
  end

  @doc """
  Gets the image path at the current history index.
  Returns nil if history is empty.
  """
  def current_image_path(document) do
    history = document.history || []
    index = document.history_index || 0

    if index > 0 and index <= length(history) do
      Enum.at(history, index - 1).image_path
    else
      nil
    end
  end

  @doc """
  Checks if undo is available.
  Returns true if we have at least one history entry and index > 0.
  """
  def can_undo?(document) do
    (document.history_index || 0) > 0
  end

  @doc """
  Checks if redo is available.
  """
  def can_redo?(document) do
    history = document.history || []
    (document.history_index || 0) < length(history)
  end
end
