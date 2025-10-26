defmodule LossyWeb.VideoChannel do
  @moduledoc """
  Phoenix Channel for video metadata and note management.

  Handles real-time communication for:
  - Video detection and record creation
  - Note CRUD operations (create, read, update, delete)
  - Visual intelligence features (Sprint 08: GPT-4o Vision refinement)

  Channel topic: `video:meta`
  """

  use Phoenix.Channel
  require Logger

  alias Lossy.Videos
  alias LossyWeb.ChannelAuth

  # Platform whitelist for validation (Sprint 15 Milestone 1)
  # Full adapter logic deferred to Milestone 1.5
  @supported_platforms [
    "youtube",
    "frameio",
    "vimeo",
    "iconik",
    "air",
    "wipster",
    "tiktok",
    "generic"
  ]

  @impl true
  def join("video:meta", payload, socket) do
    case ChannelAuth.authorize_join(socket, payload) do
      {:ok, authed_socket, auth_payload} ->
        Logger.info("[VideoChannel] Joined video metadata channel")
        response = Map.put(auth_payload, :scope, %{"type" => "meta"})
        {:ok, response, authed_socket}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl true
  def handle_in(
        "video_detected",
        %{"platform" => platform, "videoId" => video_id} = payload,
        socket
      ) do
    Logger.info("[VideoChannel] Video detected: #{platform}/#{video_id}")

    # Validate platform (Sprint 15 Milestone 1)
    unless platform in @supported_platforms do
      Logger.warning("[VideoChannel] Unknown platform detected: #{platform} (will create record anyway)")
    end

    url = Map.get(payload, "url")
    title = Map.get(payload, "title")
    user_id = Map.get(socket.assigns, :user_id)

    case Videos.find_or_create_video(%{
           platform: platform,
           external_id: video_id,
           url: url,
           title: title,
           user_id: user_id
         }) do
      {:ok, video} ->
        Logger.info("[VideoChannel] Video record created/found: #{video.id}")

        # Include platform metadata in response for debugging
        {:reply,
         {:ok,
          %{
            video_id: video.id,
            platform: platform,
            platform_supported: platform in @supported_platforms
          }}, socket}

      {:error, changeset} ->
        Logger.error("[VideoChannel] Failed to create video: #{inspect(changeset)}")
        {:reply, {:error, %{message: "Failed to create video"}}, socket}
    end
  end

  @impl true
  def handle_in("get_notes", %{"video_id" => video_id}, socket) do
    Logger.info("[VideoChannel] Fetching notes for video: #{video_id}")

    notes = Videos.list_notes_by_video(video_id)

    {:reply, {:ok, %{notes: notes}}, socket}
  end

  @impl true
  def handle_in("delete_note", %{"note_id" => note_id}, socket) do
    Logger.info("[VideoChannel] Deleting note: #{note_id}")

    case Videos.delete_note(note_id) do
      {:ok, _note} ->
        Logger.info("[VideoChannel] Note deleted successfully: #{note_id}")
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        Logger.error("[VideoChannel] Failed to delete note: #{inspect(reason)}")
        {:reply, {:error, %{message: "Failed to delete note"}}, socket}
    end
  end

  # Sprint 08: Enrich note with visual context (embedding storage)
  @impl true
  def handle_in("enrich_note", payload, socket) do
    note_id = Map.fetch!(payload, "note_id")
    embedding = Map.fetch!(payload, "embedding")
    timestamp = Map.fetch!(payload, "timestamp")
    source = Map.get(payload, "source", "local")
    device = Map.get(payload, "device", "unknown")

    Logger.info(
      "[VideoChannel] Enriching note #{note_id} with visual context (#{source}, #{device}, #{length(embedding)} dims)"
    )

    # Create visual context map
    visual_context = %{
      embedding: embedding,
      timestamp: timestamp,
      source: source,
      device: device
    }

    # Update note with visual context
    case Videos.update_note_visual_context(note_id, visual_context) do
      {:ok, updated_note} ->
        Logger.info("[VideoChannel] Note enriched successfully: #{note_id}")

        # Convert to map for JSON serialization (don't expose embedding in response)
        note_response = %{
          id: updated_note.id,
          text: updated_note.text,
          enrichment_source: updated_note.enrichment_source,
          updated_at: updated_note.updated_at
        }

        {:reply, {:ok, %{note: note_response}}, socket}

      {:error, reason} ->
        Logger.error("[VideoChannel] Failed to enrich note: #{inspect(reason)}")
        {:reply, {:error, %{message: "Failed to enrich note"}}, socket}
    end
  end

  # Sprint 08: Refine note with GPT-4o Vision
  @impl true
  def handle_in("refine_note_with_vision", payload, socket) do
    note_id = Map.fetch!(payload, "note_id")
    frame_base64 = Map.fetch!(payload, "frame_base64")
    _timestamp = Map.get(payload, "timestamp")

    Logger.info("[VideoChannel] Refining note #{note_id} with GPT-4o Vision")

    # Get current note
    note = Videos.get_note!(note_id)

    # Call GPT-4o Vision to refine note text
    case Lossy.Inference.VisionAPI.refine_note(note.text, frame_base64) do
      {:ok, refined_text} ->
        Logger.info("[VideoChannel] Note refined successfully: #{note_id}")

        # Update note with refined text
        case Videos.update_note(note, %{
               text: refined_text,
               enrichment_source: "gpt4o_vision"
             }) do
          {:ok, updated_note} ->
            # Broadcast updated note to all listeners
            Phoenix.PubSub.broadcast(
              Lossy.PubSub,
              "video:#{note.video_id}",
              {:note_updated, updated_note}
            )

            {:reply, {:ok, %{refined_text: refined_text}}, socket}

          {:error, update_reason} ->
            Logger.error("[VideoChannel] Failed to update note: #{inspect(update_reason)}")
            {:reply, {:error, %{message: "Failed to update note"}}, socket}
        end

      {:error, reason} ->
        Logger.error("[VideoChannel] Vision refinement failed: #{inspect(reason)}")
        {:reply, {:error, %{message: "Vision refinement failed"}}, socket}
    end
  end

  # Sprint 09: Video library management
  @impl true
  def handle_in("list_videos", %{"filters" => filters}, socket) do
    user_id = Map.get(socket.assigns, :user_id)

    Logger.info("[VideoChannel] Listing videos for user: #{inspect(user_id)} with filters: #{inspect(filters)}")

    videos =
      Videos.list_user_videos(user_id,
        status: filters["status"],
        platform: filters["platform"],
        search: filters["search"],
        limit: Map.get(filters, "limit", 100)
      )

    {:reply, {:ok, %{videos: serialize_videos(videos)}}, socket}
  end

  @impl true
  def handle_in("update_video_status", %{"video_id" => video_id, "status" => status}, socket) do
    Logger.info("[VideoChannel] Updating video #{video_id} status to: #{status}")

    case Videos.update_video_status(video_id, status) do
      {:ok, video} ->
        # Broadcast to all connected clients for this user
        if video.user_id do
          Phoenix.PubSub.broadcast(
            Lossy.PubSub,
            "user:#{video.user_id}",
            {:video_updated, serialize_video(video)}
          )
        end

        {:reply, :ok, socket}

      {:error, _changeset} ->
        Logger.error("[VideoChannel] Failed to update video status")
        {:reply, {:error, %{reason: "Invalid status transition"}}, socket}
    end
  end

  @impl true
  def handle_in("queue_video", video_attrs, socket) do
    # TODO: Get user_id from socket.assigns once authentication is implemented
    user_id = Map.get(socket.assigns, :user_id)

    Logger.info("[VideoChannel] Queueing video for user: #{inspect(user_id)}")

    # Convert string keys to atoms for consistency
    video_attrs_normalized = %{
      platform: video_attrs["platform"],
      external_id: video_attrs["external_id"],
      url: video_attrs["url"],
      title: video_attrs["title"],
      thumbnail_url: video_attrs["thumbnail_url"]
    }

    case Videos.queue_video(user_id, video_attrs_normalized) do
      {:ok, video} ->
        # Broadcast to all connected clients for this user
        if user_id do
          Phoenix.PubSub.broadcast(
            Lossy.PubSub,
            "user:#{user_id}",
            {:video_queued, serialize_video(video)}
          )
        end

        {:reply, {:ok, serialize_video(video)}, socket}

      {:error, changeset} ->
        Logger.error("[VideoChannel] Failed to queue video: #{inspect(changeset)}")
        {:reply, {:error, %{reason: "Failed to queue video"}}, socket}
    end
  end

  # Serialization helpers
  defp serialize_videos(videos) do
    Enum.map(videos, &serialize_video/1)
  end

  defp serialize_video(video) do
    %{
      id: video.id,
      platform: video.platform,
      external_id: video.external_id,
      url: video.url,
      title: video.title,
      thumbnail_url: video.thumbnail_url,
      duration_seconds: video.duration_seconds,
      status: video.status,
      last_viewed_at: video.last_viewed_at,
      note_count: Map.get(video, :note_count, 0),
      inserted_at: video.inserted_at
    }
  end
end
