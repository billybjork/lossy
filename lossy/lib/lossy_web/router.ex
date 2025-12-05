defmodule LossyWeb.Router do
  use LossyWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {LossyWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
    plug LossyWeb.Plugs.CORS
  end

  scope "/", LossyWeb do
    pipe_through :browser

    get "/", PageController, :home
    live "/edit/:id", EditLive
  end

  # API routes
  scope "/api", LossyWeb do
    pipe_through :api

    post "/captures", CaptureController, :create
  end
end
