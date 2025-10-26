defmodule LossyWeb.ExtensionAuth do
  @moduledoc """
  Generates and verifies signed tokens used by the Chrome extension when
  establishing Phoenix channel connections.

  Tokens are short-lived and embed the user/device relationship so we can
  assert that join attempts originate from a browser that already holds a
  valid Phoenix session cookie.
  """

  alias Phoenix.Token

  @token_salt "extension-channel-auth"
  @default_ttl 900
  @max_age 1_800

  @type claims :: %{
          String.t() => String.t() | non_neg_integer()
        }

  @spec issue_channel_token(String.t(), String.t(), Keyword.t()) :: %{
          token: String.t(),
          claims: claims()
        }
  def issue_channel_token(user_id, device_id, opts \\ []) when is_binary(user_id) do
    ttl = Keyword.get(opts, :ttl, @default_ttl)
    protocol_version = Keyword.get(opts, :protocol_version, LossyWeb.ChannelProtocol.latest_version())

    exp =
      DateTime.utc_now()
      |> DateTime.add(ttl, :second)
      |> DateTime.to_unix()

    claims = %{
      "user_id" => user_id,
      "device_id" => device_id,
      "exp" => exp,
      "protocol_version" => protocol_version
    }

    %{
      token: Token.sign(LossyWeb.Endpoint, @token_salt, claims),
      claims: claims
    }
  end

  @spec generate_channel_token(String.t(), String.t(), Keyword.t()) :: String.t()
  def generate_channel_token(user_id, device_id, opts \\ []) do
    issue_channel_token(user_id, device_id, opts).token
  end

  @spec verify_channel_token(String.t()) :: {:ok, claims()} | {:error, atom()}
  def verify_channel_token(token) when is_binary(token) do
    with {:ok, claims} <- Token.verify(LossyWeb.Endpoint, @token_salt, token, max_age: @max_age),
         :ok <- validate_required_claims(claims),
         :ok <- validate_expiration(claims),
         :ok <- validate_protocol_version(claims) do
      {:ok, claims}
    else
      {:error, _reason} -> {:error, :invalid_token}
    end
  rescue
    _ -> {:error, :invalid_token}
  end

  def verify_channel_token(_), do: {:error, :invalid_token}

  @spec default_ttl() :: non_neg_integer()
  def default_ttl, do: @default_ttl

  defp validate_required_claims(claims) do
    required = ["user_id", "device_id", "exp", "protocol_version"]

    missing =
      required
      |> Enum.reject(&Map.has_key?(claims, &1))

    case missing do
      [] -> :ok
      _ -> {:error, :missing_claims}
    end
  end

  defp validate_expiration(%{"exp" => exp}) do
    now = DateTime.utc_now() |> DateTime.to_unix()

    if exp > now do
      :ok
    else
      {:error, :expired}
    end
  end

  defp validate_protocol_version(%{"protocol_version" => version})
       when is_integer(version) and version > 0 do
    :ok
  end

  defp validate_protocol_version(_), do: {:error, :invalid_protocol_version}
end
