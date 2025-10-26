defmodule Lossy.Settings do
  @moduledoc """
  Context responsible for persistent user preference data such as feature flags,
  confidence thresholds, and future policy toggles shared between Phoenix and
  the Chrome extension.
  """

  import Ecto.Query

  alias Lossy.FeatureFlags
  alias Lossy.Repo
  alias Lossy.Settings.UserSettings

  @doc """
  Fetches the persisted settings for a user. When no record exists the defaults
  are inserted atomically and returned.
  """
  @spec get_or_create_user_settings(String.t()) :: UserSettings.t()
  def get_or_create_user_settings(user_id) when is_binary(user_id) do
    case Repo.get_by(UserSettings, user_id: user_id) do
      nil ->
        %UserSettings{}
        |> UserSettings.changeset(%{user_id: user_id})
        |> Repo.insert!(
          conflict_target: :user_id,
          on_conflict: {:replace, [:updated_at]}
        )

      settings ->
        settings
    end
  end

  @spec update_user_settings(UserSettings.t() | String.t(), map()) ::
          {:ok, UserSettings.t()} | {:error, Ecto.Changeset.t()}
  def update_user_settings(%UserSettings{} = settings, attrs) do
    settings
    |> UserSettings.changeset(attrs)
    |> Repo.update()
  end

  def update_user_settings(user_id, attrs) when is_binary(user_id) do
    get_or_create_user_settings(user_id)
    |> update_user_settings(attrs)
  end

  @spec list_missing_settings() :: [String.t()]
  def list_missing_settings do
    subquery =
      from(us in UserSettings,
        select: us.user_id
      )

    from(u in Lossy.Users.User,
      where: u.id not in subquery(subquery),
      select: u.id
    )
    |> Repo.all()
  end

  @doc """
  Ensures every user has a settings record. Intended for seed/backfill tasks.
  """
  @spec backfill_user_settings!() :: :ok
  def backfill_user_settings! do
    list_missing_settings()
    |> Enum.each(&get_or_create_user_settings/1)

    :ok
  end

  @spec feature_flags_for(String.t()) :: map()
  def feature_flags_for(user_id) when is_binary(user_id) do
    user_id
    |> get_or_create_user_settings()
    |> feature_flags_from_settings()
  end

  @spec feature_flags_from_settings(UserSettings.t()) :: map()
  def feature_flags_from_settings(%UserSettings{feature_flags: flags}) do
    FeatureFlags.to_boolean_map(flags)
  end

  @spec min_confidence_for(String.t()) :: float()
  def min_confidence_for(user_id) do
    user_id
    |> get_or_create_user_settings()
    |> Map.get(:min_confidence)
  end
end
