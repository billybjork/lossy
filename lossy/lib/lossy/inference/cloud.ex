defmodule Lossy.Inference.Cloud do
  @moduledoc """
  OpenAI API integration for Whisper transcription and GPT-4o-mini note structuring.
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
      {"Authorization", "Bearer #{get_api_key()}"},
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

  defp get_api_key do
    Application.get_env(:lossy, :openai_api_key) ||
      raise "OPENAI_API_KEY not configured"
  end

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
      {"Authorization", "Bearer #{get_api_key()}"},
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
