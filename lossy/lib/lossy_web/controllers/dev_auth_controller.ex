defmodule LossyWeb.DevAuthController do
  @moduledoc """
  DEV/TEST ONLY: Simple authentication helper for testing the extension.

  DO NOT USE IN PRODUCTION.

  This controller provides a minimal login interface for development and testing.
  """

  use LossyWeb, :controller

  alias Lossy.Users

  def index(conn, _params) do
    html(conn, """
    <!DOCTYPE html>
    <html>
    <head>
      <title>Lossy - Dev Login</title>
      <style>
        body { font-family: system-ui; max-width: 400px; margin: 100px auto; padding: 20px; }
        h1 { color: #333; }
        form { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #45a049; }
        .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 4px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <h1>🧪 Lossy Dev Login</h1>
      <div class="warning">
        <strong>⚠️ DEV/TEST ONLY</strong><br>
        This page is for development and testing purposes only.
      </div>
      <form action="/dev/auth/login" method="post">
        <input type="hidden" name="_csrf_token" value="#{Plug.CSRFProtection.get_csrf_token()}" />
        <div>
          <label>Email:</label>
          <input type="email" name="email" value="test@lossy.app" required />
        </div>
        <div>
          <label>Password:</label>
          <input type="password" name="password" value="testpassword123" required />
        </div>
        <button type="submit">Login</button>
      </form>
      <p style="text-align: center; color: #666; margin-top: 20px;">
        Default test user: test@lossy.app / testpassword123
      </p>
    </body>
    </html>
    """)
  end

  def create(conn, %{"email" => email, "password" => password}) do
    case Users.get_user_by_email(email) do
      nil ->
        conn
        |> put_flash(:error, "Invalid email or password")
        |> redirect(to: "/dev/auth")

      user ->
        if Bcrypt.verify_pass(password, user.password_hash) do
          conn
          |> put_session(:user_id, user.id)
          |> put_flash(:info, "Logged in successfully as #{user.email}")
          |> redirect(to: "/dev/auth/success")
        else
          conn
          |> put_flash(:error, "Invalid email or password")
          |> redirect(to: "/dev/auth")
        end
    end
  end

  def success(conn, _params) do
    user_id = get_session(conn, :user_id)
    user = Users.get_user(user_id)

    html(conn, """
    <!DOCTYPE html>
    <html>
    <head>
      <title>Lossy - Logged In</title>
      <style>
        body { font-family: system-ui; max-width: 600px; margin: 100px auto; padding: 20px; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 4px; overflow-x: auto; }
      </style>
    </head>
    <body>
      <div class="success">
        <h1>✅ Logged In Successfully!</h1>
        <p><strong>User:</strong> #{user.email}</p>
        <p><strong>User ID:</strong> <code>#{user.id}</code></p>
      </div>

      <h2>📋 Next Steps for Testing</h2>
      <ol>
        <li><strong>Load the Chrome Extension</strong></li>
        <li><strong>Extension will use your session cookie</strong> to get an auth token</li>
        <li><strong>Start voice mode</strong> and check the console logs</li>
      </ol>

      <h2>🔧 Quick Commands</h2>
      <p><strong>Enable Phoenix Voice Session:</strong></p>
      <pre>Lossy.Settings.update_user_settings("#{user.id}", %{
  feature_flags: %{"phoenix_voice_session" => true}
})</pre>

      <p><strong>Disable Phoenix Voice Session:</strong></p>
      <pre>Lossy.Settings.update_user_settings("#{user.id}", %{
  feature_flags: %{"phoenix_voice_session" => false}
})</pre>

      <p style="margin-top: 40px; text-align: center;">
        <a href="/dev/auth/logout">Logout</a>
      </p>
    </body>
    </html>
    """)
  end

  def delete(conn, _params) do
    conn
    |> clear_session()
    |> put_flash(:info, "Logged out successfully")
    |> redirect(to: "/dev/auth")
  end
end
