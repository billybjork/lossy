defmodule Lossy.AssetsTest do
  use Lossy.DataCase, async: true

  alias Lossy.{Assets, Documents}

  # 1x1 pixel PNG (base64 encoded)
  @valid_image_data "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  @invalid_base64 "data:image/png;base64,invalid!!!"

  setup do
    {:ok, document} =
      Documents.create_capture(%{
        source_url: "https://example.com",
        capture_mode: :screenshot
      })

    %{document: document}
  end

  describe "save_image_from_base64/3" do
    test "saves a valid base64 image", %{document: document} do
      assert {:ok, asset} =
               Assets.save_image_from_base64(document.id, @valid_image_data, :original)

      assert asset.document_id == document.id
      assert asset.kind == :original
      assert asset.width > 0
      assert asset.height > 0
      assert asset.sha256 != nil
      assert asset.storage_uri =~ document.id
    end

    test "returns error for invalid base64 data", %{document: document} do
      assert {:error, :invalid_base64} =
               Assets.save_image_from_base64(document.id, @invalid_base64, :original)
    end

    test "returns error for unsupported content type", %{document: document} do
      # data:text/plain is not an allowed content type
      invalid_data = "data:text/plain;base64,SGVsbG8gV29ybGQ="

      assert {:error, :unsupported_content_type} =
               Assets.save_image_from_base64(document.id, invalid_data, :original)
    end
  end

  describe "public_url/1" do
    test "converts storage path to public URL", %{document: document} do
      {:ok, asset} = Assets.save_image_from_base64(document.id, @valid_image_data, :original)
      url = Assets.public_url(asset)
      assert String.starts_with?(url, "/uploads/")
      assert url =~ document.id
    end
  end

  describe "get_asset/1" do
    test "retrieves an asset by ID", %{document: document} do
      {:ok, asset} = Assets.save_image_from_base64(document.id, @valid_image_data, :original)
      retrieved = Assets.get_asset(asset.id)
      assert retrieved.id == asset.id
      assert retrieved.document_id == document.id
    end

    test "returns nil for non-existent asset" do
      assert Assets.get_asset(Ecto.UUID.generate()) == nil
    end
  end
end
