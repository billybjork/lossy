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
- **[Product Vision](docs/product-vision.md)** - Goals, user flows, and product modes
- **[Architecture](docs/architecture.md)** - System components and how they interact
- **[Data Model](docs/data-model.md)** - Database schema and entity relationships
- **[ML Pipeline](docs/ml-pipeline.md)** - Machine learning models and processing decisions
- **[Technology Stack](docs/technology-stack.md)** - Key technology choices and rationale
- **[Design Principles](docs/design-principles.md)** - Guiding philosophy and architectural principles
- **[Configuration](docs/configuration.md)** - All configurable values and where they live

### Implementation Guides
- **[Browser Extension](docs/implementation/extension.md)** - TypeScript/MV3 extension implementation
- **[Backend](docs/implementation/backend.md)** - Elixir/Phoenix backend implementation
- **[Editor UI](docs/implementation/editor.md)** - LiveView-based editor implementation
- **[Roadmap](docs/implementation/roadmap.md)** - Phase-by-phase implementation plan

## Quick Start

See [Implementation Roadmap](docs/implementation/roadmap.md) for the step-by-step development plan.

## Core Technology Stack

- **Frontend**: TypeScript, Manifest V3 browser extension
- **Backend**: Elixir, Phoenix, LiveView
- **Database**: PostgreSQL
- **ML Inference**: Cloud-based (fal.ai) with future local inference
- **Image Processing**: ImageMagick/libvips

## MVP Goal

Ship a vertical slice:
> From a random web page → grab an image → edit baked-in text → download final image

With minimal but well-factored code, clear data models, and an easily extensible foundation.
