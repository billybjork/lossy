defmodule Lossy.DataCase do
  @moduledoc """
  This module defines the setup for tests requiring
  access to the application's data layer.

  You may define functions here to be used as helpers in
  your tests.

  Finally, if the test case interacts with the database,
  we enable the SQL sandbox, so changes done to the database
  are reverted at the end of every test. If you are using
  PostgreSQL, you can even run database tests asynchronously
  by setting `use Lossy.DataCase, async: true`, although
  this option is not recommended for other databases.
  """

  use ExUnit.CaseTemplate

  alias Ecto.Adapters.SQL.Sandbox

  @upload_dir "priv/static/uploads"

  using do
    quote do
      alias Lossy.Repo

      import Ecto
      import Ecto.Changeset
      import Ecto.Query
      import Lossy.DataCase
    end
  end

  setup tags do
    Lossy.DataCase.setup_sandbox(tags)

    # Clean up orphaned test uploads on test start
    # This handles any leftover files from crashed tests
    Lossy.DataCase.cleanup_orphaned_uploads()

    :ok
  end

  @doc """
  Sets up the sandbox based on the test tags.
  """
  def setup_sandbox(tags) do
    pid = Sandbox.start_owner!(Lossy.Repo, shared: not tags[:async])
    on_exit(fn -> Sandbox.stop_owner(pid) end)
  end

  @doc """
  Cleans up upload directories that don't have corresponding documents in the database.
  This handles orphaned files from tests that created uploads but rolled back the DB.
  """
  def cleanup_orphaned_uploads do
    upload_path = Path.join(File.cwd!(), @upload_dir)

    if File.exists?(upload_path) do
      upload_path
      |> File.ls!()
      |> Enum.filter(&uuid_folder?/1)
      |> Enum.each(fn folder ->
        folder_path = Path.join(upload_path, folder)

        if File.dir?(folder_path) do
          File.rm_rf!(folder_path)
        end
      end)
    end
  end

  # Check if a folder name looks like a UUID (test artifacts use document.id)
  defp uuid_folder?(name) do
    case Ecto.UUID.cast(name) do
      {:ok, _} -> true
      :error -> false
    end
  end

  @doc """
  A helper that transforms changeset errors into a map of messages.

      assert {:error, changeset} = Accounts.create_user(%{password: "short"})
      assert "password is too short" in errors_on(changeset).password
      assert %{password: ["password is too short"]} = errors_on(changeset)

  """
  def errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
