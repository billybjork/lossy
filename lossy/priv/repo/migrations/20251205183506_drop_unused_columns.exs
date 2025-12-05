defmodule Lossy.Repo.Migrations.DropUnusedColumns do
  use Ecto.Migration

  def change do
    # Drop unused columns from documents table
    alter table(:documents) do
      remove :metrics, :map, default: %{}
      remove :source_url_verified_at, :utc_datetime
      remove :source_url_status, :string, default: "not_checked"
    end

    # Drop unused column from detected_regions table
    alter table(:detected_regions) do
      remove :inpainted_asset_id, references(:assets, type: :binary_id)
    end

    # Drop index on source_url_status
    drop_if_exists index(:documents, [:source_url_status])
  end
end
