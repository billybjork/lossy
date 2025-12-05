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

# Configure Oban job processing
config :lossy, Oban,
  repo: Lossy.Repo,
  queues: [default: 10, ml: 5],
  plugins: [
    # Prune jobs after 7 days
    {Oban.Plugins.Pruner, max_age: 60 * 60 * 24 * 7}
  ]

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.25.4",
  lossy: [
    args:
      ~w(js/app.ts --bundle --target=es2022 --outdir=../priv/static/assets/js --external:/fonts/* --external:/images/* --external:/models/* --external:/wasm/* --alias:@=.),
    cd: Path.expand("../assets", __DIR__),
    env: %{
      "NODE_PATH" => [
        Path.expand("../deps", __DIR__),
        Path.expand("../assets/node_modules", __DIR__),
        Mix.Project.build_path()
      ]
    }
  ],
  lossy_worker: [
    args:
      ~w(js/ml/inference-worker.ts --bundle --target=es2022 --outdir=../priv/static/assets/js --external:/fonts/* --external:/images/* --external:/models/* --external:/wasm/* --alias:@=.),
    cd: Path.expand("../assets", __DIR__),
    env: %{
      "NODE_PATH" => [
        Path.expand("../deps", __DIR__),
        Path.expand("../assets/node_modules", __DIR__),
        Mix.Project.build_path()
      ]
    }
  ],
  lossy_css: [
    args: ~w(css/app.css --bundle --outdir=../priv/static/assets/css),
    cd: Path.expand("../assets", __DIR__)
  ]

# Configures Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [
    :request_id,
    # Document/asset identifiers
    :document_id,
    :name,
    :index,
    :segment_count,
    :source,
    :source_url,
    :region_id,
    :region_ids,
    :prediction_id,
    # File/path info
    :path,
    :file_path,
    :source_path,
    :output_path,
    :target_path,
    :image_path,
    :mask_path,
    :working_image,
    :patch,
    # Image dimensions
    :width,
    :height,
    :image_width,
    :image_height,
    :kind,
    # Processing state
    :status,
    :capture_mode,
    :output,
    :exit_code,
    :attempts,
    # Detection/ML info
    :detection_backend,
    :detection_time_ms,
    :has_text_regions,
    :text_regions_count,
    :region_count,
    :mask_count,
    :count,
    :failed_count,
    :model,
    :restoring_regions,
    # Text rendering
    :text,
    :bbox,
    :position,
    :padding,
    :font,
    :font_size,
    :size,
    :color,
    # Request/input info
    :url,
    :has_image_url,
    :has_image_data,
    :file,
    :attrs,
    # Error handling
    :reason,
    :error,
    :errors,
    :stacktrace
  ]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# ML services configuration (API keys loaded from environment)
config :lossy, :ml_services,
  # Set via environment variable in runtime.exs (after .env is loaded)
  replicate_api_key: nil

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
