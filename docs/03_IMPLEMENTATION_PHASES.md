# Implementation Phases

**Last Updated:** 2025-10-14
**Estimated Timeline:** 6-8 weeks to MVP

---

## Overview

This document breaks down implementation into **5 phases**, each delivering working functionality that builds on the previous phase. Each phase is approximately 1-2 weeks.

**Philosophy:**
- ✅ Working software at end of each phase
- ✅ Can demo/test at each milestone
- ✅ Vertical slices (full stack per feature)
- ✅ Infrastructure decisions locked early

---

## Phase 0: Project Scaffolding (Week 1)

**Goal:** Get all project foundations in place, nothing functional yet but clean structure.

### Backend Setup

```bash
cd /Users/billy/Dropbox/Projects/lossy/code
mix phx.new lossy --no-html --no-assets --binary-id
cd lossy
```

**mix.exs dependencies:**
```elixir
defp deps do
  [
    # Phoenix core
    {:phoenix, "~> 1.7.14"},
    {:phoenix_pubsub, "~> 2.1"},
    {:phoenix_live_view, "~> 0.20"},
    {:phoenix_live_dashboard, "~> 0.8"},

    # Database
    {:ecto_sql, "~> 3.11"},
    {:postgrex, ">= 0.0.0"},

    # Auth
    {:guardian, "~> 2.3"},
    {:bcrypt_elixir, "~> 3.0"},

    # Background jobs
    {:oban, "~> 2.17"},

    # HTTP client
    {:req, "~> 0.4"},

    # JSON
    {:jason, "~> 1.4"},

    # CORS
    {:cors_plug, "~> 3.0"},

    # Optional: Rustler for native code
    # {:rustler, "~> 0.32", runtime: false},
  ]
end
```

**Run migrations:**
```bash
mix ecto.create
mix ecto.migrate
```

**Test server:**
```bash
mix phx.server
# Visit http://localhost:4000
```

### Database Schema

Create initial migration:

```bash
mix ecto.gen.migration create_initial_schema
```

**Edit `priv/repo/migrations/*_create_initial_schema.exs`:**

```elixir
defmodule Lossy.Repo.Migrations.CreateInitialSchema do
  use Ecto.Migration

  def change do
    # Users table
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :email, :string, null: false
      add :password_hash, :string, null: false
      add :name, :string
      timestamps()
    end

    create unique_index(:users, [:email])

    # Videos table
    create table(:videos, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :platform, :string, null: false  # "youtube", "vimeo", "air"
      add :external_id, :string, null: false  # Platform's video ID
      add :url, :text, null: false
      add :title, :string
      add :duration_seconds, :float
      add :thumbnail_url, :text
      timestamps()
    end

    create index(:videos, [:user_id])
    create unique_index(:videos, [:platform, :external_id])

    # Notes table
    create table(:notes, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :video_id, references(:videos, type: :binary_id, on_delete: :delete_all), null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :text, :text, null: false
      add :raw_transcript, :text  # Original transcript before LLM structuring
      add :timestamp_seconds, :float, null: false
      add :category, :string  # pacing, audio, color, graphics, content, other
      add :confidence, :float  # 0.0-1.0 from LLM
      add :status, :string, null: false, default: "ghost"  # ghost, firmed, pending_post, posting, posted, failed, cancelled
      add :posted_at, :utc_datetime
      add :platform_comment_id, :string  # External platform's comment ID
      add :external_permalink, :text  # Link to posted comment
      add :error, :text  # Error message if posting failed
      timestamps()
    end

    create index(:notes, [:video_id, :timestamp_seconds])
    create index(:notes, [:user_id, :status])
    create index(:notes, [:user_id, :inserted_at])

    # Platform connections table (for Browserbase sessions)
    create table(:platform_connections, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :platform, :string, null: false  # "youtube", "vimeo", "air"
      add :browserbase_session_id, :string
      add :status, :string, null: false, default: "awaiting_auth"  # awaiting_auth, active, expired, logged_out, failed
      add :verified_at, :utc_datetime
      add :last_used_at, :utc_datetime
      timestamps()
    end

    create index(:platform_connections, [:user_id, :platform])
    create unique_index(:platform_connections, [:user_id, :platform])

    # Agent sessions table (for recovery/persistence)
    create table(:agent_sessions, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :video_id, references(:videos, type: :binary_id, on_delete: :nilify_all)
      add :status, :string, null: false, default: "idle"  # idle, listening, paused, transcribing, etc.
      add :audio_buffer_size, :integer, default: 0
      add :audio_duration_seconds, :float, default: 0.0
      add :last_activity_at, :utc_datetime
      add :metadata, :map, default: %{}  # JSON blob for additional state
      timestamps()
    end

    create index(:agent_sessions, [:user_id])
    create index(:agent_sessions, [:status, :last_activity_at])

    # Audio chunks table (temporary storage before processing)
    create table(:audio_chunks, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :agent_session_id, references(:agent_sessions, type: :binary_id, on_delete: :delete_all), null: false
      add :sequence, :integer, null: false
      add :audio_data, :binary  # Raw audio bytes
      add :processed, :boolean, default: false
      timestamps()
    end

    create index(:audio_chunks, [:agent_session_id, :sequence])
    create index(:audio_chunks, [:processed])

    # Video frames table (for CLIP embeddings, future)
    create table(:video_frames, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :video_id, references(:videos, type: :binary_id, on_delete: :delete_all), null: false
      add :timestamp_seconds, :float, null: false
      add :frame_data, :binary  # WebP encoded frame
      add :embedding, :vector, dimensions: 512  # CLIP embedding (requires pgvector extension)
      add :perceptual_hash, :string  # For duplicate detection
      timestamps()
    end

    create index(:video_frames, [:video_id, :timestamp_seconds])
  end
end
```

**Run migration:**
```bash
mix ecto.migrate
```

**Note**: The `video_frames` table uses pgvector for embeddings. Install extension first:
```sql
-- In PostgreSQL:
CREATE EXTENSION IF NOT EXISTS vector;
```

Or add to migration:
```elixir
def up do
  execute "CREATE EXTENSION IF NOT EXISTS vector"
  # ... rest of migration
end
```

### Extension Scaffolding

```bash
cd /Users/billy/Dropbox/Projects/lossy/code
mkdir -p extension/{src/{background,content,sidepanel,popup,shared,offscreen},public/{icons,models}}
cd extension
npm init -y
```

**package.json:**
```json
{
  "name": "voice-video-companion",
  "version": "0.1.0",
  "scripts": {
    "dev": "webpack --mode development --watch",
    "build": "webpack --mode production"
  },
  "dependencies": {
    "phoenix": "^1.7.0",
    "phoenix_live_view": "^0.20.0"
  },
  "devDependencies": {
    "webpack": "^5.90.0",
    "webpack-cli": "^5.1.4",
    "babel-loader": "^9.1.3",
    "@babel/core": "^7.24.0",
    "@babel/preset-env": "^7.24.0",
    "copy-webpack-plugin": "^12.0.0"
  }
}
```

**webpack.config.js:**
```javascript
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'background/service-worker': './src/background/service-worker.js',
    'sidepanel/sidepanel': './src/sidepanel/sidepanel.js',
    'popup/popup': './src/popup/popup.js',
    'content/content': './src/content/content.js',
    'offscreen/offscreen': './src/offscreen/offscreen.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: 'babel-loader',
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'public', to: '' },
        { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel.html' },
        { from: 'src/popup/popup.html', to: 'popup.html' },
        { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
      ],
    }),
  ],
};
```

**manifest.json:**
```json
{
  "manifest_version": 3,
  "name": "Voice Video Companion",
  "version": "0.1.0",
  "description": "Voice-first video review",

  "permissions": ["sidePanel", "storage", "tabs", "offscreen"],

  "host_permissions": [
    "https://*.youtube.com/*",
    "https://*.vimeo.com/*",
    "https://*.air.inc/*",
    "wss://localhost:4000/*"
  ],

  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' https://localhost:4000 wss://localhost:4000"
  },

  "side_panel": {
    "default_path": "sidepanel.html"
  },

  "action": {
    "default_popup": "popup.html"
  },

  "background": {
    "service_worker": "background/service-worker.js"
  },

  "content_scripts": [
    {
      "matches": ["https://*.youtube.com/*", "https://*.vimeo.com/*", "https://*.air.inc/*"],
      "js": ["content/content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

### Git Setup

```bash
cd /Users/billy/Dropbox/Projects/lossy/code
git init
echo "node_modules/\n.DS_Store\n*.log\n_build/\ndeps/\n.env" > .gitignore
git add .
git commit -m "Initial project scaffolding"
```

**Deliverables:**
- ✅ Backend server runs on :4000
- ✅ Database schema created
- ✅ Extension builds with webpack
- ✅ Can load extension in Chrome (shows blank popup)

---

## Phase 1: Auth + Basic LiveView Connection (Week 2)

**Goal:** Extension can authenticate and connect to Phoenix LiveView.

### Backend: Authentication

**lib/lossy/accounts/user.ex** - User model with token generation

**lib/lossy_web/controllers/auth_controller.ex:**
```elixir
defmodule LossyWeb.AuthController do
  use LossyWeb, :controller

  def login(conn, %{"email" => email, "password" => password}) do
    case Lossy.Accounts.authenticate_user(email, password) do
      {:ok, user} ->
        token = Phoenix.Token.sign(
          LossyWeb.Endpoint,
          "user socket",
          user.id,
          max_age: 30 * 24 * 60 * 60  # 30 days
        )

        json(conn, %{token: token, user: user})

      {:error, _reason} ->
        conn
        |> put_status(:unauthorized)
        |> json(%{error: "Invalid credentials"})
    end
  end
end
```

**lib/lossy_web/router.ex:**
```elixir
scope "/api", LossyWeb do
  pipe_through :api

  post "/auth/login", AuthController, :login
  post "/auth/register", AuthController, :register
end
```

### Backend: LiveView Socket

**lib/lossy_web/user_socket.ex:**
```elixir
defmodule LossyWeb.UserSocket do
  use Phoenix.Socket

  channel "audio:*", LossyWeb.AudioChannel

  def connect(%{"auth_token" => token}, socket, _connect_info) do
    case Phoenix.Token.verify(LossyWeb.Endpoint, "user socket", token) do
      {:ok, user_id} ->
        {:ok, assign(socket, :user_id, user_id)}
      {:error, _} ->
        :error
    end
  end

  def id(socket), do: "user:#{socket.assigns.user_id}"
end
```

**lib/lossy_web/live/side_panel_live.ex:**
```elixir
defmodule LossyWeb.SidePanelLive do
  use LossyWeb, :live_view

  def mount(_params, %{"auth_token" => token}, socket) do
    case verify_token(token) do
      {:ok, user_id} ->
        {:ok, assign(socket, :user_id, user_id, :connected, true)}
      {:error, _} ->
        {:ok, assign(socket, :error, "Authentication failed")}
    end
  end

  def render(assigns) do
    ~H"""
    <div class="side-panel">
      <h1>Voice Video Companion</h1>
      <%= if @connected do %>
        <p>Connected as User <%= @user_id %></p>
      <% else %>
        <p>Error: <%= @error %></p>
      <% end %>
    </div>
    """
  end

  defp verify_token(token) do
    Phoenix.Token.verify(LossyWeb.Endpoint, "user socket", token)
  end
end
```

**lib/lossy_web/router.ex:**
```elixir
scope "/extension", LossyWeb do
  pipe_through :browser  # Note: CSRF disabled for extensions

  live "/sidepanel", SidePanelLive
  live "/popup", PopupLive
end
```

**config/dev.exs:**
```elixir
config :lossy, LossyWeb.Endpoint,
  check_origin: [
    "http://localhost:4000",
    "chrome-extension://YOUR_DEV_EXTENSION_ID"  # Get from chrome://extensions
  ]
```

### Extension: Auth Flow

**src/popup/popup.html:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Login</title>
</head>
<body>
  <div id="login-form">
    <input type="email" id="email" placeholder="Email" />
    <input type="password" id="password" placeholder="Password" />
    <button id="login-btn">Login</button>
    <div id="status"></div>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

**src/popup/popup.js:**
```javascript
document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const response = await fetch('http://localhost:4000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (response.ok) {
      const { token, user } = await response.json();

      // Store token
      await chrome.storage.local.set({ authToken: token, user });

      document.getElementById('status').textContent = 'Login successful!';

      // Redirect to side panel
      setTimeout(() => {
        chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      }, 1000);
    } else {
      document.getElementById('status').textContent = 'Login failed';
    }
  } catch (error) {
    document.getElementById('status').textContent = 'Error: ' + error.message;
  }
});
```

### Extension: LiveView Side Panel

**src/sidepanel/sidepanel.html:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="Content-Security-Policy"
        content="script-src 'self'; connect-src 'self' wss://localhost:4000">
</head>
<body>
  <div id="live-root" data-phx-main="true"></div>
  <script src="sidepanel.js"></script>
</body>
</html>
```

**src/sidepanel/sidepanel.js:**
```javascript
import {Socket} from "phoenix";
import {LiveSocket} from "phoenix_live_view";

async function init() {
  const {authToken} = await chrome.storage.local.get('authToken');

  if (!authToken) {
    document.getElementById('live-root').innerHTML = '<p>Please log in first</p>';
    return;
  }

  const liveSocket = new LiveSocket("ws://localhost:4000/live", Socket, {
    params: { auth_token: authToken }
  });

  liveSocket.connect();
  window.liveSocket = liveSocket;
}

init();
```

### Testing Phase 1

1. Start backend: `mix phx.server`
2. Build extension: `cd extension && npm run build`
3. Load extension in Chrome
4. Create test user in IEx: `Lossy.Accounts.create_user(%{email: "test@test.com", password: "password123"})`
5. Click extension icon → popup → login
6. Click side panel icon → should show "Connected as User X"

**Deliverables:**
- ✅ User can log in via popup
- ✅ Token stored in chrome.storage
- ✅ Side panel connects to LiveView
- ✅ See "Connected" message in side panel

---

## Phase 2: Audio Capture + Phoenix Channels (Week 3)

**Goal:** Capture voice, stream to Phoenix, display raw transcript.

### Extension: Offscreen Audio Capture

**src/offscreen/offscreen.html:**
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
  <script src="offscreen.js"></script>
</body></html>
```

**src/offscreen/offscreen.js:**
```javascript
let mediaRecorder = null;
let audioContext = null;
let mediaStreamSource = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.cmd === 'start_audio') {
    startCapture();
  } else if (msg.cmd === 'stop_audio') {
    stopCapture();
  }
});

async function startCapture() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,  // Mono
      sampleRate: 16000,  // 16kHz for Whisper
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  // Option 1: WebM/Opus (most compatible with browsers)
  // OpenAI Whisper API accepts webm, but may need transcoding for local WASM
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: mimeType,
    audioBitsPerSecond: 16000
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      e.data.arrayBuffer().then(buffer => {
        chrome.runtime.sendMessage({
          cmd: 'audio_data',
          data: Array.from(new Uint8Array(buffer)),
          mimeType: mimeType,
          size: buffer.byteLength
        });
      });
    }
  };

  // 500ms chunks - balance between latency and efficiency
  mediaRecorder.start(500);

  // TODO Phase 6: Add VAD (Voice Activity Detection) here
  // Only send chunks when speech is detected to save bandwidth
}

function stopCapture() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    mediaRecorder = null;
  }
}

// TODO Phase 6: WASM Whisper Integration
// Uncomment when implementing local transcription:
/*
import { pipeline } from '@xenova/transformers';

let transcriber = null;

async function initTranscriber() {
  transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
}

async function transcribeLocally(audioBuffer) {
  if (!transcriber) await initTranscriber();
  const result = await transcriber(audioBuffer);
  return result.text;
}
*/
```

**Audio Format Notes:**
- **WebM/Opus**: Most browser support, OpenAI API compatible
- **For local WASM Whisper** (Phase 6): May need to transcode to WAV/PCM
- **Max buffer size**: Backend enforces 5MB / 60s limits (see 02_ARCHITECTURE.md)
- **Sample rate**: 16kHz is optimal for Whisper models

### Extension: Service Worker Audio Routing

**src/background/service-worker.js:**
```javascript
import {Socket} from "phoenix";

let audioSocket = null;
let audioChannel = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'toggle_mic') {
    toggleMic().then(sendResponse);
    return true;
  } else if (msg.cmd === 'audio_data') {
    if (audioChannel) {
      // Convert array back to Uint8Array
      const audioData = new Uint8Array(msg.data);
      audioChannel.push("audio", audioData.buffer);
    }
  }
});

async function toggleMic() {
  const {authToken, sessionId} = await chrome.storage.local.get(['authToken', 'sessionId']);

  if (!audioChannel) {
    // Connect to Phoenix
    audioSocket = new Socket("ws://localhost:4000/socket", {
      params: { token: authToken }
    });
    audioSocket.connect();

    audioChannel = audioSocket.channel(`audio:${sessionId || 'default'}`);
    await audioChannel.join()
      .receive("ok", () => console.log('Joined audio channel'))
      .receive("error", (err) => console.error('Join failed', err));

    // Create offscreen doc
    await createOffscreenDoc();

    // Start capture
    await chrome.runtime.sendMessage({ cmd: 'start_audio' });

    return { recording: true };
  } else {
    // Stop capture
    await chrome.runtime.sendMessage({ cmd: 'stop_audio' });
    audioChannel.leave();
    audioChannel = null;
    return { recording: false };
  }
}

async function createOffscreenDoc() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Audio capture for voice notes'
  });
}
```

### Backend: Audio Channel

**lib/lossy_web/channels/audio_channel.ex:**
```elixir
defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  def join("audio:" <> session_id, _payload, socket) do
    Logger.info("User #{socket.assigns.user_id} joined audio:#{session_id}")
    {:ok, assign(socket, :session_id, session_id)}
  end

  def handle_in("audio", {:binary, audio_data}, socket) do
    # For now, just log
    Logger.info("Received #{byte_size(audio_data)} bytes of audio")

    # In Phase 3, we'll add transcription
    # For now, echo back a fake transcript
    push(socket, "transcript", %{text: "Fake transcript of audio"})

    {:noreply, socket}
  end
end
```

### Extension: Display Transcript in Side Panel

**Update SidePanelLive:**
```elixir
def mount(_params, %{"auth_token" => token}, socket) do
  case verify_token(token) do
    {:ok, user_id} ->
      # Generate session ID
      session_id = Ecto.UUID.generate()

      {:ok,
       socket
       |> assign(:user_id, user_id)
       |> assign(:session_id, session_id)
       |> assign(:recording, false)
       |> stream(:transcripts, [])}

    {:error, _} ->
      {:ok, assign(socket, :error, "Authentication failed")}
  end
end

def handle_event("toggle_mic", _params, socket) do
  # Toggle recording state (actual work done by service worker)
  {:noreply, update(socket, :recording, &(!&1))}
end

def render(assigns) do
  ~H"""
  <div class="side-panel">
    <header>
      <h1>Voice Notes</h1>
      <button phx-click="toggle_mic" phx-hook="MicControl">
        <%= if @recording, do: "⏹️ Stop", else: "🎤 Record" %>
      </button>
    </header>

    <main>
      <div id="transcripts" phx-update="stream">
        <p :for={{id, t} <- @streams.transcripts} id={id}>
          <%= t.text %>
        </p>
      </div>
    </main>
  </div>
  """
end
```

**src/sidepanel/sidepanel.js - Add JS hook:**
```javascript
const Hooks = {
  MicControl: {
    mounted() {
      this.el.addEventListener('click', () => {
        // Tell service worker to toggle mic
        chrome.runtime.sendMessage({ cmd: 'toggle_mic' }, (response) => {
          console.log('Mic toggled:', response);
        });
      });
    }
  }
};

const liveSocket = new LiveSocket("ws://localhost:4000/live", Socket, {
  params: { auth_token: authToken },
  hooks: Hooks
});
```

### Testing Phase 2

1. Click mic button in side panel
2. Grant microphone permission
3. Speak: "This is a test"
4. Should see "Fake transcript of audio" appear in side panel

**Deliverables:**
- ✅ Mic captures audio in offscreen document
- ✅ Audio streams to backend via WebSocket (binary)
- ✅ Backend receives audio and sends back fake transcript
- ✅ Transcript appears in side panel

---

## Phase 3: Real STT + Note Structuring (Week 4)

**Goal:** Transcribe audio with OpenAI Whisper API, structure with GPT-4o-mini.

### Backend: Inference Module

**lib/lossy/inference/cloud.ex:**
```elixir
defmodule Lossy.Inference.Cloud do
  require Logger

  @valid_categories ~w(pacing audio color graphics content other)

  def transcribe(audio_binary) do
    api_key = Application.get_env(:lossy, :openai_api_key)

    multipart = [
      {"file", audio_binary, "audio.webm", []},
      {"model", "whisper-1"}
    ]

    case Req.post("https://api.openai.com/v1/audio/transcriptions",
      auth: {:bearer, api_key},
      multipart: multipart
    ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body["text"]}
      {:ok, %{status: status, body: body}} ->
        Logger.error("Whisper API failed: #{status} - #{inspect body}")
        {:error, :transcription_failed}
      {:error, reason} ->
        {:error, reason}
    end
  end

  def structure_note(transcript, timestamp_s) do
    api_key = Application.get_env(:lossy, :openai_api_key)

    # Few-shot examples for better LLM accuracy
    system_prompt = """
    You are a video editing assistant. Convert voice comments into structured, actionable notes.

    Examples:
    Input: "um the pacing here feels really slow maybe speed it up"
    Output: {"text": "Slow pacing - speed up", "category": "pacing", "confidence": 0.85}

    Input: "the audio is a bit muddy here can we clean it up"
    Output: {"text": "Audio muddy - clean up", "category": "audio", "confidence": 0.9}

    Input: "I love this transition it's perfect"
    Output: {"text": "Perfect transition - keep it", "category": "content", "confidence": 0.95}

    Input: "hmm not sure about this part"
    Output: {"text": "Uncertain about this section", "category": "other", "confidence": 0.4}
    """

    user_prompt = """
    Convert this voice comment:

    Transcript: "#{transcript}"
    Timestamp: #{timestamp_s}s

    Return JSON with:
    - text: concise, actionable note (5-15 words)
    - category: one of [pacing, audio, color, graphics, content, other]
    - confidence: 0.0-1.0 (how clear/actionable the feedback is)
    """

    case Req.post("https://api.openai.com/v1/chat/completions",
      auth: {:bearer, api_key},
      json: %{
        model: "gpt-4o-mini",
        messages: [
          %{role: "system", content: system_prompt},
          %{role: "user", content: user_prompt}
        ],
        response_format: %{type: "json_object"},
        temperature: 0.3  # Lower temperature for more consistent output
      }
    ) do
      {:ok, %{status: 200, body: body}} ->
        content = body["choices"] |> List.first() |> get_in(["message", "content"])

        case Jason.decode(content) do
          {:ok, note_data} ->
            validate_and_sanitize_note(note_data)

          {:error, _} ->
            Logger.error("Failed to decode LLM response: #{content}")
            {:error, :invalid_json}
        end

      {:ok, %{status: status, body: body}} ->
        Logger.error("OpenAI API failed: #{status} - #{inspect body}")
        {:error, :structuring_failed}

      {:error, reason} ->
        Logger.error("OpenAI request failed: #{inspect reason}")
        {:error, reason}
    end
  end

  # Validate schema and sanitize LLM output
  defp validate_and_sanitize_note(note_data) do
    with {:ok, text} <- validate_text(note_data["text"]),
         {:ok, category} <- validate_category(note_data["category"]),
         {:ok, confidence} <- validate_confidence(note_data["confidence"]) do
      {:ok, %{
        "text" => text,
        "category" => category,
        "confidence" => confidence
      }}
    else
      {:error, reason} ->
        Logger.error("Note validation failed: #{reason}")
        {:error, :invalid_schema}
    end
  end

  defp validate_text(text) when is_binary(text) and byte_size(text) > 0 do
    # Truncate if too long
    sanitized = text |> String.trim() |> String.slice(0, 200)
    {:ok, sanitized}
  end
  defp validate_text(_), do: {:error, "text must be non-empty string"}

  defp validate_category(category) when category in @valid_categories do
    {:ok, category}
  end
  defp validate_category(category) when is_binary(category) do
    # Fallback to "other" if invalid category
    Logger.warn("Invalid category '#{category}', defaulting to 'other'")
    {:ok, "other"}
  end
  defp validate_category(_), do: {:error, "category must be string"}

  defp validate_confidence(conf) when is_float(conf) and conf >= 0.0 and conf <= 1.0 do
    {:ok, conf}
  end
  defp validate_confidence(conf) when is_integer(conf) and conf >= 0 and conf <= 1 do
    {:ok, conf / 1.0}
  end
  defp validate_confidence(conf) when is_number(conf) do
    # Clamp to valid range
    clamped = max(0.0, min(1.0, conf / 1.0))
    {:ok, clamped}
  end
  defp validate_confidence(_), do: {:error, "confidence must be number 0.0-1.0"}
end
```

### Backend: Update Audio Channel

```elixir
def handle_in("audio", {:binary, audio_data}, socket) do
  # Spawn async task
  Task.start(fn ->
    process_audio(socket, audio_data)
  end)

  {:noreply, socket}
end

defp process_audio(socket, audio_data) do
  session_id = socket.assigns.session_id

  # Transcribe
  case Lossy.Inference.Cloud.transcribe(audio_data) do
    {:ok, transcript} ->
      # Send transcript
      push(socket, "transcript", %{text: transcript})

      # Structure note
      case Lossy.Inference.Cloud.structure_note(transcript, 0.0) do
        {:ok, note} ->
          push(socket, "ghost_comment", note)
        {:error, _} ->
          Logger.error("Failed to structure note")
      end

    {:error, reason} ->
      Logger.error("Transcription failed: #{inspect reason}")
  end
end
```

### Backend: Store Notes

**lib/lossy/videos.ex:**
```elixir
defmodule Lossy.Videos do
  alias Lossy.Repo
  alias Lossy.Videos.Note

  def create_ghost_note(attrs) do
    %Note{}
    |> Note.changeset(Map.put(attrs, :status, "ghost"))
    |> Repo.insert()
  end

  def list_notes(video_id) do
    Repo.all(
      from n in Note,
      where: n.video_id == ^video_id,
      order_by: [desc: n.inserted_at]
    )
  end
end
```

### Extension: Display Ghost Comments

Update SidePanelLive to handle ghost comments:

```elixir
def handle_info({:ghost_comment, note}, socket) do
  {:noreply, stream_insert(socket, :notes, note, at: 0)}
end
```

**Deliverables:**
- ✅ Real transcription via OpenAI Whisper API
- ✅ LLM structures transcript into clear note
- ✅ Ghost comments appear in side panel with confidence
- ✅ Notes stored in database

---

## Phase 4: Browserbase Automation (Week 5-6)

**Goal:** Auto-post high-confidence notes to video platforms.

### Backend: Python Bridge

**lib/lossy/automation/python_bridge.ex:**
```elixir
defmodule Lossy.Automation.PythonBridge do
  def apply_note(url, time_s, text) do
    script = Application.app_dir(:lossy, "priv/python/agent_playwright.py")

    args = [
      script,
      "--url", url,
      "--time", to_string(time_s),
      "--text", text,
      "--api-key", Application.get_env(:lossy, :browserbase_api_key),
      "--project-id", Application.get_env(:lossy, :browserbase_project_id),
      "--context-id", Application.get_env(:lossy, :browserbase_context_id)
    ]

    case System.cmd("python3", args, stderr_to_stdout: true) do
      {output, 0} ->
        {:ok, Jason.decode!(output)}
      {error, _} ->
        {:error, error}
    end
  end
end
```

### Create Python Agent Placeholder

```bash
# Create Python agent structure in priv/python
mkdir -p lossy/priv/python/automation
# Python agents can be ported from external reference or built from scratch
# following Browserbase API documentation
```

### Backend: Oban Worker

**lib/lossy/workers/apply_note_worker.ex:**
```elixir
defmodule Lossy.Workers.ApplyNoteWorker do
  use Oban.Worker, queue: :automation, max_attempts: 3

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"note_id" => note_id}}) do
    note = Lossy.Videos.get_note!(note_id)
    video = Lossy.Videos.get_video!(note.video_id)

    case Lossy.Automation.PythonBridge.apply_note(
      video.url,
      note.timestamp_seconds,
      note.text
    ) do
      {:ok, %{"status" => "success", "permalink" => permalink}} ->
        Lossy.Videos.update_note(note, %{
          status: "posted",
          external_permalink: permalink
        })
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end
end
```

### Backend: Queue Notes for Posting

Update audio channel to queue high-confidence notes:

```elixir
case Lossy.Inference.Cloud.structure_note(transcript, 0.0) do
  {:ok, note_data} when note_data["confidence"] > 0.7 ->
    {:ok, note} = Videos.create_ghost_note(note_data)

    # Queue for posting
    %{note_id: note.id}
    |> ApplyNoteWorker.new()
    |> Oban.insert()

    push(socket, "ghost_comment", note_data)

  {:ok, note_data} ->
    push(socket, "ghost_comment", Map.put(note_data, "manual_review", true))
end
```

**Deliverables:**
- ✅ High-confidence notes queued via Oban
- ✅ Python agent posts to video platform
- ✅ Side panel shows "Posted ✅" status
- ✅ Retry logic on failures

---

## Phase 5: Polish + Content Script Overlays (Week 7-8)

**Goal:** On-video UI (anchor chip, ghost comments), polish UX.

### Content Script: Anchor Chip

**src/content/overlay/anchor-chip.js:**
```javascript
export class AnchorChip {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.chipElement = null;
  }

  show(timestamp) {
    this.chipElement = document.createElement('div');
    this.chipElement.className = 'vvc-anchor-chip';
    this.chipElement.textContent = `📍 ${this.formatTime(timestamp)}`;
    this.chipElement.style.cssText = `
      position: absolute;
      top: 20px;
      left: 20px;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      z-index: 10000;
    `;

    this.videoElement.parentElement.appendChild(this.chipElement);
  }

  hide() {
    if (this.chipElement) {
      this.chipElement.remove();
      this.chipElement = null;
    }
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}
```

### Content Script: Ghost Comments

**src/content/overlay/ghost-comment.js:**
```javascript
export class GhostComment {
  show(note) {
    const element = document.createElement('div');
    element.className = 'vvc-ghost-comment';
    element.innerHTML = `
      <div style="opacity: ${note.confidence}">
        <strong>${note.category}</strong>
        <p>${note.text}</p>
        <button class="vvc-scratch">Scratch that</button>
        <button class="vvc-confirm">Confirm</button>
      </div>
    `;

    element.querySelector('.vvc-scratch').addEventListener('click', () => {
      this.onScratch(note.id);
      element.remove();
    });

    element.querySelector('.vvc-confirm').addEventListener('click', () => {
      this.onConfirm(note.id);
      element.style.opacity = '1.0';
    });

    document.body.appendChild(element);
  }

  onScratch(noteId) {
    chrome.runtime.sendMessage({
      action: 'scratch_note',
      noteId: noteId
    });
  }

  onConfirm(noteId) {
    chrome.runtime.sendMessage({
      action: 'confirm_note',
      noteId: noteId
    });
  }
}
```

### Testing Full Flow

1. Load video on YouTube/Air
2. Click mic in side panel
3. Speak: "The pacing here is too slow"
4. See:
   - Anchor chip on video: "📍 1:23"
   - Ghost comment appears: "Slow pacing - speed up"
   - Side panel shows note
5. After 5s, note auto-posts to platform
6. Side panel updates: "Posted ✅"

**Deliverables:**
- ✅ On-video overlays (anchor, ghost comments)
- ✅ Full end-to-end flow working
- ✅ Polish: animations, error states, loading indicators

---

## Post-MVP Enhancements

### Phase 6: WASM Whisper (Local STT)

See `TECHNICAL_REFERENCES.md` for complete implementation patterns.

- Integrate Transformers.js in offscreen document
- WebGPU acceleration with WASM fallback
- Keep cloud as fallback for accuracy

### Phase 7: CLIP Emoji Tokens

See `TECHNICAL_REFERENCES.md` for complete implementation patterns.

- Frame capture on recording start
- SigLIP via Transformers.js (better than CLIP)
- Emoji chips appear in 50-150ms (WebGPU) or 300-600ms (WASM)

### Phase 8: Multi-note Merging

- Consolidate nearby similar notes
- Background consolidation worker
- UI to approve/reject merges

---

## Timeline Summary

| Phase | Duration | End State |
|-------|----------|-----------|
| **0: Scaffolding** | Week 1 | Project structure, builds |
| **1: Auth + LiveView** | Week 2 | Extension connects to Phoenix |
| **2: Audio Streaming** | Week 3 | Voice captured, sent to backend |
| **3: Real STT/LLM** | Week 4 | Transcription + ghost comments |
| **4: Browserbase** | Week 5-6 | Auto-posting to platforms |
| **5: Polish** | Week 7-8 | On-video UI, full UX |
| **MVP COMPLETE** | **8 weeks** | **Fully functional** |

Each phase delivers working software that can be demoed and tested!
