defmodule Lossy.Repo.Migrations.MakeVideosUserIdNullableV2 do
  use Ecto.Migration

  def up do
    alter table(:videos) do
      modify :user_id, :binary_id, null: true
    end
  end

  def down do
    # Can't easily reverse this without data loss, so leave as no-op
    # If you need to make user_id NOT NULL again, create a new migration
  end
end
