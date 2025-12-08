defmodule Lossy.Repo.Migrations.MigrateLegacyStatuses do
  use Ecto.Migration

  def up do
    # Migrate legacy document statuses to valid values
    execute """
    UPDATE documents SET status = 'ready'
    WHERE status IN ('awaiting_edits', 'export_ready', 'rendering')
    """

    execute """
    UPDATE documents SET status = 'loading'
    WHERE status IN ('processing', 'queued_detection')
    """

    # Migrate legacy processing_job types


    execute """
    UPDATE processing_jobs SET type = 'detection'
    WHERE type IN ('text_detection', 'font_guess')
    """

    # Remove legacy columns from processing_jobs
    alter table(:processing_jobs) do
      remove_if_exists :text_region_id, :binary_id
      remove_if_exists :subject_type, :string
    end
  end

  def down do
    # Add back the columns (data will be lost)
    # Note: text_region_id was a FK to text_regions table which no longer exists,
    # so we add it as a plain column for rollback compatibility
    alter table(:processing_jobs) do
      add :text_region_id, :binary_id
      add :subject_type, :string, default: "document"
    end
  end
end
