defmodule Lossy.Repo.Migrations.AddDetectedRegionsAndHistory do
  use Ecto.Migration

  def change do
    # Add history support to documents
    alter table(:documents) do
      add :history, :jsonb, default: "[]"
      add :history_index, :integer, default: 0
    end

    # Create detected_regions table for generalized object detection
    create table(:detected_regions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :document_id, references(:documents, on_delete: :delete_all, type: :binary_id),
        null: false

      # Region type: text, object, or manual
      add :type, :string, null: false, default: "object"

      # Bounding box for quick hit-testing
      add :bbox, :map


      add :mask_path, :string

      # Polygon outline for rendering
      add :polygon, {:array, :map}

      # Detection confidence
      add :confidence, :float, default: 1.0

      # Flexible metadata
      add :metadata, :map, default: %{}

      # Z-index for layering
      add :z_index, :integer, default: 0

      # Processing status
      add :status, :string, default: "detected"

      # Reference to inpainted result


      timestamps()
    end

    create index(:detected_regions, [:document_id])
    create index(:detected_regions, [:type])
    create index(:detected_regions, [:status])
  end
end
