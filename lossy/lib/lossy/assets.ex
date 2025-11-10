defmodule Lossy.Assets do
  @moduledoc """
  The Assets context for managing binary assets (images, masks, etc).
  """

  import Ecto.Query, warn: false
  alias Lossy.Repo
  alias Lossy.Documents.Asset

  @doc """
  Creates an asset.
  """
  def create_asset(attrs \\ %{}) do
    %Asset{}
    |> Asset.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Gets a single asset.
  """
  def get_asset(id) do
    Repo.get(Asset, id)
  end

  @doc """
  Returns the local file system path for an asset.
  For MVP, assumes storage_uri is a local path.
  """
  def local_path(%Asset{storage_uri: "file://" <> path}), do: path
  def local_path(%Asset{storage_uri: path}), do: path
end
