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
  end

  pipeline :api_authenticated do
    plug :accepts, ["json"]
    plug :fetch_session
    plug LossyWeb.Plugs.RequireAuthenticatedUser
  end

  scope "/", LossyWeb do
    pipe_through :browser

    get "/", PageController, :home
    live "/notes", NotesLive, :index
  end

  # Other scopes may use custom stacks.
  # scope "/api", LossyWeb do
  #   pipe_through :api
  # end

  scope "/api", LossyWeb.Api do
    pipe_through :api_authenticated

    post "/auth/extension_token", ExtensionAuthController, :create
  end

  # Enable LiveDashboard and Swoosh mailbox preview in development
  if Application.compile_env(:lossy, :dev_routes) do
    # If you want to use the LiveDashboard in production, you should put
    # it behind authentication and allow only admins to access it.
    # If your application does not have an admins-only section yet,
    # you can use Plug.BasicAuth to set up some basic authentication
    # as long as you are also using SSL (which you should anyway).
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: LossyWeb.Telemetry
      forward "/mailbox", Plug.Swoosh.MailboxPreview

      # Dev-only authentication for testing extension
      get "/auth", LossyWeb.DevAuthController, :index
      post "/auth/login", LossyWeb.DevAuthController, :create
      get "/auth/success", LossyWeb.DevAuthController, :success
      get "/auth/logout", LossyWeb.DevAuthController, :delete
    end
  end
end
