defmodule Lossy.Accounts.User do
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
