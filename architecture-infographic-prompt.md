# Lossy Architecture Infographic Prompt

Create a professional, modern technical architecture infographic for "Lossy" - a browser-based image editing tool. The infographic should be landscape-oriented (16:9 ratio), clean, and use a tech-focused color scheme.

## Visual Style
- Modern, clean design with plenty of white space
- Color scheme: Deep blue (#1e3a8a) for headers, teal (#14b8a6) for frontend, orange (#f97316) for backend, purple (#a855f7) for ML/AI
- Use rounded rectangles for components, arrows for data flow
- Include small icons where appropriate (browser icon, database icon, cloud icon)
- Professional typography with clear hierarchy
- Subtle shadows and gradients for depth

## Layout Structure (Top to Bottom)

### Header Section
- Title: "LOSSY ARCHITECTURE"
- Subtitle: "Browser-Based Image Editing with ML-Powered Text Detection"
- Small tagline: "Capture → Detect → Edit → Export"

### Main Architecture Diagram (3-Tier Layout)

#### Tier 1: Browser Extension (Top Section - Teal Theme)
Create a rounded rectangle container labeled "BROWSER EXTENSION (Chrome MV3 + TypeScript)"

Inside this container, show these components horizontally:

1. **Background Service Worker**
   - Icon: Gear/cog
   - Label: "Service Worker"
   - Sub-items: "Keyboard shortcuts (⌘⇧L)", "Screenshot capture", "API orchestration"

2. **Content Script**
   - Icon: Document with code
   - Label: "Content Script"
   - Sub-items: "DOM injection", "Event coordination", "Toast notifications"

3. **Overlay UI**
   - Icon: Eye or spotlight
   - Label: "Cinematic Overlay"
   - Sub-items: "Image detection", "Spotlight effects", "Smart selection"

4. **Smart Capture Logic**
   - Icon: Camera
   - Label: "Capture Engine"
   - Sub-items: "Direct URL extraction", "Screenshot fallback", "Region cropping"

**Tech badges at bottom of section:** TypeScript • Vite • Manifest V3 • Web APIs

#### Tier 2: Phoenix Backend (Middle Section - Orange Theme)
Create a rounded rectangle container labeled "PHOENIX BACKEND (Elixir + LiveView)"

Show three layers within this container:

**Web Layer:**
- Box: "Capture Controller (API)"
  - "POST /api/captures"
- Box: "LiveView Editor"
  - "Real-time UI at /capture/:id"
  - "Phoenix PubSub updates"

**Business Logic Layer:**
- Box: "Documents Context"
  - "Document lifecycle"
  - "Text region management"
- Box: "Assets Context"
  - "Image storage"
  - "SSRF protection"
  - "SHA256 verification"
- Box: "Workers"
  - "Oban background jobs"
  - "Text detection queue"

**Data Layer:**
- Box: "PostgreSQL + Ecto"
  - Database icon
  - Tables: "users, documents, assets, text_regions, processing_jobs"
- Box: "Oban Queue"
  - Queue icon
  - "Job: text_detection, inpainting, upscaling"

**Tech badges at bottom of section:** Elixir • Phoenix • LiveView • Ecto • Oban • PostgreSQL

#### Tier 3: ML Services (Bottom Section - Purple Theme)
Create a rounded rectangle container labeled "ML INFERENCE (Cloud-Based)"

Show three service boxes horizontally:

1. **Text Detection**
   - Cloud icon
   - "PaddleOCR / DBNet"
   - "Bounding box detection"

2. **Inpainting**
   - Magic wand icon
   - "LaMa Model"
   - "Text removal & background fill"

3. **Upscaling**
   - Expand icon
   - "Real-ESRGAN"
   - "Super-resolution export"

**Tech badges at bottom of section:** fal.ai • HTTP APIs • GPU Inference

### Data Flow Arrows (Connect the tiers)

Show clear, numbered arrows indicating the complete flow:

**Capture Flow (Blue arrows, numbered 1-8):**
1. User → Extension: "⌘⇧L pressed on webpage"
2. Extension → Web Page: "DOM scan for images"
3. User → Extension: "Select image from overlay"
4. Extension → Extension: "Smart capture (URL or screenshot)"
5. Extension → Backend: "POST /api/captures {image_data}"
6. Backend → Database: "Create Document + Asset"
7. Backend → Oban: "Enqueue text_detection job"
8. Backend → ML: "Call PaddleOCR"

**Edit Flow (Green arrows, numbered 9-13):**
9. ML → Backend: "Return text regions"
10. Backend → Database: "Save TextRegion records"
11. Backend → LiveView: "PubSub broadcast update"
12. User → LiveView: "Edit text inline"
13. LiveView → Backend: "Save changes, trigger inpainting"

**Export Flow (Purple arrows, numbered 14-15):**
14. Backend → ML: "Upscale final image"
15. Backend → Browser: "Download PNG"

### Key Features Sidebar (Right side)

Create a vertical sidebar with these highlights:

**🎯 Key Features:**
- Cinematic image selection overlay
- Smart capture (URL > Screenshot)
- Real-time collaborative editing
- ML-powered text detection
- State machine-based processing
- SSRF & security protection

**📊 Data Model:**
```
User
└─ Documents
   ├─ Assets (original, working, export)
   ├─ TextRegions (bbox, text, fonts)
   └─ ProcessingJobs (queued work)
```

**⚡ Status Flow:**
queued_detection → detecting → awaiting_edits → rendering → export_ready

### Footer Section

**Design Principles:**
- "Work with the browser, not against it"
- "Your data model is your destiny"
- "Simplicity first, extensibility always"
- Job-based async processing
- Real-time updates via Phoenix PubSub

## Visual Elements to Include

1. **Connection Lines:** Use solid arrows for synchronous calls, dashed arrows for async/pub-sub
2. **Icons:** Small, simple icons for each major component (browser, database, cloud, etc.)
3. **Color Coding:** Consistent colors for each tier (teal, orange, purple)
4. **Annotations:** Small text labels on arrows showing protocols (HTTP, WebSocket, PubSub)
5. **Technology Badges:** Rounded pill-shaped badges for tech stack
6. **Status Indicators:** Small colored dots showing document status transitions
7. **Grid Background:** Subtle grid pattern to give technical feel

## Additional Notes

- Make sure all text is legible at standard viewing sizes
- Use consistent spacing and alignment throughout
- Include small version numbers where relevant (Phoenix 1.8, Elixir 1.15+, etc.)
- Add a subtle gradient background for visual interest
- Ensure the infographic tells a complete story from user action to final export
- Balance detail with clarity - avoid overwhelming with too much text

## Output Format

The final infographic should be:
- Resolution: 1920x1080 pixels minimum
- Format: PNG or SVG
- File size: Optimized for web viewing
- Style: Professional technical documentation aesthetic
