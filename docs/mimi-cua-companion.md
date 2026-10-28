# Mimi CUA character prototype

The desktop companion is an opt-in interactive pet with a replaceable character
renderer. The first effect set uses Mimi's bundled full-body sprite atlas. A
Live2D adapter is reserved behind the same presentation contract; it is not
enabled by the settings UI and has not been validated with Cubism Core.

## Interaction contract

- Hover takes priority over automatic movement and working gestures.
- Drag places the pet in global desktop logical coordinates and pins it there.
  Dragging does not open chat. The saved position is clamped after monitor changes.
- Click opens the existing Mimi chat page in the main application. The floating
  pet does not take keyboard focus away from another application.
- The context menu can resume following CUA actions after manual placement.
- Idle is still. An operation gets a short gesture, then returns to a resting
  pose. Reduced-motion mode also suppresses gesture playback and movement easing.
- The character's body accepts pointer interaction; the rest of the transparent
  surface passes input through. A human interaction suppresses incoming CUA
  animation and movement. It does not cancel the underlying CUA operation.

## Local trial

Build the workspace packages first (`bun run build`), then from
`packages/desktop` run:

```sh
bun run build:renderer
bun run build:preload
bun run build:main
bun run preview:companion
```

The isolated experiment has its own temporary preferences and does not start a
worker, request OS permissions, or issue computer input. Its chat callback only
shows a receipt; the normal application callback opens the actual Mimi page.
Closing the experiment window exits it. Native interaction smoke:

```sh
bun run preview:companion --smoke
```

`--external-cua` accepts JSON presentation events over stdin for a supervised
demonstration with another CUA client. It does not automatically observe Codex
tool calls. A caller sends start/end around the real action; omitted start
coordinates use the real pointer's current global logical position. The normal
CodeShell integration observes its embedded CUA MCP transport automatically.

## Boundaries

The driver remains the only input authority. Its stdio proxy preserves the
original MCP bytes, classifies known operations, and forwards bounded metadata
through an authenticated private Unix socket. It does not forward typed text,
scripts, image bytes, or application contents to the character renderer. An
animation acknowledgement has a 180ms deadline; presentation failures never
retry a computer action.

Known screenshots and opaque composite tools hide the character while they run,
with a shared compositor barrier. Active human interaction retains the pet, so
the overlay may appear in a capture during that interaction. Unknown tools do
not produce invented mouse paths. Coordinates use native logical points and the
actual overlay content bounds, including negative display origins and different
screen scale factors.

The character is placed beside a known target; this prototype does not provide
skeletal hand contact with an arbitrary control. The existing compact pet widget
is a separate surface in this experiment. Consolidating both surfaces and adding
more natural action assets are follow-up product work.

See `packages/desktop/resources/mimi-live2d/README.md` for the optional official
sample model, version pins, and separate Core/model licensing. Downloaded sample
assets and Core are excluded from the application package by default.
