defmodule Lossy.Repo.Migrations.AddVideoLibraryFields do
  use Ecto.Migration

  def up do
    alter table(:videos) do
      # Lifecycle status
      add :status, :string
      # Values: "queued", "in_progress", "complete", "archived"

      # Timestamps for sorting and filtering
      add :last_viewed_at, :utc_datetime
      add :queued_at, :utc_datetime
      add :completed_at, :utc_datetime

      # Future: Metadata for embeddings, custom fields, etc.
      # (JSONB chosen over map for PostgreSQL-specific indexing support)
      add :metadata, :map, default: %{}
      # Format (future): %{
      #   embedding: [1024 floats],           # Video-level summary embedding
      #   tags: ["tutorial", "color-grading"], # User-defined tags
      #   project_id: "uuid",                  # Project grouping
      #   source_file_url: "s3://...",         # Original media file
      #   custom: %{}                          # Extensible user data
      # }
    end

    # Backfill status based on note count
    # Videos with notes → "in_progress"
    # Videos without notes → "queued" (user queued but hasn't started)
    execute("""
      UPDATE videos
      SET status = CASE
        WHEN EXISTS (SELECT 1 FROM notes WHERE notes.video_id = videos.id) THEN 'in_progress'
        ELSE 'queued'
      END,
      last_viewed_at = COALESCE(
        (SELECT MAX(inserted_at) FROM notes WHERE notes.video_id = videos.id),
        videos.inserted_at
      )
    """)

    # Now make status non-nullable with default
    alter table(:videos) do
      modify :status, :string, null: false, default: "in_progress"
    end

    # Indexes for efficient queries
    create index(:videos, [:status])
    create index(:videos, [:last_viewed_at])
    create index(:videos, [:user_id, :last_viewed_at])
    create index(:videos, [:user_id, :status, :last_viewed_at])

    # Full-text search index (future - commented for Sprint 10)
    # execute("CREATE INDEX videos_title_search_idx ON videos USING gin(to_tsvector('english', title))")
  end

  def down do
    alter table(:videos) do
      remove :status
      remove :last_viewed_at
      remove :queued_at
      remove :completed_at
      remove :metadata
    end

    drop_if_exists index(:videos, [:status])
    drop_if_exists index(:videos, [:last_viewed_at])
    drop_if_exists index(:videos, [:user_id, :last_viewed_at])
    drop_if_exists index(:videos, [:user_id, :status, :last_viewed_at])
  end
end
