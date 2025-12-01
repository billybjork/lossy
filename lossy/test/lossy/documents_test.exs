defmodule Lossy.DocumentsTest do
  use Lossy.DataCase, async: true

  alias Lossy.Documents

  describe "create_capture/1" do
    test "creates a document with valid attributes" do
      attrs = %{
        source_url: "https://example.com",
        capture_mode: :screenshot
      }

      assert {:ok, document} = Documents.create_capture(attrs)
      assert document.source_url == "https://example.com"
      assert document.capture_mode == :screenshot
      assert document.status == :loading
    end

    test "returns error with invalid capture_mode" do
      attrs = %{
        source_url: "https://example.com",
        capture_mode: :invalid
      }

      assert {:error, changeset} = Documents.create_capture(attrs)
      assert %{capture_mode: _} = errors_on(changeset)
    end

    test "returns error with missing required fields" do
      assert {:error, changeset} = Documents.create_capture(%{})
      errors = errors_on(changeset)
      assert %{source_url: _} = errors
      assert %{capture_mode: _} = errors
    end
  end

  describe "update_document/2" do
    test "updates document status" do
      {:ok, document} =
        Documents.create_capture(%{
          source_url: "https://example.com",
          capture_mode: :screenshot
        })

      assert {:ok, updated} = Documents.update_document(document, %{status: :detecting})
      assert updated.status == :detecting
    end

    test "validates status values" do
      {:ok, document} =
        Documents.create_capture(%{
          source_url: "https://example.com",
          capture_mode: :screenshot
        })

      # Invalid status value
      assert {:error, changeset} = Documents.update_document(document, %{status: :invalid_status})
      assert %{status: _} = errors_on(changeset)
    end
  end
end
