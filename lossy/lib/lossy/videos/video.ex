defmodule Lossy.Videos.Video do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "videos" do
    field :platform, :string
    field :external_id, :string
    field :url, :string
    field :title, :string
    field :thumbnail_url, :string
    field :duration_seconds, :float

    # Sprint 09: Video library
    field :status, :string, default: "in_progress"
    field :last_viewed_at, :utc_datetime
    field :queued_at, :utc_datetime
    field :completed_at, :utc_datetime
    field :metadata, :map, default: %{}

    # Virtual field: note count (loaded via query)
    field :note_count, :integer, virtual: true

    belongs_to :user, Lossy.Users.User

    has_many :notes, Lossy.Videos.Note

    timestamps()
  end

  def changeset(video, attrs) do
    video
    |> cast(attrs, [
      :user_id,
      :platform,
      :external_id,
      :url,
      :title,
      :thumbnail_url,
      :duration_seconds,
      :status,
      :last_viewed_at,
      :queued_at,
      :completed_at,
      :metadata
    ])
    |> validate_required([:platform, :external_id, :url])
    # Platform can be any string - extension handles unknown platforms via GenericAdapter
    |> validate_format(:platform, ~r/^[a-z0-9_]+$/, message: "must be lowercase alphanumeric")
    |> validate_inclusion(:status, ~w(queued in_progress complete archived))
    |> unique_constraint([:platform, :external_id])
    # Auto-set timestamps based on status transitions
    |> maybe_set_status_timestamps()
  end

  defp maybe_set_status_timestamps(changeset) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    case get_change(changeset, :status) do
      "queued" -> put_change(changeset, :queued_at, now)
      "complete" -> put_change(changeset, :completed_at, now)
      _ -> changeset
    end
  end
end
