# Sprint 09: Video Library & History Management

**Status:** 📋 Planned
**Estimated Duration:** 3-4 days
**Owner:** Backend + Extension pairing
**Progress:** 0%

**Related Sprints:**
- ✅ Sprint 00 – Initial Scaffolding (videos table foundation)
- ✅ Sprint 02 – Transcription & Note Structuring (notes workflow)
- ✅ Sprint 08 – Visual Intelligence (visual_context enrichment)
- 🔜 Sprint TBD – Semantic Search (will build on searchable video library)
- 📋 Sprint TBD – Auto Posting (status tracking for note execution)

---

## Executive Summary

**The Problem:** Currently, users can only see notes for the *current* video they're watching. Once they navigate away, there's no way to:
- View their complete history of reviewed videos
- Revisit videos they've left comments on
- Plan a queue of videos to review later
- Search across their entire video library
- Let agents query past video context for better recommendations

**The Solution:** Build a lightweight **Video Library** system that tracks video lifecycle states (Queued → In Progress → Complete) and provides a searchable, chronological view of all videos the user has interacted with. The library lives in a **separate tab** within the side panel UI, keeping the main Notes tab focused and uncluttered during active recording sessions.

**Strategic Value:**
1. **Immediate UX improvement**: Users can navigate their work history
2. **Agent context foundation**: Enables agents to pull relevant past comments
3. **Workflow optimization**: Queue management for batch video review sessions
4. **Future expansion**: Lays groundwork for media asset management features (source files, advanced metadata, team collaboration)
5. **Broader applications**: Supports use cases beyond video editing (e.g., student note-taking, media archivists, researchers)

---

## Goals

### Primary Goals (Implement Now)

1. **Tabbed Side Panel UI**
   - Add **Notes** and **Library** tabs to side panel
   - Notes tab: Existing recording/note-taking interface (unchanged)
   - Library tab: New video history and queue management interface
   - Keeps active recording session UI clean and focused

2. **Video History View** (Library Tab)
   - Display all videos user has interacted with (sorted by `last_viewed_at`)
   - Show video title, thumbnail, platform, note count
   - Click to open video URL in new tab
   - Visual status indicators (Queued/In Progress/Complete)

3. **Queue Management**
   - Add videos to "Queued" status via context menu or side panel button
   - Auto-transition: "queued" → "in_progress" when first note is created
   - Manual status changes (mark as complete/archived)
   - Sort queued videos by `queued_at` timestamp

4. **Basic Search & Filtering**
   - Text search across video titles and URLs (ILIKE pattern matching)
   - Filter by platform (YouTube, Vimeo, etc.)
   - Filter by status (All/Queued/In Progress/Complete)

5. **Database Schema Updates**
   - Add `status` enum field to videos (queued, in_progress, complete, archived)
   - Add `last_viewed_at` timestamp (auto-updated on note creation or playback)
   - Add `queued_at` timestamp (set when status → queued)
   - Add `completed_at` timestamp (set when status → complete)
   - Add `metadata` JSONB field (for future extensibility)
   - Intelligent backfill: existing videos with notes → "in_progress", without notes → "queued"
   - Index for efficient sorting and filtering

### Future Goals (Scaffolding Only)

6. **Agent Query Interface** (Prepare, Don't Implement)
   - Design context functions like `Videos.get_videos_for_context/2`
   - Comment code showing how agents would query: "Get all YouTube videos with 'tutorial' in title that have notes in 'pacing' category"
   - Document in `AGENTS.md` for future sprint

7. **Semantic Search Integration** (Prepare for Sprint 10)
   - `metadata` JSONB field ready for future embedding storage
   - Design schema to support pgvector embeddings (but don't implement yet)

8. **Note Aggregation** (Design, Don't Build)
   - Sketch out query patterns for "show me all notes across videos about color grading"
   - Document join patterns for future cross-video analysis

9. **Media Asset Management Foundation** (Long-term Vision)
   - Design extensible metadata schema
   - Document potential fields: source_file_url, project_id, team_id, tags, custom_metadata
   - Don't implement - just ensure current schema won't block future expansion

---

## Success Criteria

### Must Have ✅
- [ ] User can view chronological list of all videos they've worked on
- [ ] User can click video to open in new tab
- [ ] User can manually queue videos for later review
- [ ] User can mark videos as "In Progress" or "Complete"
- [ ] Videos show note count badge
- [ ] Search by title/URL works (simple text search)
- [ ] Status filter dropdown works (All/Queued/In Progress/Complete)
- [ ] `last_viewed_at` auto-updates when user creates notes
- [ ] Database migration runs cleanly with no downtime

### Nice to Have 🎁
- [ ] Platform icons next to video titles
- [ ] Duration displayed in human-readable format (e.g., "12:34")
- [ ] Thumbnail preview on hover
- [ ] Bulk actions (select multiple → mark complete)
- [ ] Keyboard shortcuts (j/k navigation, enter to open)

### Future Sprints (Document Only) 📝
- [ ] Full-text search using tsvector (PostgreSQL FTS)
- [ ] Semantic search using pgvector embeddings
- [ ] Agent context injection ("relevant past videos" suggestion)
- [ ] Auto-status transitions (in_progress when recording starts, complete when all notes posted)
- [ ] Source file upload/linking
- [ ] Project/workspace grouping

---

## Technical Design

### Database Schema Changes

**Migration:** `priv/repo/migrations/TIMESTAMP_add_video_library_fields.exs`

```elixir
defmodule Lossy.Repo.Migrations.AddVideoLibraryFields do
  use Ecto.Migration
  import Ecto.Query

  def up do
    alter table(:videos) do
      # Lifecycle status
      add :status, :string
      # Values: "queued", "in_progress", "complete", "archived"

      # Timestamps for sorting and filtering
      add :last_viewed_at, :utc_datetime
      add :queued_at, :utc_datetime
      add :completed_at, :utc_datetime

      # Future: Metadata for embeddings, custom fields, etc.
      # (JSONB chosen over map for PostgreSQL-specific indexing support)
      add :metadata, :map, default: %{}
      # Format (future): %{
      #   embedding: [1024 floats],           # Video-level summary embedding
      #   tags: ["tutorial", "color-grading"], # User-defined tags
      #   project_id: "uuid",                  # Project grouping
      #   source_file_url: "s3://...",         # Original media file
      #   custom: %{}                          # Extensible user data
      # }
    end

    # Backfill status based on note count
    # Videos with notes → "in_progress"
    # Videos without notes → "queued" (user queued but hasn't started)
    execute("""
      UPDATE videos
      SET status = CASE
        WHEN EXISTS (SELECT 1 FROM notes WHERE notes.video_id = videos.id) THEN 'in_progress'
        ELSE 'queued'
      END,
      last_viewed_at = COALESCE(
        (SELECT MAX(inserted_at) FROM notes WHERE notes.video_id = videos.id),
        videos.inserted_at
      )
    """)

    # Now make status non-nullable with default
    alter table(:videos) do
      modify :status, :string, null: false, default: "in_progress"
    end

    # Indexes for efficient queries
    create index(:videos, [:status])
    create index(:videos, [:last_viewed_at])
    create index(:videos, [:user_id, :last_viewed_at])
    create index(:videos, [:user_id, :status, :last_viewed_at])

    # Full-text search index (future - commented for Sprint 10)
    # execute("CREATE INDEX videos_title_search_idx ON videos USING gin(to_tsvector('english', title))")
  end

  def down do
    alter table(:videos) do
      remove :status
      remove :last_viewed_at
      remove :queued_at
      remove :completed_at
      remove :metadata
    end

    drop_if_exists index(:videos, [:status])
    drop_if_exists index(:videos, [:last_viewed_at])
    drop_if_exists index(:videos, [:user_id, :last_viewed_at])
    drop_if_exists index(:videos, [:user_id, :status, :last_viewed_at])
  end
end
```

**Schema Updates:** `lib/lossy/videos/video.ex`

```elixir
schema "videos" do
  # ... existing fields ...

  # Sprint 09: Video library
  field :status, :string, default: "in_progress"
  field :last_viewed_at, :utc_datetime
  field :queued_at, :utc_datetime
  field :completed_at, :utc_datetime
  field :metadata, :map, default: %{}

  # Virtual field: note count (loaded via query)
  field :note_count, :integer, virtual: true

  # ... existing associations ...
end

def changeset(video, attrs) do
  video
  |> cast(attrs, [
    # ... existing fields ...
    :status,
    :last_viewed_at,
    :queued_at,
    :completed_at,
    :metadata
  ])
  |> validate_required([:platform, :external_id, :url])
  |> validate_inclusion(:status, ~w(queued in_progress complete archived))
  # Auto-set timestamps based on status transitions
  |> maybe_set_status_timestamps()
end

defp maybe_set_status_timestamps(changeset) do
  case get_change(changeset, :status) do
    "queued" -> put_change(changeset, :queued_at, DateTime.utc_now())
    "complete" -> put_change(changeset, :completed_at, DateTime.utc_now())
    _ -> changeset
  end
end
```

---

### Backend Context Functions

**File:** `lib/lossy/videos.ex` (extend existing)

```elixir
# Sprint 09: Video library queries

@doc """
Lists videos for the given user, ordered by most recently viewed.
Includes note count and supports filtering by status and search term.

## Options
- `:status` - Filter by status (queued, in_progress, complete, archived)
- `:platform` - Filter by platform (youtube, vimeo, etc.)
- `:search` - Text search on title/URL (case-insensitive)
- `:limit` - Max results (default: 100)

## Returns
List of videos with preloaded note_count virtual field.
"""
def list_user_videos(user_id, opts \\ []) do
  Video
  |> where([v], v.user_id == ^user_id)
  |> apply_video_filters(opts)
  |> order_by([v], desc: v.last_viewed_at, desc: v.inserted_at)
  |> limit(^Keyword.get(opts, :limit, 100))
  |> join(:left, [v], n in Note, on: n.video_id == v.id)
  |> group_by([v], v.id)
  |> select_merge([v, n], %{note_count: count(n.id)})
  |> Repo.all()
end

@doc """
Updates last_viewed_at to current time and auto-transitions status if needed.

Called when:
- User creates a note on the video
- User opens the video (if we add playback tracking later)

Auto-transitions:
- "queued" → "in_progress" when first note is created
"""
def touch_video(video_id) do
  video = Repo.get!(Video, video_id)

  attrs = %{last_viewed_at: DateTime.utc_now()}

  # Auto-transition: queued → in_progress when first note created
  attrs = if video.status == "queued" do
    Map.put(attrs, :status, "in_progress")
  else
    attrs
  end

  update_video(video, attrs)
end

@doc """
Transitions video to new status and sets appropriate timestamp.
"""
def update_video_status(video_id, new_status) when new_status in ~w(queued in_progress complete archived) do
  video = Repo.get!(Video, video_id)
  update_video(video, %{status: new_status})
end

@doc """
Queues a video for later review. Creates video record if doesn't exist.
"""
def queue_video(user_id, video_attrs) do
  case find_or_create_video(Map.put(video_attrs, :user_id, user_id)) do
    {:ok, video} ->
      update_video_status(video.id, "queued")

    {:error, changeset} ->
      {:error, changeset}
  end
end

# Future: Agent query interface (Sprint 10+)
@doc """
(FUTURE) Get videos filtered by platform, tags, or note categories.
Example: Get all YouTube videos with notes in 'pacing' category.

## Examples
    iex> Videos.get_videos_for_context(user_id,
          platform: "youtube",
          note_categories: ["pacing", "audio"],
          limit: 5
        )

This is a placeholder for agent context retrieval in future sprints.
"""
def get_videos_for_context(user_id, opts \\ []) do
  # TODO: Implement in Sprint 10 (semantic search)
  # Will support:
  # - Embedding similarity search (pgvector)
  # - Note category filtering
  # - Platform filtering
  # - Date range filtering
  # - Full-text search

  raise "Not implemented - planned for Sprint 10"
end

defp apply_video_filters(query, opts) do
  Enum.reduce(opts, query, fn
    {:status, status}, q -> where(q, [v], v.status == ^status)
    {:platform, platform}, q -> where(q, [v], v.platform == ^platform)
    {:search, term}, q ->
      pattern = "%#{term}%"
      where(q, [v], ilike(v.title, ^pattern) or ilike(v.url, ^pattern))
    _, q -> q
  end)
end

defp update_video(video, attrs) do
  video
  |> Video.changeset(attrs)
  |> Repo.update()
end
```

---

### Phoenix Channel Updates

**File:** `lib/lossy_web/channels/video_channel.ex`

```elixir
# Sprint 09: Video library events

def handle_in("list_videos", %{"filters" => filters}, socket) do
  user_id = socket.assigns.user_id

  videos = Videos.list_user_videos(user_id,
    status: filters["status"],
    platform: filters["platform"],
    search: filters["search"],
    limit: Map.get(filters, "limit", 100)
  )

  {:reply, {:ok, %{videos: serialize_videos(videos)}}, socket}
end

def handle_in("update_video_status", %{"video_id" => video_id, "status" => status}, socket) do
  case Videos.update_video_status(video_id, status) do
    {:ok, video} ->
      # Broadcast to all connected clients for this user
      broadcast(socket, "video_updated", serialize_video(video))
      {:reply, :ok, socket}

    {:error, _changeset} ->
      {:reply, {:error, %{reason: "Invalid status transition"}}, socket}
  end
end

def handle_in("queue_video", video_attrs, socket) do
  user_id = socket.assigns.user_id

  case Videos.queue_video(user_id, video_attrs) do
    {:ok, video} ->
      broadcast(socket, "video_queued", serialize_video(video))
      {:reply, {:ok, serialize_video(video)}, socket}

    {:error, changeset} ->
      {:reply, {:error, %{reason: "Failed to queue video"}}, socket}
  end
end

defp serialize_videos(videos) do
  Enum.map(videos, &serialize_video/1)
end

defp serialize_video(video) do
  %{
    id: video.id,
    platform: video.platform,
    external_id: video.external_id,
    url: video.url,
    title: video.title,
    thumbnail_url: video.thumbnail_url,
    duration_seconds: video.duration_seconds,
    status: video.status,
    last_viewed_at: video.last_viewed_at,
    note_count: Map.get(video, :note_count, 0),
    inserted_at: video.inserted_at
  }
end
```

---

### Extension Side Panel UI

**File:** `extension/src/sidepanel/sidepanel.html` (add new section)

```html
<!-- Sprint 09: Video Library Section -->
<div class="section-tabs" id="sectionTabs">
  <button class="tab-btn active" data-section="notes">Notes</button>
  <button class="tab-btn" data-section="library">Library</button>
</div>

<div class="section-content" id="notesSection">
  <!-- Existing notes/waveform UI stays here -->
</div>

<div class="section-content hidden" id="librarySection">
  <!-- Video Library UI -->
  <div class="library-header">
    <input
      type="text"
      id="videoSearch"
      placeholder="Search videos..."
      class="search-input"
    />

    <div class="library-filters">
      <select id="statusFilter" class="filter-select">
        <option value="">All Videos</option>
        <option value="queued">Queued</option>
        <option value="in_progress">In Progress</option>
        <option value="complete">Complete</option>
      </select>

      <select id="platformFilter" class="filter-select">
        <option value="">All Platforms</option>
        <option value="youtube">YouTube</option>
        <option value="vimeo">Vimeo</option>
        <option value="frame_io">Frame.io</option>
      </select>
    </div>
  </div>

  <div class="video-list" id="videoList">
    <!-- Populated dynamically via JS -->
  </div>
</div>
```

**CSS Additions:**

```css
.section-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 2px solid #e5e7eb;
}

.tab-btn {
  flex: 1;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}

.tab-btn:hover {
  color: #374151;
}

.tab-btn.active {
  color: #3b82f6;
  border-bottom-color: #3b82f6;
}

.section-content.hidden {
  display: none;
}

.library-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.search-input {
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}

.library-filters {
  display: flex;
  gap: 8px;
}

.filter-select {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  background: white;
}

.video-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.video-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  border-left: 4px solid transparent;
}

.video-item:hover {
  background: #f3f4f6;
  transform: translateX(4px);
}

.video-item[data-status="queued"] {
  border-left-color: #fbbf24;
}

.video-item[data-status="in_progress"] {
  border-left-color: #3b82f6;
}

.video-item[data-status="complete"] {
  border-left-color: #10b981;
}

.video-thumbnail {
  width: 80px;
  height: 45px;
  border-radius: 4px;
  object-fit: cover;
  background: #e5e7eb;
}

.video-info {
  flex: 1;
  min-width: 0;
}

.video-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}

.video-platform {
  text-transform: capitalize;
}

.video-notes-count {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: #dbeafe;
  color: #1e40af;
  border-radius: 4px;
  font-weight: 600;
}

.video-status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.video-status-badge.queued {
  background: #fef3c7;
  color: #92400e;
}

.video-status-badge.in_progress {
  background: #dbeafe;
  color: #1e40af;
}

.video-status-badge.complete {
  background: #d1fae5;
  color: #065f46;
}
```

**File:** `extension/src/sidepanel/sidepanel.js` (add library logic)

```javascript
// Sprint 09: Video Library Management

let currentSection = 'notes';
let videoLibraryCache = [];

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const section = e.target.dataset.section;
    switchSection(section);
  });
});

function switchSection(section) {
  currentSection = section;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });

  // Update section visibility
  document.getElementById('notesSection').classList.toggle('hidden', section !== 'notes');
  document.getElementById('librarySection').classList.toggle('hidden', section !== 'library');

  // Load library data if switching to library
  if (section === 'library') {
    loadVideoLibrary();
  }
}

// Load video library from backend
async function loadVideoLibrary() {
  const filters = {
    status: document.getElementById('statusFilter').value,
    platform: document.getElementById('platformFilter').value,
    search: document.getElementById('videoSearch').value
  };

  // Send via Phoenix Channel (assuming channel is already connected)
  chrome.runtime.sendMessage({
    type: 'channel_message',
    channel: 'video',
    event: 'list_videos',
    payload: { filters }
  }, (response) => {
    if (response.ok) {
      videoLibraryCache = response.videos;
      renderVideoLibrary(response.videos);
    }
  });
}

// Render video library list
function renderVideoLibrary(videos) {
  const listEl = document.getElementById('videoList');

  if (videos.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No videos found</div>';
    return;
  }

  listEl.innerHTML = videos.map(video => `
    <div class="video-item"
         data-video-id="${video.id}"
         data-status="${video.status}"
         data-url="${video.url}">
      <img
        src="${video.thumbnail_url || '/placeholder.png'}"
        class="video-thumbnail"
        alt="${video.title || 'Video thumbnail'}"
      />
      <div class="video-info">
        <div class="video-title">${video.title || 'Untitled Video'}</div>
        <div class="video-meta">
          <span class="video-platform">${video.platform}</span>
          ${video.note_count > 0 ? `<span class="video-notes-count">${video.note_count} notes</span>` : ''}
          <span class="video-status-badge ${video.status}">${video.status.replace('_', ' ')}</span>
        </div>
      </div>
    </div>
  `).join('');

  // Attach click handlers
  listEl.querySelectorAll('.video-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const url = e.currentTarget.dataset.url;
      chrome.tabs.create({ url });
    });
  });
}

// Filter event listeners
document.getElementById('statusFilter').addEventListener('change', loadVideoLibrary);
document.getElementById('platformFilter').addEventListener('change', loadVideoLibrary);

// Search with debounce
let searchTimeout;
document.getElementById('videoSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadVideoLibrary();
  }, 300);
});

// Listen for video updates from channel
// (Assuming service worker forwards channel broadcasts to side panel)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'channel_broadcast') {
    if (message.event === 'video_updated' || message.event === 'video_queued') {
      // Refresh library if currently viewing
      if (currentSection === 'library') {
        loadVideoLibrary();
      }
    }
  }
});
```

---

### Service Worker Updates

**File:** `extension/src/background/service-worker.js`

```javascript
// Sprint 09: Queue video from context menu

chrome.runtime.onInstalled.addListener(() => {
  // Create context menu for queueing videos
  chrome.contextMenus.create({
    id: 'queue-video',
    title: 'Add to Lossy Queue',
    contexts: ['page', 'link'],
    documentUrlPatterns: [
      '*://*.youtube.com/*',
      '*://*.vimeo.com/*',
      '*://*.frame.io/*'
      // Add more platforms as needed
    ]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'queue-video') {
    queueCurrentVideo(tab);
  }
});

async function queueCurrentVideo(tab) {
  // Extract video metadata from tab
  const videoData = await extractVideoMetadata(tab);

  // Send to backend via channel
  sendChannelMessage('video', 'queue_video', videoData, (response) => {
    if (response.ok) {
      // Show notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Video Queued',
        message: `Added "${videoData.title}" to your queue`
      });
    }
  });
}

async function extractVideoMetadata(tab) {
  // Inject content script to extract metadata
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Platform-specific selectors (reuse from existing adapters)
      const title = document.querySelector('h1')?.textContent || document.title;
      const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

      return { title, thumbnail };
    }
  });

  // Detect platform from URL
  const url = new URL(tab.url);
  const platform = detectPlatform(url.hostname);
  const external_id = extractExternalId(url, platform);

  return {
    platform,
    external_id,
    url: tab.url,
    title: result.result?.title || tab.title,
    thumbnail_url: result.result?.thumbnail
  };
}

function detectPlatform(hostname) {
  if (hostname.includes('youtube.com')) return 'youtube';
  if (hostname.includes('vimeo.com')) return 'vimeo';
  if (hostname.includes('frame.io')) return 'frame_io';
  // Add more platforms as needed
  return 'generic';
}

function extractExternalId(url, platform) {
  switch (platform) {
    case 'youtube':
      return url.searchParams.get('v') || url.pathname.split('/').pop();
    case 'vimeo':
      return url.pathname.split('/').filter(Boolean).pop();
    default:
      return url.pathname;
  }
}
```

---

## Implementation Phases

### Phase 1: Database & Backend (Day 1)

**Tasks:**
1. Create and run migration
2. Update `Video` schema with new fields and validations
3. Implement context functions in `Videos` module
4. Write tests for new query functions
5. Add channel handlers to `VideoChannel`

**Validation:**
```bash
cd lossy
mix ecto.migrate
iex -S mix phx.server

# Test in IEx:
iex> alias Lossy.Videos
iex> user_id = "..." # Use existing user ID
iex> Videos.queue_video(user_id, %{platform: "youtube", external_id: "test123", url: "https://youtube.com/watch?v=test123", title: "Test Video"})
iex> Videos.list_user_videos(user_id)
iex> Videos.list_user_videos(user_id, status: "queued", search: "Test")
```

---

### Phase 2: Side Panel UI (Day 2)

**Tasks:**
1. Add HTML structure for Library section
2. Add CSS styles
3. Implement tab switching logic
4. Build video list rendering
5. Wire up filter controls
6. Test with mock data first

**Validation:**
- Load side panel
- Switch between Notes and Library tabs
- Verify layout and styling
- Test with hardcoded video data

---

### Phase 3: Channel Integration (Day 2-3)

**Tasks:**
1. Update service worker to forward channel events
2. Implement `list_videos` channel handler
3. Implement `update_video_status` handler
4. Implement `queue_video` handler
5. Add real-time broadcast updates
6. Wire up side panel to actual backend

**Validation:**
- Open side panel, switch to Library
- Verify videos load from database
- Change status filter, verify re-query
- Search for video by title
- Queue a video from another tab via context menu

---

### Phase 4: Auto-Touch Integration (Day 3)

**Tasks:**
1. Update note creation flow to call `Videos.touch_video/1`
2. Ensure `last_viewed_at` updates when note created
3. Test sorting (most recent first)

**Validation:**
1. Watch video A, create note → verify last_viewed_at updates
2. Watch video B, create note → verify it appears at top of library
3. Return to video A, create another note → verify A jumps back to top

---

### Phase 5: Polish & Edge Cases (Day 4)

**Tasks:**
1. Handle videos without thumbnails (placeholder image)
2. Handle videos without titles (show URL or "Untitled")
3. Empty states ("No videos found")
4. Loading states
5. Error handling (network failures, invalid status transitions)
6. Performance testing (100+ videos)

**Validation:**
- Load library with 100+ videos, verify smooth scrolling
- Disconnect backend, verify graceful error handling
- Queue video with missing metadata, verify fallbacks

---

## Files Modified/Created

### Backend (Created)
- `lossy/priv/repo/migrations/TIMESTAMP_add_video_library_fields.exs`

### Backend (Modified)
- `lossy/lib/lossy/videos/video.ex` - Add fields, validations, timestamp logic
- `lossy/lib/lossy/videos.ex` - Add library query functions
- `lossy/lib/lossy_web/channels/video_channel.ex` - Add library event handlers
- `lossy/lib/lossy/videos.ex` - Update `create_note/1` to touch video

### Extension (Modified)
- `extension/src/sidepanel/sidepanel.html` - Add Library section UI
- `extension/src/sidepanel/sidepanel.js` - Add library rendering logic
- `extension/src/background/service-worker.js` - Add context menu, video queueing

### Documentation (Modified)
- `docs/AGENTS.md` - Document future agent query patterns
- `README.md` - Update feature list to mention video library

---

## Testing Guide

### Unit Tests (Backend)

**File:** `lossy/test/lossy/videos_test.exs`

```elixir
describe "video library" do
  test "list_user_videos/2 returns videos sorted by last_viewed_at" do
    user = user_fixture()

    video1 = video_fixture(user_id: user.id, last_viewed_at: ~U[2025-10-20 10:00:00Z])
    video2 = video_fixture(user_id: user.id, last_viewed_at: ~U[2025-10-21 12:00:00Z])

    videos = Videos.list_user_videos(user.id)

    assert length(videos) == 2
    assert hd(videos).id == video2.id # Most recent first
  end

  test "list_user_videos/2 filters by status" do
    user = user_fixture()

    queued = video_fixture(user_id: user.id, status: "queued")
    complete = video_fixture(user_id: user.id, status: "complete")

    results = Videos.list_user_videos(user.id, status: "queued")

    assert length(results) == 1
    assert hd(results).id == queued.id
  end

  test "list_user_videos/2 searches by title" do
    user = user_fixture()

    match = video_fixture(user_id: user.id, title: "Color Grading Tutorial")
    no_match = video_fixture(user_id: user.id, title: "Audio Mixing Guide")

    results = Videos.list_user_videos(user.id, search: "color")

    assert length(results) == 1
    assert hd(results).id == match.id
  end

  test "update_video_status/2 sets queued_at timestamp" do
    video = video_fixture(status: "in_progress")

    {:ok, updated} = Videos.update_video_status(video.id, "queued")

    assert updated.status == "queued"
    assert updated.queued_at != nil
  end

  test "touch_video/1 updates last_viewed_at" do
    video = video_fixture(last_viewed_at: ~U[2025-01-01 00:00:00Z])

    {:ok, touched} = Videos.touch_video(video.id)

    assert DateTime.compare(touched.last_viewed_at, ~U[2025-01-01 00:00:00Z]) == :gt
  end

  test "touch_video/1 auto-transitions queued → in_progress" do
    video = video_fixture(status: "queued")

    {:ok, updated} = Videos.touch_video(video.id)

    assert updated.status == "in_progress"
    assert updated.last_viewed_at != nil
  end

  test "touch_video/1 does not change status if already in_progress" do
    video = video_fixture(status: "in_progress")

    {:ok, updated} = Videos.touch_video(video.id)

    assert updated.status == "in_progress"
  end
end
```

### Integration Tests

**Scenario 1: Queue video from context menu**
1. Navigate to YouTube video
2. Right-click → "Add to Lossy Queue"
3. Open side panel → Library tab
4. Verify video appears with "Queued" badge

**Scenario 2: Search and filter**
1. Queue 3 videos with different titles and platforms
2. Open Library tab
3. Type "tutorial" in search → verify only matching videos shown
4. Clear search, select "YouTube" in platform filter → verify only YouTube videos shown
5. Select "Queued" status filter → verify only queued videos shown

**Scenario 3: Auto-status transitions**
1. Queue a video via context menu
2. Open Library tab → verify video shows "Queued" badge
3. Navigate to the queued video, create first note
4. Return to Library tab → verify status automatically changed to "In Progress"
5. Verify video moved to top of list (last_viewed_at updated)
6. Create more notes → verify status stays "In Progress"
7. Mark video as complete (manual button) → verify "Complete" badge appears

**Scenario 4: Real-time updates**
1. Open side panel on Library tab in one window
2. In another window, queue a video
3. Verify first window updates without refresh

---

## Future Enhancements (Post-Sprint 09)

### Sprint 10: Semantic Search Integration
- Add pgvector extension to PostgreSQL
- Generate embeddings for video titles + aggregated note text
- Implement similarity search: "Find videos similar to this one"
- Agent context: "Pull videos related to current video's topic"

### Auto-Status Transitions
- `queued` → `in_progress` when first note created
- `in_progress` → `complete` when:
  - All notes marked as "posted" (status: "posted")
  - User manually marks complete
  - Agent suggests completion based on note density

### Bulk Operations
- Select multiple videos → mark complete
- Select multiple videos → archive
- Export video list as CSV/JSON

### Advanced Metadata
- Custom tags (user-defined)
- Project grouping (e.g., "Client XYZ project")
- Team collaboration (shared video libraries)
- Source file linking (upload or S3 URL)

### Agent-Powered Features
- Auto-suggest related videos based on current context
- "Pull in notes from previous tutorial videos" - agent queries library
- Smart queueing: "Add all videos from this creator to queue"

### Cross-Video Analysis
- "Show me all notes about color grading across my library"
- Timeline view: "What videos did I review last week?"
- Heatmap: "Which platforms do I review most often?"

---

## Risks & Mitigations

### Risk 1: Performance with Large Libraries
**Risk:** Slow queries when user has 1000+ videos

**Mitigation:**
- Implement pagination (load 100 at a time)
- Add database indexes (already planned)
- Use `limit` in all queries
- Future: Virtual scrolling in UI

### Risk 2: Search Quality
**Risk:** Simple ILIKE search misses relevant videos

**Mitigation:**
- Phase 1: ILIKE is good enough for MVP
- Phase 2: Upgrade to PostgreSQL full-text search (tsvector)
- Phase 3: Semantic search via pgvector (Sprint 10)

### Risk 3: Status Sync Issues
**Risk:** Status out of sync if multiple tabs open

**Mitigation:**
- Use Phoenix PubSub broadcasts
- Service worker maintains single source of truth
- Side panel subscribes to real-time updates

### Risk 4: Migration Breaking Production
**Risk:** Adding non-nullable fields breaks existing videos

**Mitigation:**
- All new fields are nullable or have defaults
- `status` defaults to "in_progress"
- `last_viewed_at` can be null (backfill later)
- Test migration on staging DB first

---

## Success Metrics

### Qualitative
- ✅ "I can easily find videos I reviewed last week"
- ✅ "I can queue videos for later without interrupting my current session"
- ✅ "I can see at a glance which videos still need work"

### Quantitative
- Query latency: `list_user_videos/2` returns in <100ms for 500 videos
- UI responsiveness: Library tab loads in <500ms
- Search latency: Results update in <300ms after typing
- No N+1 queries (verify with Ecto query logging)

---

## Dependencies

### Required for Sprint 09
- ✅ PostgreSQL database running
- ✅ Phoenix Channels working (existing)
- ✅ Videos table exists (Sprint 00)
- ✅ Notes association working (Sprint 02)

### Optional (Future Sprints)
- ⏳ pgvector extension (Sprint 10 - semantic search)
- ⏳ User authentication (Sprint TBD - multi-user support)
- ⏳ Oban jobs (future - batch operations)

---

## Open Questions ✅ Resolved

1. **Auto-status transitions:** Should we auto-move videos from "queued" → "in_progress" when first note created? Or keep manual for now?
   - **Decision:** ✅ **Yes, implement auto-transition.** Videos automatically move from "queued" → "in_progress" when the user creates their first note. This provides clear feedback that work has started without requiring manual status management. Implemented in `Videos.touch_video/1`.

2. **Default status for existing videos:** Should migration backfill status based on note count?
   - **Decision:** ✅ **Yes, backfill intelligently.** Migration sets status to "in_progress" for videos with existing notes, and "queued" for videos without notes. Also backfills `last_viewed_at` from the most recent note timestamp. This provides sensible defaults based on actual user activity.

3. **Thumbnail fallbacks:** Where to get thumbnails for platforms without og:image?
   - **Decision:** ✅ Use platform icons as fallback (YouTube logo, Vimeo logo, etc.)

4. **Queue ordering:** FIFO (queued_at ASC) or let users manually reorder?
   - **Decision:** ✅ FIFO for MVP, add drag-to-reorder in future sprint

5. **Archive vs Delete:** Should we add "archive" status or just delete?
   - **Decision:** ✅ Include "archive" status in schema now, implement UI later

---

## Sprint Completion Checklist

- [ ] Database migration runs successfully (including backfill logic)
- [ ] All backend tests pass (including auto-transition tests)
- [ ] Video library renders in side panel as separate tab
- [ ] Tab switching between Notes and Library works
- [ ] Search and filters work (status, platform, text search)
- [ ] Videos can be queued from context menu
- [ ] Status badges display correctly (Queued/In Progress/Complete)
- [ ] Auto-transition: queued → in_progress when first note created
- [ ] `last_viewed_at` updates correctly when notes created
- [ ] Real-time updates working via PubSub
- [ ] Code review complete
- [ ] Documentation updated (README, AGENTS.md)
- [ ] Sprint retrospective written

---

**Sprint Status:** 📋 Ready to start
**Blocked by:** None
**Blocking:** Sprint 10 (Semantic Search - depends on video library foundation)

---

## Appendix: Agent Query Patterns (Future Reference)

```elixir
# Example 1: Agent needs context from past YouTube videos
Videos.get_videos_for_context(user_id,
  platform: "youtube",
  note_categories: ["pacing", "editing"],
  limit: 5,
  order: :most_relevant  # Future: embedding similarity
)

# Example 2: Agent suggests related videos
"I notice you're reviewing a tutorial video. Here are 3 similar tutorial videos
you reviewed in the past that might have relevant feedback patterns:
- Video A (12 notes about pacing)
- Video B (8 notes about audio quality)
- Video C (15 notes about editing flow)"

# Example 3: Cross-video insights
"You've left 47 notes about 'color grading' across 12 videos.
Your most common feedback patterns are:
1. Skin tones too saturated (8 videos)
2. Shadows crushed (6 videos)
3. Inconsistent white balance (5 videos)"
```

---

**Document Version:** 1.0
**Last Updated:** 2025-10-22
**Author:** Claude Code (Sprint Planning Assistant)
