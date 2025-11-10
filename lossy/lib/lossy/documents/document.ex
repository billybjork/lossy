defmodule Lossy.Documents.Document do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @valid_statuses [:queued_detection, :detecting, :awaiting_edits, :rendering, :export_ready, :error]
  @status_transitions %{
    queued_detection: [:detecting, :error],
    detecting: [:awaiting_edits, :error],
    awaiting_edits: [:rendering, :error],
    rendering: [:export_ready, :awaiting_edits, :error],
    export_ready: [:awaiting_edits, :error],
    error: [:queued_detection]
  }

  schema "documents" do
    field :source_url, :string
    field :capture_mode, Ecto.Enum, values: [:direct_asset, :screenshot, :composited_region]
    field :dimensions, :map
    field :metrics, :map, default: %{}
    field :status, Ecto.Enum, values: @valid_statuses, default: :queued_detection

    belongs_to :user, Lossy.Accounts.User
    belongs_to :original_asset, Lossy.Documents.Asset
    belongs_to :working_asset, Lossy.Documents.Asset

    has_many :text_regions, Lossy.Documents.TextRegion
    has_many :processing_jobs, Lossy.Documents.ProcessingJob

    timestamps()
  end

  def changeset(document, attrs) do
    document
    |> cast(attrs, [:user_id, :source_url, :capture_mode, :dimensions, :original_asset_id,
                     :working_asset_id, :status, :metrics])
    |> validate_required([:source_url, :capture_mode])
    |> validate_inclusion(:capture_mode, [:direct_asset, :screenshot, :composited_region])
    |> validate_inclusion(:status, @valid_statuses)
    |> validate_status_transition()
  end

  defp validate_status_transition(changeset) do
    case get_change(changeset, :status) do
      nil ->
        changeset

      new_status ->
        old_status = Map.get(changeset.data, :status)

        if old_status && !valid_transition?(old_status, new_status) do
          add_error(
            changeset,
            :status,
            "invalid status transition from #{old_status} to #{new_status}"
          )
        else
          changeset
        end
    end
  end

  defp valid_transition?(from_status, to_status) do
    allowed = Map.get(@status_transitions, from_status, [])
    to_status in allowed
  end
end
