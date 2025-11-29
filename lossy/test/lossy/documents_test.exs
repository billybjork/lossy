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
      assert document.status == :queued_detection
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

    test "validates status transitions" do
      {:ok, document} =
        Documents.create_capture(%{
          source_url: "https://example.com",
          capture_mode: :screenshot
        })

      # Invalid transition: queued_detection -> export_ready
      assert {:error, changeset} = Documents.update_document(document, %{status: :export_ready})
      assert %{status: _} = errors_on(changeset)
    end
  end

  describe "create_text_regions_from_local_detection/2" do
    test "creates text regions from local detection results" do
      {:ok, document} =
        Documents.create_capture(%{
          source_url: "https://example.com",
          capture_mode: :screenshot
        })

      text_regions = [
        %{
          "bbox" => %{"x" => 10, "y" => 20, "w" => 100, "h" => 30},
          "polygon" => [%{"x" => 10, "y" => 20}, %{"x" => 110, "y" => 50}],
          "confidence" => 0.95
        },
        %{
          "bbox" => %{"x" => 50, "y" => 100, "w" => 200, "h" => 40},
          "polygon" => [],
          "confidence" => 0.87
        }
      ]

      assert {:ok, 2} = Documents.create_text_regions_from_local_detection(document, text_regions)

      # Verify regions were created
      updated_document = Documents.get_document(document.id)
      assert length(updated_document.text_regions) == 2
    end
  end
end
