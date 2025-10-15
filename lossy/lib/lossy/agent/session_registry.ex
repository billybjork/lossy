defmodule Lossy.Agent.SessionRegistry do
  @moduledoc """
  Registry for AgentSession processes.
  Allows lookup by session_id.
  """

  def child_spec(_opts) do
    Registry.child_spec(
      keys: :unique,
      name: __MODULE__
    )
  end
end
