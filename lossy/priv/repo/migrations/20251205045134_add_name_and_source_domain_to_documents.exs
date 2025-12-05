defmodule Lossy.Repo.Migrations.AddNameAndSourceDomainToDocuments do
  use Ecto.Migration

  def change do
    alter table(:documents) do
      add :name, :string
      add :source_domain, :string
    end

    # Unique index on name (only for non-null values)
    create unique_index(:documents, [:name], where: "name IS NOT NULL")
    # Index on source_domain for filtering by domain
    create index(:documents, [:source_domain])
  end
end
