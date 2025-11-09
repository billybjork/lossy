# Lossy Documentation

Lossy is a browser-based photo and video editing tool that enables users to capture images from any web page and edit text overlays baked into those images.

## What is Lossy?

Lossy allows you to:
- Capture images from any web page using a browser extension
- Automatically detect text regions within images using ML
- Edit and replace text that's baked into images
- Export high-quality edited images

Think of it as "Grab Text" from Canva, but for any image on the web.

## Documentation Index

### Strategic Overview
- **[Product Vision](product-vision.md)** - Goals, user flows, and product modes
- **[Architecture](architecture.md)** - System components and how they interact
- **[Data Model](data-model.md)** - Database schema and entity relationships
- **[ML Pipeline](ml-pipeline.md)** - Machine learning models and processing decisions
- **[Technology Stack](technology-stack.md)** - Key technology choices and rationale
- **[Design Principles](design-principles.md)** - Guiding philosophy and architectural principles

### Implementation Guides
- **[Browser Extension](implementation/extension.md)** - TypeScript/MV3 extension implementation
- **[Backend](implementation/backend.md)** - Elixir/Phoenix backend implementation
- **[Editor UI](implementation/editor.md)** - LiveView-based editor implementation
- **[Roadmap](implementation/roadmap.md)** - Phase-by-phase implementation plan

## Quick Start

See [Implementation Roadmap](implementation/roadmap.md) for the step-by-step development plan.

## Core Technology Stack

- **Frontend**: TypeScript, Manifest V3 browser extension
- **Backend**: Elixir, Phoenix, LiveView
- **Database**: PostgreSQL
- **ML Inference**: Cloud-based (Replicate) with future local inference
- **Image Processing**: ImageMagick/libvips

## MVP Goal

Ship a vertical slice:
> From a random web page → grab an image → edit baked-in text → download final image

With minimal but well-factored code, clear data models, and an easily extensible foundation.
