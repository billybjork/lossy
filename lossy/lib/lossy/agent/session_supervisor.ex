defmodule Lossy.Agent.SessionSupervisor do
  use DynamicSupervisor

  def start_link(init_arg) do
    DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  def start_session(session_id, opts \\ []) do
    child_spec = %{
      id: Lossy.Agent.Session,
      start: {Lossy.Agent.Session, :start_link, [[session_id: session_id] ++ opts]},
      restart: :transient
    }

    DynamicSupervisor.start_child(__MODULE__, child_spec)
  end

  def stop_session(session_id) do
    case Registry.lookup(Lossy.Agent.SessionRegistry, session_id) do
      [{pid, _}] ->
        DynamicSupervisor.terminate_child(__MODULE__, pid)

      [] ->
        {:error, :not_found}
    end
  end
end
