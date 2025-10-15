defmodule Lossy.Repo.Migrations.MakeUserIdNullableInVideos do
  use Ecto.Migration

  def change do
    alter table(:videos) do
      modify :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: true
    end
  end
end
