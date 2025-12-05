# Design Principles

This document outlines the core design philosophy guiding Lossy's architecture and implementation.

## Core Principles

### 1. Composition Over Extension

**What it means**: Build systems from small, composable pieces rather than large, extensible frameworks.

**In practice**:
- Small focused modules: `CaptureService`, `DetectionPipeline`, `InpaintingService`, `FontService`
- Each module does one thing well
- Compose modules to build features
- Avoid inheritance hierarchies; prefer function composition

**Examples**:
```elixir
# Good: Composition
def process_document(document) do
  document
  |> DetectionPipeline.detect_text()
  |> InpaintingService.prepare_regions()
  |> RenderService.composite_image()
end

# Avoid: Extension via inheritance
class DocumentProcessor extends BaseProcessor {
  // Large class with many responsibilities
}
```

**Why**:
- Easier to test (small units)
- Easier to understand (clear boundaries)
- Easier to change (swap implementations)
- Easier to reuse (combine in new ways)

---

### 2. Async at the Boundaries, Simple Control Flow Inside

**What it means**: Concurrency and async operations belong at system boundaries. Business logic should be synchronous and straightforward.

**In practice**:

**Extension (TypeScript)**:
- Async only for: capture APIs, chrome APIs, fetch to backend
- Rest of the code: synchronous data transformations

**Backend (Elixir)**:
- Use Elixir processes/tasks to model concurrency
- Keep business logic synchronous within each process
- Let OTP handle parallelism and fault tolerance

**Why**:
- Easier to reason about (no callback hell)
- Easier to debug (clear execution paths)
- Easier to test (no mocking timers/promises everywhere)
- Leverage language strengths (Elixir's process model vs manual async in JS)

**Examples**:
```elixir
# Good: Spawn process for async work, logic inside is sync
Task.Supervisor.start_child(Lossy.TaskSupervisor, fn ->
  detect_text_sync(document)  # Synchronous function
end)

# Avoid: Nested async/await hell
async def process():
  result1 = await step1()
  result2 = await step2(result1)
  result3 = await step3(result2)
  # ... many more awaits
```

---

### 3. FP-Shaped Frontend

**What it means**: Structure frontend as functional transformations over immutable state, with effects at the edges.

**In practice**:

**LiveView**:
- Server holds authoritative state
- Events trigger pure state transformations
- Side effects (DB writes, PubSub broadcasts) at boundaries
- Client is just a view renderer

**JS Hooks**:
- Dumb view enhancers
- No client-side state machine
- Send events up to LiveView
- Receive patches from LiveView

**Why**:
- Single source of truth (server state)
- Easier to reason about (no distributed state sync)
- Easier to debug (inspect server state)
- Better reliability (client reload recovers state)

**Examples**:
```javascript
// Good: JS hook as view enhancer
Hooks.CanvasEditor = {
  mounted() {
    this.canvas = this.el.querySelector('canvas');
    this.handleClick = (e) => {
      // Push event to LiveView
      this.pushEvent('region_clicked', {x: e.offsetX, y: e.offsetY});
    };
    this.canvas.addEventListener('click', this.handleClick);
  }
}

// Avoid: Complex client-side state
class CanvasManager {
  state = { regions: [], selectedRegion: null, mode: 'edit', ... }
  // Lots of state management logic on client
}
```

---

### 4. Data Model as Destiny

**What it means**: Your data model determines what's easy and what's hard. Design it carefully from the start.

**In practice**:
- Small set of stable, composable entities
- New features should fit as "more of the same", not ad-hoc flags
- Think about evolution: how will this entity grow?
- Avoid premature abstraction, but plan for extension

**Examples**:

**Good**: Composable entity design
```
Document
  └─ has_many TextRegions

# Later, add non-text layers:
Document
  └─ has_many Layers
        └─ type: text | sticker | shape | filter
```

**Avoid**: Ad-hoc flags everywhere
```
Document
  has_sticker_enabled
  has_shape_layer
  has_filter_applied
  ...  # New boolean for each feature
```

**Why**:
- Extensibility: New features don't require schema changes
- Consistency: All layers work the same way
- Simplicity: One code path handles all layer types
- Predictability: Clear patterns for adding features

---

### 5. Imperative Shell, Functional Core

**What it means**: Keep I/O and side effects at the edges. Core logic should be pure functions.

**In practice**:

**Functional Core**:
- Pure data transformations
- Business logic
- Calculations
- Decision-making

**Imperative Shell**:
- File I/O
- Database calls
- HTTP requests
- PubSub broadcasts

**Structure**:
```
Browser Extension → Imperative shell (capture, API calls)
Phoenix Controller → Imperative shell (receive request)
Context Module     → Functional core (business logic)
Repository         → Imperative shell (DB I/O)
ML Service Client  → Imperative shell (HTTP to ML APIs)
```

**Why**:
- Easy to test core logic (no mocks needed)
- Easy to change infrastructure (swap DB, API, etc.)
- Easy to reason about (pure functions are predictable)

**Examples**:
```elixir
# Functional core
defmodule Lossy.Documents.Logic do
  def calculate_inpaint_region(text_region, padding) do
    %{
      x: text_region.bbox.x - padding,
      y: text_region.bbox.y - padding,
      w: text_region.bbox.w + 2 * padding,
      h: text_region.bbox.h + 2 * padding
    }
  end
end

# Imperative shell
defmodule Lossy.Documents do
  def inpaint_region(region_id) do
    region = Repo.get!(TextRegion, region_id)  # I/O
    inpaint_bbox = Logic.calculate_inpaint_region(region, 10)  # Pure
    ML.inpaint(region.document.image_path, inpaint_bbox)  # I/O
    Repo.update!(region, status: :inpainted)  # I/O
  end
end
```

---

### 6. Make Illegal States Unrepresentable

**What it means**: Use types and data structures to prevent invalid states.

**In practice**:
- Use enums for finite states (`status: :detected | :inpainted | :rendered`)
- Use database constraints (NOT NULL, foreign keys, check constraints)
- Validate at boundaries (changesets in Ecto)
- Use pattern matching to handle all cases

**Examples**:

**Good**: Enum enforces valid states
```elixir
schema "text_regions" do
  field :status, Ecto.Enum, values: [:detected, :inpainted, :rendered]
end
```

**Avoid**: String with no validation
```elixir
field :status, :string  # Could be anything: "detcted", "inpaint", "done", ...
```

**Why**:
- Catch errors at compile time or early runtime
- Impossible to create invalid data
- Self-documenting code

---

### 7. Optimize for Change

**What it means**: Assume requirements will change. Design for easy modification.

**In practice**:
- Small modules (easy to replace)
- Clear interfaces (easy to swap implementations)
- Avoid premature abstraction (don't generalize too early)
- Avoid premature optimization (profile first)

**Examples**:

**Good**: Interface for ML service
```elixir
defmodule Lossy.ML.Inpainting do
  @callback inpaint(image_path, mask) :: {:ok, result} | {:error, reason}
end

defmodule Lossy.ML.Fal.Inpainting do
  @behaviour Lossy.ML.Inpainting
  # Implementation
end

# Easy to swap for self-hosted later
```

**Avoid**: Tight coupling
```elixir
# API calls scattered throughout codebase
Req.post("https://api.replicate.com/v1/predictions", ...)
```

**Why**:
- Easy to experiment (swap implementations)
- Easy to upgrade (change one module)
- Easy to test (mock the interface)

---

### 8. Progressive Enhancement

**What it means**: Start with a working baseline, then add enhancements.

**In practice**:
- **MVP**: All ML in cloud → works, simple
- **v2**: Add local text detection → faster, but cloud fallback still works
- **v3**: Add optimistic mode → instant editing, but lazy mode still works

**Why**:
- Ship faster (don't wait for perfect)
- Reduce risk (always have a working version)
- Better UX (graceful degradation)

---

## How These Principles Apply to Lossy

### Extension Architecture
- **Composition**: Small modules (capture, overlay, messaging)
- **Async at boundaries**: Async only for chrome APIs and fetch
- **Imperative shell**: Extension is the shell; backend is the core

### Backend Architecture
- **Functional core**: Context modules are pure business logic
- **Imperative shell**: Controllers, repos, ML clients handle I/O
- **Data model as destiny**: Document/TextRegion/ProcessingJob is the spine

### Editor Architecture
- **FP-shaped frontend**: LiveView holds state, hooks are view enhancers
- **Composition**: Canvas rendering, interaction handling as separate hooks

### ML Pipeline
- **Progressive enhancement**: Cloud → local → hybrid
- **Optimize for change**: ML interface allows swapping providers

---

### 9. Work With The Platform, Not Against It

**What it means**: Understand and leverage the platform's native capabilities instead of fighting them with JavaScript.

**In practice**:

**Web Platform**:
- Use CSS for what CSS does best (positioning, transitions, layout)
- Use JavaScript for what JavaScript does best (logic, interactivity)
- Don't try to reimplement browser features in JS

**Example: Browser Extension Overlay**

**Bad - Fighting the browser:**
```typescript
// ❌ Trying to track positions during scroll
onScroll() {
  images.forEach(img => {
    const rect = img.getBoundingClientRect();  // 60 times/second!
    clone.style.top = `${rect.top + scrollY}px`;  // Causes jitter
    clone.style.width = `${rect.width}px`;  // Size drift from rounding
  });
}
// Problems:
// - Layout thrashing (measure/write loop)
// - Floating-point rounding errors accumulate
// - 60+ DOM reads/writes per second
// - Fighting natural scroll behavior
```

**Good - Working with the browser:**
```typescript
// ✅ Let CSS handle scrolling
createClone(element) {
  const rect = element.getBoundingClientRect();  // Once
  const scrollTop = window.pageYOffset;  // Once

  clone.style.position = 'absolute';  // Document-relative!
  clone.style.top = `${rect.top + scrollTop}px`;  // Set once
  clone.style.left = `${rect.left + scrollLeft}px`;

  // Never update positions again!
  // The browser scrolls absolutely-positioned elements naturally
}

// Only update visual effects, not positions
onScroll() {
  updateGlowEffects();  // CSS filter changes only
}
```

**Why this works:**
- `position: absolute` = document-relative positioning
- Browser handles scroll math automatically
- Zero JavaScript in scroll hot path
- Perfect 60fps performance

**More Examples:**

**Elixir/Phoenix**:
- Use LiveView's push/patch model (don't fight it with client state)
- Use process message passing (don't reinvent with manual locking)
- Use pattern matching (don't use if/else chains)

**TypeScript**:
- Use type narrowing (don't cast everywhere)
- Use discriminated unions (don't use lots of optional fields)
- Use const assertions (don't manually type every literal)

**Why**:
- Platform features are optimized (browser C++, BEAM VM, V8)
- Less code = less bugs
- More maintainable (idiomatic patterns)
- Better performance (native implementations)
- Easier for others to understand

**How to identify this pattern:**
- You're working very hard to do something "simple"
- You're fighting weird edge cases
- Performance is poor despite optimization
- You're reimplementing platform features

**Solution:**
1. Step back and ask: "How does the platform want me to do this?"
2. Read the docs/spec for the native approach
3. Try the simple, platform-native way first
4. Only add complexity if the simple way truly doesn't work

**Real-world lesson from Lossy:**
> We spent hours trying to track image positions during scroll with complex position updates, ResizeObservers, and careful rounding. The solution was deleting all that code and setting `position: absolute` once. The browser already knows how to scroll positioned elements—we just needed to get out of its way.

---

## Anti-Patterns to Avoid

### 1. God Objects
Large objects with too many responsibilities. Instead: small, focused modules.

### 2. Premature Abstraction
Creating interfaces before you know what varies. Instead: wait for 2-3 examples, then abstract.

### 3. Callback Hell
Nested async operations that are hard to follow. Instead: use language features (Elixir processes) or keep logic sync.

### 4. Distributed State
Client and server both trying to own state. Instead: server owns state, client is a view.

### 5. Ad-hoc Booleans
Adding boolean flags for every feature. Instead: use enums or new entity types.

### 6. Scattered I/O
Side effects mixed with business logic. Instead: functional core, imperative shell.

---

## Measuring Alignment

How do you know if code follows these principles?

**Good signs**:
- Small modules (~100-200 lines)
- Pure functions in business logic (testable without mocks)
- Clear data flow (easy to trace request → response)
- Easy to add new features (extend, don't modify)
- Few dependencies between modules

**Bad signs**:
- Large modules (>500 lines)
- Can't test without extensive mocking
- Side effects everywhere
- Tight coupling (change one thing, break another)
- Every feature requires schema changes

---

## Conclusion

These principles aren't rules—they're guidelines. Use judgment:
- **MVP**: Optimize for shipping. Skip abstractions if you're not sure yet.
- **Production**: Refactor toward principles as patterns emerge.
- **Scale**: Double down on principles as complexity grows.

The goal: **maintain velocity as the codebase grows**. Well-factored code with clear principles makes this possible.
