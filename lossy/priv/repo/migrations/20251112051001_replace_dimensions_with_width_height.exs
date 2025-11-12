defmodule Lossy.Repo.Migrations.ReplaceDimensionsWithWidthHeight do
  use Ecto.Migration

  def change do
    alter table(:documents) do
      remove :dimensions
      add :width, :integer
      add :height, :integer
    end
  end
end
