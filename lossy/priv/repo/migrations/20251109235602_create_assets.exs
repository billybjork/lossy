defmodule Lossy.Repo.Migrations.CreateAssets do
  use Ecto.Migration

  def change do
    create table(:assets, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :document_id, :binary_id, null: false
      add :kind, :string, null: false
      add :storage_uri, :string, null: false
      add :width, :integer
      add :height, :integer
      add :sha256, :string
      add :metadata, :map, default: %{}

      timestamps()
    end

    create index(:assets, [:document_id])
    create index(:assets, [:sha256])
  end
end
