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
  alias Lossy.Documents.{TextRegion, Asset}
  alias Lossy.ML.Inpainting
  alias Lossy.ImageProcessing.TextRenderer

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"region_id" => region_id}}) do
    Logger.info("Starting inpainting job", region_id: region_id)

    region = Repo.get!(TextRegion, region_id) |> Repo.preload(:document)

    case region.document do
      nil ->
        Logger.error("Document not found for region", region_id: region_id)
        {:error, :document_not_found}

      document ->
        process_inpainting(region, document)
    end
  end

  defp process_inpainting(region, document) do
    {:ok, updated_region} = Documents.update_text_region(region, %{status: :inpainting})

    # Reload region to get fresh editing_status
    region = Repo.get!(TextRegion, updated_region.id)

    Logger.info("Processing inpainting - step 1")
    Logger.info("Region ID: #{region.id}")
    Logger.info("Editing status: #{inspect(region.editing_status)}")
    Logger.info("Current text: #{inspect(region.current_text)}")

    Logger.info("Processing inpainting - step 2: getting asset")
    Logger.info("Document original_asset_id: #{inspect(document.original_asset_id)}")

    if is_nil(document.original_asset_id) do
      raise "Document has no original_asset_id - image may not have been downloaded yet"
    end

    original_asset =
      try do
        asset = Repo.get!(Asset, document.original_asset_id)
        Logger.info("Asset found successfully")
        asset
      rescue
        e ->
          Logger.error("Failed to get asset: #{inspect(e)}")
          reraise e, __STACKTRACE__
      end

    if is_nil(original_asset) do
      raise "Asset not found for ID: #{document.original_asset_id}"
    end

    Logger.info("Processing inpainting - step 3: getting path")
    Logger.info("Asset storage_uri: #{inspect(original_asset.storage_uri)}")

    image_path = Assets.asset_path(original_asset)

    Logger.info("Image path resolved: #{image_path}")

    # Check editing_status to determine flow
    case region.editing_status do
      :inpainting_blank ->
        # Stage 1: Inpaint to remove text, don't render new text yet
        Logger.info("Using blank inpainting flow")
        process_blank_inpainting(image_path, region, document)

      _other ->
        # Stage 2 or normal flow: Inpaint + render text
        Logger.info("Using normal inpainting flow", editing_status: region.editing_status)
        process_normal_inpainting(image_path, region, document)
    end
  rescue
    error ->
      error_message = inspect(error)
      stacktrace = Exception.format_stacktrace(__STACKTRACE__)

      Logger.error("Inpainting job crashed: #{error_message}")
      Logger.error("Stacktrace: #{stacktrace}")

      Documents.update_text_region(region, %{status: :error, editing_status: :idle})
      reraise error, __STACKTRACE__
  end

  defp process_blank_inpainting(image_path, region, document) do
    Logger.info("Processing blank inpainting (removing text)", region_id: region.id)

    case Inpainting.inpaint_region(image_path, region.bbox, padding_px: region.padding_px || 10) do
      {:ok, inpainted_path} ->
        # Save the inpainted base without rendering text
        {:ok, inpainted_asset} =
          Assets.save_image_from_path(document.id, inpainted_path, :inpainted_patch)

        # Update region to ready_to_edit status
        {:ok, _region} =
          Documents.update_text_region(region, %{
            status: :rendered,
            editing_status: :ready_to_edit,
            inpainted_asset_id: inpainted_asset.id
          })

        File.rm(inpainted_path)
        broadcast_update(document)
        Logger.info("Blank inpainting completed, ready for editing", region_id: region.id)
        :ok

      {:error, reason} ->
        handle_inpainting_error(region, reason)
    end
  end

  defp process_normal_inpainting(image_path, region, document) do
    Logger.info("Processing normal inpainting (inpaint + render text)", region_id: region.id)

    case Inpainting.inpaint_region(image_path, region.bbox, padding_px: region.padding_px || 10) do
      {:ok, inpainted_path} ->
        handle_inpainting_success(inpainted_path, region, document)

      {:error, reason} ->
        handle_inpainting_error(region, reason)
    end
  end

  defp handle_inpainting_success(inpainted_path, region, document) do
    render_result = maybe_render_text(inpainted_path, region)

    case render_result do
      {:ok, final_path} ->
        save_rendered_result(final_path, inpainted_path, region, document)

      {:error, render_reason} ->
        save_fallback_result(inpainted_path, region, document, render_reason)
    end
  end

  defp maybe_render_text(inpainted_path, region) do
    if region.current_text && region.current_text != "" do
      render_text_on_image(inpainted_path, region)
    else
      {:ok, inpainted_path}
    end
  end

  defp save_rendered_result(final_path, inpainted_path, region, document) do
    {:ok, rendered_asset} = Assets.save_image_from_path(document.id, final_path, :rendered_patch)

    {:ok, _region} =
      Documents.update_text_region(region, %{
        status: :rendered,
        editing_status: :idle,
        inpainted_asset_id: rendered_asset.id
      })

    File.rm(inpainted_path)
    if final_path != inpainted_path, do: File.rm(final_path)

    broadcast_update(document)
    Logger.info("Inpainting and text rendering completed", region_id: region.id)
    :ok
  end

  defp save_fallback_result(inpainted_path, region, document, render_reason) do
    Logger.error("Text rendering failed", region_id: region.id, reason: inspect(render_reason))

    {:ok, inpainted_asset} =
      Assets.save_image_from_path(document.id, inpainted_path, :inpainted_patch)

    Documents.update_text_region(region, %{
      status: :rendered,
      inpainted_asset_id: inpainted_asset.id
    })

    File.rm(inpainted_path)
    broadcast_update(document)

    Logger.warning("Saved inpainted image without text rendering", region_id: region.id)
    :ok
  end

  defp handle_inpainting_error(region, reason) do
    Logger.error("Inpainting failed", region_id: region.id, reason: inspect(reason))
    Documents.update_text_region(region, %{status: :error, editing_status: :idle})
    {:error, reason}
  end

  defp broadcast_update(document) do
    document = Documents.get_document(document.id)

    Phoenix.PubSub.broadcast(
      Lossy.PubSub,
      "document:#{document.id}",
      {:document_updated, document}
    )
  end

  defp render_text_on_image(image_path, region) do
    opts = build_render_opts(region)
    bbox = normalize_bbox(region.bbox)

    Logger.info("Rendering text on inpainted image",
      text: region.current_text,
      bbox: inspect(bbox),
      font_size: opts[:font_size_px]
    )

    TextRenderer.render_text_in_region(image_path, region.current_text, bbox, opts)
  end

  defp build_render_opts(region) do
    [
      font_family: region.font_family,
      font_size_px: region.font_size_px || 16,
      font_weight: region.font_weight || 400,
      color_rgba: region.color_rgba || "rgba(0,0,0,1)",
      alignment: region.alignment || :left
    ]
  end

  defp normalize_bbox(bbox) when is_map(bbox) do
    %{
      x: get_bbox_value(bbox, :x),
      y: get_bbox_value(bbox, :y),
      w: get_bbox_value(bbox, :w),
      h: get_bbox_value(bbox, :h)
    }
  end

  defp get_bbox_value(bbox, key) do
    Map.get(bbox, key) || Map.get(bbox, to_string(key)) || 0
  end
end
