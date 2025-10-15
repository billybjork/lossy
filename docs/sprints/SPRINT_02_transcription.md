# Sprint 02: Cloud Transcription & Note Structuring (MVP)

**Status:** ⏳ Planned
**Estimated Duration:** 2-3 days

---

## Goal

Implement **cloud-based transcription** using OpenAI Whisper API for the MVP. Send audio from extension → Phoenix → OpenAI Whisper → GPT-4o-mini for note structuring. Store structured notes in database with confidence scores.

**MVP Architecture:** Audio sent to cloud for fast implementation. Local WASM transcription deferred to Phase 6.

---

## Prerequisites

- ✅ Sprint 01 complete (audio streaming working)
- ⏳ OpenAI API key obtained
- ⏳ Audio chunks arriving at Phoenix backend

---

## Deliverables

- [ ] AgentSession GenServer manages recording lifecycle
- [ ] Audio chunks buffered and sent to OpenAI Whisper API
- [ ] Whisper API transcribes audio to text
- [ ] GPT-4o-mini structures transcripts into actionable notes
- [ ] Notes stored in database with category, confidence, status
- [ ] PubSub broadcasts events to LiveView
- [ ] Side panel shows real-time transcription progress
- [ ] Database schema for notes and videos
- [ ] Error handling for API failures

---

## Technical Tasks

### Task 1: AgentSession GenServer (Core Orchestrator)

The AgentSession is the heart of the system - it manages the entire recording → transcription → structuring pipeline.

**File:** `lib/lossy/agent/session.ex` (new)

#### 1.1 Session State Machine

```elixir
defmodule Lossy.Agent.Session do
  use GenServer
  require Logger

  alias Lossy.Inference.Cloud
  alias Lossy.Videos

  @max_audio_buffer_bytes 5_000_000  # 5MB max
  @max_audio_duration_seconds 60     # 60s max

  # Client API

  def start_link(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    GenServer.start_link(__MODULE__, opts, name: via_tuple(session_id))
  end

  def cast_audio(session_id, audio_chunk) do
    GenServer.cast(via_tuple(session_id), {:audio_chunk, audio_chunk})
  end

  def stop_recording(session_id) do
    GenServer.cast(via_tuple(session_id), :stop_recording)
  end

  # Server Callbacks

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.get(opts, :user_id)
    video_id = Keyword.get(opts, :video_id)

    state = %{
      session_id: session_id,
      user_id: user_id,
      video_id: video_id,
      status: :idle,
      audio_buffer: <<>>,
      audio_duration: 0,
      started_at: nil,
      last_transition: DateTime.utc_now()
    }

    Logger.info("AgentSession started: #{session_id}")
    {:ok, state}
  end

  @impl true
  def handle_cast({:audio_chunk, data}, state) do
    new_buffer = state.audio_buffer <> data
    new_duration = state.audio_duration + estimate_chunk_duration(data)

    # Broadcast partial event
    broadcast_event(state.session_id, %{
      type: :audio_chunk_received,
      buffer_size: byte_size(new_buffer),
      duration: new_duration
    })

    cond do
      byte_size(new_buffer) >= @max_audio_buffer_bytes ->
        Logger.warn("Max buffer size reached, forcing transcription")
        state = %{state | audio_buffer: new_buffer, audio_duration: new_duration}
        {:noreply, transition_to(state, :transcribing)}

      new_duration >= @max_audio_duration_seconds ->
        Logger.warn("Max duration reached, forcing transcription")
        state = %{state | audio_buffer: new_buffer, audio_duration: new_duration}
        {:noreply, transition_to(state, :transcribing)}

      true ->
        # Continue accumulating
        {:noreply, %{state | audio_buffer: new_buffer, audio_duration: new_duration}}
    end
  end

  @impl true
  def handle_cast(:stop_recording, state) do
    Logger.info("Stopping recording, transcribing #{byte_size(state.audio_buffer)} bytes")
    {:noreply, transition_to(state, :transcribing)}
  end

  # State Transitions

  defp transition_to(%{status: :idle} = state, :listening) do
    Logger.info("[#{state.session_id}] idle → listening")
    %{state | status: :listening, started_at: DateTime.utc_now()}
  end

  defp transition_to(%{status: :listening} = state, :transcribing) do
    Logger.info("[#{state.session_id}] listening → transcribing")

    # Kick off async transcription
    Task.start(fn -> transcribe_audio(state) end)

    broadcast_event(state.session_id, %{
      type: :transcription_started,
      buffer_size: byte_size(state.audio_buffer)
    })

    %{state | status: :transcribing}
  end

  # Async Work

  defp transcribe_audio(state) do
    case Cloud.transcribe_audio(state.audio_buffer) do
      {:ok, transcript_text} ->
        Logger.info("[#{state.session_id}] Transcription complete: #{String.slice(transcript_text, 0..50)}...")

        # Broadcast transcript
        broadcast_event(state.session_id, %{
          type: :transcript_ready,
          text: transcript_text
        })

        # Now structure the note
        structure_note(state, transcript_text)

      {:error, reason} ->
        Logger.error("[#{state.session_id}] Transcription failed: #{inspect(reason)}")

        broadcast_event(state.session_id, %{
          type: :transcription_failed,
          error: inspect(reason)
        })
    end
  end

  defp structure_note(state, transcript_text) do
    case Cloud.structure_note(transcript_text) do
      {:ok, structured_note} ->
        Logger.info("[#{state.session_id}] Note structured: #{inspect(structured_note)}")

        # Store in database
        {:ok, note} = Videos.create_note(%{
          transcript: transcript_text,
          text: structured_note.text,
          category: structured_note.category,
          confidence: structured_note.confidence,
          status: "ghost",
          video_id: state.video_id,
          session_id: state.session_id
        })

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

  # Helpers

  defp broadcast_event(session_id, event) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "session:#{session_id}",
      {:agent_event, event}
    )
  end

  defp estimate_chunk_duration(audio_data) do
    # WebM Opus at 16kbps ≈ 2KB/sec
    byte_size(audio_data) / 2000
  end

  defp via_tuple(session_id) do
    {:via, Registry, {Lossy.Agent.SessionRegistry, session_id}}
  end
end
```

#### 1.2 Session Supervisor

**File:** `lib/lossy/agent/session_supervisor.ex` (new)

```elixir
defmodule Lossy.Agent.SessionSupervisor do
  use DynamicSupervisor

  def start_link(init_arg) do
    DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  def start_session(session_id, opts \\ []) do
    child_spec = %{
      id: Lossy.Agent.Session,
      start: {Lossy.Agent.Session, :start_link, [[session_id: session_id] ++ opts]},
      restart: :transient
    }

    DynamicSupervisor.start_child(__MODULE__, child_spec)
  end

  def stop_session(session_id) do
    case Registry.lookup(Lossy.Agent.SessionRegistry, session_id) do
      [{pid, _}] ->
        DynamicSupervisor.terminate_child(__MODULE__, pid)

      [] ->
        {:error, :not_found}
    end
  end
end
```

#### 1.3 Session Registry

**File:** `lib/lossy/agent/session_registry.ex` (new)

```elixir
defmodule Lossy.Agent.SessionRegistry do
  @moduledoc """
  Registry for AgentSession processes.
  Allows lookup by session_id.
  """

  def child_spec(_opts) do
    Registry.child_spec(
      keys: :unique,
      name: __MODULE__
    )
  end
end
```

#### 1.4 Add to Application Supervisor

**File:** `lib/lossy/application.ex` (update)

```elixir
def start(_type, _args) do
  children = [
    # ... existing children ...
    Lossy.Agent.SessionRegistry,
    Lossy.Agent.SessionSupervisor,
    # ... rest of children ...
  ]

  opts = [strategy: :one_for_one, name: Lossy.Supervisor]
  Supervisor.start_link(children, opts)
end
```

---

### Task 2: Cloud Inference Module

**File:** `lib/lossy/inference/cloud.ex` (new)

```elixir
defmodule Lossy.Inference.Cloud do
  @moduledoc """
  OpenAI API integration for Whisper transcription and GPT-4o-mini note structuring.
  """

  require Logger

  @openai_api_key Application.compile_env(:lossy, :openai_api_key)
  @whisper_url "https://api.openai.com/v1/audio/transcriptions"
  @chat_url "https://api.openai.com/v1/chat/completions"

  @doc """
  Transcribe audio using OpenAI Whisper API.
  Accepts audio binary (WebM/Opus format from browser).
  """
  def transcribe_audio(audio_binary) when is_binary(audio_binary) do
    Logger.info("Transcribing audio with Whisper API (#{byte_size(audio_binary)} bytes)")

    # Create multipart form data
    boundary = "----WebKitFormBoundary#{:crypto.strong_rand_bytes(16) |> Base.encode16()}"

    body =
      build_multipart([
        {"model", "whisper-1"},
        {"file", audio_binary, "audio.webm", "audio/webm"},
        {"language", "en"},
        {"response_format", "json"}
      ], boundary)

    headers = [
      {"Authorization", "Bearer #{@openai_api_key}"},
      {"Content-Type", "multipart/form-data; boundary=#{boundary}"}
    ]

    case HTTPoison.post(@whisper_url, body, headers, recv_timeout: 30_000) do
      {:ok, %{status_code: 200, body: response_body}} ->
        response = Jason.decode!(response_body)
        transcript = Map.get(response, "text", "")
        {:ok, transcript}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("Whisper API error: #{status} - #{error_body}")
        {:error, "Whisper API error: #{status}"}

      {:error, %HTTPoison.Error{reason: reason}} ->
        Logger.error("Whisper request failed: #{inspect(reason)}")
        {:error, "Request failed: #{inspect(reason)}"}
    end
  end

  @doc """
  Structure raw transcript into actionable note using GPT-4o-mini.

  Input: "The pacing here feels too slow, maybe speed it up?"
  Output: %{
    text: "Speed up pacing in this section",
    category: "pacing",
    confidence: 0.85
  }
  """
  def structure_note(transcript_text, _video_context \\ %{}) do
    Logger.info("Structuring note with GPT-4o-mini: #{String.slice(transcript_text, 0..50)}...")

    prompt = build_structuring_prompt(transcript_text)

    case call_openai_chat(prompt) do
      {:ok, response} ->
        parse_structured_note(response, transcript_text)

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Private Helpers

  defp build_multipart(fields, boundary) do
    parts =
      Enum.map(fields, fn
        {name, value} when is_binary(value) ->
          """
          --#{boundary}\r
          Content-Disposition: form-data; name="#{name}"\r
          \r
          #{value}\r
          """

        {name, data, filename, content_type} ->
          """
          --#{boundary}\r
          Content-Disposition: form-data; name="#{name}"; filename="#{filename}"\r
          Content-Type: #{content_type}\r
          \r
          #{data}\r
          """
      end)

    Enum.join(parts) <> "--#{boundary}--\r\n"
  end

  defp build_structuring_prompt(transcript) do
    """
    You are a video feedback assistant. Convert this raw voice transcript into a clear, actionable note.

    Raw transcript: "#{transcript}"

    Extract:
    1. **category** (one of: pacing, audio, visual, editing, general)
    2. **text** (clear, imperative feedback - rewrite for clarity if needed)
    3. **confidence** (0.0-1.0, how clear/actionable is this feedback?)

    Respond ONLY with JSON:
    {"category": "...", "text": "...", "confidence": 0.0}

    Examples:
    - "The pacing here is too slow" → {"category": "pacing", "text": "Speed up pacing", "confidence": 0.9}
    - "Um, maybe the audio is a bit quiet?" → {"category": "audio", "text": "Increase audio volume", "confidence": 0.7}
    - "This looks great!" → {"category": "general", "text": "Positive feedback", "confidence": 0.6}
    """
  end

  defp call_openai_chat(prompt) do
    headers = [
      {"Authorization", "Bearer #{@openai_api_key}"},
      {"Content-Type", "application/json"}
    ]

    body =
      Jason.encode!(%{
        model: "gpt-4o-mini",
        messages: [
          %{
            role: "system",
            content: "You structure voice transcripts into actionable video feedback. Always respond with valid JSON."
          },
          %{role: "user", content: prompt}
        ],
        temperature: 0.3,
        max_tokens: 150
      })

    case HTTPoison.post(@chat_url, body, headers, recv_timeout: 15_000) do
      {:ok, %{status_code: 200, body: response_body}} ->
        response = Jason.decode!(response_body)
        content = get_in(response, ["choices", Access.at(0), "message", "content"])
        {:ok, content}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("OpenAI Chat API error: #{status} - #{error_body}")
        {:error, "API error: #{status}"}

      {:error, %HTTPoison.Error{reason: reason}} ->
        Logger.error("OpenAI Chat request failed: #{inspect(reason)}")
        {:error, "Request failed: #{inspect(reason)}"}
    end
  end

  defp parse_structured_note(json_string, original_transcript) do
    # GPT-4o-mini sometimes wraps JSON in markdown code blocks
    cleaned =
      json_string
      |> String.replace(~r/```json\n/, "")
      |> String.replace(~r/```\n?/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, %{"category" => cat, "text" => text, "confidence" => conf}} ->
        {:ok,
         %{
           category: cat,
           text: text,
           confidence: conf,
           original_transcript: original_transcript
         }}

      {:error, _} ->
        Logger.warn("Failed to parse GPT-4o-mini response as JSON: #{json_string}")

        # Fallback: return transcript as-is
        {:ok,
         %{
           category: "general",
           text: original_transcript,
           confidence: 0.5,
           original_transcript: original_transcript
         }}
    end
  end
end
```

**Add HTTPoison dependency:**

```elixir
# mix.exs
defp deps do
  [
    # ... existing deps ...
    {:httpoison, "~> 2.0"}
  ]
end
```

Run: `mix deps.get`

**Add OpenAI API key to config:**

```elixir
# config/runtime.exs
config :lossy,
  openai_api_key: System.get_env("OPENAI_API_KEY") || raise("OPENAI_API_KEY not set")
```

---

### Task 3: Audio Channel Updates

**File:** `lossy/lib/lossy_web/channels/audio_channel.ex` (update)

```elixir
defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Agent.SessionSupervisor

  @impl true
  def join("audio:" <> session_id, _payload, socket) do
    Logger.info("Audio channel joined: #{session_id}")

    # Start AgentSession if not already running
    case SessionSupervisor.start_session(session_id) do
      {:ok, _pid} ->
        Logger.info("Started new AgentSession: #{session_id}")

      {:error, {:already_started, _pid}} ->
        Logger.info("AgentSession already running: #{session_id}")

      {:error, reason} ->
        Logger.error("Failed to start AgentSession: #{inspect(reason)}")
    end

    {:ok, assign(socket, :session_id, session_id)}
  end

  # Handle audio chunks from extension
  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_map(audio_data) do
    # Convert map with string keys to binary (JSON serialization artifact)
    audio_list =
      audio_data
      |> Enum.sort_by(fn {k, _v} -> String.to_integer(k) end)
      |> Enum.map(fn {_k, v} -> v end)

    audio_binary = :binary.list_to_bin(audio_list)

    Logger.debug("Received audio chunk: #{byte_size(audio_binary)} bytes")

    # Send to AgentSession
    Lossy.Agent.Session.cast_audio(socket.assigns.session_id, audio_binary)

    {:noreply, socket}
  end

  @impl true
  def handle_in("audio_chunk", %{"data" => audio_data}, socket) when is_binary(audio_data) do
    Logger.debug("Received audio chunk: #{byte_size(audio_data)} bytes")

    # Send to AgentSession
    Lossy.Agent.Session.cast_audio(socket.assigns.session_id, audio_binary)

    {:noreply, socket}
  end

  # Handle stop recording event
  @impl true
  def handle_in("stop_recording", _payload, socket) do
    Logger.info("Stop recording event received")

    Lossy.Agent.Session.stop_recording(socket.assigns.session_id)

    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
  end
end
```

---

### Task 4: Database Schema

**Generate migration:**

```bash
cd lossy
mix ecto.gen.migration create_videos_and_notes
```

**File:** `priv/repo/migrations/TIMESTAMP_create_videos_and_notes.exs`

```elixir
defmodule Lossy.Repo.Migrations.CreateVideosAndNotes do
  use Ecto.Migration

  def change do
    # Videos table
    create table(:videos) do
      add :platform, :string, null: false  # youtube, vimeo, air
      add :platform_video_id, :string, null: false  # e.g., YouTube video ID
      add :url, :string, null: false
      add :title, :string
      add :thumbnail_url, :string
      add :duration_seconds, :integer

      timestamps()
    end

    create unique_index(:videos, [:platform, :platform_video_id])
    create index(:videos, [:platform])

    # Notes table
    create table(:notes) do
      add :video_id, references(:videos, on_delete: :delete_all), null: false
      add :session_id, :string, null: false
      add :transcript, :text, null: false
      add :text, :text, null: false
      add :category, :string, null: false
      add :confidence, :float, null: false
      add :status, :string, default: "ghost", null: false  # ghost, firmed, posting, posted, failed
      add :timestamp_seconds, :float
      add :transcription_duration_ms, :integer
      add :external_permalink, :string
      add :posted_at, :utc_datetime
      add :error, :text

      timestamps()
    end

    create index(:notes, [:video_id])
    create index(:notes, [:session_id])
    create index(:notes, [:status])
    create index(:notes, [:category])
  end
end
```

Run: `mix ecto.migrate`

**File:** `lib/lossy/videos/video.ex` (new schema)

```elixir
defmodule Lossy.Videos.Video do
  use Ecto.Schema
  import Ecto.Changeset

  schema "videos" do
    field :platform, :string
    field :platform_video_id, :string
    field :url, :string
    field :title, :string
    field :thumbnail_url, :string
    field :duration_seconds, :integer

    has_many :notes, Lossy.Videos.Note

    timestamps()
  end

  def changeset(video, attrs) do
    video
    |> cast(attrs, [:platform, :platform_video_id, :url, :title, :thumbnail_url, :duration_seconds])
    |> validate_required([:platform, :platform_video_id, :url])
    |> validate_inclusion(:platform, ~w(youtube vimeo air))
    |> unique_constraint([:platform, :platform_video_id])
  end
end
```

**File:** `lib/lossy/videos/note.ex` (new schema)

```elixir
defmodule Lossy.Videos.Note do
  use Ecto.Schema
  import Ecto.Changeset

  schema "notes" do
    field :session_id, :string
    field :transcript, :string
    field :text, :string
    field :category, :string
    field :confidence, :float
    field :status, :string, default: "ghost"
    field :timestamp_seconds, :float
    field :transcription_duration_ms, :integer
    field :external_permalink, :string
    field :posted_at, :utc_datetime
    field :error, :string

    belongs_to :video, Lossy.Videos.Video

    timestamps()
  end

  def changeset(note, attrs) do
    note
    |> cast(attrs, [
      :video_id,
      :session_id,
      :transcript,
      :text,
      :category,
      :confidence,
      :status,
      :timestamp_seconds,
      :transcription_duration_ms,
      :external_permalink,
      :posted_at,
      :error
    ])
    |> validate_required([:session_id, :transcript, :text, :category, :confidence])
    |> validate_inclusion(:category, ~w(pacing audio visual editing general))
    |> validate_inclusion(:status, ~w(ghost firmed posting posted failed))
    |> validate_number(:confidence, greater_than_or_equal_to: 0.0, less_than_or_equal_to: 1.0)
    |> foreign_key_constraint(:video_id)
  end
end
```

**File:** `lib/lossy/videos.ex` (new context)

```elixir
defmodule Lossy.Videos do
  @moduledoc """
  Context for video-related data: videos, notes, sessions.
  """

  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Videos.{Video, Note}

  # Videos

  def find_or_create_video(attrs) do
    case get_video_by_platform_id(attrs.platform, attrs.platform_video_id) do
      nil ->
        %Video{}
        |> Video.changeset(attrs)
        |> Repo.insert()

      video ->
        {:ok, video}
    end
  end

  def get_video_by_platform_id(platform, platform_video_id) do
    Repo.get_by(Video, platform: platform, platform_video_id: platform_video_id)
  end

  # Notes

  def create_note(attrs \\ %{}) do
    %Note{}
    |> Note.changeset(attrs)
    |> Repo.insert()
  end

  def list_notes(filters \\ %{}) do
    Note
    |> apply_filters(filters)
    |> order_by([n], desc: n.inserted_at)
    |> Repo.all()
  end

  def get_note!(id), do: Repo.get!(Note, id)

  def update_note(note, attrs) do
    note
    |> Note.changeset(attrs)
    |> Repo.update()
  end

  defp apply_filters(query, filters) do
    Enum.reduce(filters, query, fn
      {:video_id, vid}, q -> where(q, [n], n.video_id == ^vid)
      {:session_id, sid}, q -> where(q, [n], n.session_id == ^sid)
      {:status, status}, q -> where(q, [n], n.status == ^status)
      {:category, cat}, q -> where(q, [n], n.category == ^cat)
      _, q -> q
    end)
  end
end
```

---

### Task 5: Extension Updates

**File:** `extension/src/offscreen/offscreen.js` (update)

Remove WASM Whisper code, keep simple audio capture:

```javascript
console.log('Offscreen document loaded');

let mediaRecorder = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') {
    return false;
  }

  console.log('Offscreen received:', message);

  if (message.action === 'start_recording') {
    startRecording()
      .then(() => {
        console.log('Offscreen: Recording started successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Offscreen: Failed to start recording:', error);
        const errorMessage =
          error.name === 'NotAllowedError'
            ? 'Microphone permission denied. Please grant permission when prompted.'
            : error.message || String(error);
        sendResponse({ success: false, error: errorMessage });
      });
    return true;
  }

  if (message.action === 'stop_recording') {
    stopRecording();
    console.log('Offscreen: Recording stopped');
    sendResponse({ success: true });
    return false;
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 16000
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        console.log('Audio chunk available:', event.data.size, 'bytes');

        // Convert Blob to ArrayBuffer and send to service worker
        event.data.arrayBuffer().then((buffer) => {
          chrome.runtime.sendMessage({
            action: 'audio_chunk',
            data: Array.from(new Uint8Array(buffer)),
            mimeType: mimeType,
            size: buffer.byteLength
          });
        });
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };

    mediaRecorder.onstop = () => {
      console.log('MediaRecorder stopped');
      stream.getTracks().forEach((track) => track.stop());
    };

    // Start recording with 1-second chunks
    mediaRecorder.start(1000);
    console.log('Recording started');
  } catch (error) {
    console.error('Failed to start recording:', error);
    throw error;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}
```

**File:** `extension/src/background/service-worker.js` (update)

Send stop_recording event when user clicks stop:

```javascript
async function stopRecording() {
  console.log('Stopping recording...');

  // 1. Stop audio capture
  if (await hasOffscreenDocument()) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_recording'
    }).catch((err) => console.error('Failed to stop offscreen recording:', err));
  }

  // 2. Tell backend to finalize transcription
  if (audioChannel) {
    audioChannel.push('stop_recording', {})
      .receive('ok', () => console.log('Backend notified to finalize'))
      .receive('error', (err) => console.error('Failed to notify backend:', err));
  }

  // 3. Leave channel (after stop_recording sent)
  setTimeout(() => {
    if (audioChannel) {
      audioChannel.leave();
      audioChannel = null;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    isRecording = false;
  }, 500);
}
```

---

## Testing Checklist

### Backend Tests

- [ ] `iex -S mix phx.server` starts without errors
- [ ] AgentSession GenServer starts when channel joined
- [ ] Audio chunks accumulate in buffer
- [ ] Whisper API called when recording stops
- [ ] GPT-4o-mini structures transcript
- [ ] Note saved to database with correct fields
- [ ] PubSub events broadcast to session topic

### Extension Tests

- [ ] Extension builds: `npm run build`
- [ ] Click "Start Recording" → mic permission granted
- [ ] Speak for 5 seconds, click "Stop Recording"
- [ ] Check Phoenix logs: "Transcribing audio with Whisper API"
- [ ] Check Phoenix logs: "Structuring note with GPT-4o-mini"
- [ ] Side panel shows structured note (future sprint)

### Integration Tests

- [ ] End-to-end: record → transcribe → structure → save
- [ ] Error handling: Invalid API key shows error
- [ ] Error handling: Network failure retries
- [ ] Multiple sessions can run concurrently

---

## Performance Expectations

| Operation | Expected Latency | Notes |
|-----------|------------------|-------|
| Whisper API | 2-5s for 10s audio | Depends on audio length |
| GPT-4o-mini | 0.5-1.5s | Usually <1s |
| Total end-to-end | 3-7s | From stop to note displayed |

---

## Architecture Validation

**Data Flow:**
```
Audio (browser)
  ↓ [WebSocket to Phoenix]
Phoenix AudioChannel
  ↓ [Cast to AgentSession]
AgentSession (buffer + orchestrate)
  ↓ [OpenAI Whisper API]
Transcript text
  ↓ [OpenAI GPT-4o-mini API]
Structured note
  ↓ [Database + PubSub]
Extension (via LiveView in future sprint)
```

**Why Cloud-First for MVP:**
1. **Fast implementation**: No WASM complexity, no WebGPU detection
2. **Proven reliability**: OpenAI Whisper is production-grade
3. **Good quality**: Whisper API often better than tiny WASM model
4. **Defer optimization**: Move to WASM in Phase 6 after validating product

---

## Cost Tracking

OpenAI Whisper API pricing (as of 2025):
- $0.006 per minute of audio

For 100 notes/day @ 10s each:
- 100 notes × 10s = 1000s = 16.6 minutes
- Cost: $0.10/day = $3/month

GPT-4o-mini pricing:
- $0.15 per 1M input tokens, $0.60 per 1M output tokens
- ~100 tokens per note structuring
- 100 notes/day ≈ $0.01/day = $0.30/month

**Total MVP cost: ~$3.30/month for active user**

---

## Notes & Learnings

### Why AgentSession GenServer?

The GenServer pattern gives us:
- **State management**: Track audio buffer, status, timestamps
- **Process isolation**: Each session is independent, failures don't cascade
- **Async work**: Use `Task.start` for API calls without blocking
- **Supervision**: Automatic restart if process crashes
- **Registry**: Lookup sessions by ID for PubSub routing

### Why Cloud Whisper for MVP?

1. **Speed to market**: No WASM, no workers, no fallback chains
2. **Quality**: OpenAI Whisper is best-in-class
3. **Reliability**: Proven at scale, handles edge cases
4. **Cost**: $3/month per user is acceptable for MVP
5. **Simplicity**: One API call vs complex client-side pipeline

### Future Migration Path (Phase 6)

When ready to add local WASM transcription:
1. Keep Cloud.transcribe_audio as fallback
2. Add Inference.Local.transcribe_audio
3. AgentSession checks device capability
4. Offscreen document runs WASM Whisper
5. Falls back to cloud if local fails

**This sprint builds the foundation for that migration.**

---

## Next Sprint

👉 [Sprint 03 - Video Integration](./SPRINT_03_video_integration.md)

**Focus:** Content scripts detect video elements, capture timestamps, anchor notes to video playback
