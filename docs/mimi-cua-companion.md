# Mimi CUA character prototype

The desktop companion is an opt-in interactive pet with a replaceable character
renderer. The first effect set uses Mimi's bundled full-body sprite atlas. A
Live2D adapter is reserved behind the same presentation contract; it is not
enabled by the settings UI and has not been validated with Cubism Core.

## Acceptance status — 2026-10-28

The user confirmed that Mimi is visible above Chrome's native fullscreen Space
on the right 2560×1440 display after using a macOS nonactivating panel and
disabling background renderer throttling. This confirms fullscreen visibility,
not correctness of native input.

The Chrome coding exercise **failed**: a per-character foreground-key fixture
repeatedly took focus, interacted with the input method, and produced malformed
code. It had no immediate cancellation path. The fixture and its UI/IPC entry
have been removed; `--practice` now refuses to start. Do not reuse it or report
animation-frame samples as evidence that an exercise passed. The user's browser
must not be automatically relaunched or re-controlled to repeat that failed demo.

The separate opt-in native form fixture now has a stop button and
Command/Ctrl+Shift+Escape while running. Stop or timeout rejects pending and new
requests, kills only its own input daemon, and makes that fixture instance
unusable until reopened. Cancellation and timeout have isolated process-mock
tests; this revision has not been rerun against the user's desktop. It sends
complete field strings without artificial character delays. Animation must
follow normal input speed, never slow real work to extend a gesture.

## Interaction contract

- Hover takes priority over automatic movement and working gestures.
- Drag places the pet in global desktop logical coordinates and pins it there.
  Dragging does not open chat. The saved position is clamped after monitor changes.
- Click opens the existing Mimi chat page in the main application. The floating
  pet does not take keyboard focus away from another application.
- The context menu can resume following CUA actions after manual placement.
- Idle is still. Text input follows the real operation with a short completion
  tail; consecutive key input retains its animation phase. Reduced-motion mode
  suppresses gesture playback and movement easing.
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

The default isolated experiment has its own temporary preferences and does not start a
worker, request OS permissions, or issue computer input. Its chat callback only
shows a receipt; the normal application callback opens the actual Mimi page.
Closing the experiment window exits it. Native interaction smoke:

```sh
bun run preview:companion --smoke
```

`--native-cua <installed-official-driver-path>` explicitly enables a separate
public form fixture in a newly created window. It never submits the form and
does not control an existing user browser. This optional fixture remains subject
to the acceptance limits above.

For the full application path, after building Desktop run from
`packages/desktop`:

```sh
bun run test:e2e:companion-chat --right-display
```

This opens an isolated production workbench and companion. It verifies menu
dismissal releases the host's interaction hold, clicking the character opens the
real Mimi page, and two composer messages pass through the actual Pet worker in
the same session. Replies come from a local **mock model**; no real model
credentials are imported. The test uses scripted renderer input, so it does not
certify native mouse hit testing, real CUA execution or visibility above other
applications. It closes its own app and verifies process cleanup before deleting
its temporary HOME. A JSON receipt is written to `out/mimi-chat-<time>.json`.

Add `--keep-open` to retain the verified app for native interaction checks. The
console reports its PID, private HOME/userData and `companion-trial-state.json`.
Type `exit` and Enter, close that app, or send Ctrl-C to finish and clean up; the
session also expires after 30 minutes. `--right-display` requires the selected
right-side 2560×1440 monitor rather than silently choosing another. Optional
`--cua-driver <absolute-executable>` enables the real embedded driver in this
temporary profile; the local mock model itself does not issue CUA operations.
macOS uses the existing harness's Keychain metadata preflight and normal native
safeStorage, without replacing the installed app or copying its stored provider
credentials.

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
