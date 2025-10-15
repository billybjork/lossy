defmodule Lossy.Videos.Note do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "notes" do
    field :text, :string
    field :raw_transcript, :string
    field :timestamp_seconds, :float
    field :category, :string
    field :confidence, :float
    field :status, :string, default: "ghost"
    field :posted_at, :utc_datetime
    field :platform_comment_id, :string
    field :external_permalink, :string
    field :error, :string

    # For Sprint 02, we'll use session_id as a virtual field until we integrate users
    field :session_id, :string, virtual: true

    belongs_to :video, Lossy.Videos.Video
    belongs_to :user, Lossy.Users.User

    timestamps()
  end

  def changeset(note, attrs) do
    note
    |> cast(attrs, [
      :video_id,
      :user_id,
      :text,
      :raw_transcript,
      :timestamp_seconds,
      :category,
      :confidence,
      :status,
      :posted_at,
      :platform_comment_id,
      :external_permalink,
      :error,
      :session_id
    ])
    |> validate_required([:text, :timestamp_seconds])
    |> validate_inclusion(
      :category,
      ~w(pacing audio visual editing general color graphics content other)
    )
    |> validate_inclusion(:status, ~w(ghost firmed pending_post posting posted failed cancelled))
    |> validate_number(:confidence, greater_than_or_equal_to: 0.0, less_than_or_equal_to: 1.0)
    |> foreign_key_constraint(:video_id)
    |> foreign_key_constraint(:user_id)
  end
end
