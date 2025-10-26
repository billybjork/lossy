defmodule LossyWeb.ChannelProtocol do
  @moduledoc """
  Handles negotiation between the extension and Phoenix for channel protocol
  versions and related metadata returned during the join handshake.
  """

  @supported_versions [1, 2]

  @spec supported_versions() :: [integer()]
  def supported_versions, do: @supported_versions

  @spec latest_version() :: integer()
  def latest_version, do: List.last(@supported_versions)

  @doc """
  Determines which protocol version should be active during a channel session.

  Prefers the requested version when it is supported; otherwise falls back to
  the highest version Phoenix supports.
  """
  @spec negotiate(non_neg_integer() | nil, non_neg_integer() | nil) ::
          {integer(), [integer()]}
  def negotiate(requested_version, token_version \\ nil)

  def negotiate(nil, nil) do
    {@supported_versions |> List.last(), @supported_versions}
  end

  def negotiate(nil, token_version) do
    negotiate(token_version, nil)
  end

  def negotiate(requested_version, _token_version)
      when is_integer(requested_version) and requested_version in @supported_versions do
    {requested_version, @supported_versions}
  end

  def negotiate(_requested_version, token_version)
      when is_integer(token_version) and token_version in @supported_versions do
    {token_version, @supported_versions}
  end

  def negotiate(_requested_version, _token_version) do
    {@supported_versions |> List.last(), @supported_versions}
  end
end
