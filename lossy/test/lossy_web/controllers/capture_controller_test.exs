defmodule LossyWeb.CaptureControllerTest do
  use LossyWeb.ConnCase, async: true

  alias Lossy.Documents

  describe "POST /api/captures" do
    test "creates a capture with screenshot mode", %{conn: conn} do
      params = %{
        "source_url" => "https://example.com",
        "capture_mode" => "screenshot",
        "image_data" =>
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      }

      conn = post(conn, ~p"/api/captures", params)
      assert %{"id" => id, "status" => status} = json_response(conn, 201)
      assert is_binary(id)
      assert status in ["queued_detection", "detecting"]

      # Verify document was created
      document = Documents.get_document(id)
      assert document.source_url == "https://example.com"
      assert document.capture_mode == :screenshot
      assert document.original_asset_id != nil
    end

    test "creates a capture with direct_asset mode", %{conn: conn} do
      params = %{
        "source_url" => "https://example.com/image.png",
        "capture_mode" => "direct_asset",
        "image_data" =>
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      }

      conn = post(conn, ~p"/api/captures", params)
      assert %{"id" => id} = json_response(conn, 201)
      assert is_binary(id)
    end

    test "returns error with invalid capture_mode", %{conn: conn} do
      params = %{
        "source_url" => "https://example.com",
        "capture_mode" => "invalid"
      }

      conn = post(conn, ~p"/api/captures", params)
      assert %{"errors" => _errors} = json_response(conn, 422)
    end

    test "returns error with missing required fields", %{conn: conn} do
      params = %{}
      conn = post(conn, ~p"/api/captures", params)
      assert %{"errors" => errors} = json_response(conn, 422)
      assert Map.has_key?(errors, "source_url") or Map.has_key?(errors, "capture_mode")
    end
  end
end
