defmodule Lossy.Repo.Migrations.CreateProcessingJobs do
  use Ecto.Migration

  def change do
    create table(:processing_jobs, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :document_id, references(:documents, type: :binary_id, on_delete: :delete_all),
        null: false

      add :text_region_id, references(:text_regions, type: :binary_id, on_delete: :delete_all)
      add :subject_type, :string, null: false
      add :type, :string, null: false
      add :payload, :map, default: %{}
      add :status, :string, null: false, default: "queued"
      add :attempts, :integer, default: 0
      add :max_attempts, :integer, default: 3
      add :locked_at, :utc_datetime
      add :error_message, :text

      timestamps()
    end

    create index(:processing_jobs, [:document_id])
    create index(:processing_jobs, [:text_region_id])
    create index(:processing_jobs, [:status])
    create index(:processing_jobs, [:document_id, :status])
    create index(:processing_jobs, [:locked_at])
  end
end
