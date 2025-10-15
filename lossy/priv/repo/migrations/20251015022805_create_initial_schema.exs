defmodule Lossy.Repo.Migrations.CreateInitialSchema do
  use Ecto.Migration

  def change do
    # Users table
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :email, :string, null: false
      add :password_hash, :string, null: false
      add :name, :string
      timestamps()
    end

    create unique_index(:users, [:email])

    # Videos table
    create table(:videos, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :platform, :string, null: false  # "youtube", "vimeo", "air"
      add :external_id, :string, null: false  # Platform's video ID
      add :url, :text, null: false
      add :title, :string
      add :duration_seconds, :float
      add :thumbnail_url, :text
      timestamps()
    end

    create index(:videos, [:user_id])
    create unique_index(:videos, [:platform, :external_id])

    # Notes table
    create table(:notes, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :video_id, references(:videos, type: :binary_id, on_delete: :delete_all), null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :text, :text, null: false
      add :raw_transcript, :text  # Original transcript before LLM structuring
      add :timestamp_seconds, :float, null: false
      add :category, :string  # pacing, audio, color, graphics, content, other
      add :confidence, :float  # 0.0-1.0 from LLM
      add :status, :string, null: false, default: "ghost"  # ghost, firmed, pending_post, posting, posted, failed, cancelled
      add :posted_at, :utc_datetime
      add :platform_comment_id, :string  # External platform's comment ID
      add :external_permalink, :text  # Link to posted comment
      add :error, :text  # Error message if posting failed
      timestamps()
    end

    create index(:notes, [:video_id, :timestamp_seconds])
    create index(:notes, [:user_id, :status])
    create index(:notes, [:user_id, :inserted_at])

    # Platform connections table (for Browserbase sessions)
    create table(:platform_connections, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :platform, :string, null: false  # "youtube", "vimeo", "air"
      add :browserbase_session_id, :string
      add :status, :string, null: false, default: "awaiting_auth"  # awaiting_auth, active, expired, logged_out, failed
      add :verified_at, :utc_datetime
      add :last_used_at, :utc_datetime
      timestamps()
    end

    create unique_index(:platform_connections, [:user_id, :platform])

    # Agent sessions table (for recovery/persistence)
    create table(:agent_sessions, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :video_id, references(:videos, type: :binary_id, on_delete: :nilify_all)
      add :status, :string, null: false, default: "idle"  # idle, listening, paused, transcribing, etc.
      add :audio_buffer_size, :integer, default: 0
      add :audio_duration_seconds, :float, default: 0.0
      add :last_activity_at, :utc_datetime
      add :metadata, :map, default: %{}  # JSON blob for additional state
      timestamps()
    end

    create index(:agent_sessions, [:user_id])
    create index(:agent_sessions, [:status, :last_activity_at])

    # Audio chunks table (temporary storage before processing)
    create table(:audio_chunks, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :agent_session_id, references(:agent_sessions, type: :binary_id, on_delete: :delete_all), null: false
      add :sequence, :integer, null: false
      add :audio_data, :binary  # Raw audio bytes
      add :processed, :boolean, default: false
      timestamps()
    end

    create index(:audio_chunks, [:agent_session_id, :sequence])
    create index(:audio_chunks, [:processed])

    # Oban jobs table
    Oban.Migration.up(version: 12)
  end
end
