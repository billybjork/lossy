defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  # Channels
  channel "audio:*", LossyWeb.AudioChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    # For now: accept all connections (no auth)
    # Later (Sprint 05): verify token from params["token"]
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
