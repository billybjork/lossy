defmodule Lossy.Inference.Cloud do
  @moduledoc """
  OpenAI API integration for Whisper transcription and GPT-4o-mini note structuring.

  Sprint 07: Migrated from HTTPoison to Req for consistency.
  """

  require Logger

  @whisper_url "https://api.openai.com/v1/audio/transcriptions"
  @chat_url "https://api.openai.com/v1/chat/completions"

  @doc """
  Transcribe audio using OpenAI Whisper API.
  Accepts audio binary (WebM/Opus format from browser).
  """
  def transcribe_audio(audio_binary) when is_binary(audio_binary) do
    Logger.info("Transcribing audio with Whisper API (#{byte_size(audio_binary)} bytes)")

    # Build multipart form using Multipart library (Req doesn't support binary file uploads directly)
    multipart =
      Multipart.new()
      |> Multipart.add_part(Multipart.Part.text_field("whisper-1", "model"))
      |> Multipart.add_part(Multipart.Part.text_field("en", "language"))
      |> Multipart.add_part(Multipart.Part.text_field("json", "response_format"))
      |> Multipart.add_part(
        Multipart.Part.file_content_field("audio.webm", audio_binary, :file,
          filename: "audio.webm"
        )
      )

    content_length = Multipart.content_length(multipart)
    content_type = Multipart.content_type(multipart, "multipart/form-data")

    headers = [
      {"authorization", "Bearer #{get_api_key()}"},
      {"content-type", content_type},
      {"content-length", to_string(content_length)}
    ]

    response =
      Req.post(@whisper_url,
        headers: headers,
        body: Multipart.body_stream(multipart),
        receive_timeout: 30_000
      )

    case response do
      {:ok, %{status: 200, body: body}} ->
        transcript = Map.get(body, "text", "")
        {:ok, transcript}

      {:ok, %{status: status, body: body}} ->
        Logger.error("Whisper API error: #{status} - #{inspect(body)}")
        {:error, "Whisper API error: #{status}"}

      {:error, exception} ->
        Logger.error("Whisper request failed: #{inspect(exception)}")
        {:error, "Request failed: #{inspect(exception)}"}
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

  defp get_api_key do
    Application.get_env(:lossy, :openai_api_key) ||
      raise "OPENAI_API_KEY not configured"
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
    request_body = %{
      model: "gpt-4o-mini",
      messages: [
        %{
          role: "system",
          content:
            "You structure voice transcripts into actionable video feedback. Always respond with valid JSON."
        },
        %{role: "user", content: prompt}
      ],
      temperature: 0.3,
      max_tokens: 150
    }

    response =
      Req.post(@chat_url,
        auth: {:bearer, get_api_key()},
        json: request_body,
        receive_timeout: 15_000
      )

    case response do
      {:ok, %{status: 200, body: body}} ->
        content = get_in(body, ["choices", Access.at(0), "message", "content"])
        {:ok, content}

      {:ok, %{status: status, body: body}} ->
        Logger.error("OpenAI Chat API error: #{status} - #{inspect(body)}")
        {:error, "API error: #{status}"}

      {:error, exception} ->
        Logger.error("OpenAI Chat request failed: #{inspect(exception)}")
        {:error, "Request failed: #{inspect(exception)}"}
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
        Logger.warning("Failed to parse GPT-4o-mini response as JSON: #{json_string}")

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
