defmodule Lossy.Workers.Inpainting do
  @moduledoc """
  Oban worker for processing inpainting jobs.

  When a user edits text in a region, this worker:
  1. Inpaints the original background (removes text)
  2. Updates the region status
  3. Broadcasts update to LiveView
  """

  use Oban.Worker, queue: :ml, max_attempts: 3

  require Logger
  alias Lossy.{Documents, Assets, Repo}
  alias Lossy.Documents.TextRegion
  alias Lossy.ML.Inpainting
  alias Lossy.ImageProcessing.TextRenderer

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"region_id" => region_id}}) do
    Logger.info("Starting inpainting job", region_id: region_id)

    region = Repo.get!(TextRegion, region_id) |> Repo.preload(:document)
    document = region.document

    if is_nil(document) do
      Logger.error("Document not found for region", region_id: region_id)
      {:error, :document_not_found}
    else
      try do
        # Update region status to inpainting
        {:ok, region} = Documents.update_text_region(region, %{status: :inpainting})

        # Get the original image path
        original_asset = Repo.get!(Assets.Asset, document.original_asset_id)
        image_path = Assets.asset_path(original_asset)

        # Run inpainting
        case Inpainting.inpaint_region(image_path, region.bbox, padding_px: region.padding_px || 10) do
          {:ok, inpainted_path} ->
            # Render the new text onto the inpainted image
            render_result =
              if region.current_text && region.current_text != "" do
                render_text_on_image(inpainted_path, region)
              else
                {:ok, inpainted_path}
              end

            case render_result do
              {:ok, final_path} ->
                # Save the final result as an asset
                {:ok, rendered_asset} =
                  Assets.save_image_from_path(document.id, final_path, :rendered_patch)

                # Update region with rendered asset reference
                {:ok, _region} =
                  Documents.update_text_region(region, %{
                    status: :rendered,
                    inpainted_asset_id: rendered_asset.id
                  })

                # Cleanup temp files
                File.rm(inpainted_path)
                if final_path != inpainted_path, do: File.rm(final_path)

                # Broadcast update
                broadcast_update(document)

                Logger.info("Inpainting and text rendering completed", region_id: region_id)
                :ok

              {:error, render_reason} ->
                Logger.error("Text rendering failed",
                  region_id: region_id,
                  reason: inspect(render_reason)
                )

                # Still save the inpainted version even if text rendering failed
                {:ok, inpainted_asset} =
                  Assets.save_image_from_path(document.id, inpainted_path, :inpainted_patch)

                Documents.update_text_region(region, %{
                  status: :rendered,
                  inpainted_asset_id: inpainted_asset.id
                })

                File.rm(inpainted_path)
                broadcast_update(document)

                Logger.warning("Saved inpainted image without text rendering",
                  region_id: region_id
                )

                :ok
            end

          {:error, reason} ->
            Logger.error("Inpainting failed",
              region_id: region_id,
              reason: inspect(reason)
            )

            Documents.update_text_region(region, %{status: :error})
            {:error, reason}
        end
      rescue
        error ->
          Logger.error("Inpainting job crashed",
            region_id: region_id,
            error: Exception.message(error)
          )

          Documents.update_text_region(region, %{status: :error})
          reraise error, __STACKTRACE__
      end
    end
  end

  defp broadcast_update(document) do
    document = Documents.get_document(document.id)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  # Render text onto the inpainted image using region properties
  defp render_text_on_image(image_path, region) do
    # Build render options from region properties
    opts = [
      font_family: region.font_family,
      font_size_px: region.font_size_px || 16,
      font_weight: region.font_weight || 400,
      color_rgba: region.color_rgba || "rgba(0,0,0,1)",
      alignment: region.alignment || :left
    ]

    # Build bbox map from region
    bbox = %{
      x: region.bbox["x"] || region.bbox[:x] || 0,
      y: region.bbox["y"] || region.bbox[:y] || 0,
      w: region.bbox["w"] || region.bbox[:w] || 0,
      h: region.bbox["h"] || region.bbox[:h] || 0
    }

    Logger.info("Rendering text on inpainted image",
      text: region.current_text,
      bbox: inspect(bbox),
      font_size: opts[:font_size_px]
    )

    TextRenderer.render_text_in_region(image_path, region.current_text, bbox, opts)
  end
end
