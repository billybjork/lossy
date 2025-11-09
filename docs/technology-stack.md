# Technology Stack

This document covers key technology choices and the rationale behind them.

## Core Technologies

### Frontend

**Browser Extension**:
- **Language**: TypeScript
- **Manifest**: v3 (Chrome Extension / WebExtensions API)
- **Build Tool**: Vite or Webpack (TBD during implementation)
- **Why**: MV3 is the modern standard; TypeScript for type safety and maintainability

**Editor UI**:
- **Framework**: Phoenix LiveView
- **Client Enhancements**: JavaScript hooks for canvas rendering and interactions
- **Why**: LiveView eliminates complex client-side state management; JS hooks provide snappy interactions where needed

### Backend

**Server Framework**: Phoenix (Elixir)
- **Why**:
  - Excellent concurrency model (lightweight processes)
  - Built-in real-time capabilities (PubSub, LiveView)
  - Functional programming paradigm aligns with design principles
  - Strong developer experience

**Database**: PostgreSQL
- **ORM**: Ecto
- **Why**:
  - Robust, battle-tested
  - Rich querying with Ecto
  - JSONB support for flexible fields (job payloads, metadata)

**Job Processing**:
- **MVP**: `Task.Supervisor`
- **Future**: Oban (for robust queues, retries, scheduling)
- **Why**: Start simple, upgrade when needed

**Image Processing**:
- **Options**: Mogrify (ImageMagick) or Vix (libvips)
- **Why**: Server-side compositing, text rendering, format conversion

**File Storage**:
- **MVP**: Local file system
- **Production**: S3-compatible storage (AWS S3, Cloudflare R2, etc.)
- **Why**: Standard, scalable, cost-effective

---

## ML Inference Platform

### Platform Options

#### Replicate
**Pros**:
- Simple HTTP API
- Marketplace of pre-built models (LaMa, Real-ESRGAN, PaddleOCR, etc.)
- Per-second or per-image pricing
- Easy to experiment and swap models
- Great developer experience

**Cons**:
- Less control over infrastructure
- Potential cold starts
- Cost can scale unpredictably

#### fal.ai
**Pros**:
- High-performance image/video infrastructure
- Serverless GPU with better optimization
- Strong SDXL and diffusion model support
- Streaming responses
- More control over deployments

**Cons**:
- Smaller model marketplace
- May be overkill for simple use cases
- Slightly steeper learning curve

#### Self-Hosted
**Pros**:
- Full control
- Lower long-term cost at scale
- No vendor lock-in
- Custom optimizations

**Cons**:
- Ops overhead (GPU management, model serving)
- Higher upfront cost
- Requires ML infrastructure expertise

### MVP Decision

**Use Replicate** for ML inference.

**Reasoning**:
- Quick to integrate (HTTP API with SDKs)
- Can wire up LaMa, Real-ESRGAN, PaddleOCR without model hosting
- Easy to experiment and swap models
- Costs are predictable and low during MVP development
- Focus remains on product, not infrastructure

### Future Considerations

**Scale-up / v2-v3**:
- If latency becomes an issue → consider fal.ai
- If volume scales significantly → evaluate self-hosted GPU stack
- If privacy is critical → move models on-premise or to user's browser

**Hybrid Approach** (likely end-state):
- Text detection: Local (ONNX in browser)
- Inpainting: Cloud (Replicate/fal/self-hosted)
- Upscaling: Cloud with caching

---

## Font Library & Licensing

### Requirements

- Large selection (50-100+ fonts)
- No licensing headaches
- Usable in commercial products
- Accessible for:
  - Web rendering (CSS @font-face)
  - Server-side rendering (ImageMagick/libvips)

### Google Fonts

**Why Google Fonts**:
- All open-source
- Most under **SIL Open Font License (OFL)**, some Apache
- Can be bundled and used commercially
- Huge variety (1000+ families)
- Well-maintained, high-quality

**License Summary**:
- OFL allows bundling in software products
- Can modify and redistribute
- Must include license file
- Cannot sell fonts standalone (not a concern for us)

### Other Open Font Collections

**Additional Sources**:
- Open Foundry
- Font Squirrel (OFL-licensed fonts)
- Adobe Fonts (some open-source offerings)

### MVP Strategy

**Primary Source**: Google Fonts

**Curated Selection**:
- 50-100 carefully chosen families
- Cover common categories:
  - **Sans-serif**: Inter, Roboto, Open Sans, Lato, Montserrat
  - **Serif**: Lora, Merriweather, Playfair Display, PT Serif
  - **Display**: Bebas Neue, Oswald, Raleway
  - **Script**: Dancing Script, Pacifico, Great Vibes

**Hosting**:
- Self-host font files (don't rely on Google Fonts CDN)
- Reasons:
  - Performance (no external dependency)
  - Privacy (no Google tracking)
  - Reliability (no external outage risk)

**Storage**:
- `priv/static/fonts/` in Phoenix app
- Serve via Phoenix static file handler or CDN
- Make available to ImageMagick/libvips for server-side rendering

### Implementation

1. **Download fonts**:
   ```bash
   # Use google-webfonts-helper or similar
   curl https://google-webfonts-helper.herokuapp.com/api/fonts/inter
   ```

2. **Organize fonts**:
   ```
   priv/static/fonts/
     inter/
       inter-regular.woff2
       inter-bold.woff2
     roboto/
       roboto-regular.woff2
       ...
   ```

3. **CSS @font-face**:
   ```css
   @font-face {
     font-family: 'Inter';
     src: url('/fonts/inter/inter-regular.woff2') format('woff2');
     font-weight: 400;
   }
   ```

4. **Server-side access**:
   - Install TTF versions in system font directory or configure ImageMagick to use custom font path
   - Or convert WOFF2 to TTF for server use

---

## Framework Choice: Ash vs Plain Phoenix/Ecto

### Ash Framework

**What Ash Offers**:
- Declarative domain modeling (resources, actions, relationships)
- Integrated API generation (JSON:API, GraphQL)
- Authorization policies
- AshTypescript: auto-generate TS types from Ash resources
- AI-friendly code generation

**Concerns**:
- Steeper learning curve
- Added compilation overhead
- May be heavy-handed for small apps
- Less control over queries and behavior

### Plain Phoenix + Ecto

**What Phoenix + Ecto Offers**:
- Straightforward, well-documented patterns
- Full control over queries and business logic
- Lower compile times
- Easier debugging
- Smaller mental model

### MVP Decision

**Start with plain Phoenix + Ecto**.

**Reasoning**:
- Small, well-understood domain (User, Document, TextRegion, ProcessingJob)
- MVP doesn't need auto-generated APIs or complex authorization
- Lower abstraction overhead means faster iteration
- Most Elixir developers familiar with Phoenix/Ecto

**Design for Future Migration**:
- Keep contexts clean and resource-like
- Avoid scattering ad-hoc queries throughout codebase
- Structure domain logic as if resources were declarative

### When to Revisit Ash

Consider Ash when:
- Domain expands significantly (projects, teams, permissions, many asset types)
- Need for GraphQL or sophisticated API layer
- Want auto-generated TypeScript types for extension
- See repeated patterns that would benefit from declarative definitions
- Team grows and needs more guardrails

At that point, Ash's benefits (especially AshTypescript for full-stack types) become more compelling.

---

## Development Tools

### Version Control
- **Git** with GitHub
- Conventional commit messages
- Pull request workflow

### CI/CD (Future)
- **GitHub Actions** for testing and deployment
- Automated tests on PR
- Deploy to staging/production

### Testing
- **ExUnit** for Elixir backend tests
- **Jest** (or Vitest) for TypeScript/extension tests
- **Wallaby** or **Hound** for end-to-end LiveView tests

### Linting & Formatting
- **Credo** for Elixir code quality
- **mix format** for Elixir formatting
- **ESLint** + **Prettier** for TypeScript

### Monitoring (Future)
- **Telemetry** + **Phoenix Dashboard** for observability
- **Sentry** or **AppSignal** for error tracking
- **LogFlare** or **Datadog** for log aggregation

---

## Deployment Strategy

### MVP Deployment

**Single Server**:
- Phoenix app deployed to single VPS (e.g., Fly.io, Railway, Digital Ocean)
- PostgreSQL on same server or managed instance
- File storage: Local disk or mounted volume

**Why**:
- Simple, low-cost
- Good enough for MVP and early users
- Easy to debug

### Production Deployment (Future)

**Horizontal Scaling**:
- Multiple Phoenix nodes behind load balancer
- Managed PostgreSQL (AWS RDS, Fly Postgres, etc.)
- S3-compatible object storage
- CDN for static assets and processed images

**Infrastructure as Code**:
- Terraform or similar for reproducible deployments

---

## Security Considerations

### Extension Security
- Minimal permissions in manifest
- Content Security Policy
- No eval() or unsafe-inline
- Validate all messages from content scripts

### Backend Security
- HTTPS only
- CORS configuration for extension origin
- Rate limiting (Plug.RateLimiter)
- Input validation and sanitization
- Secure file upload handling
- SQL injection protection (Ecto handles this)

### API Keys
- Store ML service keys in environment variables
- Never expose in client-side code
- Rotate regularly

### User Data
- Authentication (future): Use proven library (phx.gen.auth, Guardian)
- GDPR compliance: Allow data export and deletion
- Encrypt sensitive data at rest

---

## Why This Stack?

1. **Elixir + Phoenix**: Best-in-class for real-time, concurrent apps
2. **LiveView**: Eliminates frontend complexity while maintaining rich interactivity
3. **PostgreSQL**: Industry standard, rock-solid, great Elixir support
4. **Replicate**: Fastest path to ML capabilities without infrastructure burden
5. **Google Fonts**: Largest high-quality open-source font library
6. **Plain Phoenix/Ecto**: Right-sized for MVP, clear upgrade path if needed

This stack optimizes for:
- **Developer velocity**: Quick iteration during MVP
- **Maintainability**: Clear, well-understood patterns
- **Scalability**: Proven technologies with clear scaling paths
- **Cost-effectiveness**: Pay-as-you-go ML, cheap hosting for MVP

The choices reflect a pragmatic approach: start simple, validate the product, then optimize and scale where needed.
