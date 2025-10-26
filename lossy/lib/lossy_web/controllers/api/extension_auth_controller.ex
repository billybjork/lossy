defmodule LossyWeb.Api.ExtensionAuthController do
  use LossyWeb, :controller

  alias Lossy.Settings
  alias LossyWeb.ExtensionAuth

  def create(conn, params) do
    with {:ok, device_id} <- extract_device_id(params),
         current_user <- conn.assigns.current_user,
         {:ok, body} <- issue_token(current_user.id, device_id, params) do
      conn
      |> put_status(:created)
      |> json(body)
    else
      {:error, :missing_device_id} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: "device_id_required"})

      {:error, :invalid_protocol} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: "invalid_protocol_version"})
    end
  end

  defp extract_device_id(%{"device_id" => device_id}) when is_binary(device_id) and device_id != "" do
    {:ok, device_id}
  end

  defp extract_device_id(_), do: {:error, :missing_device_id}

  defp issue_token(user_id, device_id, params) do
    requested_protocol =
      params
      |> Map.get("protocol_version")
      |> normalize_protocol()

    case requested_protocol do
      {:ok, protocol_version} ->
        %{token: token, claims: claims} =
          ExtensionAuth.issue_channel_token(user_id, device_id,
            protocol_version: protocol_version
          )

        settings = Settings.get_or_create_user_settings(user_id)
        features = Settings.feature_flags_from_settings(settings)

        {:ok,
         %{
           token: token,
           expires_at: claims["exp"],
           protocol_version: claims["protocol_version"],
           features: features,
           min_confidence: settings.min_confidence
         }}

      {:error, _} ->
        {:error, :invalid_protocol}
    end
  end

  defp normalize_protocol(nil), do: {:ok, LossyWeb.ChannelProtocol.latest_version()}

  defp normalize_protocol(version) when is_integer(version),
    do: {:ok, version}

  defp normalize_protocol(version) when is_binary(version) do
    case Integer.parse(version) do
      {parsed, ""} -> {:ok, parsed}
      _ -> {:error, :invalid}
    end
  end

  defp normalize_protocol(_), do: {:error, :invalid}
end
