defmodule Lossy.Repo.Migrations.CreateTextRegions do
  use Ecto.Migration

  def change do
    create table(:text_regions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :document_id, references(:documents, type: :binary_id, on_delete: :delete_all),
        null: false

      add :bbox, :map, null: false
      add :polygon, {:array, :map}
      add :padding_px, :integer, default: 10
      add :original_text, :text
      add :current_text, :text
      add :style_snapshot, :map, default: %{}
      add :font_family, :string, default: "Inter"
      add :font_weight, :integer, default: 400
      add :font_size_px, :integer, default: 16
      add :color_rgba, :string, default: "rgba(0,0,0,1)"
      add :alignment, :string, default: "left"
      add :inpainted_asset_id, references(:assets, type: :binary_id, on_delete: :nilify_all)
      add :z_index, :integer, default: 0
      add :status, :string, default: "detected"

      timestamps()
    end

    create index(:text_regions, [:document_id])
    create index(:text_regions, [:status])
    create index(:text_regions, [:inpainted_asset_id])
    create index(:text_regions, [:document_id, :status])
  end
end
