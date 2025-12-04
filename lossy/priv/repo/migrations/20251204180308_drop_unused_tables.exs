defmodule Lossy.Repo.Migrations.DropUnusedTables do
  use Ecto.Migration

  def change do
    # Remove user_id from documents (unused User scaffold)
    drop index(:documents, [:user_id])
    alter table(:documents) do
      remove :user_id
    end

    # Drop unused tables (order matters due to FK constraints)
    drop table(:processing_jobs)
    drop table(:text_regions)
    drop table(:users)
  end
end
