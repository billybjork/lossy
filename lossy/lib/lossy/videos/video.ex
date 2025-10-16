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
      :duration_seconds
    ])
    |> validate_required([:platform, :external_id, :url])
    # Platform can be any string - extension handles unknown platforms via GenericAdapter
    |> validate_format(:platform, ~r/^[a-z0-9_]+$/, message: "must be lowercase alphanumeric")
    |> unique_constraint([:platform, :external_id])
  end
end
