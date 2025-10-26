defmodule Lossy.Users do
  @moduledoc """
  User context exposing helpers required by Phoenix controllers, plugs, and
  channel authentication.
  """

  import Ecto.Query, warn: false

  alias Lossy.Repo
  alias Lossy.Settings
  alias Lossy.Users.User

  @spec list_users() :: [User.t()]
  def list_users, do: Repo.all(User)

  @spec get_user!(String.t()) :: User.t()
  def get_user!(id), do: Repo.get!(User, id)

  @spec get_user(String.t()) :: User.t() | nil
  def get_user(id), do: Repo.get(User, id)

  @spec get_user_by_email(String.t()) :: User.t() | nil
  def get_user_by_email(email) when is_binary(email) do
    Repo.get_by(User, email: email)
  end

  @spec ensure_settings(User.t()) :: User.t()
  def ensure_settings(%User{id: user_id} = user) do
    Settings.get_or_create_user_settings(user_id)
    user
  end

  @spec ensure_settings(String.t()) :: :ok
  def ensure_settings(user_id) when is_binary(user_id) do
    Settings.get_or_create_user_settings(user_id)
    :ok
  end
end
