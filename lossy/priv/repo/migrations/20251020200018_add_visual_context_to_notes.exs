defmodule Lossy.Repo.Migrations.AddVisualContextToNotes do
  use Ecto.Migration

  def change do
    alter table(:notes) do
      # Visual context: stores frame embedding + metadata
      # Format: %{embedding: [768 floats], timestamp: float, source: "local" | "cloud", device: "webgpu" | "wasm"}
      add :visual_context, :map, default: nil

      # Enrichment source: tracks how note was enriched
      add :enrichment_source, :string, default: "none"
      # Values: "none" | "siglip_local" | "siglip_cloud" | "manual"
    end

    # Index for filtering by enrichment source
    create index(:notes, [:enrichment_source])
  end
end
