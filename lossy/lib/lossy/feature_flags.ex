defmodule Lossy.FeatureFlags do
  @moduledoc """
  Central place for feature flag defaults and helpers used by both Phoenix and
  the Chrome extension. Flags are persisted per-user in the settings table but
  always merged with the server defaults to avoid missing keys.
  """

  @default_flags %{
    "phoenix_voice_session" => false,
    "phoenix_notes_channel" => false,
    "phoenix_video_context" => false,
    "phoenix_telemetry" => false
  }

  @spec default_flags() :: map()
  def default_flags, do: @default_flags

  @spec ensure_flag_keys(map() | nil) :: map()
  def ensure_flag_keys(flags) when is_map(flags) do
    Map.merge(@default_flags, flags)
  end

  def ensure_flag_keys(_flags), do: @default_flags

  @spec enabled?(map(), String.t() | atom()) :: boolean()
  def enabled?(flags, flag_name) when is_atom(flag_name) do
    enabled?(flags, Atom.to_string(flag_name))
  end

  def enabled?(flags, flag_name) when is_map(flags) and is_binary(flag_name) do
    flags
    |> ensure_flag_keys()
    |> Map.get(flag_name, false)
  end

  def enabled?(_flags, _flag_name), do: false

  @spec to_boolean_map(map() | nil) :: map()
  def to_boolean_map(flags) do
    flags
    |> ensure_flag_keys()
    |> Enum.into(%{}, fn
      {key, true} -> {key, true}
      {key, _} -> {key, false}
    end)
  end
end
