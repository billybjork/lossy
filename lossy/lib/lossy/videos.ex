defmodule Lossy.Videos do
  @moduledoc """
  Context for video-related data: videos, notes, sessions.
  """

  import Ecto.Query
  alias Lossy.Repo
  alias Lossy.Videos.{Video, Note}

  # Videos

  def find_or_create_video(attrs) do
    case get_video_by_platform_id(attrs[:platform], attrs[:external_id]) do
      nil ->
        %Video{}
        |> Video.changeset(attrs)
        |> Repo.insert()

      video ->
        {:ok, video}
    end
  end

  def get_video_by_platform_id(platform, external_id) do
    Repo.get_by(Video, platform: platform, external_id: external_id)
  end

  # Notes

  def create_note(attrs \\ %{}) do
    # For Sprint 02 MVP, we'll default timestamp_seconds to 0.0 if not provided
    # and we won't require user_id since we're not handling authentication yet
    attrs = Map.put_new(attrs, :timestamp_seconds, 0.0)

    %Note{}
    |> Note.changeset(attrs)
    |> Repo.insert()
  end

  def list_notes(filters \\ %{}) do
    Note
    |> apply_filters(filters)
    |> order_by([n], desc: n.inserted_at)
    |> Repo.all()
  end

  def get_note!(id), do: Repo.get!(Note, id)

  def update_note(note, attrs) do
    note
    |> Note.changeset(attrs)
    |> Repo.update()
  end

  defp apply_filters(query, filters) do
    Enum.reduce(filters, query, fn
      {:video_id, vid}, q -> where(q, [n], n.video_id == ^vid)
      {:user_id, uid}, q -> where(q, [n], n.user_id == ^uid)
      {:status, status}, q -> where(q, [n], n.status == ^status)
      {:category, cat}, q -> where(q, [n], n.category == ^cat)
      _, q -> q
    end)
  end
end
