defmodule Lossy.Repo.Migrations.AddEditingStatusToTextRegions do
  use Ecto.Migration

  def change do
    alter table(:text_regions) do
      add :editing_status, :string, default: "idle", null: false
    end

    # Add index for faster queries on editing_status
    create index(:text_regions, [:editing_status])
  end
end
