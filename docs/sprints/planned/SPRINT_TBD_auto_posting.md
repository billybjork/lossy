# Sprint TBD: Automated Note Posting with Local Browser Agent

**Status:** ⏳ Planned
**Estimated Duration:** 4-6 days

---

## Goal

Automatically post high-confidence notes to video platforms (YouTube, Vimeo, Air) using a **local browser agent** running in a dedicated Chrome profile. Users log in once per platform, then notes are posted automatically via Oban background jobs controlling the local browser.

**Key Innovation**: Local-first approach with user's authenticated browser (vs. remote Browserbase sessions).

---

## Prerequisites

- ✅ Sprint 03 complete (video integration working)
- ⏳ Node.js 18+ with npm installed
- ⏳ Playwright npm package (`playwright` and `playwright-core`)
- ⏳ Optional: Gemini 2.5 API key for AI-powered navigation
- ⏳ Optional: Browserbase account (fallback only)

---

## Deliverables

- [ ] Dedicated Chrome agent profile setup (`~/.config/lossy/agent-profile`)
- [ ] Platform connection flow (user logs in once via agent browser)
- [ ] Oban worker queues notes for posting
- [ ] Local agent GenServer controls browser via Playwright CDP
- [ ] Real-time status updates in side panel ("Logging in...", "Posted ✓")
- [ ] "Summon Agent" feature for MFA/login intervention
- [ ] Retry logic with exponential backoff
- [ ] Note status tracking (ghost → queued → posting → posted → failed)
- [ ] Error taxonomy for platform-specific failures
- [ ] Optional: Browserbase fallback for offline/long-running tasks

---

## Why Local-First?

### Advantages Over Remote (Browserbase-First)

| Factor | Local Agent | Remote (Browserbase) |
|--------|-------------|----------------------|
| **Auth** | Already logged in, no credential management | Need to create/maintain sessions |
| **Latency** | Instant (no network roundtrip) | ~100-300ms per action |
| **Complexity** | Simpler (direct Chrome control) | More complex (session management) |
| **User Control** | Can summon window for MFA/issues | Limited user intervention |
| **Cost** | $0 (uses local machine) | ~$0.10-$0.50/month per user |
| **Visibility** | Visible window (prevents throttling) | Headless (platform detection risk) |

### When to Use Browserbase (Fallback)

- User machine offline/unavailable
- Long-running batch posting (100+ notes)
- User explicitly prefers background mode

---

## Technical Tasks

### Task 1: Dedicated Agent Profile Setup

Users need a separate Chrome profile for the agent to avoid conflicts with their main browser sessions.

#### 1.1 Profile Initialization Module

**File:** `lib/lossy/automation/profile_setup.ex` (new)

```elixir
defmodule Lossy.Automation.ProfileSetup do
  @moduledoc """
  Manages the dedicated Chrome profile for the browser agent.
  Profile persists cookies, localStorage, and passkeys across sessions.
  """

  require Logger

  @profile_dir Path.expand("~/.config/lossy/agent-profile")

  def profile_path, do: @profile_dir

  def ensure_profile_exists do
    unless File.exists?(@profile_dir) do
      Logger.info("[ProfileSetup] Creating agent profile at #{@profile_dir}")

      File.mkdir_p!(@profile_dir)

      # Launch Chrome once to initialize profile structure
      {_output, 0} = System.cmd("google-chrome", [
        "--user-data-dir=#{@profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "about:blank"
      ])

      # Wait for profile initialization
      Process.sleep(2000)

      Logger.info("[ProfileSetup] Agent profile created successfully")
    end

    :ok
  end

  def open_setup_window(platform) do
    ensure_profile_exists()

    url = platform_login_url(platform)

    Logger.info("[ProfileSetup] Opening setup window for #{platform}")

    # Open Chrome to platform's login page in a new window
    {_output, 0} = System.cmd("google-chrome", [
      "--user-data-dir=#{@profile_dir}",
      "--new-window",
      url
    ])

    {:ok, "Setup window opened - please log in to #{platform}"}
  end

  def check_platform_login(platform) do
    # Will be implemented with Playwright agent
    # For now, assume manual verification
    {:ok, :unknown}
  end

  def reset_profile do
    if File.exists?(@profile_dir) do
      Logger.warn("[ProfileSetup] Resetting agent profile - deleting #{@profile_dir}")
      File.rm_rf!(@profile_dir)
      :ok
    else
      {:error, :profile_not_found}
    end
  end

  defp platform_login_url("youtube"), do: "https://accounts.google.com"
  defp platform_login_url("vimeo"), do: "https://vimeo.com/log_in"
  defp platform_login_url("air"), do: "https://air.inc/login"
  defp platform_login_url(_), do: "about:blank"
end
```

#### 1.2 Settings UI for Profile Management

**File:** `lib/lossy_web/live/settings_live.ex` (new)

```elixir
defmodule LossyWeb.SettingsLive do
  use LossyWeb, :live_view

  alias Lossy.Automation.ProfileSetup

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:platforms, ["youtube", "vimeo", "air"])
     |> assign(:profile_status, check_profile_status())}
  end

  @impl true
  def handle_event("setup_platform", %{"platform" => platform}, socket) do
    case ProfileSetup.open_setup_window(platform) do
      {:ok, message} ->
        {:noreply,
         socket
         |> put_flash(:info, message)
         |> push_event("setup_window_opened", %{platform: platform})}

      {:error, reason} ->
        {:noreply,
         socket
         |> put_flash(:error, "Failed to open setup window: #{reason}")}
    end
  end

  @impl true
  def handle_event("test_connection", %{"platform" => platform}, socket) do
    # TODO: Implement connection test via Playwright agent
    {:noreply,
     socket
     |> put_flash(:info, "Testing #{platform} connection...")}
  end

  @impl true
  def handle_event("reset_profile", _, socket) do
    case ProfileSetup.reset_profile() do
      :ok ->
        {:noreply,
         socket
         |> assign(:profile_status, check_profile_status())
         |> put_flash(:info, "Agent profile reset successfully")}

      {:error, reason} ->
        {:noreply,
         socket
         |> put_flash(:error, "Failed to reset profile: #{reason}")}
    end
  end

  @impl true
  def handle_event("open_profile_folder", _, socket) do
    # Open profile folder in file manager
    case :os.type() do
      {:unix, :darwin} ->
        System.cmd("open", [ProfileSetup.profile_path()])

      {:unix, _} ->
        System.cmd("xdg-open", [ProfileSetup.profile_path()])

      {:win32, _} ->
        System.cmd("explorer", [ProfileSetup.profile_path()])
    end

    {:noreply, socket}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="settings-page">
        <h1>Computer Use Agent Settings</h1>

        <section class="agent-profile">
          <h2>Agent Browser Profile</h2>
          <p class="help-text">
            The agent uses a dedicated Chrome profile to persist login sessions across platforms.
            You only need to log in to each platform once.
          </p>

          <div class="profile-status">
            <%= if @profile_status.exists do %>
              <span class="status-badge status-active">✓ Profile Created</span>
              <p class="profile-path"><%= @profile_status.path %></p>
            <% else %>
              <span class="status-badge status-inactive">Profile Not Created</span>
              <p class="help-text">Profile will be created automatically when you set up your first platform.</p>
            <% end %>
          </div>

          <div class="profile-actions">
            <button phx-click="open_profile_folder" class="btn-secondary">
              📁 Open Profile Folder
            </button>
            <button
              phx-click="reset_profile"
              class="btn-danger"
              data-confirm="This will log you out of all platforms. Continue?"
            >
              🗑️ Reset Profile
            </button>
          </div>
        </section>

        <section class="platform-connections">
          <h2>Platform Connections</h2>

          <div class="platforms-grid">
            <%= for platform <- @platforms do %>
              <div class="platform-card">
                <h3><%= String.capitalize(platform) %></h3>

                <div class="platform-status">
                  <span class="status-badge status-inactive">Not Connected</span>
                </div>

                <div class="platform-actions">
                  <button phx-click="setup_platform" phx-value-platform={platform} class="btn-primary">
                    Connect <%= String.capitalize(platform) %>
                  </button>
                  <button phx-click="test_connection" phx-value-platform={platform} class="btn-secondary">
                    Test Connection
                  </button>
                </div>
              </div>
            <% end %>
          </div>
        </section>

        <section class="fallback-settings">
          <h2>Fallback Options</h2>

          <div class="setting">
            <label>
              <input type="checkbox" name="prefer_browserbase" />
              Prefer Browserbase for background posting (requires API key)
            </label>
            <p class="help-text">
              When enabled, notes will be posted via cloud browser sessions instead of your local machine.
              Useful for batch posting or when your computer is offline.
            </p>
          </div>
        </section>
      </div>
    </Layouts.app>
    """
  end

  defp check_profile_status do
    path = ProfileSetup.profile_path()

    %{
      exists: File.exists?(path),
      path: path
    }
  end
end
```

**Add route:**

```elixir
# lib/lossy_web/router.ex
scope "/", LossyWeb do
  pipe_through :browser

  live "/settings", SettingsLive, :index
end
```

---

### Task 2: Playwright Agent (Local Browser Control)

#### 2.1 Playwright Agent GenServer (Elixir)

**File:** `lib/lossy/automation/local_agent.ex` (new)

```elixir
defmodule Lossy.Automation.LocalAgent do
  @moduledoc """
  Local browser agent powered by Playwright.
  Controls a dedicated Chrome profile via CDP for posting notes.
  """

  use GenServer
  require Logger

  @node_script Application.app_dir(:lossy, "priv/node/playwright_agent.js")

  # Client API

  def start_link(opts \\\\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def post_note(note_id, platform, video_url, timestamp, text) do
    GenServer.call(__MODULE__, {:post_note, note_id, platform, video_url, timestamp, text}, 120_000)
  end

  def check_login(platform) do
    GenServer.call(__MODULE__, {:check_login, platform}, 30_000)
  end

  def summon_window(note_id) do
    GenServer.cast(__MODULE__, {:summon_window, note_id})
  end

  # GenServer callbacks

  @impl true
  def init(_opts) do
    # Ensure profile exists before starting agent
    Lossy.Automation.ProfileSetup.ensure_profile_exists()

    port = Port.open(
      {:spawn_executable, System.find_executable("node")},
      [:binary, :exit_status, args: [@node_script], packet: 4]
    )

    Logger.info("[LocalAgent] Started with Node.js port")

    {:ok, %{port: port, pending: %{}}}
  end

  @impl true
  def handle_call({:post_note, note_id, platform, video_url, timestamp, text}, from, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "post_note",
      args: %{
        note_id: note_id,
        profile_dir: Lossy.Automation.ProfileSetup.profile_path(),
        platform: platform,
        video_url: video_url,
        timestamp: timestamp,
        text: text
      }
    }

    broadcast_status(note_id, :starting, "Launching browser agent")
    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], {from, note_id})}
  end

  @impl true
  def handle_call({:check_login, platform}, from, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "check_login",
      args: %{
        profile_dir: Lossy.Automation.ProfileSetup.profile_path(),
        platform: platform
      }
    }

    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], {from, nil})}
  end

  @impl true
  def handle_cast({:summon_window, note_id}, state) do
    request = %{
      id: make_ref() |> :erlang.ref_to_list() |> to_string(),
      command: "summon_window",
      args: %{note_id: note_id}
    }

    send_request(state.port, request)
    {:noreply, state}
  end

  @impl true
  def handle_info({_port, {:data, data}}, state) do
    case Jason.decode(data) do
      {:ok, %{"id" => id, "result" => result}} ->
        case Map.pop(state.pending, id) do
          {nil, _pending} ->
            Logger.warn("[LocalAgent] Received response for unknown request: #{id}")
            {:noreply, state}

          {{from, note_id}, pending} ->
            # Broadcast final status if this was a note posting
            if note_id do
              handle_result_status(note_id, result)
            end

            GenServer.reply(from, parse_result(result))
            {:noreply, %{state | pending: pending}}
        end

      {:ok, %{"status_update" => status_update}} ->
        # Intermediate status update from agent
        handle_status_update(status_update)
        {:noreply, state}

      {:ok, %{"error" => error}} ->
        Logger.error("[LocalAgent] Agent error: #{inspect(error)}")
        {:noreply, state}

      {:error, reason} ->
        Logger.error("[LocalAgent] Failed to decode response: #{inspect(reason)}")
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({_port, {:exit_status, status}}, state) do
    Logger.error("[LocalAgent] Node.js agent exited with status: #{status}")
    {:stop, :port_exit, state}
  end

  # Private helpers

  defp send_request(port, request) do
    data = Jason.encode!(request)
    Port.command(port, data)
  end

  defp parse_result(%{"status" => "posted", "permalink" => permalink}), do: {:ok, %{permalink: permalink}}
  defp parse_result(%{"status" => "logged_in"}), do: {:ok, :logged_in}
  defp parse_result(%{"status" => "not_logged_in"}), do: {:error, :not_logged_in}
  defp parse_result(%{"status" => "needs_mfa"}), do: {:error, :needs_user_intervention}
  defp parse_result(%{"status" => "needs_login"}), do: {:error, :needs_user_intervention}
  defp parse_result(%{"status" => "error", "error" => error}), do: {:error, error}
  defp parse_result(other), do: {:error, "Unknown response: #{inspect(other)}"}

  defp handle_result_status(note_id, %{"status" => "posted"}) do
    broadcast_status(note_id, :posted, "✅ Posted successfully")
  end

  defp handle_result_status(note_id, %{"status" => "needs_mfa"}) do
    broadcast_status(note_id, :needs_mfa, "⚠️ MFA verification required → Summon")
  end

  defp handle_result_status(note_id, %{"status" => "error", "error" => error}) do
    broadcast_status(note_id, :failed, "❌ Failed: #{error}")
  end

  defp handle_result_status(_, _), do: :ok

  defp handle_status_update(%{"note_id" => note_id, "status" => status, "message" => message}) do
    broadcast_status(note_id, String.to_existing_atom(status), message)
  end
  defp handle_status_update(_), do: :ok

  defp broadcast_status(note_id, status, message) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "note:#{note_id}",
      {:agent_status, %{
        status: status,
        message: message,
        timestamp: DateTime.utc_now()
      }}
    )
  end
end
```

**Add to supervision tree:**

```elixir
# lib/lossy/application.ex
def start(_type, _args) do
  children = [
    # ... existing children ...
    Lossy.Automation.LocalAgent,
    {Oban, Application.fetch_env!(:lossy, Oban)}
  ]

  opts = [strategy: :one_for_one, name: Lossy.Supervisor]
  Supervisor.start_link(children, opts)
end
```

#### 2.2 Node.js Playwright Agent

**File:** `priv/node/playwright_agent.js` (new)

```javascript
#!/usr/bin/env node
/**
 * Local browser automation agent for Lossy.
 * Uses Playwright to control dedicated Chrome profile via CDP.
 */

const { chromium } = require('playwright');

// Platform-specific posting logic
const PLATFORMS = {
  youtube: {
    async checkLogin(page) {
      await page.goto('https://www.youtube.com');
      await page.waitForLoadState('networkidle');

      try {
        await page.waitForSelector('#avatar-btn', { timeout: 5000 });
        return { status: 'logged_in' };
      } catch (e) {
        return { status: 'not_logged_in' };
      }
    },

    async postComment(page, videoUrl, timestamp, text, noteId) {
      // Navigate to video at timestamp
      await page.goto(`${videoUrl}&t=${Math.floor(timestamp)}s`);
      await sendStatus(noteId, 'navigating', 'Opened video');

      // Scroll to comments section
      await page.evaluate(() => window.scrollTo(0, 800));
      await page.waitForTimeout(1000);
      await sendStatus(noteId, 'posting', 'Scrolled to comments');

      // Click comment box
      try {
        await page.waitForSelector('#placeholder-area', { timeout: 5000 });
        await page.click('#placeholder-area');
        await sendStatus(noteId, 'posting', 'Clicked comment box');
      } catch (e) {
        return { status: 'error', error: 'Comment box not found - selector may have changed' };
      }

      // Fill comment text
      try {
        await page.waitForSelector('#contenteditable-root', { timeout: 5000 });
        await page.fill('#contenteditable-root', text);
        await sendStatus(noteId, 'posting', 'Entered comment text');
      } catch (e) {
        return { status: 'error', error: 'Comment input not found' };
      }

      // Submit comment
      try {
        await page.waitForSelector('#submit-button', { timeout: 5000 });
        await page.click('#submit-button');
        await sendStatus(noteId, 'posting', 'Submitted comment');
      } catch (e) {
        return { status: 'error', error: 'Submit button not found' };
      }

      // Wait for submission
      await page.waitForTimeout(2000);

      const permalink = `${videoUrl}&t=${Math.floor(timestamp)}s`;
      return { status: 'posted', permalink };
    }
  },

  vimeo: {
    async checkLogin(page) {
      await page.goto('https://vimeo.com');
      await page.waitForLoadState('networkidle');

      try {
        await page.waitForSelector('.topnav_menu_user', { timeout: 5000 });
        return { status: 'logged_in' };
      } catch (e) {
        return { status: 'not_logged_in' };
      }
    },

    async postComment(page, videoUrl, timestamp, text, noteId) {
      // TODO: Implement Vimeo posting
      return { status: 'error', error: 'Vimeo posting not yet implemented' };
    }
  },

  air: {
    async checkLogin(page) {
      await page.goto('https://air.inc');
      await page.waitForLoadState('networkidle');

      try {
        await page.waitForSelector('[data-test="user-avatar"]', { timeout: 5000 });
        return { status: 'logged_in' };
      } catch (e) {
        return { status: 'not_logged_in' };
      }
    },

    async postComment(page, videoUrl, timestamp, text, noteId) {
      // TODO: Implement Air posting
      return { status: 'error', error: 'Air posting not yet implemented' };
    }
  }
};

// Helper to send intermediate status updates
function sendStatus(noteId, status, message) {
  const statusUpdate = JSON.stringify({
    status_update: {
      note_id: noteId,
      status,
      message
    }
  });

  const buffer = Buffer.from(statusUpdate);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(buffer.length, 0);

  process.stdout.write(Buffer.concat([lengthBuffer, buffer]));
}

// Command handlers

async function checkLogin(profileDir, platform) {
  const platformConfig = PLATFORMS[platform];
  if (!platformConfig) {
    return { status: 'error', error: `Unknown platform: ${platform}` };
  }

  try {
    const browser = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps'
      ],
      viewport: { width: 1440, height: 900 }
    });

    const page = browser.pages()[0] || await browser.newPage();

    const result = await platformConfig.checkLogin(page);

    await browser.close();
    return result;

  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

async function postNote({ note_id, profile_dir, platform, video_url, timestamp, text }) {
  const platformConfig = PLATFORMS[platform];
  if (!platformConfig) {
    return { status: 'error', error: `Unknown platform: ${platform}` };
  }

  try {
    sendStatus(note_id, 'starting', 'Launching browser');

    const browser = await chromium.launchPersistentContext(profile_dir, {
      headless: false,  // Visible window prevents platform throttling
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps'
      ],
      viewport: { width: 1440, height: 900 }
    });

    const page = browser.pages()[0] || await browser.newPage();

    sendStatus(note_id, 'authenticating', `Checking ${platform} login`);

    // Check if logged in first
    const loginStatus = await platformConfig.checkLogin(page);

    if (loginStatus.status === 'not_logged_in') {
      await browser.close();
      return { status: 'needs_login' };
    }

    sendStatus(note_id, 'authenticated', '✓ Logged in');

    // Post comment
    const result = await platformConfig.postComment(page, video_url, timestamp, text, note_id);

    await browser.close();
    return result;

  } catch (error) {
    if (error.message.includes('login') || error.message.includes('sign in')) {
      return { status: 'needs_login' };
    } else if (error.message.includes('verification') || error.message.includes('MFA')) {
      return { status: 'needs_mfa' };
    }

    return { status: 'error', error: error.message };
  }
}

async function summonWindow(noteId) {
  // Bring browser window to foreground
  // This is platform-specific, implementation depends on OS

  // For now, just open a new window
  // TODO: Use AppleScript on macOS, wmctrl on Linux, etc.

  return { status: 'summoned' };
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
        result = await checkLogin(args.profile_dir, args.platform);
      } else if (command === 'post_note') {
        result = await postNote(args);
      } else if (command === 'summon_window') {
        result = await summonWindow(args.note_id);
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
  "name": "lossy-playwright-agent",
  "version": "1.0.0",
  "description": "Local browser automation agent for Lossy",
  "main": "playwright_agent.js",
  "dependencies": {
    "playwright": "^1.48.0"
  }
}
```

**Setup:**

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
      limit: 2,  # Max 2 concurrent posting jobs (local browser)
      rate_limit: [
        allowed: 5,  # 5 posts per period
        period: 60    # 60 seconds
      ]
    ],
    maintenance: 1
  ],
  plugins: [
    {Oban.Plugins.Pruner, max_age: 60 * 60 * 24 * 7}  # Keep jobs for 7 days
  ]
```

#### 3.2 Post Note Worker

**File:** `lib/lossy/workers/post_note_worker.ex` (new)

```elixir
defmodule Lossy.Workers.PostNoteWorker do
  use Oban.Worker,
    queue: :automation,
    max_attempts: 3,
    unique: [period: 60, fields: [:args]]  # Prevent duplicate posts

  require Logger

  alias Lossy.Videos
  alias Lossy.Automation.LocalAgent

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"note_id" => note_id}, attempt: attempt}) do
    note = Videos.get_note!(note_id, preload: [:video])

    Logger.info("[PostNoteWorker] Posting note #{note_id} (attempt #{attempt}/3)")

    # Update status to queued
    Videos.update_note(note, %{status: "queued"})

    # Call local agent
    case LocalAgent.post_note(
      note.id,
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

        :ok

      {:error, :needs_user_intervention} ->
        Logger.warn("[PostNoteWorker] Note #{note_id} needs user intervention (MFA/login)")

        Videos.update_note(note, %{
          status: "needs_intervention",
          error: "User intervention required - click Summon in side panel"
        })

        # Don't retry - user needs to handle manually
        {:discard, "Needs user intervention"}

      {:error, :not_logged_in} ->
        Logger.warn("[PostNoteWorker] User not logged in to #{note.video.platform}")

        Videos.update_note(note, %{
          status: "ghost",  # Return to ghost state
          error: "Not logged in - please connect #{note.video.platform} in settings"
        })

        {:discard, "Not logged in"}

      {:error, reason} ->
        Logger.error("[PostNoteWorker] Post failed: #{inspect(reason)}")

        Videos.update_note(note, %{
          status: "failed",
          error: "Posting failed: #{inspect(reason)}"
        })

        # Retry unknown errors
        {:error, reason}
    end
  end

  # Exponential backoff: 30s, 90s, 270s
  @impl Oban.Worker
  def backoff(attempt) do
    trunc(:math.pow(3, attempt) * 30)
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

### Task 4: Side Panel Status Updates

#### 4.1 Update Note Schema

**Migration:**

```elixir
# priv/repo/migrations/TIMESTAMP_add_agent_status_to_notes.exs
defmodule Lossy.Repo.Migrations.AddAgentStatusToNotes do
  use Ecto.Migration

  def change do
    alter table(:notes) do
      add :agent_status, :map  # JSON field for real-time status updates
    end
  end
end
```

Run: `mix ecto.migrate`

#### 4.2 Notes LiveView Updates

**File:** `lib/lossy_web/live/notes_live.ex` (update)

```elixir
defmodule LossyWeb.NotesLive do
  use LossyWeb, :live_view

  alias Lossy.Videos

  @impl true
  def mount(%{"video_id" => video_id}, _session, socket) do
    if connected?(socket) do
      # Subscribe to video-wide events
      Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{video_id}")

      # Subscribe to each note's status updates
      notes = Videos.list_notes(video_id)
      Enum.each(notes, fn note ->
        Phoenix.PubSub.subscribe(Lossy.PubSub, "note:#{note.id}")
      end)
    end

    {:ok,
     socket
     |> assign(:video_id, video_id)
     |> stream(:notes, Videos.list_notes(video_id))}
  end

  @impl true
  def handle_info({:agent_status, status}, socket) do
    # Real-time status update for a note
    # Status shape: %{status: :posting, message: "...", timestamp: ...}

    # Update note in stream
    {:noreply, socket}  # LiveView automatically updates via PubSub
  end

  @impl true
  def handle_info({:new_note, note}, socket) do
    # New note created - subscribe to its status updates
    Phoenix.PubSub.subscribe(Lossy.PubSub, "note:#{note.id}")

    {:noreply,
     socket
     |> stream_insert(:notes, note, at: 0)}
  end

  @impl true
  def handle_event("summon_agent", %{"note-id" => note_id}, socket) do
    # Bring agent window to foreground
    Lossy.Automation.LocalAgent.summon_window(note_id)

    {:noreply,
     socket
     |> put_flash(:info, "Agent window summoned - complete MFA/login and agent will resume")}
  end

  @impl true
  def handle_event("retry_post", %{"note-id" => note_id}, socket) do
    # Manually retry posting
    %{note_id: note_id}
    |> Lossy.Workers.PostNoteWorker.new()
    |> Oban.insert()

    {:noreply,
     socket
     |> put_flash(:info, "Note queued for posting")}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="notes-panel">
      <div id="notes" phx-update="stream">
        <%= for {id, note} <- @streams.notes do %>
          <div id={id} class="note-card">
            <div class="note-header">
              <span class="timestamp"><%= format_timestamp(note.timestamp_seconds) %></span>
              <span class={"status-badge status-#{note.status}"}>
                <%= status_icon(note.status) %> <%= status_text(note.status) %>
              </span>
            </div>

            <div class="note-text"><%= note.text %></div>

            <%= if note.agent_status do %>
              <div class="agent-progress">
                <div class="progress-message">
                  <%= note.agent_status.message %>
                </div>

                <%= if note.status == "needs_intervention" do %>
                  <button phx-click="summon_agent" phx-value-note-id={note.id} class="summon-btn">
                    🪄 Summon Agent Window
                  </button>
                <% end %>
              </div>
            <% end %>

            <%= if note.status == "failed" do %>
              <div class="note-actions">
                <button phx-click="retry_post" phx-value-note-id={note.id} class="btn-secondary">
                  🔄 Retry Posting
                </button>
              </div>
            <% end %>
          </div>
        <% end %>
      </div>
    </div>
    """
  end

  defp status_icon("ghost"), do: "👻"
  defp status_icon("queued"), do: "⏳"
  defp status_icon("posting"), do: "📤"
  defp status_icon("posted"), do: "✅"
  defp status_icon("failed"), do: "❌"
  defp status_icon("needs_intervention"), do: "⚠️"
  defp status_icon(_), do: "•"

  defp status_text("ghost"), do: "Draft"
  defp status_text("queued"), do: "Queued"
  defp status_text("posting"), do: "Posting..."
  defp status_text("posted"), do: "Posted"
  defp status_text("failed"), do: "Failed"
  defp status_text("needs_intervention"), do: "Needs Help"
  defp status_text(status), do: String.capitalize(status)

  defp format_timestamp(seconds) do
    minutes = div(seconds, 60)
    secs = rem(seconds, 60)
    "#{minutes}:#{String.pad_leading(to_string(secs), 2, "0")}"
  end
end
```

---

## Error Taxonomy & Retry Strategy

### Error Types

| Error | Cause | Retry? | Action |
|-------|-------|--------|--------|
| **needs_user_intervention** | MFA/login required | ❌ No | Show "Summon" button, wait for user |
| **not_logged_in** | User logged out of platform | ❌ No | Prompt to reconnect in settings |
| **selector_failed** | Platform UI changed | ❌ No | Fail permanently, needs code update |
| **network_error** | Timeout, connection issues | ✅ Yes | Retry with backoff |
| **rate_limited** | Platform throttling | ✅ Yes | Retry with longer backoff |
| **script_failed** | Automation exception | ✅ Yes | Retry up to 3 attempts |

### Retry Configuration

```elixir
# Oban worker configuration
use Oban.Worker,
  queue: :automation,
  max_attempts: 3,
  unique: [period: 60, fields: [:args]]

# Exponential backoff: 30s, 90s, 270s
def backoff(attempt) do
  trunc(:math.pow(3, attempt) * 30)
end
```

---

## Testing Checklist

### Profile Setup Tests

- [ ] Run `ProfileSetup.ensure_profile_exists()` → profile created at `~/.config/lossy/agent-profile`
- [ ] Open settings page → click "Connect YouTube" → Chrome window opens to Google login
- [ ] Log in to YouTube → close window → run `LocalAgent.check_login("youtube")` → returns `{:ok, :logged_in}`

### Posting Tests

- [ ] High-confidence note (>0.7) → auto-queued by AgentSession
- [ ] Oban picks up job within seconds → status updates in side panel
- [ ] Chrome window opens → navigates to video → posts comment
- [ ] Note status: ghost → queued → posting → posted
- [ ] Permalink stored in `external_permalink` field

### Error Handling Tests

- [ ] Log out of YouTube → posting returns `{:error, :not_logged_in}` → note stays as ghost
- [ ] Trigger MFA → posting returns `{:error, :needs_user_intervention}` → "Summon" button appears
- [ ] Click "Summon" → Chrome window comes to foreground
- [ ] Selector failure → note marked as failed (no retry)

### UI Tests

- [ ] Status badge updates in real-time (⏳ → 🔒 → ✓ → 📤 → ✅)
- [ ] Progress messages appear ("Logging in...", "Posted ✓")
- [ ] Summon button functional
- [ ] Retry button works for failed notes

---

## Optional: Browserbase Fallback

For users who want background posting or whose machines are offline, implement Browserbase fallback:

1. **Add Browserbase config:**
   ```elixir
   # config/runtime.exs
   config :lossy,
     browserbase_api_key: System.get_env("BROWSERBASE_API_KEY"),
     browserbase_project_id: System.get_env("BROWSERBASE_PROJECT_ID")
   ```

2. **Add coordinator module:**
   ```elixir
   defmodule Lossy.Automation.ComputerUseCoordinator do
     def post_note(note) do
       if should_use_local?(note) do
         LocalAgent.post_note(...)
       else
         BrowserbaseAgent.post_note(...)
       end
     end
   end
   ```

3. **See:** `docs/advanced/BROWSERBASE_FALLBACK.md` for full implementation

---

## Reference Documentation

See [06_COMPUTER_USE.md](../../06_COMPUTER_USE.md) for:
- Complete architecture overview
- **Platform adapter integration** (reusing existing selector code!)
- Gemini 2.5 Computer Use API integration (alternative to Playwright)
- Hybrid approach (adapters + Gemini fallback)
- Status update patterns
- Profile management best practices
- Browserbase fallback implementation

---

## Cost Tracking

**Local Agent:**
- Cost: $0 (uses user's machine)
- Latency: ~2-5 seconds per note
- Requires: User machine online

**Browserbase (Fallback):**
- Sessions: $0.002 per minute
- Average note posting: ~30 seconds = $0.001
- For 100 notes/month: $0.10/month

**Total cost: $0-$0.10/month per user** (vs. $0.10-$0.50 with Browserbase-first)

---

## Next Sprint

👉 [Sprint TBD - Authentication](./SPRINT_TBD_auth.md)

**Focus:** Add user authentication, multi-user support, token-based auth for LiveView
