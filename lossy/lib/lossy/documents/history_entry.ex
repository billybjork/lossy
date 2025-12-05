defmodule Lossy.Documents.HistoryEntry do
  @moduledoc """
  Embedded schema for document edit history.

  Each entry represents a snapshot of the document state after an operation.
  Used for undo/redo functionality.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false

  @action_types [:inpaint, :brush_inpaint, :batch_inpaint, :restore]

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

  @doc """
  Creates a new history entry for an inpainting operation.
  """
  def new_inpaint(image_path, region_ids) when is_list(region_ids) do
    %__MODULE__{
      image_path: image_path,
      timestamp: DateTime.utc_now(),
      action: if(length(region_ids) > 1, do: :batch_inpaint, else: :inpaint),
      metadata: %{region_ids: region_ids}
    }
  end
end
