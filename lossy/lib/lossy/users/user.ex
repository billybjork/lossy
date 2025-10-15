defmodule Lossy.Users.User do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field :email, :string
    field :password_hash, :string
    field :name, :string

    has_many :videos, Lossy.Videos.Video
    has_many :notes, Lossy.Videos.Note

    timestamps()
  end

  def changeset(user, attrs) do
    user
    |> cast(attrs, [:email, :password_hash, :name])
    |> validate_required([:email, :password_hash])
    |> validate_format(:email, ~r/@/)
    |> unique_constraint(:email)
  end
end
