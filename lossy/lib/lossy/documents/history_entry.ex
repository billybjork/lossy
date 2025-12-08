defmodule Lossy.Documents.HistoryEntry do
  @moduledoc """
  Embedded schema for document edit history.

  Each entry represents a snapshot of the document state after an operation.
  Used for undo/redo functionality.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false

  @action_types [:restore]

  embedded_schema do
    # Path to the image state at this point in history
    field :image_path, :string

    # When this action was performed
    field :timestamp, :utc_datetime

    # Type of action that created this entry
    field :action, Ecto.Enum, values: @action_types

    # Additional context (region IDs, mask paths, etc.)
    field :metadata, :map, default: %{}
  end

  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:image_path, :timestamp, :action, :metadata])
    |> validate_required([:image_path, :timestamp, :action])
    |> validate_inclusion(:action, @action_types)
  end
end
