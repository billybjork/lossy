defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  @impl true
  def join("audio:" <> session_id, _payload, socket) do
    Logger.info("Audio channel joined: #{session_id}")
    {:ok, assign(socket, :session_id, session_id)}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_map(audio_data) do
    # Convert map with string keys to list, then to binary
    audio_list = audio_data
    |> Enum.sort_by(fn {k, _v} -> String.to_integer(k) end)
    |> Enum.map(fn {_k, v} -> v end)

    audio_binary = :binary.list_to_bin(audio_list)

    Logger.info("Received audio chunk: #{byte_size(audio_binary)} bytes")

    # Echo back a fake transcript for testing
    push(socket, "transcript", %{
      text: "Fake transcript of audio",
      timestamp: System.system_time(:second)
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_binary(audio_data) do
    Logger.info("Received audio chunk: #{byte_size(audio_data)} bytes")

    # Echo back a fake transcript for testing
    push(socket, "transcript", %{
      text: "Fake transcript of audio",
      timestamp: System.system_time(:second)
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
  end
end
