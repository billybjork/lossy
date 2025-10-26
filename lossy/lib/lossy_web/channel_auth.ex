defmodule LossyWeb.ChannelAuth do
  @moduledoc """
  Shared authentication helper used by Phoenix channels to validate the join
  payload coming from the Chrome extension.
  """

  require Logger

  alias Lossy.Settings
  alias LossyWeb.ChannelJoinLimiter
  alias LossyWeb.ChannelProtocol
  alias LossyWeb.ExtensionAuth

  @type join_response :: %{
          active_version: integer(),
          supported_versions: [integer()],
          features: map(),
          device_id: String.t(),
          user_id: String.t(),
          min_confidence: float()
        }

  @spec authorize_join(Phoenix.Socket.t(), map(), keyword()) ::
          {:ok, Phoenix.Socket.t(), join_response()}
          | {:error, %{reason: atom()}}
  def authorize_join(socket, payload, opts \\ []) do
    with {:ok, token} <- resolve_token(socket, payload),
         {:ok, claims} <- ExtensionAuth.verify_channel_token(token),
         :ok <- ensure_device(payload, claims),
         :ok <- audit_join(claims),
         :ok <- rate_limit_join(claims, opts) do
      finalize_join(socket, payload, claims)
    else
      {:error, reason} ->
        Logger.warning("Channel join rejected: #{inspect(reason)}")
        {:error, %{reason: reason}}
    end
  end

  defp resolve_token(_socket, %{"token" => token}) when is_binary(token) do
    {:ok, token}
  end

  defp resolve_token(%{assigns: %{raw_token: token}}, _payload) when is_binary(token) do
    {:ok, token}
  end

  defp resolve_token(_socket, _payload), do: {:error, :missing_token}

  defp ensure_device(%{"device_id" => device_id}, %{"device_id" => device_id}) when is_binary(device_id) do
    :ok
  end

  defp ensure_device(%{"device_id" => _payload_device_id}, _claims), do: {:error, :device_mismatch}
  defp ensure_device(_payload, _claims), do: :ok

  defp audit_join(%{"user_id" => user_id, "device_id" => device_id}) do
    Logger.info("Channel join attempt user=#{user_id} device=#{device_id}")
    :ok
  end

  defp rate_limit_join(%{"device_id" => device_id}, opts) do
    limit = Keyword.get(opts, :limit, 12)
    window = Keyword.get(opts, :window, 60_000)

    ChannelJoinLimiter.allow?(device_id, limit: limit, window: window)
  end

  defp finalize_join(socket, payload, %{
         "user_id" => user_id,
         "device_id" => device_id,
         "protocol_version" => token_version
       }) do
    settings = Settings.get_or_create_user_settings(user_id)

    requested_version = Map.get(payload, "requested_version")

    {active_version, supported_versions} =
      ChannelProtocol.negotiate(normalize_version(requested_version), token_version)

    features = Settings.feature_flags_from_settings(settings)

    socket =
      socket
      |> Phoenix.Socket.assign(:user_id, user_id)
      |> Phoenix.Socket.assign(:device_id, device_id)
      |> Phoenix.Socket.assign(:active_protocol_version, active_version)
      |> Phoenix.Socket.assign(:supported_protocol_versions, supported_versions)
      |> Phoenix.Socket.assign(:feature_flags, features)
      |> Phoenix.Socket.assign(:user_settings_id, settings.id)
      |> Phoenix.Socket.assign(:min_confidence, settings.min_confidence)

    response = %{
      active_version: active_version,
      supported_versions: supported_versions,
      features: features,
      device_id: device_id,
      user_id: user_id,
      min_confidence: settings.min_confidence
    }

    {:ok, socket, response}
  end

  defp normalize_version(nil), do: nil

  defp normalize_version(version) when is_integer(version) and version > 0, do: version

  defp normalize_version(version) when is_binary(version) do
    case Integer.parse(version) do
      {parsed, ""} -> parsed
      _ -> nil
    end
  end

  defp normalize_version(_), do: nil
end
