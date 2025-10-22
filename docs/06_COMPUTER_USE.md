# Computer Use Integration - Local-First Browser Agents

**Last Updated:** 2025-10-22
**Status:** Pre-Implementation

---

## 🎯 Overview

This guide covers the **local-first browser agent** architecture for automated video platform interactions - specifically posting structured notes as comments on Air, YouTube, Vimeo, etc.

### Why Local-First?

**Primary Approach: Local Browser Agent**

- **Auth**: Already authenticated in user's browser - no credential management needed
- **Latency**: No remote viewport roundtrip (instant feedback)
- **Complexity**: Simpler to implement - direct Chrome control
- **User Control**: User can intervene when needed (MFA, login issues)
- **Cost**: Zero incremental cost (vs. Browserbase metered usage)

**Fallback: Browserbase (Optional)**

- **Long-running tasks**: Tasks that don't depend on user's machine
- **Headless background**: True background operation when user closes browser
- **Advanced features**: Session recording, debugging, team collaboration

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Lossy Extension                                                 │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Side Panel (LiveView)                                      │  │
│  │                                                             │  │
│  │ - Note cards with status badges:                           │  │
│  │   • "⏳ Queued for posting"                                │  │
│  │   • "🔒 Logging in..."                                    │  │
│  │   • "✓ Logged in"                                          │  │
│  │   • "📤 Posting comment (3/12 uploaded)"                  │  │
│  │   • "⚠️ Blocked by MFA → Summon"                          │  │
│  │   • "✅ Posted"                                            │  │
│  │                                                             │  │
│  │ [Summon Agent] button when MFA/login needed               │  │
│  └─────────────────┬───────────────────────────────────────────┘  │
│                    │                                               │
└────────────────────┼───────────────────────────────────────────────┘
                     │
                     │ WebSocket (status updates)
                     │
┌────────────────────▼───────────────────────────────────────────────┐
│  Backend (Elixir)                                                  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Oban Worker Queue                                             │ │
│  │                                                                │ │
│  │ - Enqueues note posting jobs                                  │ │
│  │ - Broadcasts status updates via PubSub                       │ │
│  │ - Retry logic with exponential backoff                       │ │
│  └──────────────────┬───────────────────────────────────────────┘ │
│                     │                                               │
│  ┌──────────────────▼───────────────────────────────────────────┐ │
│  │ Computer Use Coordinator                                      │ │
│  │                                                                │ │
│  │ Decision tree:                                                │ │
│  │  1. Try local Chrome agent first                             │ │
│  │  2. Fall back to Browserbase if:                             │ │
│  │     - User machine offline/unavailable                       │ │
│  │     - User explicitly requested background posting           │ │
│  │     - Local agent failed 3x                                  │ │
│  └──────────────────┬───────────────────────────────────────────┘ │
│                     │                                               │
│         ┌───────────┴──────────┐                                   │
│         │                      │                                   │
│  ┌──────▼────────┐     ┌───────▼──────────┐                       │
│  │ LocalAgent    │     │ BrowserbaseAgent │                       │
│  │ GenServer     │     │ (Fallback)       │                       │
│  └──────┬────────┘     └──────────────────┘                       │
│         │                                                           │
└─────────┼───────────────────────────────────────────────────────────┘
          │
          │ CDP over WebSocket
          │
┌─────────▼───────────────────────────────────────────────────────┐
│  Local Chrome Instance (Dedicated Agent Profile)                │
│                                                                   │
│  Launch Configuration:                                           │
│  - Profile: ~/.config/lossy/agent-profile                       │
│  - Args:                                                         │
│    • --user-data-dir=~/.config/lossy/agent-profile             │
│    • --no-first-run                                             │
│    • --no-default-browser-check                                 │
│    • --disable-default-apps                                     │
│  - Visible window (prevents platform throttling)                │
│  - Separate from user's main Chrome profile                    │
│                                                                   │
│  Persisted State:                                                │
│  - Cookies (YouTube, Vimeo, Air login sessions)                │
│  - LocalStorage                                                  │
│  - Passkeys / Auth tokens                                       │
│                                                                   │
│  Automation Driver:                                              │
│  - Option 1: Gemini 2.5 Computer Use API (AI-powered)          │
│  - Option 2: Playwright with CDP (traditional selectors)       │
│  - Option 3: Hybrid (Playwright + Gemini for complex UIs)      │
└───────────────────────────────────────────────────────────────────┘
```

---

## 🔌 Leveraging Existing Platform Adapters

### Overview: When Adapters Are Useful

Your existing platform adapters (`YouTubeAdapter`, `VimeoAdapter`, etc.) were built to find video and timeline elements in the extension. These are **directly reusable** for the browser automation agent - but only for certain approaches.

| Automation Approach | Uses Adapters? | Why |
|---------------------|----------------|-----|
| **Playwright (Selector-based)** | ✅ **YES** | Needs CSS selectors to click/type - adapters provide these |
| **Gemini Computer Use (Vision-based)** | ❌ **NO** | Operates on screenshots - doesn't need selectors |
| **Hybrid (Recommended)** | ✅ **PARTIALLY** | Use adapters for known platforms, Gemini for unknowns |

### What Adapters Provide Today

Your adapters already expose platform-specific selectors:

**YouTube** (`extension/src/content/platforms/youtube/youtube-selectors.js`):
```javascript
export const YouTubeSelectors = {
  VIDEO: ['#movie_player video', 'video.html5-main-video', ...],
  PROGRESS_BAR: ['.ytp-progress-bar-container', ...],
  PLAYER_CONTAINER: ['#movie_player', '.html5-video-player'],
  CONTROLS: ['.ytp-chrome-bottom']
};
```

**Vimeo** (`extension/src/content/platforms/vimeo/vimeo-selectors.js`):
```javascript
export const VimeoSelectors = {
  VIDEO: 'video',
  PROGRESS_BAR: ['[data-progress-bar="true"]', '.vp-progress', ...],
  PLAYER_CONTAINER: ['[data-player-container]', '.vp-video-wrapper'],
  CONTROLS: ['[data-control-bar="true"]', '.vp-controls']
};
```

### Extending Adapters for Comment Posting

To reuse these adapters for browser automation, extend them with **comment-related selectors**:

**Example: YouTube Comment Selectors** (add to `youtube-selectors.js`):

```javascript
export const YouTubeSelectors = {
  // ... existing VIDEO, PROGRESS_BAR, etc.

  // Comment posting selectors
  COMMENTS: {
    // Comment box activation
    COMMENT_PLACEHOLDER: [
      '#placeholder-area',           // Primary
      '#simplebox-placeholder',      // Fallback
      '[aria-label*="Comment" i]'    // Semantic fallback
    ],

    // Text input (after clicking placeholder)
    TEXT_INPUT: [
      '#contenteditable-root',       // Primary
      '[contenteditable="true"]',    // Generic fallback
      'ytd-commentbox [role="textbox"]' // Semantic
    ],

    // Submit button
    SUBMIT: [
      '#submit-button',              // Primary
      'ytd-commentbox button[aria-label*="Comment" i]',
      '[aria-label*="Post" i]'       // Fallback
    ],

    // Login detection
    USER_AVATAR: [
      '#avatar-btn',                 // Primary - indicates logged in
      'ytd-topbar-menu-button-renderer button[aria-label*="Account" i]'
    ]
  }
};
```

**Example: Vimeo Comment Selectors** (add to `vimeo-selectors.js`):

```javascript
export const VimeoSelectors = {
  // ... existing VIDEO, PROGRESS_BAR, etc.

  COMMENTS: {
    COMMENT_PLACEHOLDER: [
      '[data-comment-box]',
      '[class*="CommentBox"]',
      'textarea[placeholder*="comment" i]'
    ],

    TEXT_INPUT: [
      'textarea[name="comment"]',
      '[data-comment-input]'
    ],

    SUBMIT: [
      '[data-comment-submit]',
      'button[type="submit"][class*="Comment"]'
    ],

    USER_AVATAR: [
      '.topnav_menu_user',           // Indicates logged in
      '[data-user-menu]'
    ]
  }
};
```

### Integration Pattern: Playwright Agent

Here's how the Playwright agent can use your adapters:

**Node.js Agent** (`priv/node/playwright_agent.js`):

```javascript
// Import selector patterns (shared as JSON or generated from JS)
const PLATFORM_SELECTORS = {
  youtube: {
    comments: {
      placeholder: ['#placeholder-area', '#simplebox-placeholder'],
      textInput: ['#contenteditable-root', '[contenteditable="true"]'],
      submit: ['#submit-button'],
      userAvatar: ['#avatar-btn']
    }
  },
  vimeo: {
    comments: {
      placeholder: ['[data-comment-box]', 'textarea[placeholder*="comment" i]'],
      textInput: ['textarea[name="comment"]'],
      submit: ['[data-comment-submit]'],
      userAvatar: ['.topnav_menu_user']
    }
  }
};

async function postComment(page, platform, videoUrl, timestamp, text, noteId) {
  const selectors = PLATFORM_SELECTORS[platform].comments;

  // 1. Navigate to video
  await page.goto(`${videoUrl}&t=${Math.floor(timestamp)}s`);
  sendStatus(noteId, 'navigating', 'Opened video');

  // 2. Scroll to comments (optional - platform-specific)
  if (platform === 'youtube') {
    await page.evaluate(() => window.scrollTo(0, 800));
  }

  // 3. Click comment placeholder (try each selector in order)
  for (const selector of selectors.placeholder) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      await page.click(selector);
      sendStatus(noteId, 'posting', 'Clicked comment box');
      break;
    } catch (e) {
      continue; // Try next selector
    }
  }

  // 4. Type comment text
  for (const selector of selectors.textInput) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      await page.fill(selector, text);
      sendStatus(noteId, 'posting', 'Entered comment text');
      break;
    } catch (e) {
      continue;
    }
  }

  // 5. Submit
  for (const selector of selectors.submit) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      await page.click(selector);
      sendStatus(noteId, 'posting', 'Submitted comment');
      break;
    } catch (e) {
      continue;
    }
  }

  await page.waitForTimeout(2000);
  return { status: 'posted', permalink: `${videoUrl}&t=${Math.floor(timestamp)}s` };
}

async function checkLogin(page, platform) {
  const selectors = PLATFORM_SELECTORS[platform].comments;

  // Navigate to platform homepage
  const urls = {
    youtube: 'https://www.youtube.com',
    vimeo: 'https://vimeo.com',
    air: 'https://air.inc'
  };

  await page.goto(urls[platform]);
  await page.waitForLoadState('networkidle');

  // Check for user avatar (indicates logged in)
  for (const selector of selectors.userAvatar) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      return { status: 'logged_in' };
    } catch (e) {
      continue;
    }
  }

  return { status: 'not_logged_in' };
}
```

### Sharing Selectors Between Extension & Agent

Since your selectors are defined in JavaScript, you have a few options:

**Option 1: Generate JSON from JS** (Recommended)

```bash
# Build script that exports selectors as JSON
cd extension/src/content/platforms
node -e "
  import('./youtube/youtube-selectors.js').then(m => {
    console.log(JSON.stringify(m.YouTubeSelectors, null, 2));
  });
" > ../../../../lossy/priv/node/selectors/youtube.json
```

**Option 2: Duplicate Selectors** (Simpler, but manual sync)

Just copy the selectors to `priv/node/selectors/youtube.js` and keep them in sync.

**Option 3: Import from Extension** (Advanced)

Use symlinks or a build step to share the exact same files.

### When NOT to Use Adapters

**Gemini Computer Use** operates purely on visual screenshots, so it doesn't need selectors:

```elixir
# Gemini agent - no selectors needed!
defp agent_loop(state) do
  screenshot = capture_screenshot(state.page)

  {:ok, response} = Gemini.chat(
    model: "gemini-2.5-computer-use-preview-10-2025",
    messages: [
      %{role: "user", content: "Post this comment: '#{state.text}' at timestamp #{state.timestamp}"},
      %{role: "user", content: [%{type: "image", data: screenshot}]}
    ]
  )

  # Gemini figures out where to click based on the screenshot
  # No selectors required!
end
```

### Recommended Hybrid Approach

**Use adapters for platforms you know** (fast, reliable):

```javascript
// Playwright agent checks if selectors exist for platform
const PLATFORMS_WITH_ADAPTERS = ['youtube', 'vimeo', 'air'];

async function postNote({ platform, videoUrl, timestamp, text, noteId }) {
  if (PLATFORMS_WITH_ADAPTERS.includes(platform)) {
    // Use fast selector-based approach
    return await postCommentWithSelectors(platform, videoUrl, timestamp, text, noteId);
  } else {
    // Fall back to Gemini for unknown platforms
    return await postCommentWithGemini(videoUrl, timestamp, text, noteId);
  }
}
```

**Benefits**:
- **YouTube/Vimeo**: ~2-3 seconds (Playwright with your adapters)
- **Unknown platforms**: ~10-15 seconds (Gemini figures it out visually)
- **Best of both worlds**: Fast when possible, flexible when needed

### Summary: Adapter Integration Checklist

- [ ] Extend existing selector files with COMMENTS object
- [ ] Export selectors as JSON or duplicate to Node.js agent
- [ ] Update Playwright agent to use selector arrays (try each in order)
- [ ] Add fallback to Gemini for platforms without adapter selectors
- [ ] Test selector fallbacks (primary → semantic → generic)

**Key Insight**: Your adapters are **immediately useful** for the Playwright approach. They provide battle-tested, stable selectors that will make the agent faster and more reliable than starting from scratch!

---

## 🔧 Implementation Approaches

### Option 1: Gemini 2.5 Computer Use API (Recommended)

**Why Gemini:**
- Vision-based navigation (screenshot → action)
- Resilient to platform UI changes
- Natural language instructions
- Built-in safety confirmations

**Agent Loop Pattern:**

```elixir
defmodule Lossy.Automation.GeminiAgent do
  @moduledoc """
  Local browser agent powered by Gemini 2.5 Computer Use API.
  Controls a dedicated Chrome profile via CDP + screenshots.
  """

  # 1. Send request with screenshot + goal
  defp agent_loop(state) do
    screenshot = capture_screenshot(state.page)

    {:ok, response} = Gemini.chat(
      model: "gemini-2.5-computer-use-preview-10-2025",
      tools: [computer_use_tool()],
      messages: [
        %{role: "user", content: state.goal},
        %{role: "user", content: [%{type: "image", data: screenshot}]}
      ]
    )

    # 2. Get function call response
    case response.function_call do
      %{name: "click_at", args: %{x: x, y: y}} ->
        # 3. Execute action
        {:ok, _} = CDP.click(state.page, denormalize_coords(x, y))

        # 4. Capture new screenshot and repeat
        broadcast_status("Clicked login button")
        agent_loop(state)

      %{name: "type_text_at", args: %{x: x, y: y, text: text}} ->
        CDP.click(state.page, denormalize_coords(x, y))
        CDP.type(state.page, text)
        broadcast_status("Entered comment text")
        agent_loop(state)

      %{name: "done"} ->
        broadcast_status("✅ Posted")
        {:ok, :completed}

      %{name: "error", args: %{reason: reason}} ->
        broadcast_status("⚠️ #{reason} → Summon")
        {:error, :needs_user_intervention}
    end
  end

  defp computer_use_tool do
    %{
      type: "computer_use",
      environment: "ENVIRONMENT_BROWSER",
      excluded_predefined_functions: []
    }
  end

  defp denormalize_coords(norm_x, norm_y) do
    # Gemini uses 1000x1000 normalized grid
    {
      Integer.floor(norm_x / 1000 * @viewport_width),
      Integer.floor(norm_y / 1000 * @viewport_height)
    }
  end
end
```

**Status Broadcasting Pattern:**

```elixir
defp broadcast_status(message) do
  Phoenix.PubSub.broadcast(
    Lossy.PubSub,
    "note:#{note_id}",
    {:agent_status, message}
  )
end
```

**Safety Decisions:**

Gemini returns `safety_decision` field for actions requiring confirmation:
- `regular` → Execute immediately
- `requires_confirmation` → Prompt user in side panel before proceeding

---

### Option 2: Playwright + CDP (Traditional Selectors)

**Why Playwright:**
- Proven reliability
- Platform-specific selectors
- Faster execution (no LLM roundtrip)
- Easier debugging

**Implementation (Elixir Port or Node.js):**

```elixir
defmodule Lossy.Automation.PlaywrightAgent do
  use GenServer

  @node_script Application.app_dir(:lossy, "priv/node/playwright_agent.js")

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    port = Port.open(
      {:spawn_executable, System.find_executable("node")},
      [:binary, :exit_status, args: [@node_script], packet: 4]
    )

    {:ok, %{port: port, pending: %{}}}
  end

  def post_note(note_id, platform, video_url, timestamp, text) do
    GenServer.call(__MODULE__, {:post_note, note_id, platform, video_url, timestamp, text}, 60_000)
  end

  def handle_call({:post_note, note_id, platform, video_url, timestamp, text}, from, state) do
    request = %{
      id: generate_id(),
      command: "post_note",
      args: %{
        note_id: note_id,
        profile_dir: profile_path(),
        platform: platform,
        video_url: video_url,
        timestamp: timestamp,
        text: text
      }
    }

    send_request(state.port, request)
    {:noreply, put_in(state.pending[request.id], from)}
  end

  def handle_info({_port, {:data, data}}, state) do
    response = Jason.decode!(data)

    case Map.pop(state.pending, response["id"]) do
      {from, pending} when not is_nil(from) ->
        GenServer.reply(from, parse_result(response["result"]))
        {:noreply, %{state | pending: pending}}

      _ ->
        {:noreply, state}
    end
  end

  defp parse_result(%{"status" => "posted", "permalink" => permalink}), do: {:ok, %{permalink: permalink}}
  defp parse_result(%{"status" => "needs_mfa"}), do: {:error, :needs_user_intervention}
  defp parse_result(%{"status" => "error", "error" => error}), do: {:error, error}

  defp profile_path do
    Path.expand("~/.config/lossy/agent-profile")
  end
end
```

**Node.js Agent Script** (`priv/node/playwright_agent.js`):

```javascript
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE_DIR = path.join(os.homedir(), '.config', 'lossy', 'agent-profile');

// Platform-specific posting logic
const PLATFORMS = {
  youtube: {
    async postComment(page, videoUrl, timestamp, text) {
      await page.goto(`${videoUrl}&t=${Math.floor(timestamp)}s`);

      // Scroll to comments
      await page.evaluate(() => window.scrollTo(0, 800));

      // Click comment box
      await page.click('#placeholder-area');
      await page.fill('#contenteditable-root', text);
      await page.click('#submit-button');

      await page.waitForTimeout(2000);

      return {
        status: 'posted',
        permalink: `${videoUrl}&t=${Math.floor(timestamp)}s`
      };
    }
  },

  vimeo: {
    // ... Vimeo-specific logic
  },

  air: {
    // ... Air-specific logic
  }
};

async function postNote({ note_id, profile_dir, platform, video_url, timestamp, text }) {
  const browser = await chromium.launchPersistentContext(profile_dir, {
    headless: false,  // Visible window prevents throttling
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps'
    ],
    viewport: { width: 1440, height: 900 }
  });

  try {
    const page = browser.pages()[0] || await browser.newPage();

    // Check if logged in
    const platformConfig = PLATFORMS[platform];
    const result = await platformConfig.postComment(page, video_url, timestamp, text);

    await browser.close();
    return result;

  } catch (error) {
    await browser.close();

    if (error.message.includes('login required')) {
      return { status: 'needs_mfa' };
    }

    return { status: 'error', error: error.message };
  }
}

// Port communication loop (packet:4 protocol)
let buffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);

    if (buffer.length < 4 + length) {
      break;
    }

    const message = buffer.slice(4, 4 + length);
    buffer = buffer.slice(4 + length);

    try {
      const request = JSON.parse(message.toString());
      const { id, command, args } = request;

      let result;

      if (command === 'post_note') {
        result = await postNote(args);
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
```

---

### Option 3: Hybrid Approach (Recommended for Production)

**Best of Both Worlds:**

1. **Use Playwright for known platforms with stable selectors** (fast, reliable)
2. **Fall back to Gemini for:**
   - New platforms without selector mappings
   - Handling unexpected UI changes
   - Complex interactions (file uploads, multi-step flows)

```elixir
defmodule Lossy.Automation.HybridAgent do
  def post_note(note_id, platform, video_url, timestamp, text) do
    case platform do
      p when p in ["youtube", "vimeo"] ->
        # Known platform, use Playwright
        PlaywrightAgent.post_note(note_id, platform, video_url, timestamp, text)

      "air" ->
        # Complex UI, use Gemini
        GeminiAgent.post_note(note_id, platform, video_url, timestamp, text)

      _ ->
        # Unknown platform, try Gemini
        GeminiAgent.post_note(note_id, platform, video_url, timestamp, text)
    end
  end
end
```

---

## 📊 Status Update Patterns

### Side Panel Note Card States

Display real-time agent progress on each note card:

```html
<!-- Side Panel LiveView Template -->
<div class="note-card" id={"note-#{@note.id}"}>
  <div class="note-header">
    <span class="timestamp"><%= format_timestamp(@note.timestamp_seconds) %></span>
    <span class={"status-badge status-#{@note.status}"}>
      <%= status_icon(@note.status) %> <%= status_text(@note.status) %>
    </span>
  </div>

  <div class="note-text"><%= @note.text %></div>

  <%= if @note.agent_status do %>
    <div class="agent-progress">
      <div class="progress-steps">
        <%= for step <- @note.agent_status.steps do %>
          <div class={"step step-#{step.status}"}>
            <%= step_icon(step.status) %> <%= step.message %>
          </div>
        <% end %>
      </div>

      <%= if @note.agent_status.needs_intervention do %>
        <button phx-click="summon_agent" phx-value-note-id={@note.id} class="summon-btn">
          🪄 Summon Agent Window
        </button>
      <% end %>
    </div>
  <% end %>
</div>
```

**Status Badge Examples:**

| Status | Icon | Message |
|--------|------|---------|
| `queued` | ⏳ | Queued for posting |
| `starting` | 🚀 | Launching browser agent |
| `authenticating` | 🔒 | Logging in to YouTube |
| `authenticated` | ✓ | Logged in |
| `navigating` | 🧭 | Opening video |
| `posting` | 📤 | Posting comment (step 3/7) |
| `needs_mfa` | ⚠️ | Blocked by MFA → Summon |
| `needs_login` | ⚠️ | Login required → Summon |
| `posted` | ✅ | Posted successfully |
| `failed` | ❌ | Failed: Selector not found |

### PubSub Broadcasting

```elixir
# Broadcast from agent GenServer
defp update_status(note_id, status, message, step_number \\ nil) do
  Phoenix.PubSub.broadcast(
    Lossy.PubSub,
    "note:#{note_id}",
    {:agent_status, %{
      status: status,
      message: message,
      step: step_number,
      total_steps: 7,
      timestamp: DateTime.utc_now()
    }}
  )
end

# Example usage in agent
update_status(note_id, :authenticating, "Logging in to YouTube")
update_status(note_id, :posting, "Posting comment", 3)
update_status(note_id, :needs_mfa, "MFA verification required")
```

### LiveView Handling

```elixir
defmodule LossyWeb.NotesLive do
  def mount(_params, _session, socket) do
    # Subscribe to all notes for this video
    Phoenix.PubSub.subscribe(Lossy.PubSub, "video:#{socket.assigns.video_id}")

    {:ok, socket}
  end

  def handle_info({:agent_status, %{note_id: note_id} = status}, socket) do
    # Update note's agent_status field
    {:noreply,
     socket
     |> update_note_status(note_id, status)
     |> maybe_show_summon_notification(status)}
  end

  defp update_note_status(socket, note_id, status) do
    stream_insert(socket, :notes, %{
      id: note_id,
      agent_status: status
    }, at: -1)
  end

  defp maybe_show_summon_notification(socket, %{status: :needs_mfa}) do
    push_event(socket, "show_notification", %{
      type: "warning",
      message: "Agent needs your help - click Summon to complete MFA"
    })
  end
  defp maybe_show_summon_notification(socket, _), do: socket
end
```

---

## 🪄 User Intervention Flow

### "Summon Agent" Feature

When agent encounters MFA or login issues:

1. **Agent detects blockage:**
   ```elixir
   {:error, :needs_user_intervention}
   ```

2. **Broadcast to side panel:**
   ```elixir
   update_status(note_id, :needs_mfa, "MFA verification required")
   ```

3. **Side panel shows "Summon" button:**
   ```html
   <button phx-click="summon_agent" phx-value-note-id={@note.id}>
     🪄 Summon Agent Window
   </button>
   ```

4. **User clicks Summon → Agent window comes to foreground:**
   ```elixir
   def handle_event("summon_agent", %{"note-id" => note_id}, socket) do
     # Send message to agent to bring window to front
     Lossy.Automation.LocalAgent.summon_window(note_id)

     {:noreply,
      socket
      |> put_flash(:info, "Agent window opened - complete MFA and agent will resume")
     }
   end
   ```

5. **Agent pauses, waits for user to handle MFA**

6. **Agent detects MFA completion (e.g., URL change), resumes automatically**

7. **Status updates to "✓ Authenticated" → continues posting**

---

## 🔐 Profile Management

### Dedicated Agent Profile

**Why Separate Profile:**
- Keeps agent cookies isolated from user's main browser
- Prevents conflicting sessions
- Easier to reset/clear if needed
- Security isolation

**Profile Location:**
```
~/.config/lossy/agent-profile/
├── Cookies
├── Local Storage/
├── Preferences
└── ...
```

**First-Time Setup Flow:**

```elixir
defmodule Lossy.Automation.ProfileSetup do
  def ensure_profile_exists do
    profile_dir = profile_path()

    unless File.exists?(profile_dir) do
      # Launch Chrome once to initialize profile
      {_output, 0} = System.cmd("google-chrome", [
        "--user-data-dir=#{profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank"
      ])

      # Wait for profile initialization
      Process.sleep(2000)
    end

    :ok
  end

  def open_setup_window(platform) do
    profile_dir = profile_path()

    # Open Chrome to platform's login page
    {_output, 0} = System.cmd("google-chrome", [
      "--user-data-dir=#{profile_dir}",
      "--new-window",
      platform_login_url(platform)
    ])

    {:ok, "Profile setup window opened - please log in"}
  end

  defp platform_login_url("youtube"), do: "https://accounts.google.com"
  defp platform_login_url("vimeo"), do: "https://vimeo.com/log_in"
  defp platform_login_url("air"), do: "https://air.inc/login"

  defp profile_path do
    Path.expand("~/.config/lossy/agent-profile")
  end
end
```

### Settings UI for Profile Management

```heex
<!-- Settings LiveView -->
<div class="agent-profile-settings">
  <h2>Computer Use Agent</h2>

  <div class="platform-connections">
    <%= for platform <- ["youtube", "vimeo", "air"] do %>
      <div class="platform-card">
        <h3><%= String.capitalize(platform) %></h3>

        <%= if platform_connected?(platform) do %>
          <span class="status">✓ Connected</span>
          <button phx-click="test_connection" phx-value-platform={platform}>
            Test Connection
          </button>
          <button phx-click="logout_platform" phx-value-platform={platform}>
            Log Out
          </button>
        <% else %>
          <span class="status">Not connected</span>
          <button phx-click="setup_platform" phx-value-platform={platform}>
            Set Up <%= String.capitalize(platform) %>
          </button>
        <% end %>
      </div>
    <% end %>
  </div>

  <div class="profile-management">
    <button phx-click="open_profile_folder" class="secondary">
      📁 Open Profile Folder
    </button>
    <button phx-click="reset_profile" class="danger" data-confirm="This will log you out of all platforms. Continue?">
      🗑️ Reset Agent Profile
    </button>
  </div>
</div>
```

---

## 🔄 Fallback to Browserbase

### When to Use Browserbase

Browserbase becomes useful for:

1. **User machine offline/unavailable**
2. **Long-running multi-note batch posting** (user can close browser)
3. **Local agent failed repeatedly** (3+ attempts)
4. **User explicitly prefers cloud** (settings toggle)

### Fallback Logic

```elixir
defmodule Lossy.Automation.ComputerUseCoordinator do
  def post_note(note) do
    cond do
      should_use_browserbase?(note) ->
        BrowserbaseAgent.post_note(note)

      true ->
        case LocalAgent.post_note(note) do
          {:ok, result} ->
            {:ok, result}

          {:error, :machine_offline} ->
            # Fallback to Browserbase
            BrowserbaseAgent.post_note(note)

          {:error, :needs_user_intervention} ->
            # Don't fallback - user needs to handle locally
            {:error, :needs_user_intervention}

          {:error, reason} when note.retry_count >= 3 ->
            # Failed 3x locally, try Browserbase
            BrowserbaseAgent.post_note(note)

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp should_use_browserbase?(note) do
    # Check user preference
    user = Lossy.Accounts.get_user!(note.user_id)
    user.prefer_browserbase_posting == true
  end
end
```

---

## 📚 Reference Implementation Examples

### 1. Gemini Computer Use Setup (Python Reference)

```python
# Reference from Google's official examples
import google.generativeai as genai
from playwright.sync_api import sync_playwright

model = genai.GenerativeModel(
    model_name="gemini-2.5-computer-use-preview-10-2025",
    tools=[{
        "computer_use": {
            "environment": "ENVIRONMENT_BROWSER"
        }
    }]
)

def agent_loop(page, goal):
    screenshot = page.screenshot(type="png")

    response = model.generate_content([
        goal,
        {"mime_type": "image/png", "data": screenshot}
    ])

    for part in response.parts:
        if part.function_call:
            func = part.function_call

            if func.name == "click_at":
                x = denormalize_x(func.args["x"], page.viewport_size["width"])
                y = denormalize_y(func.args["y"], page.viewport_size["height"])
                page.mouse.click(x, y)

            elif func.name == "type_text_at":
                # ... handle typing
                pass

            # Recurse with new screenshot
            return agent_loop(page, goal)

    return "Done"
```

### 2. Playwright Persistent Context (from playwright-skill)

```javascript
// Reference from playwright-skill
const { chromium } = require('playwright');

const browser = await chromium.launchPersistentContext(
  '/path/to/profile',
  {
    headless: false,
    slowMo: 100,  // Visible slow motion for debugging
    args: [
      '--no-first-run',
      '--no-default-browser-check'
    ]
  }
);

const page = browser.pages()[0] || await browser.newPage();
```

### 3. Chrome DevTools MCP Pattern

```javascript
// Reference from Chrome DevTools MCP
import { MCP } from '@modelcontextprotocol/sdk';

const mcp = new MCP({
  server: 'chrome-devtools',
  options: {
    userDataDir: '/path/to/profile',
    headless: false
  }
});

// Agent can now control browser via natural language
await mcp.chat("Navigate to YouTube and post this comment: 'Great video!'");
```

---

## 🧪 Testing Strategy

### Local Development

```bash
# 1. Ensure profile exists
cd lossy
iex -S mix phx.server
```

```elixir
# 2. In IEx:
Lossy.Automation.ProfileSetup.ensure_profile_exists()
Lossy.Automation.ProfileSetup.open_setup_window("youtube")
# -> Chrome window opens to YouTube login
# -> Manually log in
# -> Close window

# 3. Test posting
{:ok, note} = Lossy.Videos.get_note(1)
Lossy.Automation.LocalAgent.post_note(note.id, "youtube", note.video.url, note.timestamp_seconds, note.text)
# -> Chrome window opens, navigates, posts comment
# -> Watch in real-time!
```

### Unit Tests

```elixir
# test/lossy/automation/local_agent_test.exs
defmodule Lossy.Automation.LocalAgentTest do
  use Lossy.DataCase, async: false

  @tag :integration
  test "posts note to YouTube via local agent" do
    note = insert(:note, %{
      text: "Test note",
      timestamp_seconds: 45.2,
      video: insert(:video, %{
        platform: "youtube",
        url: "https://www.youtube.com/watch?v=TEST_VIDEO"
      })
    })

    assert {:ok, %{permalink: permalink}} = LocalAgent.post_note(
      note.id,
      "youtube",
      note.video.url,
      note.timestamp_seconds,
      note.text
    )

    assert permalink =~ "youtube.com"
  end

  test "returns :needs_user_intervention when MFA detected" do
    # Mock MFA scenario
    # ...
  end
end
```

---

## 🚀 Production Checklist

- [ ] **Profile setup flow** - Settings UI to connect platforms
- [ ] **Status broadcasting** - Real-time updates to side panel
- [ ] **Summon window feature** - Bring agent to foreground on MFA
- [ ] **Persistent profile** - Cookies/auth persist across sessions
- [ ] **Graceful degradation** - Fallback to Browserbase if local fails
- [ ] **Error taxonomy** - Clear categorization (needs_mfa, selector_failed, etc.)
- [ ] **Retry logic** - Exponential backoff in Oban
- [ ] **Telemetry** - Track success rates, latency per platform
- [ ] **User preferences** - Toggle local vs. Browserbase
- [ ] **Documentation** - User-facing guide for profile setup

---

## 📖 Additional References

- **Gemini Computer Use API**: https://ai.google.dev/gemini-api/docs/computer-use
- **Playwright Persistent Contexts**: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- **playwright-skill (Claude Code)**: https://github.com/lackeyjb/playwright-skill
- **Chrome DevTools MCP**: https://developer.chrome.com/blog/devtools-mcp
- **Chrome DevTools Protocol (CDP)**: https://chromedevtools.github.io/devtools-protocol/

---

## 🎯 Summary

**Recommended Stack:**

1. **Primary**: Local Chrome agent with dedicated profile
   - **Driver**: Playwright for known platforms (fast, reliable)
   - **AI fallback**: Gemini 2.5 Computer Use for complex/unknown UIs
   - **User visibility**: Visible window + side panel status updates
   - **Intervention**: "Summon" button brings agent window to foreground

2. **Fallback**: Browserbase (optional)
   - Only when user machine offline or explicit preference
   - See `docs/advanced/BROWSERBASE_FALLBACK.md` for details

**Key Principles:**

- **User in control**: Can always intervene via Summon
- **Observable**: Real-time status on each note card
- **Resilient**: Fallback to Browserbase if local fails
- **Simple**: No complex auth management, uses existing browser sessions
- **Fast**: No remote viewport latency

This approach gives you the best of both worlds: **speed and simplicity of local automation** with **reliability and background operation of cloud fallback**.
