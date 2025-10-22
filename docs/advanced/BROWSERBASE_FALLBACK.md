# Browserbase Fallback Integration (Optional)

**Last Updated:** 2025-10-22
**Status:** Optional/Fallback
**Primary Approach:** See [docs/06_COMPUTER_USE.md](../06_COMPUTER_USE.md) for local-first browser automation

---

## 🎯 Overview

This guide covers integrating **Browserbase** as a **fallback option** for automated note posting when local browser agents are unavailable or unsuitable.

**⚠️ Note**: This is NOT the primary approach. Use local browser agents first (see main Computer Use doc).

### When to Use Browserbase (Fallback Only)

- **User machine offline** - Can't run local Chrome
- **Long-running batch jobs** - Posting 100+ notes, user wants to close browser
- **User preference** - Explicitly prefers cloud-based posting
- **Local agent failures** - 3+ consecutive failures on local approach

### Why Browserbase (When Used)?

- **Persistent Sessions**: Long-lived browser contexts maintain login state (30 days)
- **1Password Integration**: Native support for password management (Browserbase feature)
- **No Credential Storage**: Users log in once via hosted browser, contexts persist
- **Stealth Mode**: Realistic browser fingerprints, headful option for debugging
- **Background Operation**: True headless mode when user's machine is offline
- **AI Navigation**: Stagehand handles dynamic selectors better than brittle CSS
- **Production-Ready**: Handles proxy rotation, CAPTCHA challenges, session management

---

## 🏗️ Architecture Overview

```
Backend
│
├── AgentSession (GenServer)
│   └── Posts event: {:note_ready, note_id}
│
├── Oban Worker
│   ├── Receives: note_id from queue
│   ├── Calls: Python bridge → Browserbase API
│   └── Updates: note status in DB
│
└── Python Bridge
    ├── Phase 1: System.cmd() wrapper
    ├── Phase 2: Port with JSON protocol
    └── Phase 3: Pure Elixir (gradual migration)
```

---

## 📁 Repository Structure

```
lossy/
├── lib/lossy/automation/
│   ├── browserbase_client.ex      # API wrapper
│   ├── note_poster.ex              # Oban worker
│   └── python_bridge.ex            # Temporary bridge
│
├── priv/python/
│   ├── automation/
│   │   ├── agent_playwright.py     # Traditional selectors
│   │   ├── agent_stagehand.py      # AI navigation
│   │   └── apply_note.py           # Main entry point
│   └── requirements.txt
│
└── config/
    └── runtime.exs                 # BROWSERBASE_API_KEY
```

---

## 🔄 Integration Phases

### Phase 1: Python Bridge (Week 5)

Keep existing Python agents, call via `System.cmd()`:

```elixir
# lib/lossy/automation/python_bridge.ex
defmodule Lossy.Automation.PythonBridge do
  @moduledoc """
  Temporary bridge to existing Python Browserbase agents.
  Gradual migration path to pure Elixir.
  """

  @python_path Application.app_dir(:lossy, "priv/python")

  def post_note(note_id) do
    note = Lossy.Videos.get_note!(note_id)

    args = [
      Path.join(@python_path, "automation/apply_note.py"),
      "--video-url", note.video.url,
      "--timestamp", to_string(note.timestamp),
      "--text", note.text,
      "--session-id", note.video.browserbase_session_id
    ]

    case System.cmd("python3", args, stderr_to_stdout: true) do
      {output, 0} ->
        {:ok, Jason.decode!(output)}

      {error, code} ->
        {:error, "Python agent failed (code #{code}): #{error}"}
    end
  end
end
```

**Pros:**
- Zero Python rewrite needed
- Existing agents work as-is
- Fast implementation

**Cons:**
- Process spawn overhead (~50ms per call)
- No streaming/progress updates
- Error handling via exit codes only

---

### Phase 2: Port Communication (Week 7+)

Upgrade to long-lived Port with JSON protocol:

```elixir
# lib/lossy/automation/python_bridge.ex
defmodule Lossy.Automation.PythonBridge do
  use GenServer

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def init(_) do
    port = Port.open(
      {:spawn, "python3 -u #{Path.join(@python_path, "automation/port_server.py")}"},
      [:binary, :exit_status, packet: 4]
    )
    {:ok, %{port: port, requests: %{}}}
  end

  def post_note(note_id) do
    GenServer.call(__MODULE__, {:post_note, note_id}, 60_000)
  end

  def handle_call({:post_note, note_id}, from, state) do
    note = Lossy.Videos.get_note!(note_id)
    request_id = generate_id()

    payload = %{
      id: request_id,
      action: "post_note",
      data: %{
        video_url: note.video.url,
        timestamp: note.timestamp,
        text: note.text,
        session_id: note.video.browserbase_session_id
      }
    }

    Port.command(state.port, Jason.encode!(payload))

    new_state = put_in(state.requests[request_id], {from, note_id})
    {:noreply, new_state}
  end

  def handle_info({port, {:data, data}}, %{port: port} = state) do
    response = Jason.decode!(data)

    case Map.pop(state.requests, response["id"]) do
      {{from, _note_id}, new_requests} ->
        GenServer.reply(from, {:ok, response["result"]})
        {:noreply, %{state | requests: new_requests}}

      {nil, _} ->
        {:noreply, state}
    end
  end
end
```

**Python side** (`priv/python/automation/port_server.py`):

```python
import sys
import json
import struct
from automation.apply_note import post_note_to_platform

def read_message():
    """Read length-prefixed message (packet: 4)"""
    length_bytes = sys.stdin.buffer.read(4)
    if not length_bytes:
        return None
    length = struct.unpack('!I', length_bytes)[0]
    return json.loads(sys.stdin.buffer.read(length))

def send_message(msg):
    """Send length-prefixed message"""
    data = json.dumps(msg).encode('utf-8')
    length = struct.pack('!I', len(data))
    sys.stdout.buffer.write(length + data)
    sys.stdout.buffer.flush()

def main():
    while True:
        request = read_message()
        if not request:
            break

        try:
            if request['action'] == 'post_note':
                result = post_note_to_platform(**request['data'])
                send_message({'id': request['id'], 'result': result})
            else:
                send_message({'id': request['id'], 'error': 'Unknown action'})
        except Exception as e:
            send_message({'id': request['id'], 'error': str(e)})

if __name__ == '__main__':
    main()
```

**Pros:**
- Single persistent process (no spawn overhead)
- Can stream progress updates
- Better error handling

**Cons:**
- Requires Python refactor
- Port crashes affect all requests
- Still maintaining Python bridge

---

### Phase 3: Pure Elixir (Optional, Future)

Gradually migrate to native Elixir Browserbase client:

```elixir
# lib/lossy/automation/browserbase_client.ex
defmodule Lossy.Automation.BrowserbaseClient do
  @moduledoc """
  Native Elixir client for Browserbase API.
  Uses HTTPoison + websocket for CDP protocol.
  """

  use HTTPoison.Base

  @base_url "https://www.browserbase.com/v1"
  @api_key Application.compile_env(:lossy, :browserbase_api_key)

  def create_session(opts \\ []) do
    post("/sessions", %{
      projectId: opts[:project_id] || get_project_id(),
      keepAlive: true,
      browserSettings: %{
        viewport: %{width: 1920, height: 1080}
      }
    })
  end

  def get_debug_url(session_id) do
    case get("/sessions/#{session_id}/debug") do
      {:ok, %{body: %{"debuggerUrl" => url}}} -> {:ok, url}
      error -> error
    end
  end

  # CDP over WebSocket
  def connect_cdp(session_id) do
    {:ok, debug_url} = get_debug_url(session_id)
    ws_url = String.replace(debug_url, "http://", "ws://")

    {:ok, pid} = :gun.open(
      ws_url |> URI.parse() |> Map.get(:host) |> String.to_charlist(),
      443,
      %{protocols: [:http], transport: :tls}
    )

    {:ok, _protocol} = :gun.await_up(pid)
    stream_ref = :gun.ws_upgrade(pid, ws_url |> URI.parse() |> Map.get(:path))

    receive do
      {:gun_upgrade, ^pid, ^stream_ref, ["websocket"], _headers} ->
        {:ok, %{pid: pid, stream: stream_ref}}
    after
      5_000 -> {:error, :timeout}
    end
  end

  def send_cdp_command(conn, method, params \\ %{}) do
    id = :erlang.unique_integer([:positive])
    payload = Jason.encode!(%{id: id, method: method, params: params})
    :gun.ws_send(conn.pid, conn.stream, {:text, payload})

    receive do
      {:gun_ws, _, _, {:text, response}} ->
        Jason.decode!(response)
    after
      30_000 -> {:error, :timeout}
    end
  end

  # Helper to navigate
  def navigate(conn, url) do
    send_cdp_command(conn, "Page.navigate", %{url: url})
  end

  # Helper to click element (basic, not AI)
  def click_element(conn, selector) do
    # 1. Get document
    %{"result" => %{"root" => %{"nodeId" => root_id}}} =
      send_cdp_command(conn, "DOM.getDocument")

    # 2. Query selector
    %{"result" => %{"nodeId" => node_id}} =
      send_cdp_command(conn, "DOM.querySelector", %{
        nodeId: root_id,
        selector: selector
      })

    # 3. Get box model for coordinates
    %{"result" => %{"model" => %{"content" => coords}}} =
      send_cdp_command(conn, "DOM.getBoxModel", %{nodeId: node_id})

    [x, y | _] = coords

    # 4. Dispatch click
    send_cdp_command(conn, "Input.dispatchMouseEvent", %{
      type: "mousePressed",
      x: x,
      y: y,
      button: "left",
      clickCount: 1
    })

    send_cdp_command(conn, "Input.dispatchMouseEvent", %{
      type: "mouseReleased",
      x: x,
      y: y,
      button: "left"
    })
  end

  defp process_request_headers(headers) do
    [{"x-bb-api-key", @api_key} | headers]
  end

  defp process_response_body(body) do
    Jason.decode!(body)
  end
end
```

**Note**: Pure Elixir means reimplementing Playwright/Stagehand behavior. For AI navigation, still need:
- LLM-based selector generation
- Retry logic for dynamic content
- Screenshot-based validation

**Recommendation**: Stick with Python bridge (Phase 1 or 2) until Elixir CDP ecosystem matures.

---

## 🔧 Oban Worker Setup

Queue notes for posting with retry logic:

```elixir
# lib/lossy/automation/note_poster.ex
defmodule Lossy.Automation.NotePoster do
  use Oban.Worker,
    queue: :automation,
    max_attempts: 3,
    unique: [period: 60]  # Prevent duplicate posts

  alias Lossy.Videos
  alias Lossy.Automation.PythonBridge

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"note_id" => note_id}}) do
    note = Videos.get_note!(note_id)

    # Update status: queued → posting
    Videos.update_note(note, %{status: "posting"})

    case PythonBridge.post_note(note_id) do
      {:ok, result} ->
        Videos.update_note(note, %{
          status: "posted",
          posted_at: DateTime.utc_now(),
          platform_comment_id: result["comment_id"]
        })

        # Broadcast success to LiveView
        Phoenix.PubSub.broadcast(
          Lossy.PubSub,
          "video:#{note.video_id}",
          {:note_posted, note.id}
        )

        :ok

      {:error, reason} ->
        Videos.update_note(note, %{status: "failed", error: reason})
        {:error, reason}
    end
  end
end
```

**Enqueue from AgentSession:**

```elixir
# lib/lossy/agent/session.ex
def handle_cast({:finalize_note, note_id}, state) do
  note = Videos.get_note!(note_id)

  if note.confidence >= 0.7 and note.status == "ready" do
    # Queue for posting
    %{note_id: note_id}
    |> Lossy.Automation.NotePoster.new()
    |> Oban.insert()

    {:noreply, state}
  else
    {:noreply, state}
  end
end
```

---

## 🔐 Session Management

### Creating Browserbase Contexts

**Flow Overview:**
```
1. User: Clicks "Connect YouTube" in extension settings
2. Backend: Creates Browserbase session (persistent browser context)
3. Extension: Opens Browserbase debug URL in new tab
4. Browserbase: Shows hosted Chrome browser in that tab
5. User: Manually logs into YouTube in the hosted browser
6. User: Closes the tab when logged in
7. Extension: Calls "verify_connection" endpoint
8. Backend: Tests session by navigating to youtube.com
9. Backend: Checks if logged in (detects profile/avatar element)
10. If logged in: Marks connection as "active"
11. All future note postings reuse this authenticated session
```

**Key Details:**
- **Session Persistence**: Browserbase sessions keep cookies/localStorage for 30 days (default)
- **No Credential Storage**: We never see user's YouTube password
- **One-Time Setup**: User logs in once, extension uses session forever
- **Session Expiry**: If inactive for 30 days, user must re-authenticate

User initiates auth flow from extension settings:

```elixir
# lib/lossy_web/live/settings_live.ex
def handle_event("connect_platform", %{"platform" => platform}, socket) do
  user = socket.assigns.current_user

  # Create Browserbase session with keepAlive enabled
  {:ok, session} = Lossy.Automation.BrowserbaseClient.create_session(%{
    projectId: Application.get_env(:lossy, :browserbase_project_id),
    keepAlive: true,  # Persist session for 30 days
    browserSettings: %{
      viewport: %{width: 1920, height: 1080}
    }
  })

  {:ok, debug_url} = Lossy.Automation.BrowserbaseClient.get_debug_url(session.id)

  # Store session
  {:ok, connection} = Lossy.Accounts.create_platform_connection(%{
    user_id: user.id,
    platform: platform,
    browserbase_session_id: session.id,
    status: "awaiting_auth",
    last_used_at: DateTime.utc_now()
  })

  # Open debug URL in new tab (user logs in manually)
  {:noreply,
    socket
    |> assign(:pending_connection, connection)
    |> push_event("open_url", %{url: debug_url, connection_id: connection.id})
    |> put_flash(:info, "Log in to #{platform} in the new tab. Close tab when done.")
  }
end

# User clicks "I'm done logging in" button
def handle_event("verify_connection", %{"connection_id" => id}, socket) do
  connection = Lossy.Accounts.get_connection!(id)

  # Test connection by navigating to platform
  case verify_platform_login(connection.browserbase_session_id, connection.platform) do
    {:ok, :logged_in} ->
      Lossy.Accounts.update_connection(connection, %{
        status: "active",
        verified_at: DateTime.utc_now(),
        last_used_at: DateTime.utc_now()
      })
      {:noreply, put_flash(socket, :info, "✅ #{connection.platform} connected!")}

    {:error, :not_logged_in} ->
      {:noreply, put_flash(socket, :error, "Not logged in. Please try again.")}

    {:error, :session_expired} ->
      Lossy.Accounts.update_connection(connection, %{status: "expired"})
      {:noreply, put_flash(socket, :error, "Session expired. Please create a new connection.")}
  end
end

# Helper to verify login
defp verify_platform_login(session_id, platform) do
  # Use Python bridge to check if logged in
  url = case platform do
    "youtube" -> "https://www.youtube.com"
    "vimeo" -> "https://vimeo.com"
    "air" -> "https://air.inc"
  end

  selector = case platform do
    "youtube" -> "#avatar-btn"  # YouTube profile button
    "vimeo" -> ".topnav_menu_user"  # Vimeo user menu
    "air" -> "[data-test='user-avatar']"  # Air avatar
  end

  case PythonBridge.check_login(session_id, url, selector) do
    {:ok, true} -> {:ok, :logged_in}
    {:ok, false} -> {:error, :not_logged_in}
    {:error, :session_not_found} -> {:error, :session_expired}
    {:error, reason} -> {:error, reason}
  end
end
```

**Python helper** (`priv/python/automation/check_login.py`):
```python
import sys
from playwright.sync_api import sync_playwright

def check_login(session_id, url, selector, timeout=10000):
    """Check if user is logged in by looking for profile element."""
    with sync_playwright() as p:
        # Connect to Browserbase session
        browser = p.chromium.connect_over_cdp(
            f"wss://connect.browserbase.com?apiKey={api_key}&sessionId={session_id}"
        )
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()

        # Navigate to platform
        page.goto(url, wait_until='networkidle')

        # Check if profile element exists (indicates logged in)
        try:
            element = page.wait_for_selector(selector, timeout=timeout)
            return {"logged_in": element is not None}
        except:
            return {"logged_in": False}
```

### Reusing Sessions & Keep-Alive Strategy

**Session Lifecycle:**
- **Created**: When user connects platform
- **Active**: After successful login verification
- **Used**: Every time a note is posted
- **Expires**: After 30 days of inactivity (Browserbase default)
- **Keep-Alive**: Ping session every 20 days to prevent expiry

```elixir
# lib/lossy/automation/note_poster.ex
defp get_session_for_video(video) do
  # Find active connection for this platform
  connection =
    Lossy.Accounts.get_connection_by_platform(video.user_id, video.platform)

  cond do
    connection && connection.status == "active" ->
      # Update last_used_at timestamp
      Lossy.Accounts.update_connection(connection, %{
        last_used_at: DateTime.utc_now()
      })
      {:ok, connection.browserbase_session_id}

    connection && connection.status == "expired" ->
      {:error, :session_expired}

    connection && connection.status == "logged_out" ->
      {:error, :logged_out}

    true ->
      {:error, :no_active_connection}
  end
end

def perform(%Oban.Job{args: %{"note_id" => note_id}}) do
  note = Videos.get_note!(note_id, preload: [:video, :user])

  case get_session_for_video(note.video) do
    {:ok, session_id} ->
      # Use existing session
      case PythonBridge.post_note(note_id, session_id) do
        {:ok, result} ->
          Videos.update_note(note, %{
            status: "posted",
            posted_at: DateTime.utc_now(),
            platform_comment_id: result["comment_id"],
            external_permalink: result["permalink"]
          })
          :ok

        {:error, :session_expired} ->
          # Mark connection as expired
          connection = Lossy.Accounts.get_connection_by_platform(note.user_id, note.video.platform)
          Lossy.Accounts.update_connection(connection, %{status: "expired"})

          Videos.update_note(note, %{
            status: "failed",
            error: "Session expired - please reconnect"
          })
          {:error, :session_expired}

        {:error, reason} ->
          Videos.update_note(note, %{status: "failed", error: inspect(reason)})
          {:error, reason}
      end

    {:error, :no_active_connection} ->
      # Fail gracefully, notify user to reconnect
      Videos.update_note(note, %{
        status: "pending_auth",
        error: "#{note.video.platform} not connected - please connect in settings"
      })

      # Notify user via LiveView
      Phoenix.PubSub.broadcast(
        Lossy.PubSub,
        "user:#{note.user_id}",
        {:connection_required, note.video.platform}
      )

      {:error, :no_auth}

    {:error, :session_expired} ->
      Videos.update_note(note, %{
        status: "pending_auth",
        error: "Session expired - please reconnect #{note.video.platform}"
      })
      {:error, :session_expired}
  end
end
```

**Background worker to keep sessions alive:**
```elixir
# lib/lossy/workers/session_keep_alive_worker.ex
defmodule Lossy.Workers.SessionKeepAliveWorker do
  use Oban.Worker, queue: :maintenance

  @impl Oban.Worker
  def perform(_job) do
    # Find sessions that haven't been used in 20 days
    # (ping before 30-day expiry)
    twenty_days_ago = DateTime.add(DateTime.utc_now(), -20, :day)

    connections =
      Lossy.Accounts.list_connections_needing_keepalive(twenty_days_ago)

    Enum.each(connections, fn conn ->
      case ping_session(conn.browserbase_session_id) do
        {:ok, _} ->
          Lossy.Accounts.update_connection(conn, %{
            last_used_at: DateTime.utc_now()
          })
          Logger.info("Pinged session #{conn.browserbase_session_id}")

        {:error, :not_found} ->
          Lossy.Accounts.update_connection(conn, %{
            status: "expired"
          })
          Logger.warn("Session expired: #{conn.browserbase_session_id}")

        {:error, reason} ->
          Logger.error("Failed to ping session: #{inspect(reason)}")
      end
    end)

    :ok
  end

  defp ping_session(session_id) do
    # Simple navigation to keep session alive
    PythonBridge.ping_session(session_id)
  end
end

# Schedule in application.ex
# Run daily at 3am
config :lossy, Oban,
  repo: Lossy.Repo,
  queues: [
    automation: 3,
    maintenance: 1
  ],
  plugins: [
    {Oban.Plugins.Cron,
     crontab: [
       {"0 3 * * *", Lossy.Workers.SessionKeepAliveWorker}  # Daily at 3am
     ]}
  ]
```

---

## 🐛 Error Handling

### Common Errors

1. **Session Expired**
   - Browserbase sessions expire after 30 days of inactivity
   - Detect: CDP connection refused or 404 from API
   - Solution: Update connection status to `expired`, notify user to reconnect

2. **Platform Logged Out**
   - User manually logged out on the platform
   - Detect: Navigation to login page instead of video page
   - Solution: Mark connection as `logged_out`, prompt re-auth

3. **Rate Limiting**
   - Platform blocks rapid comment posting
   - Detect: 429 errors or "slow down" messages
   - Solution: Exponential backoff in Oban (built-in with max_attempts)

4. **Selector Changes**
   - Platform updates UI, selectors break
   - Detect: Element not found after retries
   - Solution: Stagehand AI navigation (more resilient than CSS selectors)

### Retry Strategy

```elixir
# config/config.exs
config :lossy, Oban,
  repo: Lossy.Repo,
  queues: [
    automation: [
      limit: 3,  # Max 3 concurrent posting jobs
      rate_limit: [allowed: 10, period: 60]  # 10 posts per minute
    ]
  ]

# lib/lossy/automation/note_poster.ex
use Oban.Worker,
  queue: :automation,
  max_attempts: 3,
  priority: 1  # Higher priority than background jobs

def backoff(attempt) do
  # Exponential backoff: 10s, 30s, 90s
  trunc(:math.pow(3, attempt) * 10)
end
```

---

## 📊 Monitoring & Observability

### Telemetry Events

```elixir
# lib/lossy/automation/note_poster.ex
defp emit_telemetry(event, metadata) do
  :telemetry.execute(
    [:lossy, :automation, event],
    %{count: 1},
    metadata
  )
end

def perform(%Oban.Job{args: %{"note_id" => note_id}} = job) do
  start_time = System.monotonic_time()

  result = do_post_note(note_id)

  duration = System.monotonic_time() - start_time

  emit_telemetry(:note_posted, %{
    note_id: note_id,
    duration_ms: System.convert_time_unit(duration, :native, :millisecond),
    attempt: job.attempt,
    success: match?(:ok, result)
  })

  result
end
```

### LiveView Status Updates

```elixir
# lib/lossy_web/live/notes_live.ex
def handle_info({:note_posted, note_id}, socket) do
  note = Videos.get_note!(note_id)

  {:noreply,
    socket
    |> stream_insert(:notes, note)
    |> put_flash(:info, "Note posted successfully!")
  }
end

def handle_info({:note_failed, note_id, reason}, socket) do
  {:noreply,
    socket
    |> put_flash(:error, "Failed to post note: #{reason}")
  }
end
```

---

## 🧪 Testing Strategy

### Unit Tests (Python Agents)

Keep existing Python tests:

```bash
cd priv/python
pytest automation/test_agent_stagehand.py
```

### Integration Tests (Elixir Bridge)

```elixir
# test/lossy/automation/python_bridge_test.exs
defmodule Lossy.Automation.PythonBridgeTest do
  use Lossy.DataCase, async: false

  alias Lossy.Automation.PythonBridge

  @tag :integration
  test "posts note to Air via Python agent" do
    note = insert(:note, %{
      text: "Test note",
      timestamp: 45.2,
      video: insert(:video, %{
        url: "https://air.inc/video/test",
        browserbase_session_id: "test-session-123"
      })
    })

    assert {:ok, result} = PythonBridge.post_note(note.id)
    assert result["comment_id"]
    assert result["status"] == "posted"
  end
end
```

### E2E Tests (Browserbase Sandbox)

Use Browserbase test mode with mock sessions:

```elixir
# config/test.exs
config :lossy, :browserbase_client,
  api_key: "test_key",
  base_url: "https://sandbox.browserbase.com"
```

---

## 🚀 Production Checklist

- [ ] **API Keys**: Store `BROWSERBASE_API_KEY` in `runtime.exs` (from env var)
- [ ] **Oban Config**: Set queue limits and rate limiting
- [ ] **Telemetry**: Hook up metrics to monitoring (DataDog, AppSignal, etc.)
- [ ] **Error Tracking**: Send Python errors to Sentry/Rollbar
- [ ] **Session Expiry**: Cron job to detect and notify expired connections
- [ ] **User Notifications**: Email/push when notes fail to post
- [ ] **Cost Monitoring**: Track Browserbase usage (minutes per user)
- [ ] **Python Deps**: Lock versions in `requirements.txt`, use venv
- [ ] **Graceful Degradation**: Queue notes if Browserbase is down
- [ ] **Documentation**: User-facing guide for connecting platforms

---

## 📚 References

- **Browserbase API Docs**: https://docs.browserbase.com
- **Playwright Guide**: https://playwright.dev/python/docs/intro
- **Stagehand Repo**: https://github.com/browserbase/stagehand
- **Oban Documentation**: https://hexdocs.pm/oban/Oban.html
- **Elixir Ports Guide**: https://hexdocs.pm/elixir/Port.html

---

## 🎯 Summary

**Recommended Approach**:
1. **Week 5**: Python bridge via `System.cmd()` (fast, proven agents)
2. **Week 7+**: Upgrade to Port communication (optional, better performance)
3. **Future**: Pure Elixir only if Python becomes bottleneck

**Key Principles**:
- **Pragmatic**: Use what works (Python agents are battle-tested)
- **Observable**: Telemetry + LiveView status updates
- **Resilient**: Oban retries + exponential backoff
- **User-Friendly**: Clear error messages, reconnection prompts
- **Cost-Effective**: Session reuse, rate limiting

The goal is **reliable, automated posting** with minimal user friction. Python bridge achieves this fastest while keeping migration path open.
