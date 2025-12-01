defmodule Lossy.ML.Config do
  @moduledoc """
  Centralized configuration access for ML services.
  """

  # Replicate model versions
  @lama_model_version "allenhooo/lama:cdac78a1bec5b23c07fd29692fb70baa513ea403a39e643c48ec5edadb15fe72"

  # SAM 2 - Meta's Segment Anything Model 2
  # Official meta/sam-2 model on Replicate
  # Supports automatic mask generation with points_per_side parameter
  @sam2_model_version "meta/sam-2:0e3c684b02f0af4add1e335d2c68eb43dd2ed5f5e5c08a11e42d52ec9cc93fce"

  @doc """
  Gets the Replicate API key from application config.
  Raises if not configured.
  """
  def replicate_api_key do
    case Application.get_env(:lossy, :ml_services)[:replicate_api_key] do
      nil ->
        raise """
        REPLICATE_API_TOKEN environment variable is not set.
        Please set it in your environment or .env file:

            export REPLICATE_API_TOKEN="your-api-key"

        Then source the file or restart your application.
        """

      key ->
        key
    end
  end

  @doc """
  Gets the Replicate API key, returning {:ok, key} or {:error, :not_configured}.
  """
  def fetch_replicate_api_key do
    case Application.get_env(:lossy, :ml_services)[:replicate_api_key] do
      nil -> {:error, :not_configured}
      key -> {:ok, key}
    end
  end

  @doc """
  Gets the LaMa model version for Replicate.
  """
  def lama_model_version, do: @lama_model_version

  @doc """
  Gets the SAM 2 model version for Replicate.
  """
  def sam2_model_version, do: @sam2_model_version
end
