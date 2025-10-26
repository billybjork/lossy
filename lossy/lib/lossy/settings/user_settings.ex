defmodule Lossy.Settings.UserSettings do
  use Ecto.Schema
  import Ecto.Changeset

  alias Lossy.FeatureFlags
  alias Lossy.Users.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "user_settings" do
    field :feature_flags, :map, default: FeatureFlags.default_flags()
    field :min_confidence, :float, default: 0.3
    field :preferred_protocol_version, :integer
    field :metadata, :map, default: %{}

    belongs_to :user, User

    timestamps()
  end

  @doc false
  def changeset(settings, attrs \\ %{}) do
    settings
    |> cast(attrs, [
      :feature_flags,
      :min_confidence,
      :preferred_protocol_version,
      :metadata,
      :user_id
    ])
    |> put_default_feature_flags()
    |> validate_required([:feature_flags, :min_confidence, :user_id])
    |> validate_number(:min_confidence,
      greater_than_or_equal_to: 0.0,
      less_than_or_equal_to: 1.0
    )
    |> unique_constraint(:user_id)
  end

  def defaults do
    %{
      "feature_flags" => FeatureFlags.default_flags(),
      "min_confidence" => 0.3,
      "metadata" => %{}
    }
  end

  defp put_default_feature_flags(changeset) do
    flags =
      changeset
      |> get_field(:feature_flags, %{})
      |> FeatureFlags.ensure_flag_keys()

    put_change(changeset, :feature_flags, flags)
  end
end
