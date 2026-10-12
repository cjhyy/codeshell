# Docker candidate browser request boundary

This is test-only wiring for the six Docker candidate browser consumers and the
retained Panel version UI called by `smoke-candidate-panel-lifecycle.mjs`. It does
not change Host/Panel product permissions or provide OS/process confinement.
The driver wiring and Node/container isolation are a separate checkpoint.

`createDockerBrowserGuard({ child, origin, policyPath, policyHash })` accepts the
driver's captured live `ChildProcess`, never an environment-only URL. It verifies
the canonical private policy and receipt paths inside the private `0700` HOME,
`0600` single-link regular files, policy SHA256, pinned preload bytes, and matching
controller PID/parent/policy/HOME/preload proofs. The six negative pre-Core probes
must precede the exact `127.0.0.1` listener receipt. Reads pin the opened inode and
path; receipt reads permit append and ignore only an unfinished final line.
Malformed complete receipt rows, replacement/symlink files, digest mismatch,
foreign listeners and exited children fail closed. Authority is checked again
before each new context.

Each consumer requires a factory-created guard before launching Chromium. Its
contexts install HTTP/WS routes and initialization restrictions before any page,
always with `serviceWorkers: "block"`. Existing/default contexts and direct
`browser.newContext/newPage` are refused. Only the existing viewport, touch,
download and microphone options are accepted. Design now uses the same explicit
Chromium channel and sandbox setting as the other consumers. A version chooser
context-creation failure still closes its owned browser.

Download exports its fixed `downloadFixtureServerSource` so the controller can
freeze that entry's bytes; SHA256 remains
`9302772ccc8e5b2eac9fc0bb164aabe5a83c6ff3b764422cd4ce733e43a953e8`, identical
to the original inline fixture on `5459addac`. Fixture FFmpeg uses captured async
`execFile` with the original argv and awaits completion; this grants no arbitrary
Node expression or PATH permission. Host Chromium launch process enforcement is
outside this HTTP/WS helper; normal Playwright launch/close custody remains.

HTTP requests require both the exact HTTP protocol and owned origin. Every
request uses `route.fetch({ maxRedirects: 0, timeout: 150000 })`; every redirect is
refused before fulfillment, with `304` retained as a non-redirect response. Finite
response bytes, status and headers (including media Range responses) are
preserved. There is no redirect allowlist. SSE is refused; current six consumers
and their Web/Panel call chains use finite JSON/static/download/media responses
and WebSocket updates. This route buffers finite bodies and does not validate
progressive streaming, SSE, or weak-network behavior.

WebSocket connections use the installed `ws` transport with
`followRedirects: false` and a 10-second handshake deadline, rather than allowing
Chromium's native WebSocket handshake to redirect. Only the current owned
context's cookies matching the exact target origin/path are read, and the fixed
owned Origin is sent. Text/binary frames and close codes/reasons are forwarded.
Playwright's mock selects the first offered subprotocol; a different upstream
selection is refused instead of being reported as that protocol. Socket errors
close the route without printing URLs, headers, cookies, query strings or raw
upstream error text. Context/browser close and controller exit stop owned
sockets; cleanup independently attempts each socket and requires close receipts
within five seconds, preserving non-Error failures in an aggregate error.

Test-context initialization refuses Worker, SharedWorker, EventSource,
WebTransport and WebRTC constructors, which none of these six current business
scenarios needs. In-page blob/data media, MediaRecorder, downloads, microphone
fixtures, byte/hash checks, editor playback, PDF exports and all original
business assertions remain. Blob/data URLs cannot acquire HTTP/WS authority.

## Validation and remaining acceptance

On the isolated task branch based on `5459addac`, the guarded pure shard
`tests/docker-candidate-browser-guard.test.ts` passed **35 tests / 111 assertions**,
with zero skipped tests. It creates private files, a synthetic ChildProcess
subject, fake Playwright objects and fake WebSocket transports; it starts no
process, browser, socket, Core/Main or Docker runtime. It covers the private
authority failures, route-before-page/default-context restrictions, redirect and
protocol boundaries, finite media response preservation, scoped-cookie/frame
forwarding, handshake/protocol failure and independent cleanup/error retention.
Targeted ESLint, Prettier and syntax checks for all eight script modules passed.
Final guarded shard log: `/tmp/codeshell-docker-candidate-browser-guard-20261013.log`,
SHA256 `0d85fb139012207b606a1d4f3227537ffdd6cfbeeb002936d345364cacbdbeaf`.

Real Playwright/HTTP/WS interoperability and every original Docker business
scenario remain pending the combined Linux candidate run. The current final
Panel input is `3f80db2c6130c69e5ade873f0f0aebb9593b1631` (Job Hunt 4.2.0;
other five package trees retained from `41bb3638`). Prior candidate receipts for
`41bb3638` cannot certify that new Job package or this new guard. No browser,
Docker, native Electron, Keychain, speech service, publication or deployment was
started for this checkpoint.
