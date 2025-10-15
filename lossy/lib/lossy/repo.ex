defmodule Lossy.Repo do
  use Ecto.Repo,
    otp_app: :lossy,
    adapter: Ecto.Adapters.Postgres
end
