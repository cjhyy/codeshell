# UI Review Findings

## P0

No P0 findings.

## P1

- [ ] [P1] packages/desktop/src/renderer/Markdown.tsx:51 — sanitized untrusted markdown still allows arbitrary `style` on `span`, which can visually spoof or hide UI/content after `rehypeRaw` parses assistant-supplied HTML — remove `style` from the schema or allow only a narrow, parsed style allowlist needed for highlighting.
- [ ] [P1] packages/desktop/src/renderer/browser/useBrowserTabs.ts:137 — any guest page can print `__CS_OPEN_TAB__...` to the console and force the host to open tabs/searches because the listener trusts every console message containing the sentinel — require `startsWith`, parse and require http(s), rate-limit/dedupe, or move the signal to a channel the page cannot spoof.
- [ ] [P1] packages/desktop/src/renderer/ChatView.tsx:249 — an active voice recording has no unmount cleanup, so the mic stream, max-duration timer, and async transcription callbacks can outlive the composer — add an unmount cleanup that clears the timer, stops recorder/tracks, nulls handlers/refs, and ignores transcription results after unmount.
- [ ] [P1] packages/tui/src/ui/components/ProviderModelFlow.tsx:287 — provider model fetches have no `try/catch/finally`; a rejected `fetchModelList` leaves `fetchLoading` stuck and can raise an unhandled rejection in onboarding/model setup — wrap the await, set an error `FetchResult`, and always clear loading with a mounted/stale guard.

## P2

- [ ] [P2] packages/desktop/src/renderer/App.tsx:2687 — dock resize installs global `mousemove`/`mouseup` listeners and body styles that are removed only on `mouseup`, so unmount/window loss mid-drag leaks listeners and leaves `userSelect`/cursor stuck — track an active drag disposer in a ref and clean it on unmount, blur, and pointer cancel.
- [ ] [P2] packages/desktop/src/renderer/browser/useElementPicking.ts:36 — the 60s picker timeout only flips React state; it does not clear the timer on success or abort the injected guest-page picker/listeners when the host times out, unmounts, or switches tabs — clear the timeout and inject/call a guest cleanup hook when abandoning a pick.
- [ ] [P2] packages/desktop/src/renderer/settings/useSettingsResource.ts:84 — refresh-triggered reloads ignore the cancel function returned by `reload()` and have no sequence guard, so late IPC results can set state after unmount or overwrite newer settings data — centralize in-flight cancellation with a request id/AbortController and cancel all pending reloads in cleanup.
- [ ] [P2] packages/desktop/src/main/pty-service.ts:194 — `pty:start` passes renderer-supplied `cwd` straight into `node-pty.spawn`, so a deleted/invalid directory can throw through IPC instead of falling back or returning a structured error — validate that `cwd` exists and is a directory, then catch spawn failures.
- [ ] [P2] packages/desktop/src/main/desktop-services.ts:705 — `openPath`/reveal/editor IPC resolves arbitrary absolute paths or arbitrary `cwd`+relative paths from the renderer, expanding a renderer compromise into broad host-file launching — constrain these actions to known workspace roots or require an explicit trusted user-action token for outside-workspace paths.
- [ ] [P2] packages/desktop/src/main/browser-driver/automation-host.ts:33 — browser automation attaches the CDP debugger once and keeps it attached until guest destruction, contradicting the adapter's per-action lifecycle and potentially blocking DevTools/other debugger users — keep the ref map independent of debugger attachment and detach after each action or after a short idle timeout.
- [ ] [P2] packages/desktop/src/main/browser-driver/policy.ts:5 — the policy comment says domain whitelist misses can be approved, but `automation-host` hard-blocks them with no approval path — update the comment/spec to match fail-closed behavior or reintroduce an explicit approval bypass.
- [ ] [P2] packages/cdp/src/driver.ts:278 — `CdpActionsDriver.navigate` accepts any string and relies on hosts to police schemes, which is unsafe for the package's advertised standalone CDP use — validate/normalize allowed schemes in the driver or require a host policy callback before `Page.navigate`.
- [ ] [P2] packages/cdp/src/driver.ts:211 — image extraction awaits an in-page `fetch()`/canvas promise with no timeout or abort, so a hostile or stalled image URL can hang the browser image action indefinitely — add an in-page `AbortController` timeout or host-level CDP command timeout.
- [ ] [P2] packages/cdp/src/driver.ts:446 — link/image extraction mutates page DOM with generic `data-cs-ref` attributes and never clears old refs, risking collisions with site code and stale image lookups — use a namespaced/run-scoped attribute and clear previous marks before tagging.
- [ ] [P2] packages/cdp/src/driver.ts:239 — element screenshots compute a box without scrolling/intersecting it with the viewport while `captureBeyondViewport` is false, so offscreen or partially visible refs can fail or capture the wrong region — scroll the element into view and clamp the clip to layout viewport, or enable beyond-viewport capture when supported.
- [ ] [P2] packages/tui/src/render/components/App.tsx:259 — the deferred XTVERSION query is not tracked/canceled and `TerminalQuerier` has no dispose path for pending `send()`/`flush()` promises, so unmount can still write query escapes or leave promises unresolved — store and clear the immediate, and add `TerminalQuerier.dispose()` that resolves/drops pending work before raw-mode teardown.
- [ ] [P2] packages/tui/src/render/hooks/use-input.ts:55 — `useInput` always calls `setRawMode(true)` when active even when `isRawModeSupported` is false, causing non-TTY/piped runs to throw during layout effects — skip raw-mode setup when unsupported or expose a controlled non-interactive fallback.

## Guardrails Checked

- Renderer runtime imports: no violation found; desktop renderer/mobile references to CodeShell packages are `import type` only.
- Core importing TUI: no source violation found; the only core hit names `@cjhyy/code-shell-tui` inside the `no-host-deps` test guard.
