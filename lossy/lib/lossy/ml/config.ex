defmodule Lossy.ML.Config do
  @moduledoc """
  Centralized configuration access for ML services.
  """

  # Replicate model versions
  @lama_model_version "allenhooo/lama:cdac78a1bec5b23c07fd29692fb70baa513ea403a39e643c48ec5edadb15fe72"

  @doc """
  Gets the fal.ai API key from application config.
  Raises if not configured.
  """
  def fal_api_key do
    case Application.get_env(:lossy, :ml_services)[:fal_api_key] do
      nil ->
        raise """
        FAL_API_KEY environment variable is not set.
        Please set it in your environment or .env file:

            export FAL_API_KEY="your-api-key"

        Then source the file or restart your application.
        """

      key ->
        key
    end
  end

  @doc """
  Gets the fal.ai API key, returning {:ok, key} or {:error, :not_configured}.
  Useful for graceful degradation.
  """
  def fetch_fal_api_key do
    case Application.get_env(:lossy, :ml_services)[:fal_api_key] do
      nil -> {:error, :not_configured}
      key -> {:ok, key}
    end
  end

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
end
