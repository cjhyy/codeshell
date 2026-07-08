# CodeShell TUI/CDP Review - 2026-07-08

Scope: read-only review of `packages/tui/` and `packages/cdp/` only. Core and desktop were not reviewed except by type/import surface visible from these packages.

Summary: no critical findings. Major risks cluster around TUI cancellation/secret handling/stream routing and CDP action semantics. Minor findings are mostly rendering drift and UI affordances that are wired only partially.

## 🔴 Critical

No critical findings confirmed in this pass.

## 🟠 Major

### `packages/tui/src/ui/index.tsx:82` - Ctrl+C cancellation path is bypassed by Ink-level exit

Problem: the REPL render is created with `exitOnCtrlC: true`, while the internal renderer exits immediately on raw Ctrl+C at `packages/tui/src/render/components/App.tsx:377` and `useInput` suppresses child handlers when `internal_exitOnCtrlC` is true at `packages/tui/src/render/hooks/use-input.ts:78`. That means the TUI app-level Ctrl+C branch at `packages/tui/src/ui/App.tsx:1081` is not the reliable owner of cancellation.

Impact: pressing Ctrl+C during a run exits/unmounts instead of taking the intended "cancel active query, commit interrupted streaming text, cancel background agents, clean history" path. The final REPL cleanup still runs after unmount, but the user-facing cancellation semantics and in-flight protocol cancellation are skipped.

Fix: start the REPL with `exitOnCtrlC: false` and let `App.tsx` handle both "cancel when running" and "exit when idle", or change the renderer to emit Ctrl+C to children before default exit. Add a regression test around a running query receiving Ctrl+C.

### `packages/tui/src/ui/components/CommandInput.tsx:171` - `/login <api-key>` persists secrets in input history

Problem: every submitted input is written with `addToHistory(v)` before dispatch. `/login` explicitly accepts an API key argument at `packages/tui/src/cli/commands/builtin/extra-commands.ts:55` and reads it from `arg.trim()` at line 57, and `input-history` queues the full display string for disk persistence at `packages/tui/src/ui/input-history.ts:208`.

Impact: API keys entered as `/login sk-...` are stored in `~/.code-shell/history.jsonl`, can be recalled with arrow history, and are not cleared by `/logout`. This is a local credential leak into persistent terminal history.

Fix: remove or deprecate `/login <api-key>` in favor of a secret prompt, or mark commands/arguments as sensitive so `CommandInput` redacts/skips history. Extend `/logout` to scrub matching historical secret entries.

### `packages/tui/src/ui/components/ProviderModelFlow.tsx:695` - API key entry is rendered as plain text

Problem: the onboarding/provider flow renders `API Key:` followed by a normal `TextInput` with `value={apiKey}` at line 697.

Impact: pasted or typed credentials are visible in the terminal during entry and can be captured by screen recording, terminal logging, or shoulder surfing. This is inconsistent with the nearby `maskKey()` treatment for environment keys.

Fix: add a `SecretInput`/`TextInput` mask mode that renders bullets while preserving the real value in state. Show only a short masked preview after sanitization.

### `packages/tui/src/cli/commands/builtin/core-commands.ts:709` - `/config show/get` can print saved credentials

Problem: `/config show` dumps `SettingsManager.get()` as raw JSON at line 709, and `/config get <key>` prints arbitrary selected values at line 718. Settings can include `credentials[].apiKey`, `models[].apiKey`, provider keys, or other secrets.

Impact: credentials can land in scrollback, exported transcripts, screenshots, or shared logs. This also defeats the secret masking used elsewhere in the model/provider UI.

Fix: run all config display paths through a recursive redactor for key names like `apiKey`, `token`, `secret`, `authorization`, `password`, and provider credential fields. Require an explicit unsafe/debug flag for raw secret output.

### `packages/tui/src/ui/App.tsx:1591` - async slash command failures are not awaited or caught

Problem: `handleSubmit` dispatches slash commands at `packages/tui/src/ui/App.tsx:1485`, and `handleSlashCommand` calls `commandRegistry.dispatch(cmd, cmdCtx)` at line 1591 without awaiting or catching the returned promise. Several command handlers are async and do not wrap their first protocol query, for example `/permissions` at `packages/tui/src/cli/commands/builtin/permissions-command.ts:23` and `/features` at `packages/tui/src/cli/commands/builtin/features-command.ts:16`.

Impact: a rejected `client.query()` can become an unhandled promise rejection instead of a visible status message. Depending on runtime policy, this can terminate the process or leave the user with a silent no-op.

Fix: make `handleSlashCommand` return/await `Promise.resolve(commandRegistry.dispatch(...)).catch(...)`, and render a status/error entry from the catch. Keep command-local catches where they provide better messages.

### `packages/tui/src/ui/App.tsx:1441` - background-agent notifications can be drained and then dropped

Problem: the notification effect drains the queue with `notificationQueue.drainAll(sessionId)` before calling `submitToEngine()` at line 1445. `submitToEngine()` immediately returns if `queryGuard.reserve()` fails at line 1251.

Impact: if a user submit or another injection reserves the guard between the effect checks and the `submitToEngine` call, the notification items are already removed and the main agent never sees the background-agent completion.

Fix: reserve the query slot before draining, or make `submitToEngine` return an accepted/rejected boolean and requeue drained items on rejection. Avoid fire-and-forget for paths that consume durable queue state.

### `packages/tui/src/ui/App.tsx:576` - sub-agent `thinking_delta` is mixed into the main spinner

Problem: `stream_request_start`, `text_delta`, tool events, task updates, and errors all gate or drop `agentId !== undefined`, but `thinking_delta` appends to the single `thinkingBufferRef` without checking `agentId`.

Impact: a child agent's thinking stream can appear in the main agent spinner or mix with the main agent's thinking content. That is confusing at best and can leak child-agent reasoning into the wrong transcript surface.

Fix: mirror the `text_delta` guard for `thinking_delta`, or route child-agent thinking into the child transcript model instead of the global spinner state.

### `packages/cdp/src/driver.ts:130` - `clickNode` falls back to synthetic `this.click()`

Problem: when geometry fails, `clickNode` calls `jsClick()`, which resolves the node and runs `Runtime.callFunctionOn` with `function(){ this.click(); }` at lines 153-156.

Impact: this violates the package's "real input" contract. `HTMLElement.click()` is synthetic (`isTrusted === false`), bypasses hit testing and visibility/occlusion, and can trigger actions on elements a user could not actually click.

Fix: make no-box clicks fail with `staleRef`/`no layout box` by default, or gate JS fallback behind an explicit unsafe option. Prefer a visible-point calculation with CDP input dispatch for all default clicks.

### `packages/cdp/src/driver.ts:119` - click coordinates are the element quad center, not a visible viewport point

Problem: `centerOf()` averages the content quad at lines 119-121 after `DOM.scrollIntoViewIfNeeded`, and `clickNode()` dispatches mouse events to that point at lines 134-137. There is no viewport intersection/clamping.

Impact: for very tall/wide or partially visible elements, the element center can remain outside the viewport after scrolling. CDP mouse events then miss the target or fail, even though a visible part of the element is clickable.

Fix: reuse the screenshot path's `layoutViewportRect()`/`intersectRects()` logic to choose a point inside the visible intersection, with a small inset. Return a stale/no-visible-box result when no intersection exists.

### `packages/cdp/src/driver.ts:295` - `fetchImageData()` interpolates `maxDim` directly into evaluated JS

Problem: `ref` is escaped via `JSON.stringify(ref)`, and `timeoutMs` is sanitized, but `maxDim` is embedded directly into a `Runtime.evaluate` expression.

Impact: TypeScript callers see `number`, but the published JS API has no runtime guard. If a host forwards an untrusted value as `maxDim`, it can turn into evaluated page JavaScript. Even accidental non-numeric values create brittle expression strings.

Fix: sanitize `maxDim` with `positiveFinite(maxDim, MAX_IMAGE_DIM)` before interpolation, and preferably build the call with JSON-serialized arguments for every dynamic value or use `Runtime.callFunctionOn` with `arguments`.

### `packages/cdp/src/driver.ts:646` - video refs are tagged in the DOM but not returned to callers

Problem: the extract script sets `data-codeshell-cdp-ref="vidN"` on each video at line 650, but `pushVid()` only returns `{url:s}` at line 646. The public `CdpVideo` type has only `url` at `packages/cdp/src/types.ts:63`.

Impact: `fetchImageData()` claims to support `img1/vid1` refs, but `extractLinks()` gives the host no video ref to pass back. Video frame fetch/screenshot fallback is effectively unreachable unless the host guesses `vidN` ordering.

Fix: add `ref?: string` to `CdpVideo` and include the assigned video ref in each returned video entry. If multiple `<source>` URLs map to one video element, return the same ref on each or normalize to one video entry per element.

### `packages/cdp/src/driver.ts:302` - missing image/video refs are not marked stale

Problem: when the in-page image lookup reports `missing`, `fetchImageData()` returns `{ ok:false, detail: ... }` without `staleRef: true`.

Impact: callers cannot distinguish a stale extract ref from a generic image-read failure, so they may not know to re-run extraction/snapshot before retrying.

Fix: include `staleRef: true` on missing-ref returns, and consider doing the same for ref lookup failures that indicate the tagged DOM node disappeared.

## 🟡 Minor

### `packages/tui/src/ui/components/MessageContent.tsx:23` - markdown render cache ignores terminal width

Problem: the LRU cache is keyed only by markdown text, and `getMarkedInstance()` captures `process.stdout.columns` only when the singleton is first created at lines 82-86.

Impact: after terminal resize, rows can re-render because `MessageRow` receives new `columns`, but cached ANSI and the singleton `marked-terminal` width can still reflect the old terminal width. This causes stale wrapping/reflow.

Fix: include effective width in the cache key and recreate or parameterize the `Marked` instance when width changes. Clear width-sensitive cache entries on resize.

### `packages/tui/src/ui/components/FullscreenLayout.tsx:170` - new-message pill/divider has no scroll-away source

Problem: `useUnseenDivider()` exposes `onScrollAway`, but `App` destructures only `onScrollToBottom` at `packages/tui/src/ui/App.tsx:316`. `VirtualMessageList` receives only `dividerIndex`/`unseenCount` at lines 1691-1692, and `FullscreenLayout` receives `showPill`/`onJumpToNew` at lines 2052-2054.

Impact: scrolling away from the bottom never flips `isScrolledAway`, so the "N new messages" pill and divider do not appear even though the components exist.

Fix: expose sticky/scroll-away changes from `ScrollBox`/`VirtualMessageList` and wire them to `useUnseenDivider().onScrollAway`; clear them through the existing jump-to-bottom path.

### `packages/tui/src/ui/App.tsx:715` - compact tool-result flag is never rendered

Problem: Arena retry detection stores `compact: looksLikeArenaRetry` on a `tool_result` entry, and `ToolCallResult` supports a `compact` prop at `packages/tui/src/ui/components/ToolCall.tsx:95`, but `renderEntry()` does not pass that prop at lines 2101-2108.

Impact: the intended compact retry UI never activates; repeated Arena parameter retries still render as normal error/result cards.

Fix: add `compact?: boolean` to the `ChatEntry` tool-result type and pass it through to `ToolCallResult`.

### `packages/tui/src/ui/components/TextInput.tsx:95` - Delete behaves like Backspace

Problem: `key.backspace || key.delete` is handled by deleting the character before the cursor.

Impact: the Delete key removes the wrong character for mid-line editing, which is especially noticeable in long prompts and pasted multi-line inputs.

Fix: split Backspace and Delete handling. Backspace should remove `cursorOffset - 1`; Delete should remove `cursorOffset` without moving the cursor.

### `packages/tui/src/cli/commands/repl.ts:144` - REPL bypasses the shared max-context resolver

Problem: `replCommand()` uses a local fallback expression for `maxContextTokens`, while `run.ts`/`runs.ts` use `resolveMaxContextTokens()` and that helper is the tested surface at `packages/tui/src/cli/commands/max-context-tokens.ts:3`.

Impact: behavior is currently equivalent, but future validation or fallback fixes can land in the helper and leave the interactive REPL divergent.

Fix: import and use `resolveMaxContextTokens(llmConfig, settings.context.maxTokens)` in `repl.ts`.

### `packages/tui/src/cli/commands/builtin/image-command.ts:80` - `/image` reads the full file before any size guard

Problem: after `statSync()`, the command immediately `readFileSync()`s the image into memory and then base64-encodes it.

Impact: a huge `.png`/`.jpg` can spike TUI memory before the engine's image policy gets a chance to reject it.

Fix: enforce a TUI-side max byte size before reading, ideally using the same limit text as the engine. For larger files, return a status telling the user to compress first.

### `packages/cdp/src/keymap.ts:160` - needs verification: printable `pressKey()` events omit text payloads

Problem: `planKeySequence()` emits only `type`, `key`, `code`, virtual key codes, and modifiers. It does not set CDP `text`/`unmodifiedText` for printable single-character keyDown events.

Impact: if hosts use `pressKey("a")` to type a printable character, CDP may focus/change shortcuts but not insert text in editable controls. This may be acceptable if `pressKey()` is only intended for control keys and shortcuts, since `typeNode()` uses `Input.insertText`.

Fix: verify against Chromium with a focused `<input>`. If printable `pressKey()` is supported, add `text`/`unmodifiedText` for unmodified printable keys and tests for insertion; otherwise document that text input must use `typeNode()`.

## Verification Notes

- Read `CODESHELL.md` first and limited the substantive review to `packages/tui/` and `packages/cdp/`.
- Confirmed `packages/cdp` has no Playwright dependency or imports; the action layer uses injected `CdpSender`.
- Checked CDP unit tests in `packages/cdp/src/driver.test.ts` and `keymap.test.ts`; existing tests cover domain enablement, click event sequence, navigation scheme blocking, screenshot scaling, NaN timeout guard, and NaN scroll guard. The findings above target gaps not covered by those tests.
- Confirmed `resolveMaxContextTokens()` is used by `run.ts` and `runs.ts`, but not by the interactive REPL command.
- Confirmed `ContextUsageBar` is currently unused by `rg -n "ContextUsageBar" packages/tui/src`; the active status bar is `StatusLine`.
- Did not run the full test suite because this was a read-only review request and no implementation changes were made.
