# Sprint TBD: Authentication

**Status:** ⏳ Future
**Estimated Duration:** 2-3 days

---

## Goal

Add user authentication to support multiple users and prepare for production deployment. Uses **Phoenix.Token** (not cookies) for extension-compatible auth.

---

## Prerequisites

- ✅ Sprints 01-04 complete (core features working)
- ⏳ Ready to onboard real users
- ⏳ Extension ID obtained from Chrome Web Store (or dev mode)

---

## Deliverables

- [ ] User registration and login (REST API)
- [ ] Phoenix.Token-based auth (extension-compatible)
- [ ] Extension login flow via options page
- [ ] Token stored in chrome.storage.local (encrypted by OS)
- [ ] LiveView connections authenticated
- [ ] WebSocket channels authenticated
- [ ] Per-user data isolation with user-scoped queries
- [ ] PubSub topic namespacing (user:#{user_id})
- [ ] Logout functionality
- [ ] check_origin configuration for extension

---

## Why Token-Based Auth (Not Cookies)?

Extensions have origin `chrome-extension://EXTENSION_ID`, which creates issues with cookies:

- ❌ Cross-origin cookies blocked by browsers
- ❌ Third-party cookie restrictions
- ❌ SameSite policies incompatible

✅ **Solution: Phoenix.Token**
- Works across origins
- No CSRF vulnerability
- Extension storage encrypted at OS level
- 30-day expiry with refresh support

See `../../04_LIVEVIEW_PATTERNS.md` for complete patterns.

---

## Technical Tasks

### Task 1: Accounts Context (Backend)

**File:** `lib/lossy/accounts.ex` (new)

```elixir
defmodule Lossy.Accounts do
  @moduledoc """
  User account management.
  """

  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Accounts.User

  def create_user(attrs \\ %{}) do
    %User{}
    |> User.registration_changeset(attrs)
    |> Repo.insert()
  end

  def get_user!(id), do: Repo.get!(User, id)

  def get_user_by_email(email) do
    Repo.get_by(User, email: email)
  end

  def authenticate_user(email, password) do
    user = get_user_by_email(email)

    cond do
      user && Bcrypt.verify_pass(password, user.password_hash) ->
        {:ok, user}

      user ->
        Bcrypt.no_user_verify()
        {:error, :invalid_credentials}

      true ->
        Bcrypt.no_user_verify()
        {:error, :invalid_credentials}
    end
  end

  def change_user(user, attrs \\ %{}) do
    User.changeset(user, attrs)
  end
end
```

**File:** `lib/lossy/accounts/user.ex` (new)

```elixir
defmodule Lossy.Accounts.User do
  use Ecto.Schema
  import Ecto.Changeset

  schema "users" do
    field :email, :string
    field :password, :string, virtual: true
    field :password_hash, :string
    field :name, :string

    has_many :notes, Lossy.Videos.Note
    has_many :videos, Lossy.Videos.Video

    timestamps()
  end

  def registration_changeset(user, attrs) do
    user
    |> cast(attrs, [:email, :password, :name])
    |> validate_required([:email, :password])
    |> validate_email()
    |> validate_password()
    |> put_password_hash()
  end

  def changeset(user, attrs) do
    user
    |> cast(attrs, [:email, :name])
    |> validate_email()
  end

  defp validate_email(changeset) do
    changeset
    |> validate_required([:email])
    |> validate_format(:email, ~r/^[^\s]+@[^\s]+$/, message: "must be a valid email")
    |> unsafe_validate_unique(:email, Lossy.Repo)
    |> unique_constraint(:email)
  end

  defp validate_password(changeset) do
    changeset
    |> validate_required([:password])
    |> validate_length(:password, min: 8, max: 80)
  end

  defp put_password_hash(changeset) do
    case changeset do
      %Ecto.Changeset{valid?: true, changes: %{password: password}} ->
        put_change(changeset, :password_hash, Bcrypt.hash_pwd_salt(password))

      _ ->
        changeset
    end
  end
end
```

**Migration:**

```bash
cd lossy
mix ecto.gen.migration create_users
```

**File:** `priv/repo/migrations/TIMESTAMP_create_users.exs`

```elixir
defmodule Lossy.Repo.Migrations.CreateUsers do
  use Ecto.Migration

  def change do
    create table(:users) do
      add :email, :string, null: false
      add :password_hash, :string, null: false
      add :name, :string

      timestamps()
    end

    create unique_index(:users, [:email])

    # Add user_id to existing tables
    alter table(:videos) do
      add :user_id, references(:users, on_delete: :delete_all)
    end

    alter table(:notes) do
      add :user_id, references(:users, on_delete: :delete_all)
    end

    create index(:videos, [:user_id])
    create index(:notes, [:user_id])
  end
end
```

**Add bcrypt dependency:**

```elixir
# mix.exs
defp deps do
  [
    # ... existing deps ...
    {:bcrypt_elixir, "~> 3.0"}
  ]
end
```

Run: `mix deps.get && mix ecto.migrate`

---

### Task 2: Auth API Controller

**File:** `lib/lossy_web/controllers/auth_controller.ex` (new)

```elixir
defmodule LossyWeb.AuthController do
  use LossyWeb, :controller
  alias Lossy.Accounts

  @doc """
  Register a new user.
  POST /api/auth/register
  Body: {"email": "...", "password": "...", "name": "..."}
  """
  def register(conn, %{"email" => email, "password" => password} = params) do
    case Accounts.create_user(params) do
      {:ok, user} ->
        token = generate_token(user)

        conn
        |> put_status(:created)
        |> json(%{
          token: token,
          user: %{
            id: user.id,
            email: user.email,
            name: user.name
          }
        })

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{errors: format_errors(changeset)})
    end
  end

  @doc """
  Login existing user.
  POST /api/auth/login
  Body: {"email": "...", "password": "..."}
  """
  def login(conn, %{"email" => email, "password" => password}) do
    case Accounts.authenticate_user(email, password) do
      {:ok, user} ->
        token = generate_token(user)

        json(conn, %{
          token: token,
          user: %{
            id: user.id,
            email: user.email,
            name: user.name
          }
        })

      {:error, :invalid_credentials} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{error: "Invalid email or password"})
    end
  end

  @doc """
  Verify token validity (for client-side checks).
  GET /api/auth/verify
  Header: Authorization: Bearer TOKEN
  """
  def verify(conn, _params) do
    case get_token_from_header(conn) do
      {:ok, token} ->
        case verify_token(token) do
          {:ok, user_id} ->
            user = Accounts.get_user!(user_id)

            json(conn, %{
              valid: true,
              user: %{
                id: user.id,
                email: user.email,
                name: user.name
              }
            })

          {:error, _reason} ->
            conn
            |> put_status(:unauthorized)
            |> json(%{valid: false, error: "Invalid or expired token"})
        end

      {:error, _} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{valid: false, error: "No token provided"})
    end
  end

  # Private helpers

  defp generate_token(user) do
    Phoenix.Token.sign(
      LossyWeb.Endpoint,
      "user socket",
      user.id,
      max_age: 30 * 24 * 60 * 60  # 30 days
    )
  end

  defp verify_token(token) do
    Phoenix.Token.verify(
      LossyWeb.Endpoint,
      "user socket",
      token,
      max_age: 30 * 24 * 60 * 60
    )
  end

  defp get_token_from_header(conn) do
    case Plug.Conn.get_req_header(conn, "authorization") do
      ["Bearer " <> token] -> {:ok, token}
      _ -> {:error, :no_token}
    end
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", to_string(value))
      end)
    end)
  end
end
```

**Add routes:**

**File:** `lib/lossy_web/router.ex` (update)

```elixir
scope "/api", LossyWeb do
  pipe_through :api

  post "/auth/register", AuthController, :register
  post "/auth/login", AuthController, :login
  get "/auth/verify", AuthController, :verify
end
```

---

### Task 3: Socket Authentication

**File:** `lib/lossy_web/user_socket.ex` (update)

```elixir
defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  # Channels
  channel "audio:*", LossyWeb.AudioChannel
  channel "video:*", LossyWeb.VideoChannel

  @impl true
  def connect(params, socket, _connect_info) do
    case verify_token(params["auth_token"]) do
      {:ok, user_id} ->
        {:ok, assign(socket, :user_id, user_id)}

      {:error, _reason} ->
        :error
    end
  end

  @impl true
  def id(socket), do: "user:#{socket.assigns.user_id}"

  defp verify_token(nil), do: {:error, :no_token}

  defp verify_token(token) do
    Phoenix.Token.verify(
      LossyWeb.Endpoint,
      "user socket",
      token,
      max_age: 30 * 24 * 60 * 60
    )
  end
end
```

**File:** `lib/lossy_web/channels/audio_channel.ex` (update join)

```elixir
@impl true
def join("audio:" <> session_id, payload, socket) do
  user_id = socket.assigns.user_id  # From UserSocket.connect
  video_id = Map.get(payload, "video_id")
  timestamp = Map.get(payload, "timestamp")

  Logger.info("Audio channel joined: #{session_id} (user: #{user_id})")

  # Start AgentSession with user context
  case SessionSupervisor.start_session(session_id,
    user_id: user_id,
    video_id: video_id,
    timestamp: timestamp) do
    {:ok, _pid} ->
      Logger.info("Started AgentSession: #{session_id}")

    {:error, {:already_started, _pid}} ->
      Logger.info("AgentSession already running: #{session_id}")

    {:error, reason} ->
      Logger.error("Failed to start AgentSession: #{inspect(reason)}")
  end

  {:ok, assign(socket, :session_id, session_id)}
end
```

---

### Task 4: LiveView Authentication

**File:** `lib/lossy_web/live/side_panel_live.ex` (update mount)

```elixir
@impl true
def mount(_params, session, socket) do
  case verify_token(session["auth_token"]) do
    {:ok, user_id} ->
      session_id = session["session_id"] || generate_session_id()
      video_id = session["video_id"]

      # Subscribe to user-specific topics
      Phoenix.PubSub.subscribe(Lossy.PubSub, "session:#{session_id}")
      Phoenix.PubSub.subscribe(Lossy.PubSub, "user:#{user_id}")

      if video_id do
        Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")
      end

      # Load user-scoped notes
      notes = if video_id do
        Lossy.Videos.list_notes_for_user(user_id, video_id)
      else
        Lossy.Videos.list_recent_notes(user_id, limit: 50)
      end

      {:ok,
       socket
       |> assign(:user_id, user_id)
       |> assign(:session_id, session_id)
       |> assign(:current_video_id, video_id)
       |> stream(:notes, notes)}

    {:error, _reason} ->
      {:ok,
       socket
       |> put_flash(:error, "Please log in to continue")
       |> redirect(to: "/login")}
  end
end

defp verify_token(nil), do: {:error, :no_token}

defp verify_token(token) do
  Phoenix.Token.verify(
    LossyWeb.Endpoint,
    "user socket",
    token,
    max_age: 30 * 24 * 60 * 60
  )
end
```

---

### Task 5: Extension Login Flow

**File:** `extension/src/options/login.html` (new)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Voice Video Companion - Login</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 400px;
      margin: 40px auto;
      padding: 20px;
    }
    .form-group {
      margin-bottom: 15px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    button {
      width: 100%;
      padding: 10px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
    }
    button:hover {
      background: #45a049;
    }
    .error {
      color: red;
      margin-top: 10px;
    }
    .success {
      color: green;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>Login</h1>

  <form id="login-form">
    <div class="form-group">
      <label for="email">Email</label>
      <input type="email" id="email" required/>
    </div>

    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" required/>
    </div>

    <button type="submit">Login</button>
  </form>

  <div id="message"></div>

  <script src="login.js"></script>
</body>
</html>
```

**File:** `extension/src/options/login.js` (new)

```javascript
const API_BASE = 'http://localhost:4000/api';  // TODO: Use production URL

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const messageEl = document.getElementById('message');

  messageEl.textContent = 'Logging in...';
  messageEl.className = '';

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok) {
      // Store token in chrome.storage.local (encrypted by OS)
      await chrome.storage.local.set({
        authToken: data.token,
        user: data.user
      });

      messageEl.textContent = 'Login successful! You can close this page.';
      messageEl.className = 'success';

      // Notify service worker to reconnect
      chrome.runtime.sendMessage({ action: 'auth_updated' });

      // Auto-close after 2 seconds
      setTimeout(() => window.close(), 2000);
    } else {
      messageEl.textContent = data.error || 'Login failed';
      messageEl.className = 'error';
    }
  } catch (error) {
    messageEl.textContent = `Error: ${error.message}`;
    messageEl.className = 'error';
  }
});
```

**Update manifest:**

```json
{
  "options_page": "options/login.html",
  "permissions": ["storage"]
}
```

---

### Task 6: User-Scoped Queries

**File:** `lib/lossy/videos.ex` (update context)

```elixir
defmodule Lossy.Videos do
  # ... existing code ...

  @doc """
  List notes for a specific user and video.
  Ensures data isolation between users.
  """
  def list_notes_for_user(user_id, video_id) do
    Note
    |> where([n], n.user_id == ^user_id)
    |> where([n], n.video_id == ^video_id)
    |> order_by([n], desc: n.inserted_at)
    |> Repo.all()
  end

  @doc """
  List recent notes for a user (across all videos).
  """
  def list_recent_notes(user_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)

    Note
    |> where([n], n.user_id == ^user_id)
    |> order_by([n], desc: n.inserted_at)
    |> limit(^limit)
    |> Repo.all()
  end

  @doc """
  Create note with user_id.
  """
  def create_note(user_id, attrs \\ %{}) do
    %Note{}
    |> Note.changeset(Map.put(attrs, :user_id, user_id))
    |> Repo.insert()
  end

  @doc """
  Get user's video or create if not exists.
  """
  def find_or_create_video(user_id, attrs) do
    case get_video_by_platform_id(attrs.platform, attrs.platform_video_id) do
      nil ->
        %Video{}
        |> Video.changeset(Map.put(attrs, :user_id, user_id))
        |> Repo.insert()

      video ->
        {:ok, video}
    end
  end
end
```

---

### Task 7: Endpoint Configuration

**File:** `config/config.exs` (update)

```elixir
config :lossy, LossyWeb.Endpoint,
  # Allow extension origin
  check_origin: [
    "https://your-phoenix-app.com",
    "chrome-extension://YOUR_EXTENSION_ID"  # Get from chrome://extensions
  ]
```

**For development:**

```elixir
# config/dev.exs
config :lossy, LossyWeb.Endpoint,
  check_origin: [
    "http://localhost:4000",
    "chrome-extension://*"  # Wildcard for dev (extension ID changes)
  ]
```

**Getting Extension ID:**
1. Load extension in Chrome (Developer mode)
2. Go to `chrome://extensions`
3. Copy the ID under extension name
4. Add to `check_origin` list

---

### Task 8: PubSub Topic Namespacing

**Pattern for broadcasting user-specific events:**

```elixir
# Broadcast to specific user
Phoenix.PubSub.broadcast(
  Lossy.PubSub,
  "user:#{user_id}",
  {:notification, %{type: :note_posted, note_id: note.id}}
)

# Broadcast to session (within user context)
Phoenix.PubSub.broadcast(
  Lossy.PubSub,
  "session:#{session_id}",
  {:agent_event, %{type: :transcription_complete}}
)

# Broadcast to video (multi-user in future)
Phoenix.PubSub.broadcast(
  Lossy.PubSub,
  "video:#{video_id}",
  {:new_note, note}
)
```

---

## Testing Checklist

### Backend Tests

- [ ] User registration creates user with hashed password
- [ ] Login returns valid Phoenix.Token
- [ ] Token verification works in UserSocket.connect/3
- [ ] Token verification works in LiveView mount
- [ ] User-scoped queries return only user's data
- [ ] Invalid token returns :error

### Extension Tests

- [ ] Login flow stores token in chrome.storage.local
- [ ] Side panel connects with stored token
- [ ] WebSocket channels authenticate with token
- [ ] Logout clears token from storage
- [ ] Token expiry handled gracefully (redirect to login)

### Integration Tests

- [ ] End-to-end: Register → Login → Create note → Verify ownership
- [ ] Multi-user: User A cannot see User B's notes
- [ ] Token refresh before expiry
- [ ] Extension update preserves auth state

---

## Security Considerations

1. **Token Storage**
   - ✅ chrome.storage.local encrypted at OS level
   - ✅ No localStorage (accessible to content scripts)
   - ✅ No sessionStorage (cleared on tab close)

2. **Token Transmission**
   - ✅ HTTPS only for production
   - ✅ WebSocket upgrade over TLS (wss://)
   - ✅ No token in URL params

3. **Password Security**
   - ✅ Bcrypt with salt (not plaintext)
   - ✅ Timing-safe comparison
   - ✅ No password stored in extension

4. **CORS & CSP**
   - ✅ check_origin whitelist (not wildcard in prod)
   - ✅ Extension CSP allows only wss:// to backend

---

## Reference Documentation

- **../../04_LIVEVIEW_PATTERNS.md** - Complete auth patterns with LiveView
- **../../03_ARCHITECTURE.md** - Token flow and PubSub topics
- **Phoenix.Token docs** - https://hexdocs.pm/phoenix/Phoenix.Token.html

---

## Next Sprint

👉 [Sprint TBD - Polish & UX](./SPRINT_TBD_polish.md)
