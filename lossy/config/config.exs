# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :lossy,
  ecto_repos: [Lossy.Repo],
  generators: [timestamp_type: :utc_datetime]

# Configures the endpoint
config :lossy, LossyWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: LossyWeb.ErrorHTML, json: LossyWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Lossy.PubSub,
  live_view: [signing_salt: "W8moorYZ"]

# Configures the mailer
#
# By default it uses the "Local" adapter which stores the emails
# locally. You can see the emails in your browser, at "/dev/mailbox".
#
# For production it's recommended to configure a different adapter
# at the `config/runtime.exs`.
config :lossy, Lossy.Mailer, adapter: Swoosh.Adapters.Local

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.25.4",
  lossy: [
    args:
      ~w(js/app.js --bundle --target=es2022 --outdir=../priv/static/assets/js --external:/fonts/* --external:/images/* --alias:@=.),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
  ]

# Configure tailwind (the version is required)
config :tailwind,
  version: "4.1.7",
  lossy: [
    args: ~w(
      --input=assets/css/app.css
      --output=priv/static/assets/css/app.css
    ),
    cd: Path.expand("..", __DIR__)
  ]

# Configures Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Lossy application configuration
config :lossy, :ml_pipeline,
  pre_upscale_min_dimension: 500,
  pre_upscale_factor: 2.0,
  mask_padding_multiplier: 0.4,
  mask_padding_min: 6,
  mask_padding_max: 24,
  text_detection_confidence_threshold: 0.7,
  default_upscale_factor: 4,
  max_upscale_factor: 8

config :lossy, :jobs,
  default_max_attempts: 3,
  retry_backoff_base_ms: 1000,
  retry_backoff_max_ms: 30_000,
  text_detection_timeout_ms: 60_000,
  inpainting_timeout_ms: 120_000,
  upscaling_timeout_ms: 180_000,
  allow_duplicate_jobs: false

config :lossy, :assets,
  storage_backend: Lossy.Storage.Local,
  local_base_path: "priv/static/uploads",
  max_upload_size_mb: 50,
  max_dimension_px: 8192,
  cleanup_working_assets_after_days: 30,
  cleanup_export_assets_after_days: 7

config :lossy, :image_processing,
  warn_large_image_threshold: 4096,
  max_canvas_dimension: 8192,
  export_jpeg_quality: 90,
  export_png_compression: 6,
  default_font: "Inter",
  fallback_fonts: ["Roboto", "Arial", "sans-serif"]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
