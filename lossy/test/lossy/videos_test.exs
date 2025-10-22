defmodule Lossy.VideosTest do
  use Lossy.DataCase

  alias Lossy.Videos
  alias Lossy.Videos.{Video, Note}

  describe "video library" do
    test "list_user_videos/2 returns videos sorted by last_viewed_at" do
      user_id = Ecto.UUID.generate()

      {:ok, video1} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "video1",
          url: "https://youtube.com/watch?v=video1",
          last_viewed_at: ~U[2025-10-20 10:00:00Z]
        })

      {:ok, video2} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "video2",
          url: "https://youtube.com/watch?v=video2",
          last_viewed_at: ~U[2025-10-21 12:00:00Z]
        })

      videos = Videos.list_user_videos(user_id)

      assert length(videos) == 2
      # Most recent first
      assert hd(videos).id == video2.id
    end

    test "list_user_videos/2 filters by status" do
      user_id = Ecto.UUID.generate()

      {:ok, queued} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "queued_video",
          url: "https://youtube.com/watch?v=queued",
          status: "queued"
        })

      {:ok, _complete} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "complete_video",
          url: "https://youtube.com/watch?v=complete",
          status: "complete"
        })

      results = Videos.list_user_videos(user_id, status: "queued")

      assert length(results) == 1
      assert hd(results).id == queued.id
    end

    test "list_user_videos/2 searches by title" do
      user_id = Ecto.UUID.generate()

      {:ok, match} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "tutorial_video",
          url: "https://youtube.com/watch?v=tutorial",
          title: "Color Grading Tutorial"
        })

      {:ok, _no_match} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "audio_video",
          url: "https://youtube.com/watch?v=audio",
          title: "Audio Mixing Guide"
        })

      results = Videos.list_user_videos(user_id, search: "color")

      assert length(results) == 1
      assert hd(results).id == match.id
    end

    test "list_user_videos/2 includes note count" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "test_video",
          url: "https://youtube.com/watch?v=test"
        })

      # Create 3 notes for this video
      {:ok, _note1} =
        Videos.create_note(%{
          video_id: video.id,
          text: "Test note 1",
          timestamp_seconds: 10.0
        })

      {:ok, _note2} =
        Videos.create_note(%{
          video_id: video.id,
          text: "Test note 2",
          timestamp_seconds: 20.0
        })

      {:ok, _note3} =
        Videos.create_note(%{
          video_id: video.id,
          text: "Test note 3",
          timestamp_seconds: 30.0
        })

      videos = Videos.list_user_videos(user_id)

      assert length(videos) == 1
      video_with_count = hd(videos)
      assert video_with_count.note_count == 3
    end

    test "update_video_status/2 sets queued_at timestamp" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "status_video",
          url: "https://youtube.com/watch?v=status",
          status: "in_progress"
        })

      {:ok, updated} = Videos.update_video_status(video.id, "queued")

      assert updated.status == "queued"
      assert updated.queued_at != nil
    end

    test "update_video_status/2 sets completed_at timestamp" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "complete_video",
          url: "https://youtube.com/watch?v=complete",
          status: "in_progress"
        })

      {:ok, updated} = Videos.update_video_status(video.id, "complete")

      assert updated.status == "complete"
      assert updated.completed_at != nil
    end

    test "touch_video/1 updates last_viewed_at" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "touch_video",
          url: "https://youtube.com/watch?v=touch",
          last_viewed_at: ~U[2025-01-01 00:00:00Z]
        })

      {:ok, touched} = Videos.touch_video(video.id)

      assert DateTime.compare(touched.last_viewed_at, ~U[2025-01-01 00:00:00Z]) == :gt
    end

    test "touch_video/1 auto-transitions queued → in_progress" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "transition_video",
          url: "https://youtube.com/watch?v=transition",
          status: "queued"
        })

      {:ok, updated} = Videos.touch_video(video.id)

      assert updated.status == "in_progress"
      assert updated.last_viewed_at != nil
    end

    test "touch_video/1 does not change status if already in_progress" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "no_transition_video",
          url: "https://youtube.com/watch?v=no_transition",
          status: "in_progress"
        })

      {:ok, updated} = Videos.touch_video(video.id)

      assert updated.status == "in_progress"
    end

    test "queue_video/2 creates video with queued status" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.queue_video(user_id, %{
          platform: "youtube",
          external_id: "queue_test",
          url: "https://youtube.com/watch?v=queue_test",
          title: "Queued Video Test"
        })

      assert video.status == "queued"
      assert video.user_id == user_id
      assert video.queued_at != nil
    end

    test "create_note/1 touches video (updates last_viewed_at)" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "note_touch_video",
          url: "https://youtube.com/watch?v=note_touch",
          last_viewed_at: ~U[2025-01-01 00:00:00Z]
        })

      {:ok, _note} =
        Videos.create_note(%{
          video_id: video.id,
          text: "Test note",
          timestamp_seconds: 10.0
        })

      # Reload video to see updated last_viewed_at
      updated_video = Repo.get!(Video, video.id)

      assert DateTime.compare(updated_video.last_viewed_at, ~U[2025-01-01 00:00:00Z]) == :gt
    end

    test "create_note/1 auto-transitions video from queued to in_progress" do
      user_id = Ecto.UUID.generate()

      {:ok, video} =
        Videos.find_or_create_video(%{
          user_id: user_id,
          platform: "youtube",
          external_id: "auto_transition_video",
          url: "https://youtube.com/watch?v=auto_transition",
          status: "queued"
        })

      assert video.status == "queued"

      {:ok, _note} =
        Videos.create_note(%{
          video_id: video.id,
          text: "First note triggers transition",
          timestamp_seconds: 10.0
        })

      # Reload video to see status change
      updated_video = Repo.get!(Video, video.id)

      assert updated_video.status == "in_progress"
    end
  end
end
