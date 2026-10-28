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
tool calls. A caller sends start/end around the real action; only explicit,
authoritative global logical coordinates move the character. Without a target,
the pet stays in place: the human pointer is not a proxy for a CUA target. The normal
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

## Comparison with the pinned CUA virtual cursor

Source review targets `trycua/cua` tag `cua-driver-rs-v0.34.1`, matching the
desktop lockfile. This is an implementation comparison, not a measured latency
or visual acceptance result.

| Concern            | Native agent cursor                                                                       | Current companion and required change                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Position authority | Window-scoped operations can move a virtual cursor without moving the human's OS pointer. | Never derive an operation target from the human pointer. Unknown targets leave the pet in place.                                 |
| Execution timing   | The driver can await cursor arrival before input and supplies semantic begin/end events.  | The MCP observer sees request/response boundaries, not resolved input stages. Strict synchronization needs an additional bridge. |
| Appearance         | The default 42-point theme is authored in dotLottie and compiled into a bounded artifact. | Keep the full character renderer and its sprite/Live2D adapter; use a separate exact action hotspot.                             |
| Playback           | Native actions distinguish one-shot, held and loop playback, with end transitions.        | The current brief cues are an experiment. Authored gestures should follow the corresponding action lifecycle.                    |
| Human interaction  | The native overlay passes mouse input through.                                            | The pet adds explicit drag/chat priority and must remain interactive.                                                            |
| Multiple displays  | The pinned macOS overlay draws on `NSScreen.mainScreen`.                                  | Keep independent per-display placement and actual window-origin conversion; do not copy this limitation.                         |

`get_agent_cursor_state` exposes the same-session registry's global-point
`position`, `visual_state`, theme and motion settings. This is a last commanded
target, not a stream of interpolated animation positions. It does not expose
all display bounds and cannot inspect an unrelated Codex CUA connection. The
native position and semantic hooks are in-process Rust interfaces; no public
MCP event subscription was found in the reviewed transport surface.

The next accurate integration is: resolved CUA target → approach/arrival →
action begin/end → shared operation hotspot and character gesture. Merely
changing the pet image or copying OS-pointer coordinates cannot establish that
contract. Until this is connected and visibly checked on the selected external
display, the experiment must not be reported as full visual acceptance.

Official pinned sources:

- [Window vs desktop cursor modes](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/platform-macos/src/tools/move_cursor.rs)
- [Public cursor snapshot](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/platform-macos/src/tools/cursor_tools.rs)
- [Theme and playback state](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/cursor-overlay/src/theme.rs)
- [Native overlay, coordinates and arrival](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/platform-macos/src/cursor/overlay.rs)
- [Position hook](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/cua-driver-core/src/cursor_hook.rs)
- [Action lifecycle hook](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/crates/cua-driver-core/src/cursor_events.rs)
