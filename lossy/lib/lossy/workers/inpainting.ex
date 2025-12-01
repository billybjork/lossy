defmodule Lossy.Workers.Inpainting do
  @moduledoc """
  Oban worker for processing inpainting jobs.

  Pipeline:
  1. Combine masks if multiple regions selected
  2. Call LaMa inpainting via Replicate
  3. Save result as working_asset
  4. Update history and broadcast
  """

  use Oban.Worker, queue: :ml, max_attempts: 3

  require Logger
  import Ecto.Query
  alias Lossy.{Documents, Assets, Repo}
  alias Lossy.Documents.{Asset, Document, HistoryEntry}
  alias Lossy.ML.Inpainting
  alias Lossy.ImageProcessing.Mask

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"document_id" => doc_id, "mask_paths" => mask_paths} = args}) do
    region_ids = Map.get(args, "region_ids", [])
    Logger.info("Starting batch inpainting job", document_id: doc_id, mask_count: length(mask_paths))

    document = Documents.get_document(doc_id)

    if document do
      process_batch_inpainting(document, mask_paths, region_ids)
    else
      {:error, :document_not_found}
    end
  end

  defp process_batch_inpainting(document, mask_paths, region_ids) do
    if is_nil(document.original_asset_id) do
      {:error, :no_image}
    else
      # Get current working image (or original if no working image yet)
      image_path = get_current_image_path(document)

      # Combine multiple masks into one for a single API call
      with {:ok, combined_mask_path} <- combine_masks_if_needed(mask_paths, document.id),
           {:ok, inpainted_path} <- Inpainting.inpaint_with_mask(image_path, combined_mask_path),
           {:ok, document} <- save_inpaint_result_with_history(document, inpainted_path, region_ids) do
        # Clean up temporary combined mask if we created one
        if length(mask_paths) > 1 do
          File.rm(combined_mask_path)
        end

        broadcast_update(document)
        broadcast_inpainting_complete(document)
        :ok
      else
        {:error, reason} ->
          Logger.error("Batch inpainting failed", reason: inspect(reason))
          {:error, reason}
      end
    end
  rescue
    error ->
      Logger.error("Batch inpainting crashed: #{inspect(error)}")
      {:error, inspect(error)}
  end

  defp get_current_image_path(document) do
    # Use working asset if available, otherwise original
    asset =
      if document.working_asset_id do
        Repo.get!(Asset, document.working_asset_id)
      else
        Repo.get!(Asset, document.original_asset_id)
      end

    Assets.asset_path(asset)
  end

  defp combine_masks_if_needed([single_mask], _doc_id), do: {:ok, single_mask}

  defp combine_masks_if_needed(mask_paths, doc_id) when length(mask_paths) > 1 do
    # Generate output path for combined mask
    dir = Path.join(["priv/static/uploads", doc_id])
    File.mkdir_p!(dir)
    output_path = Path.join(dir, "combined_mask_#{System.system_time(:millisecond)}.png")

    Mask.combine_masks(mask_paths, output_path)
  end

  defp save_inpaint_result_with_history(document, inpainted_path, region_ids) do
    # 1. Save current image to history BEFORE we overwrite it
    current_image_path = get_current_image_path(document)
    history_entry = HistoryEntry.new_inpaint(current_image_path, region_ids)

    # 2. Save the new inpainted image as working asset
    {:ok, new_working_asset} =
      Assets.save_image_from_path(document.id, inpainted_path, :working)

    # 3. Update document with new working asset and history entry
    changeset =
      document
      |> Document.add_history_entry(history_entry)
      |> Ecto.Changeset.put_change(:working_asset_id, new_working_asset.id)
      |> Ecto.Changeset.put_change(:status, :ready)

    case Repo.update(changeset) do
      {:ok, updated_doc} ->
        # 4. Mark the inpainted regions as complete
        mark_regions_inpainted(region_ids)

        # Clean up temp inpainted file (we saved it as asset)
        File.rm(inpainted_path)
        {:ok, updated_doc}

      {:error, changeset} ->
        Logger.error("Failed to save inpaint result", errors: inspect(changeset.errors))
        {:error, :save_failed}
    end
  end

  defp mark_regions_inpainted(region_ids) when is_list(region_ids) do
    alias Lossy.Documents.DetectedRegion

    # Update all regions to inpainted status
    from(r in DetectedRegion, where: r.id in ^region_ids)
    |> Repo.update_all(set: [status: :inpainted, updated_at: NaiveDateTime.utc_now()])

    Logger.info("Marked regions as inpainted", count: length(region_ids))
  end

  defp broadcast_update(document) do
    document = Documents.get_document(document.id)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  defp broadcast_inpainting_complete(document) do
    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:inpainting_complete, %{document_id: document.id}}
    )
  end
end
