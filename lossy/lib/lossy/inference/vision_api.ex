defmodule Lossy.Inference.VisionAPI do
  @moduledoc """
  Sprint 08: GPT-4o Vision API integration for visual note refinement.

  This module sends video frame images to GPT-4o Vision to refine note text
  based on visual context. Used for the "Refine with Vision" feature.

  Privacy note: This sends frame images to OpenAI's API. Only called when
  user explicitly triggers "Refine with Vision" button.
  """

  require Logger

  @doc """
  Refine a note's text using GPT-4o Vision analysis of a video frame.

  ## Parameters

    * `original_text` - The current note text to refine
    * `frame_base64` - Base64 encoded JPEG image of the video frame
    * `opts` - Options (optional)
      * `:model` - Model to use (default: "gpt-4o")
      * `:max_tokens` - Maximum tokens in response (default: 150)
      * `:temperature` - Sampling temperature (default: 0.7)

  ## Returns

    * `{:ok, refined_text}` - Successfully refined text
    * `{:error, reason}` - Failed to refine (API error, timeout, etc.)

  ## Examples

      iex> VisionAPI.refine_note("Slow pacing here", frame_base64)
      {:ok, "Slow pacing during product demo - consider cutting the repetitive UI walkthrough"}

  """
  def refine_note(original_text, frame_base64, opts \\ []) do
    model = Keyword.get(opts, :model, "gpt-4o")
    max_tokens = Keyword.get(opts, :max_tokens, 150)
    temperature = Keyword.get(opts, :temperature, 0.7)

    Logger.info(
      "[VisionAPI] Refining note with GPT-4o Vision (#{String.length(original_text)} chars)"
    )

    # TODO: Add cost tracking / rate limiting
    # GPT-4o Vision costs ~$0.01-0.03 per image
    # Consider: user quotas, daily limits, cost alerts

    prompt = build_refinement_prompt(original_text)

    messages = [
      %{
        role: "user",
        content: [
          %{
            type: "text",
            text: prompt
          },
          %{
            type: "image_url",
            image_url: %{
              url: "data:image/jpeg;base64,#{frame_base64}",
              # Lower cost, sufficient for video feedback
              detail: "low"
            }
          }
        ]
      }
    ]

    case call_openai_vision(messages, model, max_tokens, temperature) do
      {:ok, refined_text} ->
        Logger.info("[VisionAPI] ✅ Note refined successfully")
        {:ok, refined_text}

      {:error, reason} = error ->
        Logger.error("[VisionAPI] ❌ Failed to refine note: #{inspect(reason)}")
        error
    end
  end

  # Build the refinement prompt
  defp build_refinement_prompt(original_text) do
    """
    You are a video editing assistant helping improve video review comments by adding visual context.

    The user is reviewing a video and made this voice comment: "#{original_text}"

    Your task: Look at the video frame and improve the comment by adding specific visual details you observe.

    Guidelines:
    - Describe what you see in the frame (UI elements, text, images, people, objects, colors, composition)
    - Keep the response to 1-2 concise sentences
    - Make the comment more specific and actionable based on the visual content
    - Focus on production elements: editing, graphics, composition, visual effects, etc.
    - If the original comment is clear and the visual doesn't add value, just return the original text

    Examples:
    - Original: "The pacing is slow here" → Improved: "The pacing is slow during this product demo section - consider cutting the repetitive UI walkthrough"
    - Original: "Add more context" → Improved: "Add context about the blue soap bottles shown at 0:08"
    - Original: "This looks great" → Improved: "The transition from the soap display to the ocean cleanup footage at 0:08 looks great"

    Provide only the improved comment text, no explanation or meta-commentary:
    """
  end

  # Call OpenAI Chat Completion API with vision
  defp call_openai_vision(messages, model, max_tokens, temperature) do
    api_key = get_api_key()

    if api_key do
      make_vision_request(api_key, messages, model, max_tokens, temperature)
    else
      {:error, :missing_api_key}
    end
  end

  defp make_vision_request(api_key, messages, model, max_tokens, temperature) do
    url = "https://api.openai.com/v1/chat/completions"

    request_body = %{
      model: model,
      messages: messages,
      max_tokens: max_tokens,
      temperature: temperature
    }

    response =
      Req.post(url,
        auth: {:bearer, api_key},
        json: request_body,
        receive_timeout: 30_000
      )

    case response do
      {:ok, %{status: 200, body: body}} ->
        extract_refined_text(body)

      {:ok, %{status: status, body: body}} ->
        Logger.error("[VisionAPI] API error #{status}: #{inspect(body)}")
        {:error, {:api_error, status}}

      {:error, exception} ->
        Logger.error("[VisionAPI] Request failed: #{inspect(exception)}")
        {:error, {:request_failed, exception}}
    end
  end

  defp extract_refined_text(body) do
    content = get_in(body, ["choices", Access.at(0), "message", "content"])

    if content do
      # Trim whitespace and remove surrounding quotes if present
      refined_text =
        content
        |> String.trim()
        |> String.trim("\"")
        |> String.trim("'")

      {:ok, refined_text}
    else
      Logger.error("[VisionAPI] No content in API response: #{inspect(body)}")
      {:error, :no_content}
    end
  end

  defp get_api_key do
    Application.get_env(:lossy, :openai_api_key) ||
      System.get_env("OPENAI_API_KEY")
  end
end
