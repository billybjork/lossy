defmodule Lossy.Repo.Migrations.MakeUserIdOptionalInNotes do
  use Ecto.Migration

  def change do
    alter table(:notes) do
      modify :user_id, :binary_id, null: true
    end
  end
end
