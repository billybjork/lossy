defmodule LossyWeb.Plugs.RequireAuthenticatedUser do
  @moduledoc """
  Ensures the request originates from an authenticated Phoenix session.

  The extension reuses the browser session cookie, so any API route that
  returns channel tokens should pass through this plug.
  """

  import Plug.Conn

  alias Lossy.Users

  def init(opts), do: opts

  def call(conn, _opts) do
    current_user =
      conn.assigns[:current_user] ||
        conn.assigns[:current_user_id] && Users.get_user(conn.assigns[:current_user_id]) ||
        conn |> get_session(:user_id) |> maybe_fetch_user()

    case current_user do
      nil ->
        conn
        |> send_unauthorized()
        |> halt()

      user ->
        Users.ensure_settings(user)
        assign(conn, :current_user, user)
    end
  end

  defp maybe_fetch_user(nil), do: nil
  defp maybe_fetch_user(user_id), do: Users.get_user(user_id)

  defp send_unauthorized(conn) do
    body = Jason.encode!(%{error: "unauthenticated"})

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(:unauthorized, body)
  end
end
