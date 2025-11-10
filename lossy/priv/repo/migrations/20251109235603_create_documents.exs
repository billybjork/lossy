defmodule Lossy.Repo.Migrations.CreateDocuments do
  use Ecto.Migration

  def change do
    create table(:documents, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all)
      add :source_url, :string, null: false
      add :capture_mode, :string, null: false
      add :dimensions, :map
      add :original_asset_id, references(:assets, type: :binary_id, on_delete: :nilify_all)
      add :working_asset_id, references(:assets, type: :binary_id, on_delete: :nilify_all)
      add :status, :string, null: false, default: "queued_detection"
      add :metrics, :map, default: %{}

      timestamps()
    end

    create index(:documents, [:user_id])
    create index(:documents, [:status])
    create index(:documents, [:original_asset_id])
    create index(:documents, [:working_asset_id])
  end
end
