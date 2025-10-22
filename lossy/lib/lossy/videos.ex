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

  # Sprint 09: Video library queries

  @doc """
  Lists videos for the given user, ordered by most recently viewed.
  Includes note count and supports filtering by status and search term.

  ## Options
  - `:status` - Filter by status (queued, in_progress, complete, archived)
  - `:platform` - Filter by platform (youtube, vimeo, etc.)
  - `:search` - Text search on title/URL (case-insensitive)
  - `:limit` - Max results (default: 100)

  ## Returns
  List of videos with preloaded note_count virtual field.
  """
  def list_user_videos(user_id, opts \\ []) do
    query =
      if user_id do
        where(Video, [v], v.user_id == ^user_id)
      else
        where(Video, [v], is_nil(v.user_id))
      end

    query
    |> apply_video_filters(opts)
    |> order_by([v], desc: v.last_viewed_at, desc: v.inserted_at)
    |> limit(^Keyword.get(opts, :limit, 100))
    |> join(:left, [v], n in Note, on: n.video_id == v.id)
    |> group_by([v], v.id)
    |> select_merge([v, n], %{note_count: count(n.id)})
    |> Repo.all()
  end

  @doc """
  Updates last_viewed_at to current time and auto-transitions status if needed.

  Called when:
  - User creates a note on the video
  - User opens the video (if we add playback tracking later)

  Auto-transitions:
  - "queued" → "in_progress" when first note is created
  """
  def touch_video(video_id) do
    video = Repo.get!(Video, video_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)
    attrs = %{last_viewed_at: now}

    # Auto-transition: queued → in_progress when first note created
    attrs =
      if video.status == "queued" do
        Map.put(attrs, :status, "in_progress")
      else
        attrs
      end

    update_video(video, attrs)
  end

  @doc """
  Transitions video to new status and sets appropriate timestamp.
  """
  def update_video_status(video_id, new_status)
      when new_status in ~w(queued in_progress complete archived) do
    video = Repo.get!(Video, video_id)
    update_video(video, %{status: new_status})
  end

  @doc """
  Queues a video for later review. Creates video record if doesn't exist.
  """
  def queue_video(user_id, video_attrs) do
    case find_or_create_video(Map.put(video_attrs, :user_id, user_id)) do
      {:ok, video} ->
        update_video_status(video.id, "queued")

      {:error, changeset} ->
        {:error, changeset}
    end
  end

  # Future: Agent query interface (Sprint 10+)
  @doc """
  (FUTURE) Get videos filtered by platform, tags, or note categories.
  Example: Get all YouTube videos with notes in 'pacing' category.

  ## Examples
      iex> Videos.get_videos_for_context(user_id,
            platform: "youtube",
            note_categories: ["pacing", "audio"],
            limit: 5
          )

  This is a placeholder for agent context retrieval in future sprints.
  """
  def get_videos_for_context(_user_id, _opts \\ []) do
    # TODO: Implement in Sprint 10 (semantic search)
    # Will support:
    # - Embedding similarity search (pgvector)
    # - Note category filtering
    # - Platform filtering
    # - Date range filtering
    # - Full-text search

    raise "Not implemented - planned for Sprint 10"
  end

  defp apply_video_filters(query, opts) do
    Enum.reduce(opts, query, fn
      {:status, nil}, q -> q
      {:status, status}, q -> where(q, [v], v.status == ^status)

      {:platform, nil}, q -> q
      {:platform, platform}, q -> where(q, [v], v.platform == ^platform)

      {:search, nil}, q -> q
      {:search, ""}, q -> q
      {:search, term}, q ->
        pattern = "%#{term}%"
        where(q, [v], ilike(v.title, ^pattern) or ilike(v.url, ^pattern))

      _, q ->
        q
    end)
  end

  defp update_video(video, attrs) do
    video
    |> Video.changeset(attrs)
    |> Repo.update()
  end

  # Notes

  def create_note(attrs \\ %{}) do
    result =
      %Note{}
      |> Note.changeset(attrs)
      |> Repo.insert()

    # Sprint 09: Touch video when note is created (updates last_viewed_at and auto-transitions status)
    case result do
      {:ok, note} ->
        if note.video_id do
          touch_video(note.video_id)
        end

        {:ok, note}

      error ->
        error
    end
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

  # Sprint 08: Update note with visual context
  def update_note_visual_context(note_id, visual_context) do
    note = Repo.get!(Note, note_id)

    note
    |> Note.changeset(%{
      visual_context: visual_context,
      enrichment_source: "siglip_#{visual_context.source}"
    })
    |> Repo.update()
  end

  def delete_note(id) do
    case Repo.get(Note, id) do
      nil ->
        {:error, :not_found}

      note ->
        Repo.delete(note)
    end
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
