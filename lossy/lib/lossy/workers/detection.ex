defmodule Lossy.Workers.Detection do
  @moduledoc """
  Oban worker for running object detection on documents.

  Runs multiple detection pipelines in parallel:
  1. Text detection (existing PP-OCRv3 regions from extension, or server-side)
  2. Object segmentation (SAM 2 via Replicate)

  Results are saved as DetectedRegion records and broadcast to LiveView.
  """

  use Oban.Worker, queue: :ml, max_attempts: 3

  require Logger
  alias Lossy.{Documents, Assets, Repo}
  alias Lossy.Documents.{DetectedRegion, Asset}
  alias Lossy.ML.SAM

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"document_id" => document_id}}) do
    Logger.info("Starting detection job", document_id: document_id)

    document = Documents.get_document(document_id)

    if document && document.original_asset_id do
      run_detection(document)
    else
      Logger.error("Document or asset not found", document_id: document_id)
      {:error, :document_not_found}
    end
  end

  defp run_detection(document) do
    # Update status to detecting
    {:ok, document} = Documents.update_document(document, %{status: :detecting})
    broadcast_update(document)

    original_asset = Repo.get!(Asset, document.original_asset_id)
    image_path = Assets.asset_path(original_asset)

    # Create output directory for masks
    mask_dir = Path.join(["priv", "static", "uploads", document.id, "masks"])
    File.mkdir_p!(mask_dir)

    # Run SAM 2 detection
    case run_sam_detection(document, image_path, mask_dir) do
      {:ok, regions} ->
        # Save regions to database
        saved_regions = save_regions(document.id, regions)
        Logger.info("Saved #{length(saved_regions)} detected regions")

        # Update status and broadcast
        {:ok, document} = Documents.update_document(document, %{status: :ready})
        broadcast_masks(document, saved_regions)
        :ok

      {:error, reason} ->
        Logger.error("Detection failed: #{inspect(reason)}")
        {:ok, _} = Documents.update_document(document, %{status: :ready})
        # Still mark as ready - detection failure shouldn't block editing
        {:error, reason}
    end
  end

  defp run_sam_detection(document, image_path, mask_dir) do
    Logger.info("Running SAM 2 detection", document_id: document.id)

    case SAM.segment_everything(image_path) do
      {:ok, output} ->
        SAM.download_and_create_regions(document.id, output, mask_dir)

      {:error, :api_key_not_configured} ->
        Logger.warning("Replicate API key not configured, skipping SAM detection")
        {:ok, []}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp save_regions(document_id, regions) do
    Enum.map(regions, fn region ->
      attrs = %{
        document_id: document_id,
        type: region.type,
        bbox: region.bbox,
        mask_path: region.mask_path,
        polygon: region.polygon,
        confidence: region.confidence,
        metadata: region.metadata,
        z_index: region.z_index,
        status: :detected
      }

      changeset = DetectedRegion.changeset(%DetectedRegion{}, attrs)

      case Repo.insert(changeset) do
        {:ok, saved_region} ->
          saved_region

        {:error, changeset} ->
          Logger.error("Failed to save region: #{inspect(changeset.errors)}")
          nil
      end
    end)
    |> Enum.filter(&(&1 != nil))
  end

  defp broadcast_update(document) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  defp broadcast_masks(document, regions) do
    # Convert regions to serializable format for frontend
    masks = Enum.map(regions, fn region ->
      %{
        id: region.id,
        type: Atom.to_string(region.type),
        bbox: region.bbox,
        mask_url: mask_path_to_url(region.mask_path, document.id),
        confidence: region.confidence,
        z_index: region.z_index
      }
    end)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:masks_detected, masks}
    )
  end

  defp mask_path_to_url(nil, _document_id), do: nil
  defp mask_path_to_url(mask_path, document_id) do
    # Convert file path to web URL
    # e.g., "priv/static/uploads/abc/masks/mask_0.png" -> "/uploads/abc/masks/mask_0.png"
    filename = Path.basename(mask_path)
    "/uploads/#{document_id}/masks/#{filename}"
  end
end
