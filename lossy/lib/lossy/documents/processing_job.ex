defmodule Lossy.Documents.ProcessingJob do
  @moduledoc """
  Schema for background processing jobs.

  Tracks asynchronous tasks like detection, inpainting, and upscaling
  with retry logic and error handling.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @job_types [:detection, :inpainting, :upscale]
  @statuses [:queued, :running, :done, :error]

  schema "processing_jobs" do
    field :type, Ecto.Enum, values: @job_types
    field :payload, :map, default: %{}
    field :status, Ecto.Enum, values: @statuses, default: :queued
    field :attempts, :integer, default: 0
    field :max_attempts, :integer, default: 3
    field :locked_at, :utc_datetime
    field :error_message, :string

    belongs_to :document, Lossy.Documents.Document

    timestamps()
  end

  def changeset(job, attrs) do
    job
    |> cast(attrs, [
      :document_id,
      :type,
      :payload,
      :status,
      :attempts,
      :max_attempts,
      :locked_at,
      :error_message
    ])
    |> validate_required([:document_id, :type, :status])
    |> validate_inclusion(:type, @job_types)
    |> validate_inclusion(:status, @statuses)
  end
end
