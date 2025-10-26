defmodule LossyWeb.ChannelJoinLimiter do
  @moduledoc """
  Lightweight in-memory guard that limits how frequently a device can attempt
  to join Phoenix channels. The extension should cache tokens, so repeated
  joins within a short interval indicate either an error loop or potential
  abuse.
  """

  @table :lossy_channel_join_attempts

  @spec allow?(String.t(), keyword()) :: :ok | {:error, :rate_limited | :invalid_device}
  def allow?(device_id, opts \\ [])

  def allow?(device_id, opts) when is_binary(device_id) do
    limit = Keyword.get(opts, :limit, 10)
    window = Keyword.get(opts, :window, 60_000)
    now = System.system_time(:millisecond)

    ensure_table!()

    case :ets.lookup(@table, device_id) do
      [] ->
        :ets.insert(@table, {device_id, {1, now}})
        :ok

      [{^device_id, {count, first_ts}}] ->
        cond do
          now - first_ts > window ->
            :ets.insert(@table, {device_id, {1, now}})
            :ok

          count + 1 > limit ->
            {:error, :rate_limited}

          true ->
            :ets.insert(@table, {device_id, {count + 1, first_ts}})
            :ok
        end
    end
  end

  def allow?(_device_id, _opts), do: {:error, :invalid_device}

  defp ensure_table! do
    case :ets.whereis(@table) do
      :undefined ->
        :ets.new(@table, [
          :named_table,
          :public,
          :set,
          read_concurrency: true,
          write_concurrency: true
        ])

      _ ->
        :ok
    end
  end
end
