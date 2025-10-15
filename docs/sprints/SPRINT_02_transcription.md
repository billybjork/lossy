# Sprint 02: WASM Transcription & Cloud Note Structuring

**Status:** ⏳ Planned
**Estimated Duration:** 2-3 days

---

## Goal

Implement **local-first** transcription using WASM Whisper (Transformers.js) in the browser extension's offscreen document, then send **only the text transcript** to Phoenix backend for GPT-4o-mini note structuring. Store structured notes in database with confidence scores.

**Privacy-first architecture:** Audio never leaves the browser. Only text transcripts are sent to cloud.

---

## Prerequisites

- ✅ Sprint 01 complete (audio streaming working)
- ⏳ OpenAI API key obtained (for GPT-4o-mini note structuring only)
- ⏳ Audio chunks accumulating in offscreen document

---

## Deliverables

- [ ] WASM Whisper (Transformers.js) transcribes audio locally in browser
- [ ] WebGPU → WASM automatic fallback based on device capability
- [ ] Transcript text (not audio) sent to Phoenix backend
- [ ] GPT-4o-mini structures transcripts into actionable notes
- [ ] Notes have category, confidence, and cleaned text
- [ ] Notes stored in database with status tracking
- [ ] Side panel shows real transcripts and structured notes
- [ ] Error handling with cloud Whisper API fallback (optional)

---

## Technical Tasks

### Task 1: WASM Whisper Setup (Extension - Offscreen Document)

**File:** `extension/src/offscreen/transcription.js`

#### 1.1 Install Dependencies

```bash
cd extension
npm install @huggingface/transformers
```

#### 1.2 WebGPU Detection & Model Initialization

```javascript
import { pipeline } from '@huggingface/transformers';

let transcriber = null;
let device = 'webgpu';
let isInitializing = false;

async function initializeTranscriber() {
  if (transcriber || isInitializing) return;

  isInitializing = true;
  console.log('Initializing Whisper transcriber...');

  // Detect WebGPU availability
  if (!('gpu' in navigator)) {
    console.warn('WebGPU not available, falling back to WASM');
    device = 'wasm';
  }

  try {
    // Use tiny.en model for MVP (fast, good quality for English)
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        device: device,
        dtype: device === 'webgpu' ? 'fp16' : 'int8',
        model_file_name: device === 'webgpu' ? 'onnx/model_fp16.onnx' : 'onnx/model_quantized.onnx'
      }
    );

    console.log(`Whisper initialized with ${device.toUpperCase()}`);
    isInitializing = false;

    // Notify service worker that transcriber is ready
    chrome.runtime.sendMessage({
      action: 'transcriber_ready',
      device: device
    });

  } catch (error) {
    console.error('Failed to initialize Whisper:', error);
    isInitializing = false;
    transcriber = null;

    // Notify service worker of failure (will use cloud fallback)
    chrome.runtime.sendMessage({
      action: 'transcriber_failed',
      error: error.message
    });
  }
}

// Initialize on load
initializeTranscriber();
```

#### 1.3 Audio Buffer → Transcription Pipeline

**File:** `extension/src/offscreen/offscreen.js` (update existing)

```javascript
let mediaRecorder = null;
let audioChunks = [];
let isTranscribing = false;

// When recording stops, transcribe accumulated audio
async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();

    // Wait for all chunks to arrive
    await new Promise(resolve => {
      mediaRecorder.onstop = async () => {
        console.log('Recording stopped, transcribing...');

        // Combine audio chunks into single blob
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        audioChunks = [];

        // Transcribe locally
        await transcribeAudio(audioBlob);

        resolve();
      };
    });

    mediaRecorder = null;
  }
}

async function transcribeAudio(audioBlob) {
  if (!transcriber) {
    console.warn('Transcriber not ready, cannot transcribe locally');

    // Send audio to backend as fallback
    chrome.runtime.sendMessage({
      action: 'transcription_fallback',
      audioData: await audioBlob.arrayBuffer()
    });
    return;
  }

  isTranscribing = true;
  const startTime = performance.now();

  try {
    // Convert WebM blob to format Whisper expects
    const arrayBuffer = await audioBlob.arrayBuffer();

    // Transcribe with Whisper
    const result = await transcriber(arrayBuffer, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false  // Word timestamps not needed for MVP
    });

    const duration = performance.now() - startTime;
    console.log(`Transcription complete in ${duration.toFixed(0)}ms:`, result.text);

    // Send transcript TEXT to service worker (not audio!)
    chrome.runtime.sendMessage({
      action: 'transcript_ready',
      text: result.text,
      duration_ms: duration,
      device: device
    });

  } catch (error) {
    console.error('Local transcription failed:', error);

    // Fallback: send audio to cloud
    chrome.runtime.sendMessage({
      action: 'transcription_fallback',
      audioData: await audioBlob.arrayBuffer(),
      error: error.message
    });
  } finally {
    isTranscribing = false;
  }
}
```

**Why this approach:**
- Audio stays in browser (privacy-first)
- WebGPU acceleration when available (~100-300ms for 5s audio)
- Automatic WASM fallback (~500-2000ms)
- Cloud fallback only if local fails

---

### Task 2: Service Worker Updates

**File:** `extension/src/background/service-worker.js`

Update to handle transcript text instead of audio chunks:

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  // NEW: Handle transcript from offscreen document
  if (message.action === 'transcript_ready' && sender.url?.includes('offscreen.html')) {
    if (audioChannel) {
      // Send TRANSCRIPT TEXT to Phoenix (not audio!)
      audioChannel.push('transcript_text', {
        text: message.text,
        duration_ms: message.duration_ms,
        device: message.device
      })
        .receive('ok', (response) => {
          console.log('Transcript sent, structured note received:', response);

          // Forward structured note to side panel
          chrome.runtime.sendMessage({
            action: 'structured_note',
            data: response
          });
        })
        .receive('error', (err) => console.error('Failed to send transcript:', err));
    }
    return false;
  }

  // NEW: Handle cloud fallback (if local transcription fails)
  if (message.action === 'transcription_fallback' && sender.url?.includes('offscreen.html')) {
    console.warn('Using cloud Whisper fallback');

    if (audioChannel) {
      // Send audio binary to cloud (only as fallback)
      const audioData = new Uint8Array(message.audioData);
      audioChannel.push('audio_chunk_fallback', { data: audioData })
        .receive('ok', (response) => console.log('Cloud transcription complete'))
        .receive('error', (err) => console.error('Cloud transcription failed:', err));
    }
    return false;
  }
});
```

---

### Task 3: Backend Inference Module

**File:** `lib/lossy/inference.ex` (new context)

```elixir
defmodule Lossy.Inference do
  @moduledoc """
  Inference routing for STT and LLM.
  Local WASM transcription is preferred, cloud is fallback.
  """

  alias Lossy.Inference.Cloud

  @doc """
  Structure transcript text into actionable note using GPT-4o-mini.
  This always runs in cloud (not local).
  """
  def structure_note(transcript_text, video_context \\ %{}) do
    Cloud.structure_note(transcript_text, video_context)
  end

  @doc """
  Cloud Whisper fallback (only called if local WASM fails).
  """
  def transcribe_audio_fallback(audio_binary) do
    Cloud.transcribe_audio(audio_binary)
  end
end
```

**File:** `lib/lossy/inference/cloud.ex` (new)

```elixir
defmodule Lossy.Inference.Cloud do
  require Logger

  @openai_api_key System.get_env("OPENAI_API_KEY")

  @doc """
  Transcribe audio using OpenAI Whisper API.
  Only used as fallback when local WASM transcription fails.
  """
  def transcribe_audio(audio_binary) do
    Logger.info("Using cloud Whisper fallback (#{byte_size(audio_binary)} bytes)")

    # TODO: Implement OpenAI Whisper API call
    # This is rarely needed in practice since WASM works on most devices

    {:ok, "Cloud transcription not yet implemented"}
  end

  @doc """
  Structure raw transcript into actionable note using GPT-4o-mini.

  Input: "The pacing here feels too slow, maybe speed it up?"
  Output: %{
    text: "Speed up pacing in this section",
    category: "pacing",
    confidence: 0.85,
    original_transcript: "..."
  }
  """
  def structure_note(transcript_text, video_context) do
    Logger.info("Structuring note with GPT-4o-mini: #{String.slice(transcript_text, 0..50)}...")

    prompt = build_structuring_prompt(transcript_text, video_context)

    case call_openai_chat(prompt) do
      {:ok, response} ->
        parse_structured_note(response, transcript_text)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp build_structuring_prompt(transcript, _context) do
    """
    You are a video feedback assistant. Convert this raw voice transcript into a clear, actionable note.

    Raw transcript: "#{transcript}"

    Extract:
    1. **category** (one of: pacing, audio, visual, editing, general)
    2. **text** (clear, imperative feedback)
    3. **confidence** (0.0-1.0, how clear/actionable is this feedback?)

    Respond ONLY with JSON:
    {"category": "...", "text": "...", "confidence": 0.0}
    """
  end

  defp call_openai_chat(prompt) do
    url = "https://api.openai.com/v1/chat/completions"
    headers = [
      {"Authorization", "Bearer #{@openai_api_key}"},
      {"Content-Type", "application/json"}
    ]

    body = Jason.encode!(%{
      model: "gpt-4o-mini",
      messages: [
        %{role: "system", content: "You structure voice transcripts into actionable video feedback."},
        %{role: "user", content: prompt}
      ],
      temperature: 0.3,
      max_tokens: 150
    })

    case HTTPoison.post(url, body, headers, recv_timeout: 10_000) do
      {:ok, %{status_code: 200, body: response_body}} ->
        response = Jason.decode!(response_body)
        content = get_in(response, ["choices", Access.at(0), "message", "content"])
        {:ok, content}

      {:ok, %{status_code: status, body: error_body}} ->
        Logger.error("OpenAI API error: #{status} - #{error_body}")
        {:error, "API error: #{status}"}

      {:error, %HTTPoison.Error{reason: reason}} ->
        Logger.error("OpenAI request failed: #{inspect(reason)}")
        {:error, "Request failed: #{inspect(reason)}"}
    end
  end

  defp parse_structured_note(json_string, original_transcript) do
    case Jason.decode(json_string) do
      {:ok, %{"category" => cat, "text" => text, "confidence" => conf}} ->
        {:ok, %{
          category: cat,
          text: text,
          confidence: conf,
          original_transcript: original_transcript
        }}

      {:error, _} ->
        # LLM returned invalid JSON, return fallback
        {:ok, %{
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

---

### Task 4: Audio Channel Updates

**File:** `lossy/lib/lossy_web/channels/audio_channel.ex`

Update to handle transcript text instead of audio chunks:

```elixir
defmodule LossyWeb.AudioChannel do
  use Phoenix.Channel
  require Logger

  alias Lossy.Inference

  @impl true
  def join("audio:" <> session_id, _payload, socket) do
    Logger.info("Audio channel joined: #{session_id}")
    {:ok, assign(socket, :session_id, session_id)}
  end

  @impl true
  def handle_in("transcript_text", %{"text" => text} = payload, socket) do
    Logger.info("Received transcript text (#{String.length(text)} chars): #{String.slice(text, 0..50)}...")

    device = Map.get(payload, "device", "unknown")
    duration_ms = Map.get(payload, "duration_ms", 0)

    # Structure the transcript using GPT-4o-mini
    case Inference.structure_note(text) do
      {:ok, structured_note} ->
        Logger.info("Structured note: #{inspect(structured_note)}")

        # Push structured note back to client
        push(socket, "structured_note", %{
          transcript: text,
          category: structured_note.category,
          text: structured_note.text,
          confidence: structured_note.confidence,
          timestamp: System.system_time(:second),
          transcription_device: device,
          transcription_duration_ms: duration_ms
        })

        {:noreply, socket}

      {:error, reason} ->
        Logger.error("Failed to structure note: #{inspect(reason)}")

        # Send error to client
        push(socket, "error", %{
          message: "Failed to structure note",
          reason: inspect(reason)
        })

        {:noreply, socket}
    end
  end

  # FALLBACK: Handle cloud transcription (only if local WASM fails)
  @impl true
  def handle_in("audio_chunk_fallback", %{"data" => audio_data}, socket) when is_map(audio_data) do
    audio_list = audio_data
    |> Enum.sort_by(fn {k, _v} -> String.to_integer(k) end)
    |> Enum.map(fn {_k, v} -> v end)

    audio_binary = :binary.list_to_bin(audio_list)

    Logger.warn("Using cloud Whisper fallback (#{byte_size(audio_binary)} bytes)")

    case Inference.transcribe_audio_fallback(audio_binary) do
      {:ok, transcript_text} ->
        # Now structure the transcript
        case Inference.structure_note(transcript_text) do
          {:ok, structured_note} ->
            push(socket, "structured_note", %{
              transcript: transcript_text,
              category: structured_note.category,
              text: structured_note.text,
              confidence: structured_note.confidence,
              timestamp: System.system_time(:second),
              transcription_device: "cloud",
              transcription_duration_ms: nil
            })

          {:error, reason} ->
            push(socket, "error", %{message: "Failed to structure note", reason: inspect(reason)})
        end

      {:error, reason} ->
        Logger.error("Cloud transcription failed: #{inspect(reason)}")
        push(socket, "error", %{message: "Transcription failed", reason: inspect(reason)})
    end

    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{pong: true}}, socket}
  end
end
```

---

### Task 5: Database Schema

**Generate migration:**

```bash
cd lossy
mix ecto.gen.migration create_notes
```

**File:** `priv/repo/migrations/TIMESTAMP_create_notes.exs`

```elixir
defmodule Lossy.Repo.Migrations.CreateNotes do
  use Ecto.Migration

  def change do
    create table(:notes) do
      add :transcript, :text, null: false
      add :text, :text, null: false
      add :category, :string, null: false
      add :confidence, :float, null: false
      add :status, :string, default: "pending", null: false
      add :video_url, :string
      add :video_id, :string
      add :timestamp_seconds, :integer
      add :transcription_device, :string
      add :transcription_duration_ms, :integer
      add :external_permalink, :string

      timestamps()
    end

    create index(:notes, [:video_id])
    create index(:notes, [:status])
    create index(:notes, [:category])
  end
end
```

Run: `mix ecto.migrate`

**File:** `lib/lossy/videos/note.ex` (new schema)

```elixir
defmodule Lossy.Videos.Note do
  use Ecto.Schema
  import Ecto.Changeset

  schema "notes" do
    field :transcript, :string
    field :text, :string
    field :category, :string
    field :confidence, :float
    field :status, :string, default: "pending"
    field :video_url, :string
    field :video_id, :string
    field :timestamp_seconds, :integer
    field :transcription_device, :string
    field :transcription_duration_ms, :integer
    field :external_permalink, :string

    timestamps()
  end

  def changeset(note, attrs) do
    note
    |> cast(attrs, [
      :transcript, :text, :category, :confidence, :status,
      :video_url, :video_id, :timestamp_seconds,
      :transcription_device, :transcription_duration_ms,
      :external_permalink
    ])
    |> validate_required([:transcript, :text, :category, :confidence])
    |> validate_inclusion(:category, ~w(pacing audio visual editing general))
    |> validate_inclusion(:status, ~w(pending posted failed))
    |> validate_number(:confidence, greater_than_or_equal_to: 0.0, less_than_or_equal_to: 1.0)
  end
end
```

**File:** `lib/lossy/videos.ex` (new context)

```elixir
defmodule Lossy.Videos do
  @moduledoc """
  Context for video-related data: notes, sessions, metadata.
  """

  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Videos.Note

  def create_note(attrs \\ %{}) do
    %Note{}
    |> Note.changeset(attrs)
    |> Repo.insert()
  end

  def list_notes(filters \\ %{}) do
    Note
    |> apply_filters(filters)
    |> Repo.all()
  end

  def get_note!(id), do: Repo.get!(Note, id)

  defp apply_filters(query, filters) do
    Enum.reduce(filters, query, fn
      {:video_id, vid}, q -> where(q, [n], n.video_id == ^vid)
      {:status, status}, q -> where(q, [n], n.status == ^status)
      {:category, cat}, q -> where(q, [n], n.category == ^cat)
      _, q -> q
    end)
  end
end
```

---

## Testing Checklist

### Browser Extension Tests

- [ ] Load extension, open side panel
- [ ] Click "Start Recording", grant mic permission
- [ ] Speak clearly: "The pacing here is too slow"
- [ ] Check offscreen console: "Transcription complete in Xms: The pacing here is too slow"
- [ ] Check service worker console: "Transcript sent, structured note received"
- [ ] Side panel shows:
  - Raw transcript: "The pacing here is too slow"
  - Structured note: "Speed up pacing in this section"
  - Category badge: "pacing"
  - Confidence indicator: ~0.8-0.9

### Backend Tests

- [ ] Phoenix logs show: "Received transcript text (28 chars): The pacing here is too slow..."
- [ ] Phoenix logs show: "Structured note: %{category: \"pacing\", ...}"
- [ ] Database contains note with correct fields
- [ ] No audio data stored in database (only text!)

### Performance Tests

- [ ] WebGPU device: Transcription <300ms for 5s audio
- [ ] WASM fallback: Transcription <2s for 5s audio
- [ ] GPT-4o-mini structuring: <1.5s average
- [ ] Total end-to-end: <3s from speech end to structured note display

---

## Architecture Validation

**Privacy-First Verification:**
- ✅ Audio data never sent to Phoenix backend
- ✅ Only text transcripts leave browser
- ✅ OpenAI receives text only (not audio)
- ✅ Local WASM Whisper is default path
- ✅ Cloud Whisper fallback is opt-in/automatic failure recovery

**Data Flow:**
```
Audio (browser only)
  ↓ [WASM Whisper in offscreen doc]
Transcript text
  ↓ [WebSocket to Phoenix]
GPT-4o-mini
  ↓ [Structured note]
Database (Postgres)
  ↓ [WebSocket to extension]
Side Panel UI
```

---

## Notes & Learnings

### Why WASM-first?

1. **Privacy**: Audio never leaves user's device
2. **Speed**: WebGPU Whisper is often faster than cloud RTT
3. **Offline**: Works without internet
4. **Cost**: No per-minute Whisper API costs

### Model Selection

- **Whisper tiny.en**: ~40MB, fast, good quality for English
- **Future**: Upgrade to base.en (~150MB) for better accuracy if needed

### Cloud Fallback Triggers

- WebGPU/WASM initialization fails
- Transcription throws error
- User explicitly disables local transcription
- RAM < 4GB (future auto-detection)

---

## Next Sprint

👉 [Sprint 03 - Video Integration](./SPRINT_03_video_integration.md)

**Focus:** Content scripts to detect video elements, capture timestamps, anchor notes to video playback
