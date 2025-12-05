defmodule Lossy.Documents.Naming do
  @moduledoc """
  Generates human-readable document names in format: lossy-YYYYMMDD-NNN
  where NNN is a daily incrementing sequence number.
  """

  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Documents.Document

  @doc """
  Generates the next available name for today.

  Format: lossy-YYYYMMDD-NNN where NNN is daily incrementing (001, 002, etc.)

  ## Examples

      iex> Lossy.Documents.Naming.generate_name()
      "lossy-20251204-001"

  """
  def generate_name do
    today = Date.utc_today()
    date_str = Calendar.strftime(today, "%Y%m%d")
    prefix = "lossy-#{date_str}-"

    next_number = get_next_daily_number(prefix)

    "#{prefix}#{String.pad_leading(Integer.to_string(next_number), 3, "0")}"
  end

  defp get_next_daily_number(prefix) do
    # Query for documents starting with today's prefix
    pattern = "#{prefix}%"

    query =
      from d in Document,
        where: like(d.name, ^pattern),
        select: d.name

    existing_names = Repo.all(query)

    if Enum.empty?(existing_names) do
      1
    else
      # Extract numbers and find max
      max_num =
        existing_names
        |> Enum.map(&extract_sequence_number(&1, prefix))
        |> Enum.max()

      max_num + 1
    end
  end

  defp extract_sequence_number(name, prefix) do
    case String.replace_prefix(name, prefix, "") do
      "" ->
        0

      num_str ->
        case Integer.parse(num_str) do
          {num, _} -> num
          :error -> 0
        end
    end
  end

  @doc """
  Extracts domain from a URL, removing www. prefix.

  ## Examples

      iex> Lossy.Documents.Naming.extract_domain("https://www.nytimes.com/article")
      "nytimes.com"

      iex> Lossy.Documents.Naming.extract_domain("https://example.com:8080/path")
      "example.com"

      iex> Lossy.Documents.Naming.extract_domain(nil)
      nil

  """
  def extract_domain(nil), do: nil

  def extract_domain(url) when is_binary(url) do
    case URI.parse(url) do
      %URI{host: nil} ->
        nil

      %URI{host: host} ->
        host
        |> String.replace_prefix("www.", "")
        |> String.downcase()
    end
  end
end
