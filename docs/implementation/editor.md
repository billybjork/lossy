# Editor UI Implementation

This guide covers the implementation of the Lossy editor interface using Phoenix LiveView and JavaScript hooks.

## Goals

The editor is a real-time, interactive interface for:
- Displaying captured images with detected text regions
- Allowing users to edit text in-place
- Showing live updates as ML processing completes
- Providing export functionality

**Architecture**: FP-flavored frontend with server-side state.

---

## LiveView Architecture

### Responsibilities

**LiveView (Server-Side)**:
- Hold authoritative document state
- Subscribe to processing job updates (via PubSub)
- Handle user events (text edits, region selections)
- Persist changes to database
- Push state updates to client

**JS Hooks (Client-Side)**:
- Canvas rendering (draw image + overlays)
- Drag/resize text regions
- Immediate text input feedback
- Send events to LiveView

---

## LiveView Module

**File**: `lib/lossy_web/live/capture_live.ex`

```elixir
defmodule LossyWeb.CaptureLive do
  use LossyWeb, :live_view
  alias Lossy.Documents
  alias Lossy.Documents.{Document, TextRegion}

  @impl true
  def mount(%{"id" => document_id}, _session, socket) do
    if connected?(socket) do
      # Subscribe to document updates
      Phoenix.PubSub.subscribe(Lossy.PubSub, "document:#{document_id}")
    end

    document = Documents.get_document(document_id)

    if document do
      {:ok,
       socket
       |> assign(:document, document)
       |> assign(:text_regions, document.text_regions)
       |> assign(:selected_region_id, nil)
       |> assign(:loading, document.status == :pending_detection)}
    else
      {:ok,
       socket
       |> put_flash(:error, "Document not found")
       |> redirect(to: "/")}
    end
  end

  @impl true
  def handle_info({:document_updated, document}, socket) do
    {:noreply,
     socket
     |> assign(:document, document)
     |> assign(:loading, false)}
  end

  @impl true
  def handle_info({:region_updated, region}, socket) do
    # Update the specific region in state
    updated_regions =
      Enum.map(socket.assigns.text_regions, fn r ->
        if r.id == region.id, do: region, else: r
      end)

    {:noreply, assign(socket, :text_regions, updated_regions)}
  end

  @impl true
  def handle_event("select_region", %{"region_id" => region_id}, socket) do
    {:noreply, assign(socket, :selected_region_id, region_id)}
  end

  @impl true
  def handle_event("update_region_text", %{"region_id" => region_id, "text" => new_text}, socket) do
    region = Enum.find(socket.assigns.text_regions, &(&1.id == region_id))

    if region do
      # Update in DB
      {:ok, updated_region} = Documents.update_text_region(region, %{current_text: new_text})

      # Enqueue inpainting job
      :ok = Documents.inpaint_region(updated_region)

      # Optimistic update in UI
      updated_regions =
        Enum.map(socket.assigns.text_regions, fn r ->
          if r.id == region_id, do: %{updated_region | status: :inpainting}, else: r
        end)

      {:noreply, assign(socket, :text_regions, updated_regions)}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("download", _params, socket) do
    document = socket.assigns.document

    # Trigger download (client-side via hook or server-side file response)
    {:noreply,
     socket
     |> push_event("download_image", %{url: document.working_image_path})}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="editor-container">
      <div class="editor-header">
        <h1>Lossy Editor</h1>
        <button phx-click="download" class="btn-download">
          Download PNG
        </button>
      </div>

      <div class="editor-main">
        <%= if @loading do %>
          <div class="loading-state">
            <div class="spinner"></div>
            <p>Finding text...</p>
          </div>
        <% else %>
          <div
            id="canvas-editor"
            phx-hook="CanvasEditor"
            data-image-url={@document.working_image_path}
            data-regions={Jason.encode!(@text_regions)}
            class="canvas-container"
          >
            <canvas id="main-canvas"></canvas>
          </div>

          <div class="regions-panel">
            <h2>Text Regions</h2>
            <%= for region <- @text_regions do %>
              <div
                class={"region-item #{if @selected_region_id == region.id, do: "selected"}"}
                phx-click="select_region"
                phx-value-region_id={region.id}
              >
                <div class="region-text"><%= region.current_text %></div>
                <div class="region-status"><%= region.status %></div>
              </div>
            <% end %>
          </div>
        <% end %>
      </div>
    </div>
    """
  end
end
```

---

## JavaScript Hooks

### Canvas Editor Hook

**File**: `assets/js/hooks/canvas_editor.js`

```javascript
export const CanvasEditor = {
  mounted() {
    this.canvas = this.el.querySelector('#main-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.image = new Image();
    this.regions = [];
    this.selectedRegion = null;
    this.dragging = false;

    // Load image
    const imageUrl = this.el.dataset.imageUrl;
    this.image.src = imageUrl;
    this.image.onload = () => {
      this.setupCanvas();
      this.render();
    };

    // Load regions
    this.updateRegions(JSON.parse(this.el.dataset.regions));

    // Event listeners
    this.canvas.addEventListener('click', this.handleClick.bind(this));
    this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
    this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));

    // Listen for updates from server
    this.handleEvent('download_image', ({url}) => {
      this.downloadImage(url);
    });
  },

  updated() {
    // Re-parse regions when they change
    this.updateRegions(JSON.parse(this.el.dataset.regions));
    this.render();
  },

  setupCanvas() {
    // Set canvas size to match image
    this.canvas.width = this.image.width;
    this.canvas.height = this.image.height;
  },

  updateRegions(regions) {
    this.regions = regions;
  },

  render() {
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw image
    this.ctx.drawImage(this.image, 0, 0);

    // Draw region overlays
    this.regions.forEach(region => {
      this.drawRegion(region);
    });
  },

  drawRegion(region) {
    const {x, y, w, h} = region.bbox;

    // Draw bounding box
    this.ctx.strokeStyle = region.status === 'rendered' ? '#10B981' : '#3B82F6';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(x, y, w, h);

    // Draw semi-transparent overlay
    this.ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    this.ctx.fillRect(x, y, w, h);

    // Draw text (current)
    this.ctx.fillStyle = region.color_rgba || 'rgba(0,0,0,1)';
    this.ctx.font = `${region.font_weight} ${region.font_size_px}px ${region.font_family}`;
    this.ctx.textAlign = region.alignment || 'left';
    this.ctx.fillText(region.current_text, x + 5, y + region.font_size_px);
  },

  handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find clicked region
    const clickedRegion = this.regions.find(region => {
      const {x: rx, y: ry, w, h} = region.bbox;
      return x >= rx && x <= rx + w && y >= ry && y <= ry + h;
    });

    if (clickedRegion) {
      this.selectRegion(clickedRegion);
    }
  },

  selectRegion(region) {
    this.selectedRegion = region;

    // Notify server
    this.pushEvent('select_region', {region_id: region.id});

    // Show inline editor
    this.showInlineEditor(region);
  },

  showInlineEditor(region) {
    // Create contenteditable div positioned over region
    const {x, y, w, h} = region.bbox;
    const rect = this.canvas.getBoundingClientRect();

    const editor = document.createElement('div');
    editor.id = 'inline-editor';
    editor.contentEditable = true;
    editor.textContent = region.current_text;
    editor.style.cssText = `
      position: absolute;
      left: ${rect.left + x}px;
      top: ${rect.top + y}px;
      width: ${w}px;
      min-height: ${h}px;
      font-family: ${region.font_family};
      font-size: ${region.font_size_px}px;
      font-weight: ${region.font_weight};
      color: ${region.color_rgba};
      background: rgba(255, 255, 255, 0.9);
      border: 2px solid #3B82F6;
      padding: 4px;
      z-index: 1000;
    `;

    // Remove existing editor
    const existing = document.getElementById('inline-editor');
    if (existing) existing.remove();

    document.body.appendChild(editor);
    editor.focus();

    // Select all text
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    // Handle blur/enter
    const handleSave = () => {
      const newText = editor.textContent;
      this.pushEvent('update_region_text', {
        region_id: region.id,
        text: newText
      });
      editor.remove();
    };

    editor.addEventListener('blur', handleSave);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        editor.remove();
      }
    });
  },

  handleMouseDown(e) {
    // Implement drag to move regions (future)
  },

  handleMouseMove(e) {
    // Implement drag to move regions (future)
  },

  handleMouseUp(e) {
    // Implement drag to move regions (future)
  },

  downloadImage(url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lossy-edited.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};
```

### Register Hooks

**File**: `assets/js/app.js`

```javascript
import {Socket} from "phoenix"
import {LiveSocket} from "phoenix_live_view"
import {CanvasEditor} from "./hooks/canvas_editor"

let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content");
let liveSocket = new LiveSocket("/live", Socket, {
  params: {_csrf_token: csrfToken},
  hooks: {CanvasEditor}
});

liveSocket.connect();

window.liveSocket = liveSocket;
```

---

## Styling

**File**: `assets/css/editor.css`

```css
.editor-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #F3F4F6;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background: white;
  border-bottom: 1px solid #E5E7EB;
}

.editor-main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.canvas-container {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem;
  overflow: auto;
}

#main-canvas {
  max-width: 100%;
  max-height: 100%;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.regions-panel {
  width: 300px;
  background: white;
  border-left: 1px solid #E5E7EB;
  padding: 1rem;
  overflow-y: auto;
}

.region-item {
  padding: 0.75rem;
  margin-bottom: 0.5rem;
  border: 1px solid #E5E7EB;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.2s;
}

.region-item:hover {
  border-color: #3B82F6;
  background: #EFF6FF;
}

.region-item.selected {
  border-color: #3B82F6;
  background: #DBEAFE;
}

.region-text {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.region-status {
  font-size: 0.75rem;
  color: #6B7280;
  text-transform: uppercase;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid #E5E7EB;
  border-top-color: #3B82F6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.btn-download {
  padding: 0.5rem 1rem;
  background: #3B82F6;
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}

.btn-download:hover {
  background: #2563EB;
}
```

---

## Real-Time Updates Flow

### 1. Text Detection Complete

```
ML Service → Backend → Documents.execute_text_detection
                            ↓
                    Create TextRegion records
                            ↓
                    broadcast_document_updated()
                            ↓
                    PubSub → LiveView
                            ↓
                    handle_info({:document_updated, ...})
                            ↓
                    Update assigns, send to client
                            ↓
                    CanvasEditor.updated() → render()
```

### 2. User Edits Text

```
User types → Inline editor blur/enter
                ↓
        JS pushEvent("update_region_text")
                ↓
        LiveView.handle_event("update_region_text")
                ↓
        Documents.update_text_region()
        Documents.inpaint_region()
                ↓
        Optimistic update (status: :inpainting)
                ↓
        Send to client immediately
                ↓
        ML job completes → broadcast_region_updated()
                ↓
        LiveView.handle_info({:region_updated, ...})
                ↓
        Update assigns (status: :rendered)
                ↓
        Client re-renders with new status
```

---

## Advanced Features

### Font Picker

Add a dropdown to change font:

```elixir
# In LiveView template
<select phx-change="change_font" phx-value-region_id={region.id}>
  <%= for font <- @available_fonts do %>
    <option value={font} selected={region.font_family == font}>
      <%= font %>
    </option>
  <% end %>
</select>

# In LiveView module
def handle_event("change_font", %{"region_id" => region_id, "value" => font}, socket) do
  region = Enum.find(socket.assigns.text_regions, &(&1.id == region_id))
  {:ok, _updated} = Documents.update_text_region(region, %{font_family: font})
  {:noreply, socket}
end
```

### Keyboard Shortcuts

```javascript
// In CanvasEditor hook
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    this.selectNextRegion();
  } else if (e.metaKey && e.key === 's') {
    e.preventDefault();
    this.pushEvent('download', {});
  }
});
```

### Undo/Redo

Track region history in LiveView:

```elixir
def handle_event("undo", _params, socket) do
  # Pop from history stack
  # Revert region to previous state
  {:noreply, socket}
end
```

---

## Performance Optimization

### Canvas Rendering

- **Debounce**: Don't re-render on every pixel move during drag
- **RAF**: Use `requestAnimationFrame` for smooth animations
- **Layers**: Separate image layer from overlay layer (two canvases)

### LiveView Optimization

- **Temporary assigns**: Use `assign(..., temporary: true)` for large data
- **Phx-update**: Use `phx-update="replace"` to avoid DOM diffing issues
- **Streams**: Consider `Phoenix.LiveView.stream()` for large region lists

---

## Testing

### LiveView Tests

**File**: `test/lossy_web/live/capture_live_test.exs`

```elixir
defmodule LossyWeb.CaptureLiveTest do
  use LossyWeb.ConnCase
  import Phoenix.LiveViewTest
  alias Lossy.Documents

  test "displays document when loaded", %{conn: conn} do
    document = insert(:document)

    {:ok, view, html} = live(conn, "/capture/#{document.id}")

    assert html =~ "Lossy Editor"
    assert has_element?(view, "#canvas-editor")
  end

  test "updates UI when text detection completes", %{conn: conn} do
    document = insert(:document, status: :pending_detection)

    {:ok, view, _html} = live(conn, "/capture/#{document.id}")

    # Simulate detection completion
    Documents.complete_text_detection(document, [
      %{bbox: %{x: 10, y: 10, w: 100, h: 50}, text: "Hello"}
    ])

    # Wait for update
    assert render(view) =~ "Hello"
  end
end
```

### Hook Tests (with Jest)

```javascript
import {CanvasEditor} from '../canvas_editor';

describe('CanvasEditor', () => {
  it('renders image on canvas', () => {
    // Mock canvas and image
    // Verify drawImage called
  });

  it('highlights region on click', () => {
    // Simulate click
    // Verify region selection
  });
});
```

---

## Accessibility

- **Keyboard navigation**: Tab through regions, Enter to edit
- **Screen reader support**: Add ARIA labels to canvas and regions
- **High contrast mode**: Ensure overlays are visible
- **Focus management**: Trap focus in inline editor

---

## Next Steps

See [Roadmap](roadmap.md) for implementation phases and [Backend](backend.md) for server-side integration details.
