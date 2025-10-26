defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  alias LossyWeb.ExtensionAuth

  channel "audio:*", LossyWeb.AudioChannel
  channel "video:*", LossyWeb.VideoChannel
  channel "notes:*", LossyWeb.NotesChannel

  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case ExtensionAuth.verify_channel_token(token) do
      {:ok, %{"user_id" => user_id, "device_id" => device_id} = claims} ->
        socket =
          socket
          |> assign(:user_id, user_id)
          |> assign(:device_id, device_id)
          |> assign(:token_protocol_version, claims["protocol_version"])
          |> assign(:raw_token, token)

        {:ok, socket}

      {:error, _reason} ->
        :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error

  @impl true
  def id(socket), do: "devices:#{socket.assigns.device_id}"
end
