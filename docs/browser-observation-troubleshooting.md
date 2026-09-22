# Browser observation stalls: diagnosis and regression checks

## Findings (2026-09-22)

The installed application logs are in `~/.code-shell/logs/engine-YYYY-MM-DD.log`
and `~/.code-shell/logs/desktop/desktop-YYYY-MM-DD.log`. Filter `tool.exec.end`
by `d.tool`; `d.duration_ms`, `d.args`, and `d.errorSnippet` distinguish navigation
from observation. The tool-card duration was unreliable for Codex-backed sessions
because the MCP bridge used one turn ID for every invocation in that turn.

The reported Feishu run, in `engine-2026-09-22.log`:

| UTC finish | Operation | Duration | Result |
| --- | --- | ---: | --- |
| 07:00:55.150 | navigate | 4,552 ms | success |
| 07:01:07.744 | wait (requested 10 s) | 5,011 ms | protocol timeout |
| 07:01:38.027 | snapshot | 30,006 ms | tool timeout |
| 07:02:44.707 | snapshot retry | 30,002 ms | tool timeout |
| 07:03:27.242 | read | 30,004 ms | tool timeout |

An isolated real-Electron probe reproduced an auxiliary frame whose URL was `:`
and whose evaluation never returned within the probe's 6.5-second deadline,
while main-frame evaluation returned in 0–1 ms. The old snapshot/read path waited
for every frame. Puppeteer's wait for a frame execution context happens before
sending a protocol command, so increasing `protocolTimeout` alone does not fix it.
The driver's serial queue also held subsequent observations behind pending work.
This establishes the blocking path, not why the remote page created that frame.

The page also remained `interactive` for at least 45 seconds with useful controls
already rendered. Waiting for `readyState === "complete"` unnecessarily depended
on every auxiliary resource finishing. This is distinct from dynamic table data
becoming available: DOM readiness must not imply that a Canvas sheet is readable.

## Changes

- Inspect a child frame's containing element before entering its execution
  context; skip non-rendered frames, retaining visible offscreen frames.
- Bound a main-frame observation to 8 seconds, a child to 2 seconds, and the
  frame traversal to 15 seconds. Preserve usable results with explicit warnings
  when a visible frame fails. Partial reads must not claim `Read: complete`.
- Register element refs only after a frame finishes in time. Dispose late
  handles instead of allowing them to repopulate a newer snapshot's refs.
- Wait for DOM readiness with interval polling, and explicitly report that
  dynamic content can still be loading. Keep the requested wait deadline.
- Give protocol commands 65 seconds (the explicit wait limit is 60 seconds),
  with 90 seconds of outer action headroom. Observation's outer limit remains
  30 seconds; the observation-specific budgets finish earlier.
- Give each MCP invocation a unique host tool ID, avoiding navigation/error card
  collisions between multiple calls in the same Codex turn.

## Measurements

Three new hidden Electron windows in an isolated profile, using the same Feishu
document. These are browser-driver timings, not end-to-end model response times.
Observations were deliberately delayed about 45 seconds after the load wait to
let the troublesome auxiliary frame appear. The timings below do **not** measure
time until all sheet data is rendered.

| Round | New window + driver | Navigation (DOMContentLoaded) | Snapshot | Text read |
| --- | ---: | ---: | ---: | ---: |
| 1 | 273 ms | 19,345 ms | 13 ms | 7 ms |
| 2 | 81 ms | 13,992 ms | 5 ms | 4 ms |
| 3 | 80 ms | 5,885 ms | 13 ms | 10 ms |

Each observed 28 controls. Text reads contained only 41 characters of DOM text;
Canvas cell contents still require vision/scrolling. These clean-profile timings
are not directly comparable to the installed application's cached profile.
Network navigation remains variable; the measured improvement is that an
unresponsive auxiliary frame no longer stalls page observation.

A final fresh-profile run with the DOM-ready wait change measured 177 ms to
create/connect, 23,292 ms to navigate, **5 ms for a successful readiness wait**,
then 6 ms to snapshot and 4 ms to read after an explicit 45-second settle period.
This returned 16 controls and 41 characters of text, without warnings or errors.

## Repeating the probe

`packages/desktop/scripts/benchmark-browser-observe.ts` uses the production
Electron/Puppeteer adapter with a new temporary profile and emits JSON timings
without page contents. It accepts `BROWSER_PROBE_URL`, `BROWSER_PROBE_ROUNDS`
(default 3), and `BROWSER_PROBE_SETTLE_MS` (default 0). Set the latter to `45000`
when reproducing late-created auxiliary frames.

From the repository root after installing dependencies and building packages:

```sh
packages/desktop/node_modules/.bin/esbuild packages/desktop/scripts/benchmark-browser-observe.ts --bundle --platform=node --format=esm --outfile=/tmp/codeshell-browser-probe.mjs --external:electron --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
BROWSER_PROBE_URL='https://your-test-page.example/' BROWSER_PROBE_ROUNDS=3 packages/desktop/node_modules/.bin/electron /tmp/codeshell-browser-probe.mjs
```

Validation covers real Chrome cross-origin/shadow-DOM reads and actions, a pending
resource that must not prevent DOM-ready observation, hidden/stalled child frames,
late-handle cleanup, queue recovery, partial-result presentation, and distinct MCP
call IDs. Real website probes are diagnostics, not network-dependent CI tests.
The focused regression run passed 122 tests across eight files. Full workspace
build/type checks, changed-file lint, and Chrome extension bundling also passed.

## Slow-page recovery follow-up

The tool loop now observes after navigation/action rather than always adding a
separate readiness wait. If dynamic content is still loading, `browser_act`
supports a targeted, read-only wait:

```json
{"action":"wait","text":"Results loaded","timeout_ms":10000}
{"action":"wait","selector":"#loading","state":"hidden","timeout_ms":10000}
```

`selector` must come from observed page evidence. `text` is a visible substring,
optionally scoped by the selector. These conditions cover the main document,
not iframe or Canvas text. A visible result does not prove that every row has
loaded. Invalid selectors fail explicitly; non-finite timeout values cannot
disable the driver's 30-second default/60-second maximum. The Puppeteer deadline
also bounds execution-context acquisition and cancels the wait poller; late
handles are disposed. Conditions pass through the worker, runtime, authorization
wrappers, and Chrome extension; Puppeteer and Playwright share the predicate.

Snapshot/read/extract failures with structured `TIMEOUT` codes attempt at most
one viewport screenshot for a vision-capable model. `fallback:"none"` opts out.
The original failure is retained, the result says it is incomplete, and pixels
are not treated as extracted URLs or element refs. Permission/target failures,
cancellation, and non-vision models do not trigger this fallback. Partial reads
with warnings remain available without automatically adding an image.

Fallback capture has a separate 5-second tool budget. The shared Puppeteer
screenshot operation is bounded to 4 seconds so its serial queue remains usable.
Electron's native viewport capture no longer depends on evaluating page JS first;
element-region captures still require valid DOM geometry. These deadlines cannot
make a frozen renderer responsive, and screenshot recovery can also fail.

No click, typing, submission, message, navigation or reload is automatically
replayed. A timed-out write reports that its outcome is uncertain and instructs
the model to verify the current state before retrying. Existing task ownership,
vision gating, domain grants, and human-takeover boundaries remain in force.

Follow-up validation: 256 tests passed across 24 files, including real Chrome
tests for both maintained drivers, stalled waits/screenshots, late-handle cleanup,
fallback cancellation and gating, condition forwarding, and uncertain writes.
Workspace build/type checks, changed-file lint, and extension bundling passed.
