defmodule LossyWeb.PageController do
  use LossyWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
