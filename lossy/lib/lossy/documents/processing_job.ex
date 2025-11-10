defmodule Lossy.Documents.ProcessingJob do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "processing_jobs" do
    field :type, Ecto.Enum, values: [:text_detection, :inpaint_region, :upscale_document, :font_guess]
    field :subject_type, Ecto.Enum, values: [:document, :text_region]
    field :payload, :map, default: %{}
    field :status, Ecto.Enum, values: [:queued, :running, :done, :error], default: :queued
    field :attempts, :integer, default: 0
    field :max_attempts, :integer, default: 3
    field :locked_at, :utc_datetime
    field :error_message, :string

    belongs_to :document, Lossy.Documents.Document
    belongs_to :text_region, Lossy.Documents.TextRegion

    timestamps()
  end

  def changeset(job, attrs) do
    job
    |> cast(attrs, [:document_id, :text_region_id, :subject_type, :type, :payload, :status,
                    :attempts, :max_attempts, :locked_at, :error_message])
    |> validate_required([:document_id, :subject_type, :type, :status])
    |> validate_inclusion(:type, [:text_detection, :inpaint_region, :upscale_document, :font_guess])
    |> validate_inclusion(:subject_type, [:document, :text_region])
    |> validate_inclusion(:status, [:queued, :running, :done, :error])
  end
end
