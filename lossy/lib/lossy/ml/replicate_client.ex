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
    Logger.info("Creating Replicate prediction", model: model_version)

    case Config.fetch_replicate_api_key() do
      {:ok, api_key} ->
        do_create_prediction(api_key, model_version, input)

      {:error, :not_configured} ->
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
        Logger.info("Prediction created",
          prediction_id: body["id"],
          status: body["status"]
        )

        {:ok, body}

      {:ok, %{status: status, body: body}} ->
        Logger.error("Replicate API error",
          status: status,
          error: body["error"] || body["detail"]
        )

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

  defp do_await_completion(prediction_id, attempt, max_attempts, _poll_interval)
       when attempt >= max_attempts do
    Logger.error("Prediction timed out", prediction_id: prediction_id, attempts: attempt)
    {:error, :timeout}
  end

  defp do_await_completion(prediction_id, attempt, max_attempts, poll_interval) do
    case get_prediction(prediction_id) do
      {:ok, %{"status" => "succeeded", "output" => output}} ->
        Logger.info("Prediction succeeded", prediction_id: prediction_id)
        {:ok, output}

      {:ok, %{"status" => "failed", "error" => error}} ->
        Logger.error("Prediction failed", prediction_id: prediction_id, error: error)
        {:error, {:prediction_failed, error}}

      {:ok, %{"status" => "canceled"}} ->
        Logger.warning("Prediction canceled", prediction_id: prediction_id)
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

  defp auth_headers(api_key) do
    [
      {"authorization", "Bearer #{api_key}"},
      {"content-type", "application/json"}
    ]
  end
end
