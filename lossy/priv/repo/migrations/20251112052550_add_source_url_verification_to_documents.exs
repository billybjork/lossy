defmodule Lossy.Repo.Migrations.AddSourceUrlVerificationToDocuments do
  use Ecto.Migration

  def change do
    alter table(:documents) do
      add :source_url_verified_at, :utc_datetime
      add :source_url_status, :string, default: "not_checked"
    end

    create index(:documents, [:source_url_status])
  end
end
