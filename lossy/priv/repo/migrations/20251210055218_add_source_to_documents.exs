defmodule Lossy.Repo.Migrations.AddSourceToDocuments do
  use Ecto.Migration

  def change do
    # Create the source enum type
    execute(
      "CREATE TYPE document_source AS ENUM ('extension', 'upload')",
      "DROP TYPE document_source"
    )

    alter table(:documents) do
      add :source, :document_source, default: "extension", null: false
    end

    # Make source_url nullable (was required before)
    execute(
      "ALTER TABLE documents ALTER COLUMN source_url DROP NOT NULL",
      "ALTER TABLE documents ALTER COLUMN source_url SET NOT NULL"
    )
  end
end
