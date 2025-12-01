defmodule Lossy.ML.ReplicateClient do
  @moduledoc """
  HTTP client for Replicate API.

  Uses Req for HTTP requests as per project guidelines.
  Handles prediction creation, polling, and result retrieval.
  """

  require Logger
  alias Lossy.ML.Config

  @base_url "https://api.replicate.com/v1"
  @poll_interval_ms 1000
  @max_poll_attempts 60

  @doc """
  Create a new prediction.

  Returns the prediction object with status, id, and URLs for polling.
  """
  def create_prediction(model_version, input) do
    case Config.fetch_replicate_api_key() do
      {:ok, api_key} ->
        do_create_prediction(api_key, model_version, input)

      {:error, :not_configured} ->
        Logger.error("Replicate API key not configured")
        {:error, :api_key_not_configured}
    end
  end

  defp do_create_prediction(api_key, model_version, input) do
    body = %{
      version: model_version,
      input: input
    }

    case Req.post("#{@base_url}/predictions",
           json: body,
           headers: auth_headers(api_key),
           receive_timeout: 30_000
         ) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        {:ok, body}

      {:ok, %{status: status, body: body}} ->
        error_detail = body["error"] || body["detail"] || inspect(body)
        Logger.error("Replicate API error: #{error_detail} (HTTP #{status})")
        {:error, {:api_error, status, body}}

      {:error, reason} ->
        Logger.error("Replicate request failed", reason: inspect(reason))
        {:error, {:request_failed, reason}}
    end
  end

  @doc """
  Get the current status of a prediction.
  """
  def get_prediction(prediction_id) do
    case Config.fetch_replicate_api_key() do
      {:ok, api_key} ->
        do_get_prediction(api_key, prediction_id)

      {:error, :not_configured} ->
        {:error, :api_key_not_configured}
    end
  end

  defp do_get_prediction(api_key, prediction_id) do
    case Req.get("#{@base_url}/predictions/#{prediction_id}",
           headers: auth_headers(api_key),
           receive_timeout: 30_000
         ) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        {:ok, body}

      {:ok, %{status: status, body: body}} ->
        {:error, {:api_error, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end

  @doc """
  Wait for a prediction to complete.

  Polls the prediction status until it succeeds, fails, or times out.
  Returns {:ok, output} on success, {:error, reason} on failure.
  """
  def await_completion(prediction_id, opts \\ []) do
    max_attempts = Keyword.get(opts, :max_attempts, @max_poll_attempts)
    poll_interval = Keyword.get(opts, :poll_interval_ms, @poll_interval_ms)

    do_await_completion(prediction_id, 0, max_attempts, poll_interval)
  end

  defp do_await_completion(_prediction_id, attempt, max_attempts, _poll_interval)
       when attempt >= max_attempts do
    Logger.error("Replicate prediction timed out after #{attempt} attempts")
    {:error, :timeout}
  end

  defp do_await_completion(prediction_id, attempt, max_attempts, poll_interval) do
    case get_prediction(prediction_id) do
      {:ok, %{"status" => "succeeded", "output" => output}} ->
        {:ok, output}

      {:ok, %{"status" => "failed", "error" => error}} ->
        Logger.error("Replicate prediction failed: #{error}")
        {:error, {:prediction_failed, error}}

      {:ok, %{"status" => "canceled"}} ->
        {:error, :canceled}

      {:ok, %{"status" => status}} when status in ["starting", "processing"] ->
        # Still running, wait and poll again
        Process.sleep(poll_interval)
        do_await_completion(prediction_id, attempt + 1, max_attempts, poll_interval)

      {:error, reason} ->
        # Transient error, retry
        if attempt < 3 do
          Process.sleep(poll_interval)
          do_await_completion(prediction_id, attempt + 1, max_attempts, poll_interval)
        else
          {:error, reason}
        end
    end
  end

  @doc """
  Run a prediction synchronously.

  Creates the prediction and waits for completion.
  Returns {:ok, output} on success.
  """
  def run(model_version, input, opts \\ []) do
    with {:ok, prediction} <- create_prediction(model_version, input) do
      await_completion(prediction["id"], opts)
    end
  end

  @doc """
  Upload a file to Replicate's file hosting.

  Returns {:ok, url} where url is a signed URL that Replicate can access.
  Use this for files larger than 256KB that can't use data URLs.
  """
  def upload_file(file_path) do
    case Config.fetch_replicate_api_key() do
      {:ok, api_key} ->
        do_upload_file(api_key, file_path)

      {:error, :not_configured} ->
        {:error, :api_key_not_configured}
    end
  end

  defp do_upload_file(api_key, file_path) do
    filename = Path.basename(file_path)
    content_type = mime_type_for(file_path)

    case File.read(file_path) do
      {:ok, file_data} ->
        # Replicate's files API uses multipart upload
        multipart =
          {:multipart,
           [
             {:file, file_data,
              {"form-data", [name: "file", filename: filename]},
              [{"content-type", content_type}]}
           ]}

        Req.post("#{@base_url}/files",
          body: multipart,
          headers: [{"authorization", "Bearer #{api_key}"}],
          receive_timeout: 60_000
        )
        |> handle_upload_response()

      {:error, reason} ->
        {:error, {:file_read_failed, reason}}
    end
  end

  defp handle_upload_response({:ok, %{status: status, body: %{"urls" => %{"get" => url}}}})
       when status in 200..299 do
    Logger.info("File uploaded to Replicate", url: url)
    {:ok, url}
  end

  defp handle_upload_response({:ok, %{status: status, body: body}}) when status in 200..299 do
    Logger.error("Unexpected file upload response: #{inspect(body)}")
    {:error, :unexpected_response}
  end

  defp handle_upload_response({:ok, %{status: status, body: body}}) do
    Logger.error("File upload failed: #{inspect(body)} (HTTP #{status})")
    {:error, {:upload_failed, status, body}}
  end

  defp handle_upload_response({:error, reason}) do
    Logger.error("File upload request failed", reason: inspect(reason))
    {:error, {:request_failed, reason}}
  end

  defp mime_type_for(path) do
    case Path.extname(path) |> String.downcase() do
      ".png" -> "image/png"
      ".jpg" -> "image/jpeg"
      ".jpeg" -> "image/jpeg"
      ".webp" -> "image/webp"
      _ -> "application/octet-stream"
    end
  end

  defp auth_headers(api_key) do
    [
      {"authorization", "Bearer #{api_key}"},
      {"content-type", "application/json"}
    ]
  end
end
