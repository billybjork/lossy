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

  def list_notes_by_video(video_id) do
    Note
    |> where([n], n.video_id == ^video_id)
    |> order_by([n], asc: n.timestamp_seconds)
    |> Repo.all()
    |> Enum.map(&note_to_map/1)
  end

  defp note_to_map(note) do
    %{
      id: note.id,
      text: note.text,
      category: note.category,
      timestamp_seconds: note.timestamp_seconds,
      confidence: note.confidence,
      status: note.status
    }
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
