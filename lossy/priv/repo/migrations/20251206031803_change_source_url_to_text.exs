defmodule Lossy.Repo.Migrations.ChangeSourceUrlToText do
  use Ecto.Migration

  def change do
    alter table(:documents) do
      modify :source_url, :text, from: :string
    end
  end
end
