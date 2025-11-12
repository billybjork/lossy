# Data Model

> "Your data model is your destiny."

The data model is the foundation of Lossy. It's designed to be:
- **Small**: A focused set of stable, composable entities
- **Evolvable**: New features fit as "more of the same", not ad-hoc flags
- **Clear**: Each entity has a single, well-defined purpose

## Core Entities

### User

Basic user identity for associating captures with accounts.

**Fields**:
- `id` (UUID, primary key)

**Future**:
- Authentication fields (email, password hash, etc.)
- Preferences, quotas, plan information

---

### Document (aka Capture)

Represents one captured image and its editing session.

**Fields**:
- `id` (UUID, primary key)
- `user_id` (UUID, foreign key → User)
- `source_url` (string) - The web page URL where image was captured
- `source_url_verified_at` (timestamp, nullable) - When the source URL was last verified
- `source_url_status` (enum: `not_checked` | `accessible` | `unreachable` | `timeout`) - Accessibility status of the source URL
- `capture_mode` (enum: `direct_asset` | `screenshot`) - How the image was obtained
- `dimensions` (JSON: `{width, height}`) - Pixel dimensions at capture time
- `original_asset_id` (UUID, foreign key → Asset) - Pointer to stored original image
- `working_asset_id` (UUID, foreign key → Asset) - Pointer to current composited image with edits
- `status` (enum: `queued_detection` | `detecting` | `awaiting_edits` | `rendering` | `export_ready` | `error`) - Document processing state
- `metrics` (JSONB) - Derived data like dominant colors or OCR confidence
- `created_at` (timestamp)
- `updated_at` (timestamp)

**Relationships**:
- `has_many :text_regions`
- `has_many :processing_jobs`

**Status Flow**:
```
queued_detection → detecting → awaiting_edits → rendering → export_ready
                                  ↘ error
```

**State Transition Validation**: The document changeset should validate that status transitions follow the defined flow. Invalid transitions (e.g., `detecting` → `export_ready`) should be rejected to prevent inconsistent states. Implement this in the changeset with a custom validation function.

**Future Extensions**:
- Add `project_id` for organizing multiple documents
- Add `team_id`/`workspace_id` when collaboration features arrive

---

### Asset

Represents every binary artifact (original capture, working composites, masks, exports).

**Fields**:
- `id` (UUID, primary key)
- `document_id` (UUID, foreign key → Document)
- `kind` (enum: `original` | `working` | `mask` | `inpainted_patch` | `export`)
- `storage_uri` (string) - Location of the asset (local path, S3 key, etc.)
- `width` / `height` (integers) - Pixel dimensions
- `sha256` (string) - Integrity + dedupe
- `metadata` (JSONB) - EXIF, DPI, color profile, etc.
- `created_at` / `updated_at`

**Relationships**:
- `belongs_to :document`

**Usage**:
- Documents reference the relevant assets via `original_asset_id`/`working_asset_id`
- Text regions can point at `inpainted_asset_id`
- Processing jobs can emit new assets without sprinkling raw file paths across tables

---

### TextRegion

Represents one detected text area within a document, including its styling and current state.

**Fields**:
- `id` (UUID, primary key)
- `document_id` (UUID, foreign key → Document)
- `bbox` (JSON: `{x, y, w, h}`) - Axis-aligned bounding box in image coordinates
- `polygon` (JSON: `[{x, y}, ...]`) - Original quadrilateral from detector for rotated text
- `padding_px` (integer) - Extra expansion for inpainting mask
- `original_text` (string, nullable) - OCR output (optional, for reference)
- `current_text` (string, nullable) - Text currently displayed (defaults to `original_text`)
- `style_snapshot` (JSONB) - Captures font/color/alignment for undo + auditing
- `font_family` (string) - e.g., "Inter", "Roboto"
- `font_weight` (integer) - e.g., 400, 700
- `font_size_px` (integer) - Font size in pixels
- `color_rgba` (string) - e.g., "rgba(255,255,255,1.0)`
- `alignment` (enum: `left` | `center` | `right`)
- `inpainted_asset_id` (UUID, foreign key → Asset, nullable) - Background-only patch
- `z_index` (integer) - Layering order (for future multi-layer support)
- `status` (enum: `detected` | `inpainting` | `rendered` | `error`) - Processing state

**Relationships**:
- `belongs_to :document`

**Design Notes**:
- `bbox` and `polygon`: The axis-aligned bounding box (`bbox`) is derived from the `polygon` for simple rectangular text. For rotated/skewed detections, `polygon` contains the original quadrilateral points from the detector, while `bbox` stores the minimum enclosing rectangle for efficient querying and rendering. Both are stored redundantly for performance.
- `metrics` JSONB usage: Store expensive-to-compute derived data here (dominant colors, OCR confidence scores, font guesses). Don't use for frequently-updated values or data that should be in dedicated columns.

**Status Flow**:
```
detected → inpainting → rendered
           ↘ error
```

**Future Extensions**:
- Support for rotated/transformed text (add rotation, skew fields)
- Support for multi-line text (add line_height, text_align_vertical)
- Rich styling (shadow, stroke, gradient)

---

### ProcessingJob

Represents an asynchronous ML or image processing task.

**Fields**:
- `id` (UUID, primary key)
- `document_id` (UUID, foreign key → Document)
- `subject_type` (enum: `document` | `text_region`)
- `subject_id` (UUID, foreign key) - Entity this job mutates
- `type` (enum: `text_detection` | `inpaint_region` | `upscale_document` | `font_guess`)
- `payload` (JSON) - Job-specific parameters (model version, padding, etc.)
- `status` (enum: `queued` | `running` | `done` | `error`)
- `attempts` (integer, default 0)
- `max_attempts` (integer, default 3)
- `locked_at` (timestamp, nullable) - For Oban-style locking
- `error_message` (string, nullable)
- `created_at` (timestamp)
- `updated_at` (timestamp)

**Relationships**:
- `belongs_to :document`

**Status Flow**:
```
queued → running → done
                ↘ error
```

**Job Types**:
- `text_detection`: Detect all text regions in a document
- `inpaint_region`: Remove text from a specific region
- `upscale_document`: Super-resolution enhancement
- `font_guess`: Infer font characteristics from image

**Future Extensions**:
- Add `queue`/`priority` fields for multi-tier processing
- Add `result` JSON field for storing job outputs
- Add `scheduled_at` for deferred jobs

---

## Entity Relationships

```
User
 └─ has_many Documents
        ├─ has_many Assets
        ├─ has_many TextRegions
        └─ has_many ProcessingJobs
```

## Evolution Strategy

This structure is **composable** and **extensible**:

### Adding Non-Text Layers (v2+)

Introduce a `Layer` table that generalizes `TextRegion`:

```
Layer
- id
- document_id
- type (enum: text | sticker | shape | filter)
- position (JSON: x, y, w, h)
- z_index
- status
- layer_data (JSON, type-specific fields)
```

`TextRegion` can either:
1. Remain as-is and reference `Layer` via `layer_id`, or
2. Migrate to become a specialized view/subtype of `Layer`

### Adding Projects/Folders

```
Project
- id
- user_id
- name
- created_at

Document gains:
- project_id (foreign key → Project)
```

### Adding Collaboration

```
ProjectMember
- project_id
- user_id
- role (owner | editor | viewer)
```

### Adding Version History

```
DocumentVersion
- id
- document_id
- working_image_path
- version_number
- created_at
```

## Database Indexes

**Essential indexes for MVP**:
- `documents.user_id`
- `documents.status`
- `text_regions.document_id`
- `processing_jobs.document_id`
- `processing_jobs.status`

**Composite indexes for common queries**:
- `(document_id, status)` on `text_regions`
- `(document_id, status)` on `processing_jobs`

## Data Storage Strategy

**Structured Data**: PostgreSQL
- User accounts, documents, regions, jobs
- ACID guarantees, rich querying

**File Storage**: S3-compatible (or local file system for MVP)
- Original images
- Working/composited images
- Inpainted patches
- Exported results

**File Path Convention**:
```
/uploads/{user_id}/documents/{document_id}/original.{ext}
/uploads/{user_id}/documents/{document_id}/working.png
/uploads/{user_id}/documents/{document_id}/regions/{region_id}/inpainted.png
```

## Data Lifecycle

1. **Capture**: Create `Document`, store `original_image_path`
2. **Detection**: Create `ProcessingJob` (text_detection) → Create `TextRegion` records
3. **Edit**: Update `TextRegion.current_text` → Create `ProcessingJob` (inpaint_region)
4. **Composite**: Update `Document.working_image_path` with rendered result
5. **Export**: Generate final PNG from `working_image_path`, optionally upscale
6. **Cleanup**: (Future) Delete old working files, archive documents

## Why This Model?

1. **Normalized but not over-normalized**: Balances DRY with query simplicity
2. **Job tracking**: `ProcessingJob` makes async operations visible and debuggable
3. **Incremental processing**: Each `TextRegion` tracks its own processing state
4. **Audit trail**: Timestamps on everything
5. **Extensible**: Clear path to add layers, versions, projects without major refactoring

This model embodies "composition over extension": new features are new entities or new types within existing entities, not scattered flags.
