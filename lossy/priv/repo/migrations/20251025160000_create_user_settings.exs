defmodule Lossy.Repo.Migrations.CreateUserSettings do
  use Ecto.Migration

  def up do
    execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")

    create table(:user_settings, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :feature_flags, :map, null: false, default: %{}
      add :min_confidence, :float, null: false, default: 0.3
      add :preferred_protocol_version, :integer
      add :metadata, :map, null: false, default: %{}
      timestamps()
    end

    create unique_index(:user_settings, [:user_id])

    flush()

    execute("""
    INSERT INTO user_settings (
      id,
      user_id,
      feature_flags,
      min_confidence,
      preferred_protocol_version,
      metadata,
      inserted_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      id,
      '{}'::jsonb,
      0.3,
      NULL,
      '{}'::jsonb,
      now(),
      now()
    FROM users
    ON CONFLICT (user_id) DO NOTHING
    """)
  end

  def down do
    drop_if_exists(unique_index(:user_settings, [:user_id]))
    drop table(:user_settings)
  end
end
