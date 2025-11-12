defmodule Lossy.Accounts.User do
  @moduledoc """
  Schema for user accounts.

  Basic user model for associating documents with users.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    timestamps()
  end

  def changeset(user, attrs) do
    user
    |> cast(attrs, [])
  end
end
