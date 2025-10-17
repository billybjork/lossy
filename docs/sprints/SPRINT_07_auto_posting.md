# Sprint 07: Automated Note Posting with Browserbase

**Status:** ⏳ Planned
**Estimated Duration:** 3-5 days

---

## Goal

Automatically post high-confidence notes to video platforms (YouTube, Vimeo, Air) using Browserbase automation. Users connect their platforms once, then notes are posted automatically via Oban background jobs with Playwright (Node.js) agents controlled from Elixir.

---

## Prerequisites

- ✅ Sprint 03 complete (video integration working)
- ⏳ Browserbase account & API key
- ⏳ Node.js 18+ with npm installed
- ⏳ Playwright npm package

---

## Deliverables

- [ ] Platform connection flow (user logs in via Browserbase)
- [ ] Browserbase session persistence (30-day keep-alive)
- [ ] Oban worker queues notes for posting
- [ ] Elixir Playwright client (GenServer + Port) controls browser automation
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
    # Call Playwright client to verify login
    Lossy.Automation.PlaywrightClient.check_login(session_id, platform)
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

### Task 2: Playwright Client & Node.js Agents

#### 2.1 Playwright Client Module (Elixir)

**File:** `lib/lossy/automation/playwright_client.ex` (new)

```elixir
defmodule Lossy.Automation.PlaywrightClient do
  @moduledoc """
  Elixir client for Playwright browser automation via Node.js Port.
  Manages communication with a Node.js Playwright server process.
  """

  use GenServer
  require Logger

  @node_script_path Application.app_dir(:lossy, "priv/node/playwright_server.js")

  # Client API

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def check_login(session_id, platform) do
    GenServer.call(__MODULE__, {:check_login, session_id, platform}, 30_000)
  end

  def post_note(session_id, platform, video_url, timestamp, text) do
    GenServer.call(__MODULE__, {:post_note, session_id, platform, video_url, timestamp, text}, 60_000)
  end

  def ping_session(session_id) do
    GenServer.call(__MODULE__, {:ping_session, session_id}, 30_000)
  end

  # GenServer callbacks

  @impl true
  def init(_opts) do
    port = Port.open(
      {:spawn_executable, System.find_executable("node")},
      [:binary, :exit_status, args: [@node_script_path], packet: 4]
    )

    {:ok, %{port: port, pending: %{}}}
  end

  @impl true
  def handle_call({:check_login, session_id, platform}, from, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "check_login",
      args: %{session_id: session_id, platform: platform}
    }

    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], from)}
  end

  @impl true
  def handle_call({:post_note, session_id, platform, video_url, timestamp, text}, from, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "post_note",
      args: %{
        session_id: session_id,
        platform: platform,
        video_url: video_url,
        timestamp: timestamp,
        text: text
      }
    }

    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], from)}
  end

  @impl true
  def handle_call({:ping_session, session_id}, from, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "ping_session",
      args: %{session_id: session_id}
    }

    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], from)}
  end

  @impl true
  def handle_info({_port, {:data, data}}, state) do
    case Jason.decode(data) do
      {:ok, %{"id" => id, "result" => result}} ->
        case Map.pop(state.pending, id) do
          {nil, _pending} ->
            Logger.warn("Received response for unknown request: #{id}")
            {:noreply, state}

          {from, pending} ->
            GenServer.reply(from, parse_result(result))
            {:noreply, %{state | pending: pending}}
        end

      {:ok, %{"error" => error}} ->
        Logger.error("Playwright server error: #{inspect(error)}")
        {:noreply, state}

      {:error, reason} ->
        Logger.error("Failed to decode response: #{inspect(reason)}")
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({_port, {:exit_status, status}}, state) do
    Logger.error("Playwright server exited with status: #{status}")
    {:stop, :port_exit, state}
  end

  # Private helpers

  defp send_request(port, request) do
    data = Jason.encode!(request)
    Port.command(port, data)
  end

  defp parse_result(%{"status" => "logged_in"}), do: {:ok, :logged_in}
  defp parse_result(%{"status" => "not_logged_in"}), do: {:error, :not_logged_in}
  defp parse_result(%{"status" => "posted", "permalink" => permalink}), do: {:ok, %{permalink: permalink}}
  defp parse_result(%{"status" => "pong"}), do: {:ok, :pong}
  defp parse_result(%{"status" => "error", "error" => "session_expired"}), do: {:error, :session_expired}
  defp parse_result(%{"status" => "error", "error" => "rate_limited"}), do: {:error, :rate_limited}
  defp parse_result(%{"status" => "error", "error" => "selector_failed"}), do: {:error, :selector_failed}
  defp parse_result(%{"status" => "error", "error" => "not_found"}), do: {:error, :not_found}
  defp parse_result(%{"status" => "error", "error" => error}), do: {:error, error}
  defp parse_result(other), do: {:error, "Unknown response: #{inspect(other)}"}
end
```

**Add to supervision tree:**

```elixir
# lib/lossy/application.ex
def start(_type, _args) do
  children = [
    # ... existing children ...
    Lossy.Automation.PlaywrightClient,
    {Oban, Application.fetch_env!(:lossy, Oban)}
  ]

  opts = [strategy: :one_for_one, name: Lossy.Supervisor]
  Supervisor.start_link(children, opts)
end
```

#### 2.2 Node.js Playwright Server

**File:** `priv/node/playwright_server.js` (new)

```javascript
#!/usr/bin/env node
/**
 * Playwright automation server for Elixir Port communication.
 * Handles browser automation commands via JSON-RPC over stdin/stdout.
 */

const { chromium } = require('playwright-core');
const readline = require('readline');

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;

// Platform-specific selectors
const PLATFORM_CONFIG = {
  youtube: {
    url: 'https://www.youtube.com',
    selector: '#avatar-btn',
    timeout: 10000
  },
  vimeo: {
    url: 'https://vimeo.com',
    selector: '.topnav_menu_user',
    timeout: 10000
  },
  air: {
    url: 'https://air.inc',
    selector: '[data-test="user-avatar"]',
    timeout: 10000
  }
};

// Command handlers

async function checkLogin(sessionId, platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return { status: 'error', error: `Unknown platform: ${platform}` };
  }

  try {
    const connectUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    const browser = await chromium.connectOverCDP(connectUrl);

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto(config.url, { waitUntil: 'networkidle' });

    try {
      await page.waitForSelector(config.selector, { timeout: config.timeout });
      await browser.close();
      return { status: 'logged_in' };
    } catch (e) {
      await browser.close();
      return { status: 'not_logged_in' };
    }
  } catch (error) {
    if (error.message.includes('session not found')) {
      return { status: 'error', error: 'session_expired' };
    }
    return { status: 'error', error: error.message };
  }
}

async function postToYoutube(page, videoUrl, timestamp, text) {
  await page.goto(videoUrl, { waitUntil: 'networkidle' });

  // Seek to timestamp
  await page.evaluate((t) => {
    document.querySelector('video').currentTime = t;
  }, timestamp);

  // Scroll to comments
  await page.evaluate(() => window.scrollTo(0, 800));

  // Click comment box
  try {
    await page.waitForSelector('#placeholder-area', { timeout: 5000 });
    await page.click('#placeholder-area');
  } catch (e) {
    return { status: 'error', error: 'selector_failed' };
  }

  // Fill comment
  try {
    await page.waitForSelector('#contenteditable-root', { timeout: 5000 });
    await page.fill('#contenteditable-root', text);
  } catch (e) {
    return { status: 'error', error: 'selector_failed' };
  }

  // Submit
  try {
    await page.waitForSelector('#submit-button', { timeout: 5000 });
    await page.click('#submit-button');
  } catch (e) {
    return { status: 'error', error: 'selector_failed' };
  }

  await page.waitForTimeout(2000);

  const permalink = `${videoUrl}&t=${Math.floor(timestamp)}s`;
  return { status: 'posted', permalink };
}

async function postToVimeo(page, videoUrl, timestamp, text) {
  // TODO: Implement Vimeo posting
  return { status: 'error', error: 'Vimeo posting not yet implemented' };
}

async function postToAir(page, videoUrl, timestamp, text) {
  // TODO: Implement Air posting
  return { status: 'error', error: 'Air posting not yet implemented' };
}

async function postNote(sessionId, platform, videoUrl, timestamp, text) {
  try {
    const connectUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    const browser = await chromium.connectOverCDP(connectUrl);

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    let result;
    if (platform === 'youtube') {
      result = await postToYoutube(page, videoUrl, timestamp, text);
    } else if (platform === 'vimeo') {
      result = await postToVimeo(page, videoUrl, timestamp, text);
    } else if (platform === 'air') {
      result = await postToAir(page, videoUrl, timestamp, text);
    } else {
      result = { status: 'error', error: `Unknown platform: ${platform}` };
    }

    await browser.close();
    return result;
  } catch (error) {
    if (error.message.includes('session expired') || error.message.includes('session not found')) {
      return { status: 'error', error: 'session_expired' };
    } else if (error.message.includes('rate limit')) {
      return { status: 'error', error: 'rate_limited' };
    }
    return { status: 'error', error: error.message };
  }
}

async function pingSession(sessionId) {
  try {
    const connectUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    const browser = await chromium.connectOverCDP(connectUrl);

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto('about:blank');
    await browser.close();

    return { status: 'pong' };
  } catch (error) {
    if (error.message.includes('not found')) {
      return { status: 'error', error: 'not_found' };
    }
    return { status: 'error', error: 'failed' };
  }
}

// Main message loop (Port packet:4 protocol)

let buffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);

    if (buffer.length < 4 + length) {
      break; // Wait for more data
    }

    const message = buffer.slice(4, 4 + length);
    buffer = buffer.slice(4 + length);

    try {
      const request = JSON.parse(message.toString());
      const { id, command, args } = request;

      let result;

      if (command === 'check_login') {
        result = await checkLogin(args.session_id, args.platform);
      } else if (command === 'post_note') {
        result = await postNote(args.session_id, args.platform, args.video_url, args.timestamp, args.text);
      } else if (command === 'ping_session') {
        result = await pingSession(args.session_id);
      } else {
        result = { status: 'error', error: `Unknown command: ${command}` };
      }

      const response = JSON.stringify({ id, result });
      const responseBuffer = Buffer.from(response);
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(responseBuffer.length, 0);

      process.stdout.write(Buffer.concat([lengthBuffer, responseBuffer]));
    } catch (error) {
      console.error('Error processing message:', error);
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
```

**File:** `priv/node/package.json`

```json
{
  "name": "lossy-playwright",
  "version": "1.0.0",
  "description": "Playwright automation server for Lossy",
  "main": "playwright_server.js",
  "dependencies": {
    "playwright-core": "^1.40.0"
  }
}
```

**Setup Node.js environment:**

```bash
cd lossy/priv/node
npm install
npx playwright install chromium
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
  alias Lossy.Automation.PlaywrightClient

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

        # Call Playwright client
        case PlaywrightClient.post_note(
          connection.browserbase_session_id,
          note.video.platform,
          note.video.url,
          note.timestamp_seconds,
          note.text
        ) do
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
  alias Lossy.Automation.PlaywrightClient

  @impl Oban.Worker
  def perform(_job) do
    # Find sessions that haven't been used in 20 days
    # (ping before 30-day expiry)
    twenty_days_ago = DateTime.add(DateTime.utc_now(), -20, :day)

    connections = Accounts.list_connections_needing_keepalive(twenty_days_ago)

    Logger.info("[SessionKeepAlive] Checking #{length(connections)} connections")

    Enum.each(connections, fn conn ->
      case PlaywrightClient.ping_session(conn.browserbase_session_id) do
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
| **script_failed** | Automation script exception | ✅ Yes | Retry up to 3 attempts |

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
- [ ] Playwright client successfully posts to YouTube
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
- Pure Elixir CDP client (future optimization, optional)
- Alternative Playwright integration approaches

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

👉 [Sprint 08 - Authentication](./SPRINT_08_auth.md)

**Focus:** Add user authentication, multi-user support, token-based auth for LiveView
