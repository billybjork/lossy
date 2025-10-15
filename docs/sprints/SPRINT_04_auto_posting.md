# Sprint 04: Automated Note Posting with Browserbase

**Status:** ⏳ Planned
**Estimated Duration:** 3-5 days

---

## Goal

Automatically post high-confidence notes to video platforms (YouTube, Vimeo, Air) using Browserbase automation. Users connect their platforms once, then notes are posted automatically via Oban background jobs with Python/Playwright agents.

---

## Prerequisites

- ✅ Sprint 03 complete (video integration working)
- ⏳ Browserbase account & API key
- ⏳ Python 3.10+ with Playwright installed
- ⏳ Existing Python agents (from prior work)

---

## Deliverables

- [ ] Platform connection flow (user logs in via Browserbase)
- [ ] Browserbase session persistence (30-day keep-alive)
- [ ] Oban worker queues notes for posting
- [ ] Python bridge calls Playwright agents
- [ ] Retry logic with exponential backoff
- [ ] Note status tracking (ghost → posting → posted → failed)
- [ ] Error taxonomy for platform-specific failures
- [ ] Session expiry detection and notification
- [ ] Side panel shows posting progress

---

## Technical Tasks

### Task 1: Platform Connection Flow

Users need to connect their YouTube/Vimeo/Air accounts once. This creates a persistent Browserbase session that's reused for all future note postings.

#### 1.1 Platform Connections Schema

**Generate migration:**

```bash
cd lossy
mix ecto.gen.migration create_platform_connections
```

**File:** `priv/repo/migrations/TIMESTAMP_create_platform_connections.exs`

```elixir
defmodule Lossy.Repo.Migrations.CreatePlatformConnections do
  use Ecto.Migration

  def change do
    create table(:platform_connections) do
      add :user_id, references(:users, on_delete: :delete_all), null: false
      add :platform, :string, null: false  # youtube, vimeo, air
      add :browserbase_session_id, :string, null: false
      add :status, :string, default: "awaiting_auth", null: false  # awaiting_auth, active, expired, logged_out
      add :last_used_at, :utc_datetime
      add :verified_at, :utc_datetime
      add :error, :text

      timestamps()
    end

    create unique_index(:platform_connections, [:user_id, :platform])
    create index(:platform_connections, [:status])
    create index(:platform_connections, [:last_used_at])
  end
end
```

Run: `mix ecto.migrate`

**File:** `lib/lossy/accounts/platform_connection.ex` (new schema)

```elixir
defmodule Lossy.Accounts.PlatformConnection do
  use Ecto.Schema
  import Ecto.Changeset

  schema "platform_connections" do
    field :platform, :string
    field :browserbase_session_id, :string
    field :status, :string, default: "awaiting_auth"
    field :last_used_at, :utc_datetime
    field :verified_at, :utc_datetime
    field :error, :string

    belongs_to :user, Lossy.Accounts.User

    timestamps()
  end

  def changeset(connection, attrs) do
    connection
    |> cast(attrs, [:user_id, :platform, :browserbase_session_id, :status, :last_used_at, :verified_at, :error])
    |> validate_required([:platform, :browserbase_session_id])
    |> validate_inclusion(:platform, ~w(youtube vimeo air))
    |> validate_inclusion(:status, ~w(awaiting_auth active expired logged_out))
    |> unique_constraint([:user_id, :platform])
  end
end
```

**File:** `lib/lossy/accounts.ex` (update context)

```elixir
defmodule Lossy.Accounts do
  # ... existing code ...

  alias Lossy.Accounts.PlatformConnection

  def create_platform_connection(attrs) do
    %PlatformConnection{}
    |> PlatformConnection.changeset(attrs)
    |> Repo.insert()
  end

  def get_connection_by_platform(user_id, platform) do
    Repo.get_by(PlatformConnection, user_id: user_id, platform: platform)
  end

  def update_connection(connection, attrs) do
    connection
    |> PlatformConnection.changeset(attrs)
    |> Repo.update()
  end

  def list_connections_needing_keepalive(threshold_date) do
    from(c in PlatformConnection,
      where: c.status == "active" and c.last_used_at < ^threshold_date
    )
    |> Repo.all()
  end
end
```

#### 1.2 Browserbase Client Module

**File:** `lib/lossy/automation/browserbase_client.ex` (new)

```elixir
defmodule Lossy.Automation.BrowserbaseClient do
  @moduledoc """
  Browserbase API client for creating and managing browser sessions.
  """

  require Logger

  @base_url "https://www.browserbase.com/v1"
  @api_key Application.compile_env(:lossy, :browserbase_api_key)
  @project_id Application.compile_env(:lossy, :browserbase_project_id)

  def create_session(opts \\ []) do
    body = %{
      projectId: opts[:project_id] || @project_id,
      keepAlive: true,  # Session persists for 30 days
      browserSettings: %{
        viewport: %{width: 1920, height: 1080}
      }
    }

    case post("/sessions", body) do
      {:ok, %{"id" => session_id}} ->
        {:ok, %{id: session_id}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def get_debug_url(session_id) do
    case get("/sessions/#{session_id}/debug") do
      {:ok, %{"debuggerFullscreenUrl" => url}} ->
        {:ok, url}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def get_connect_url(session_id) do
    "wss://connect.browserbase.com?apiKey=#{@api_key}&sessionId=#{session_id}"
  end

  # Private helpers

  defp post(path, body) do
    url = @base_url <> path
    headers = [
      {"x-bb-api-key", @api_key},
      {"Content-Type", "application/json"}
    ]

    encoded_body = Jason.encode!(body)

    case HTTPoison.post(url, encoded_body, headers, recv_timeout: 30_000) do
      {:ok, %{status_code: 200, body: response_body}} ->
        {:ok, Jason.decode!(response_body)}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("Browserbase API error: #{status} - #{error_body}")
        {:error, "API error: #{status}"}

      {:error, %HTTPoison.Error{reason: reason}} ->
        Logger.error("Browserbase request failed: #{inspect(reason)}")
        {:error, "Request failed"}
    end
  end

  defp get(path) do
    url = @base_url <> path
    headers = [{"x-bb-api-key", @api_key}]

    case HTTPoison.get(url, headers, recv_timeout: 30_000) do
      {:ok, %{status_code: 200, body: response_body}} ->
        {:ok, Jason.decode!(response_body)}

      {:ok, %{status_code: 404}} ->
        {:error, :not_found}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("Browserbase API error: #{status} - #{error_body}")
        {:error, "API error: #{status}"}

      {:error, %HTTPoison.Error{reason: reason}} ->
        Logger.error("Browserbase request failed: #{inspect(reason)}")
        {:error, "Request failed"}
    end
  end
end
```

**Add config:**

```elixir
# config/runtime.exs
config :lossy,
  browserbase_api_key: System.get_env("BROWSERBASE_API_KEY") || raise("BROWSERBASE_API_KEY not set"),
  browserbase_project_id: System.get_env("BROWSERBASE_PROJECT_ID") || raise("BROWSERBASE_PROJECT_ID not set")
```

#### 1.3 Connection Flow (LiveView)

**File:** `lib/lossy_web/live/settings_live.ex` (new)

```elixir
defmodule LossyWeb.SettingsLive do
  use LossyWeb, :live_view

  alias Lossy.Accounts
  alias Lossy.Automation.BrowserbaseClient

  @impl true
  def mount(_params, session, socket) do
    user_id = session["user_id"]  # Will implement auth in Sprint 05
    connections = Accounts.list_user_connections(user_id)

    {:ok,
     socket
     |> assign(:user_id, user_id)
     |> assign(:connections, connections)
     |> assign(:pending_connection, nil)}
  end

  @impl true
  def handle_event("connect_platform", %{"platform" => platform}, socket) do
    # Create Browserbase session
    case BrowserbaseClient.create_session() do
      {:ok, %{id: session_id}} ->
        {:ok, debug_url} = BrowserbaseClient.get_debug_url(session_id)

        # Store connection as pending
        {:ok, connection} = Accounts.create_platform_connection(%{
          user_id: socket.assigns.user_id,
          platform: platform,
          browserbase_session_id: session_id,
          status: "awaiting_auth"
        })

        # Open debug URL in new window (user will log in manually)
        {:noreply,
         socket
         |> assign(:pending_connection, connection)
         |> push_event("open_browserbase_window", %{url: debug_url, connection_id: connection.id})
         |> put_flash(:info, "Log in to #{platform} in the new window, then click 'Verify Connection'")}

      {:error, reason} ->
        {:noreply,
         socket
         |> put_flash(:error, "Failed to create Browserbase session: #{reason}")}
    end
  end

  @impl true
  def handle_event("verify_connection", %{"connection_id" => id}, socket) do
    connection = Accounts.get_connection!(id)

    # Test if user is logged in by checking for profile element
    case verify_login(connection.browserbase_session_id, connection.platform) do
      {:ok, :logged_in} ->
        {:ok, _} = Accounts.update_connection(connection, %{
          status: "active",
          verified_at: DateTime.utc_now(),
          last_used_at: DateTime.utc_now()
        })

        {:noreply,
         socket
         |> assign(:pending_connection, nil)
         |> reload_connections()
         |> put_flash(:info, "✅ #{connection.platform} connected successfully!")}

      {:error, :not_logged_in} ->
        {:noreply,
         socket
         |> put_flash(:error, "Not logged in. Please log in to #{connection.platform} and try again.")}

      {:error, :session_expired} ->
        {:ok, _} = Accounts.update_connection(connection, %{status: "expired"})

        {:noreply,
         socket
         |> assign(:pending_connection, nil)
         |> put_flash(:error, "Session expired. Please try connecting again.")}
    end
  end

  @impl true
  def handle_event("disconnect_platform", %{"platform" => platform}, socket) do
    connection = Accounts.get_connection_by_platform(socket.assigns.user_id, platform)

    if connection do
      {:ok, _} = Accounts.update_connection(connection, %{status: "logged_out"})

      {:noreply,
       socket
       |> reload_connections()
       |> put_flash(:info, "#{platform} disconnected")}
    else
      {:noreply, socket}
    end
  end

  defp verify_login(session_id, platform) do
    # Call Python script to verify login
    Lossy.Automation.PythonBridge.check_login(session_id, platform)
  end

  defp reload_connections(socket) do
    connections = Accounts.list_user_connections(socket.assigns.user_id)
    assign(socket, :connections, connections)
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="settings-page">
      <h1>Platform Connections</h1>

      <div class="connections-list">
        <div :for={platform <- ["youtube", "vimeo", "air"]} class="platform-card">
          <h3><%= String.capitalize(platform) %></h3>

          <%= if connection = Enum.find(@connections, &(&1.platform == platform && &1.status == "active")) do %>
            <div class="connected">
              <span class="status">✅ Connected</span>
              <p class="meta">Last used: <%= format_datetime(connection.last_used_at) %></p>
              <button phx-click="disconnect_platform" phx-value-platform={platform}>
                Disconnect
              </button>
            </div>
          <% else %>
            <div class="disconnected">
              <button phx-click="connect_platform" phx-value-platform={platform}>
                Connect <%= String.capitalize(platform) %>
              </button>
            </div>
          <% end %>
        </div>
      </div>

      <%= if @pending_connection do %>
        <div class="pending-verification">
          <h3>Waiting for verification...</h3>
          <p>After logging in to <%= @pending_connection.platform %>, click below:</p>
          <button phx-click="verify_connection" phx-value-connection-id={@pending_connection.id}>
            I've Logged In - Verify Connection
          </button>
        </div>
      <% end %>
    </div>
    """
  end

  defp format_datetime(nil), do: "Never"
  defp format_datetime(dt), do: Calendar.strftime(dt, "%b %d, %Y")
end
```

---

### Task 2: Python Bridge & Agents

#### 2.1 Python Bridge Module

**File:** `lib/lossy/automation/python_bridge.ex` (new)

```elixir
defmodule Lossy.Automation.PythonBridge do
  @moduledoc """
  Bridge to Python Playwright agents.
  Uses System.cmd for MVP, can upgrade to Port in future.
  """

  require Logger

  @python_path Application.app_dir(:lossy, "priv/python")

  def check_login(session_id, platform) do
    script = Path.join(@python_path, "automation/check_login.py")

    args = [
      script,
      "--session-id", session_id,
      "--platform", platform
    ]

    case System.cmd("python3", args, stderr_to_stdout: true, cd: @python_path) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, %{"logged_in" => true}} ->
            {:ok, :logged_in}

          {:ok, %{"logged_in" => false}} ->
            {:error, :not_logged_in}

          {:error, _} ->
            Logger.error("Failed to parse check_login output: #{output}")
            {:error, :invalid_response}
        end

      {error, code} ->
        Logger.error("check_login script failed (code #{code}): #{error}")

        cond do
          String.contains?(error, "session not found") ->
            {:error, :session_expired}

          true ->
            {:error, :script_failed}
        end
    end
  end

  def post_note(session_id, note) do
    script = Path.join(@python_path, "automation/post_note.py")

    args = [
      script,
      "--session-id", session_id,
      "--platform", note.video.platform,
      "--video-url", note.video.url,
      "--timestamp", to_string(note.timestamp_seconds),
      "--text", note.text
    ]

    case System.cmd("python3", args, stderr_to_stdout: true, cd: @python_path) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, %{"status" => "posted", "permalink" => permalink}} ->
            {:ok, %{permalink: permalink}}

          {:ok, %{"status" => "failed", "error" => error}} ->
            {:error, error}

          {:error, _} ->
            Logger.error("Failed to parse post_note output: #{output}")
            {:error, "Invalid response from Python agent"}
        end

      {error, code} ->
        Logger.error("post_note script failed (code #{code}): #{error}")

        cond do
          String.contains?(error, "session expired") ->
            {:error, :session_expired}

          String.contains?(error, "rate limit") ->
            {:error, :rate_limited}

          String.contains?(error, "element not found") ->
            {:error, :selector_failed}

          true ->
            {:error, "Script failed: #{String.slice(error, 0..200)}"}
        end
    end
  end

  def ping_session(session_id) do
    script = Path.join(@python_path, "automation/ping_session.py")

    args = [script, "--session-id", session_id]

    case System.cmd("python3", args, stderr_to_stdout: true, cd: @python_path) do
      {_output, 0} ->
        {:ok, :pong}

      {error, _code} ->
        if String.contains?(error, "not found") do
          {:error, :not_found}
        else
          {:error, :failed}
        end
    end
  end
end
```

#### 2.2 Python Agent: Check Login

**File:** `priv/python/automation/check_login.py` (new)

```python
#!/usr/bin/env python3
"""
Check if user is logged in to a platform.
Looks for profile element to verify login state.
"""

import argparse
import json
import sys
import os
from playwright.sync_api import sync_playwright

BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY")

PLATFORM_CONFIG = {
    "youtube": {
        "url": "https://www.youtube.com",
        "selector": "#avatar-btn",  # Profile button
        "timeout": 10000
    },
    "vimeo": {
        "url": "https://vimeo.com",
        "selector": ".topnav_menu_user",
        "timeout": 10000
    },
    "air": {
        "url": "https://air.inc",
        "selector": "[data-test='user-avatar']",
        "timeout": 10000
    }
}

def check_login(session_id, platform):
    config = PLATFORM_CONFIG.get(platform)
    if not config:
        return {"logged_in": False, "error": f"Unknown platform: {platform}"}

    try:
        with sync_playwright() as p:
            # Connect to Browserbase session
            browser = p.chromium.connect_over_cdp(
                f"wss://connect.browserbase.com?apiKey={BROWSERBASE_API_KEY}&sessionId={session_id}"
            )

            # Get existing context and page
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()

            # Navigate to platform
            page.goto(config["url"], wait_until="networkidle")

            # Check for profile element
            try:
                element = page.wait_for_selector(config["selector"], timeout=config["timeout"])
                logged_in = element is not None
            except:
                logged_in = False

            browser.close()

            return {"logged_in": logged_in}

    except Exception as e:
        error_msg = str(e)
        if "session not found" in error_msg.lower():
            return {"logged_in": False, "error": "session not found"}
        else:
            return {"logged_in": False, "error": error_msg}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--platform", required=True)
    args = parser.parse_args()

    result = check_login(args.session_id, args.platform)
    print(json.dumps(result))
```

#### 2.3 Python Agent: Post Note

**File:** `priv/python/automation/post_note.py` (new)

```python
#!/usr/bin/env python3
"""
Post a note as a comment on a video platform.
Uses Playwright with platform-specific selectors.
"""

import argparse
import json
import sys
import os
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY")

def post_to_youtube(page, video_url, timestamp, text):
    """Post comment to YouTube at specific timestamp."""
    # Navigate to video
    page.goto(video_url, wait_until="networkidle")

    # Seek to timestamp
    page.evaluate(f"document.querySelector('video').currentTime = {timestamp}")

    # Scroll to comments section
    page.evaluate("window.scrollTo(0, 800)")

    # Click comment box
    try:
        comment_box = page.wait_for_selector("#placeholder-area", timeout=5000)
        comment_box.click()
    except PlaywrightTimeout:
        return {"status": "failed", "error": "Could not find comment box"}

    # Wait for editable area
    try:
        editable = page.wait_for_selector("#contenteditable-root", timeout=5000)
        editable.fill(text)
    except PlaywrightTimeout:
        return {"status": "failed", "error": "Could not find editable area"}

    # Click submit button
    try:
        submit_btn = page.wait_for_selector("#submit-button", timeout=5000)
        submit_btn.click()
    except PlaywrightTimeout:
        return {"status": "failed", "error": "Could not find submit button"}

    # Wait for comment to appear
    page.wait_for_timeout(2000)

    # Get permalink (approximation - YouTube doesn't always provide immediate link)
    permalink = f"{video_url}&t={int(timestamp)}s"

    return {"status": "posted", "permalink": permalink}

def post_to_vimeo(page, video_url, timestamp, text):
    """Post comment to Vimeo at specific timestamp."""
    page.goto(video_url, wait_until="networkidle")

    # Vimeo implementation here (similar pattern)
    # For now, return not implemented
    return {"status": "failed", "error": "Vimeo posting not yet implemented"}

def post_to_air(page, video_url, timestamp, text):
    """Post comment to Air at specific timestamp."""
    page.goto(video_url, wait_until="networkidle")

    # Air implementation here (similar pattern)
    return {"status": "failed", "error": "Air posting not yet implemented"}

def post_note(session_id, platform, video_url, timestamp, text):
    try:
        with sync_playwright() as p:
            # Connect to Browserbase session
            browser = p.chromium.connect_over_cdp(
                f"wss://connect.browserbase.com?apiKey={BROWSERBASE_API_KEY}&sessionId={session_id}"
            )

            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()

            # Route to platform-specific handler
            if platform == "youtube":
                result = post_to_youtube(page, video_url, timestamp, text)
            elif platform == "vimeo":
                result = post_to_vimeo(page, video_url, timestamp, text)
            elif platform == "air":
                result = post_to_air(page, video_url, timestamp, text)
            else:
                result = {"status": "failed", "error": f"Unknown platform: {platform}"}

            browser.close()
            return result

    except Exception as e:
        error_msg = str(e)

        if "session expired" in error_msg.lower() or "session not found" in error_msg.lower():
            return {"status": "failed", "error": "session expired"}
        elif "rate limit" in error_msg.lower():
            return {"status": "failed", "error": "rate limit"}
        else:
            return {"status": "failed", "error": error_msg}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--video-url", required=True)
    parser.add_argument("--timestamp", type=float, required=True)
    parser.add_argument("--text", required=True)
    args = parser.parse_args()

    result = post_note(
        args.session_id,
        args.platform,
        args.video_url,
        args.timestamp,
        args.text
    )

    print(json.dumps(result))
```

**File:** `priv/python/requirements.txt`

```
playwright==1.40.0
```

**Setup Python environment:**

```bash
cd lossy/priv/python
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

---

### Task 3: Oban Worker for Note Posting

#### 3.1 Oban Configuration

**File:** `config/config.exs` (add Oban config)

```elixir
config :lossy, Oban,
  repo: Lossy.Repo,
  queues: [
    automation: [
      limit: 3,  # Max 3 concurrent posting jobs
      rate_limit: [
        allowed: 10,  # 10 posts per period
        period: 60    # 60 seconds
      ]
    ],
    maintenance: 1
  ],
  plugins: [
    {Oban.Plugins.Pruner, max_age: 60 * 60 * 24 * 7},  # Keep jobs for 7 days
    {Oban.Plugins.Cron,
     crontab: [
       {"0 3 * * *", Lossy.Workers.SessionKeepAliveWorker}  # Daily at 3am
     ]}
  ]
```

**Add Oban to supervision tree:**

```elixir
# lib/lossy/application.ex
def start(_type, _args) do
  children = [
    # ... existing children ...
    {Oban, Application.fetch_env!(:lossy, Oban)}
  ]

  opts = [strategy: :one_for_one, name: Lossy.Supervisor]
  Supervisor.start_link(children, opts)
end
```

**Add Oban dependency:**

```elixir
# mix.exs
defp deps do
  [
    # ... existing deps ...
    {:oban, "~> 2.15"}
  ]
end
```

Run: `mix deps.get && mix ecto.migrate`

#### 3.2 Note Poster Worker

**File:** `lib/lossy/workers/post_note_worker.ex` (new)

```elixir
defmodule Lossy.Workers.PostNoteWorker do
  use Oban.Worker,
    queue: :automation,
    max_attempts: 3,
    unique: [period: 60, fields: [:args]]  # Prevent duplicate posts

  require Logger

  alias Lossy.Videos
  alias Lossy.Accounts
  alias Lossy.Automation.PythonBridge

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"note_id" => note_id}, attempt: attempt}) do
    note = Videos.get_note!(note_id, preload: [:video])

    Logger.info("[PostNoteWorker] Posting note #{note_id} (attempt #{attempt}/3)")

    # Update status to posting
    Videos.update_note(note, %{status: "posting"})

    # Get active platform connection
    case get_active_connection(note.video.platform) do
      {:ok, connection} ->
        # Update last used timestamp
        Accounts.update_connection(connection, %{last_used_at: DateTime.utc_now()})

        # Call Python agent
        case PythonBridge.post_note(connection.browserbase_session_id, note) do
          {:ok, %{permalink: permalink}} ->
            Logger.info("[PostNoteWorker] Note #{note_id} posted successfully")

            Videos.update_note(note, %{
              status: "posted",
              posted_at: DateTime.utc_now(),
              external_permalink: permalink,
              error: nil
            })

            # Broadcast success
            broadcast_note_posted(note)

            :ok

          {:error, :session_expired} ->
            Logger.warn("[PostNoteWorker] Session expired for #{note.video.platform}")

            Accounts.update_connection(connection, %{status: "expired"})

            Videos.update_note(note, %{
              status: "failed",
              error: "Platform session expired - please reconnect"
            })

            # Don't retry if session expired
            {:discard, "Session expired"}

          {:error, :rate_limited} ->
            Logger.warn("[PostNoteWorker] Rate limited on #{note.video.platform}")

            Videos.update_note(note, %{
              status: "ghost",  # Return to ghost state for manual retry
              error: "Rate limited - will retry later"
            })

            # Retry with backoff
            {:snooze, backoff_seconds(attempt)}

          {:error, :selector_failed} ->
            Logger.error("[PostNoteWorker] Selector failed (platform UI may have changed)")

            Videos.update_note(note, %{
              status: "failed",
              error: "Platform UI changed - posting failed"
            })

            # Don't retry selector failures (needs code update)
            {:discard, "Selector failed"}

          {:error, reason} ->
            Logger.error("[PostNoteWorker] Post failed: #{inspect(reason)}")

            Videos.update_note(note, %{
              status: "failed",
              error: "Posting failed: #{inspect(reason)}"
            })

            # Retry unknown errors
            {:error, reason}
        end

      {:error, :no_connection} ->
        Logger.warn("[PostNoteWorker] No active connection for #{note.video.platform}")

        Videos.update_note(note, %{
          status: "ghost",
          error: "#{note.video.platform} not connected - please connect in settings"
        })

        # Broadcast notification to user
        broadcast_connection_required(note.video.platform)

        {:discard, "No active connection"}
    end
  end

  # Helpers

  defp get_active_connection(platform) do
    # TODO: Get user_id from note in Sprint 05 (auth)
    # For now, assume single user
    case Accounts.get_connection_by_platform(1, platform) do
      nil ->
        {:error, :no_connection}

      %{status: "active"} = connection ->
        {:ok, connection}

      %{status: status} ->
        Logger.warn("Connection exists but status is: #{status}")
        {:error, :no_connection}
    end
  end

  defp backoff_seconds(attempt) do
    # Exponential backoff: 30s, 90s, 270s
    trunc(:math.pow(3, attempt) * 30)
  end

  defp broadcast_note_posted(note) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "video:#{note.video_id}",
      {:note_posted, note.id}
    )
  end

  defp broadcast_connection_required(platform) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "user:global",  # Will be user-specific in Sprint 05
      {:connection_required, platform}
    )
  end
end
```

#### 3.3 Enqueue Notes from AgentSession

**File:** `lib/lossy/agent/session.ex` (update)

```elixir
defp structure_note(state, transcript_text) do
  case Cloud.structure_note(transcript_text) do
    {:ok, structured_note} ->
      Logger.info("[#{state.session_id}] Note structured: #{inspect(structured_note)}")

      # Store in database with video context
      {:ok, note} = Videos.create_note(%{
        transcript: transcript_text,
        text: structured_note.text,
        category: structured_note.category,
        confidence: structured_note.confidence,
        status: "ghost",
        video_id: state.video_id,
        session_id: state.session_id,
        timestamp_seconds: state.timestamp_seconds
      })

      # Auto-queue high-confidence notes for posting
      if structured_note.confidence >= 0.7 do
        Logger.info("[#{state.session_id}] High confidence (#{structured_note.confidence}), queueing for posting")

        %{note_id: note.id}
        |> Lossy.Workers.PostNoteWorker.new()
        |> Oban.insert()
      end

      # Broadcast final result
      broadcast_event(state.session_id, %{
        type: :note_created,
        note: note
      })

      # Also broadcast to video topic
      if state.video_id do
        Phoenix.PubSub.broadcast(
          Lossy.PubSub,
          "video:#{state.video_id}",
          {:new_note, note}
        )
      end

    {:error, reason} ->
      Logger.error("[#{state.session_id}] Note structuring failed: #{inspect(reason)}")

      broadcast_event(state.session_id, %{
        type: :structuring_failed,
        error: inspect(reason)
      })
  end
end
```

---

### Task 4: Session Keep-Alive Worker

**File:** `lib/lossy/workers/session_keep_alive_worker.ex` (new)

```elixir
defmodule Lossy.Workers.SessionKeepAliveWorker do
  use Oban.Worker, queue: :maintenance

  require Logger

  alias Lossy.Accounts
  alias Lossy.Automation.PythonBridge

  @impl Oban.Worker
  def perform(_job) do
    # Find sessions that haven't been used in 20 days
    # (ping before 30-day expiry)
    twenty_days_ago = DateTime.add(DateTime.utc_now(), -20, :day)

    connections = Accounts.list_connections_needing_keepalive(twenty_days_ago)

    Logger.info("[SessionKeepAlive] Checking #{length(connections)} connections")

    Enum.each(connections, fn conn ->
      case PythonBridge.ping_session(conn.browserbase_session_id) do
        {:ok, :pong} ->
          Accounts.update_connection(conn, %{last_used_at: DateTime.utc_now()})
          Logger.info("[SessionKeepAlive] Pinged #{conn.platform} session: #{conn.browserbase_session_id}")

        {:error, :not_found} ->
          Accounts.update_connection(conn, %{status: "expired"})
          Logger.warn("[SessionKeepAlive] Session expired: #{conn.browserbase_session_id}")

        {:error, reason} ->
          Logger.error("[SessionKeepAlive] Failed to ping: #{inspect(reason)}")
      end
    end)

    :ok
  end
end
```

**File:** `priv/python/automation/ping_session.py` (new)

```python
#!/usr/bin/env python3
"""Ping a Browserbase session to keep it alive."""

import argparse
import sys
import os
from playwright.sync_api import sync_playwright

BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY")

def ping_session(session_id):
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(
                f"wss://connect.browserbase.com?apiKey={BROWSERBASE_API_KEY}&sessionId={session_id}"
            )

            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()

            # Simple navigation to keep session alive
            page.goto("about:blank")

            browser.close()
            return True

    except Exception as e:
        if "not found" in str(e).lower():
            return False
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    args = parser.parse_args()

    if ping_session(args.session_id):
        sys.exit(0)
    else:
        sys.exit(1)
```

---

## Error Taxonomy & Retry Strategy

### Error Types

| Error | Cause | Retry? | Action |
|-------|-------|--------|--------|
| **session_expired** | Browserbase session >30 days old | ❌ No | Mark connection as expired, notify user |
| **rate_limited** | Platform throttling posts | ✅ Yes | Backoff 30s, 90s, 270s |
| **selector_failed** | Platform UI changed | ❌ No | Fail permanently, needs code update |
| **not_logged_in** | User logged out manually | ❌ No | Mark connection as logged_out, notify user |
| **network_error** | Timeout, connection issues | ✅ Yes | Retry with backoff |
| **script_failed** | Python exception | ✅ Yes | Retry up to 3 attempts |

### Retry Configuration

```elixir
# Oban worker configuration
use Oban.Worker,
  queue: :automation,
  max_attempts: 3,
  unique: [period: 60, fields: [:args]]

# Backoff calculation
defp backoff_seconds(attempt) do
  # 30s, 90s, 270s
  trunc(:math.pow(3, attempt) * 30)
end
```

---

## Testing Checklist

### Platform Connection Tests

- [ ] Click "Connect YouTube" → Browserbase window opens
- [ ] Log in to YouTube in Browserbase window
- [ ] Click "Verify Connection" → connection status shows "active"
- [ ] Record note → note queued for posting
- [ ] Check database: `platform_connections` has active record

### Posting Tests

- [ ] High-confidence note (>0.7) → auto-queued by AgentSession
- [ ] Oban picks up job within seconds
- [ ] Python agent successfully posts to YouTube
- [ ] Note status updated: ghost → posting → posted
- [ ] Permalink stored in `external_permalink` field

### Error Handling Tests

- [ ] Expired session → note marked as failed, user notified
- [ ] Rate limit → note snoozed with backoff
- [ ] Selector failure → note marked as failed (no retry)
- [ ] No connection → note stays as ghost, user notified

### Keep-Alive Tests

- [ ] Cron job runs daily at 3am
- [ ] Old sessions (>20 days) pinged successfully
- [ ] `last_used_at` updated
- [ ] Expired sessions marked as expired

---

## Reference Documentation

See [04_BROWSERBASE_INTEGRATION.md](../04_BROWSERBASE_INTEGRATION.md) for:
- Complete Browserbase API reference
- Advanced session management
- Port communication (Phase 2 optimization)
- Pure Elixir CDP client (Phase 3, optional)

---

## Cost Tracking

**Browserbase pricing (as of 2025):**
- Sessions: $0.002 per minute
- Average note posting: ~30 seconds = $0.001

**For 100 notes/month:**
- Cost: $0.10/month

**Session persistence:**
- One login per platform = 3 sessions
- Keep-alive pings: negligible (<1 minute/month)

**Total Browserbase cost: ~$0.10-$0.50/month per user**

---

## Next Sprint

👉 [Sprint 05 - Authentication](./SPRINT_05_auth.md)

**Focus:** Add user authentication, multi-user support, token-based auth for LiveView
