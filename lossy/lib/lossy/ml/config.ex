defmodule Lossy.ML.Config do
  @moduledoc """
  Centralized configuration access for ML services.
  """

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
end
