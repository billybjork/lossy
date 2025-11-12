defmodule Lossy.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      LossyWeb.Telemetry,
      Lossy.Repo,
      {DNSCluster, query: Application.get_env(:lossy, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Lossy.PubSub},
      # Oban job processing
      {Oban, Application.fetch_env!(:lossy, Oban)},
      # Task supervisor for async job processing
      {Task.Supervisor, name: Lossy.TaskSupervisor},
      # Start a worker by calling: Lossy.Worker.start_link(arg)
      # {Lossy.Worker, arg},
      # Start to serve requests, typically the last entry
      LossyWeb.Endpoint
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Lossy.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    LossyWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
