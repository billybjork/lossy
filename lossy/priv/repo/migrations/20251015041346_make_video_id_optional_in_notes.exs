defmodule Lossy.Repo.Migrations.MakeVideoIdOptionalInNotes do
  use Ecto.Migration

  def change do
    alter table(:notes) do
      modify :video_id, :binary_id, null: true
    end
  end
end
