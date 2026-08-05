# Browser Runtime architecture

## Decision

CodeShell has one Browser Runtime control plane with four deliberately separate
target paths:

1. **InAppBrowserBackend (default)** — a runtime-owned background target in the
   task's `persist:browser:<bucket>` profile. It shares the in-app browser's
   cookies and sign-in state without controlling any user-opened tab. The exact
   background target can be revealed in place for login or human takeover.
2. **BuiltInTabClaimBackend (explicit claim)** — the user-facing Electron
   `<webview>`. Focus never grants control. A user gesture grants one exact
   guest id to one task for 30 minutes.
3. **ChromeExtensionBackend (optional)** — an MV3 extension attaches
   `chrome.debugger` to one signed-in tab, then relays CDP commands through an
   authenticated Native Messaging host. A short pairing request binds that tab
   to one task; tab close, debugger detach, revoke, or expiry removes the grant.
4. **DedicatedPlaywrightBackend (optional)** — an isolated filesystem profile
   for scheduled tasks, unattended work, and explicit isolated crawling. It is
   never selected silently for an ordinary interactive task.

The dispatch order is an explicit built-in grant, then an explicit Chrome
grant, then the task-owned in-app target. Scheduled tasks explicitly request
Dedicated Playwright. Creating either grant closes the task-owned target so two
browsers cannot silently continue at once.

## Why Playwright is above CDP

The old driver manually implemented mouse coordinates, input events, waiting,
and stale references. CDP remains useful for the in-app and claimed-tab
transports, but it is not a mature interaction runtime by itself. The dedicated
Playwright backend uses `Locator` for strict resolution, auto-waiting, and
actionability checks (visible, stable, receives events, enabled, editable),
while CodeShell keeps ownership of policy, task identity, profiles, trace
visibility, pagination, backend selection, and human handoff.

References:

- <https://playwright.dev/docs/locators>
- <https://playwright.dev/docs/actionability>
- <https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context>
- <https://playwright.dev/docs/browsers>

## Semantic contract

- Snapshot refs include a snapshot epoch (`s3:e1` or `pw3:e1`).
- A cross-document navigation changes `documentId` and invalidates old refs.
- Read results are deterministic chunks with an opaque document-bound cursor.
- Scroll returns structured position/end state and `NO_PROGRESS` when repeating
  cannot help.
- Routine background calls are projected as `hidden` or `milestones`; complete
  engine traces remain available.

## Chrome extension and Native Messaging

The bundled extension lives in `packages/desktop/resources/chrome-extension`.
The desktop app registers `com.cjhyy.codeshell.browser_runtime` for the stable
extension id `lfibcnkpbhakjhfpjkmknhilbhldgflh`. The native host accepts only
that exact `chrome-extension://.../` origin and authenticates again to the
owning desktop process with a random owner-only token over loopback.

Native messages use Chrome's 32-bit byte-length-prefixed UTF-8 JSON protocol.
The native-host subprocess is a framing relay only; the desktop process owns
pairing, allowlists, sensitive-action gates, snapshot state, and CDP request
correlation.

References:

- <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>

In development, open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select the bundled extension directory shown by the
BrowserPanel's Chrome pairing UI. Packaged apps include the same directory as
an extra resource and register the native host at startup.
