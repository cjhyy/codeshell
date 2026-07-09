# Desktop Code Review - 2026-07-08

Scope: read-only review of `packages/desktop/` only, covering Electron main process, preload, and renderer. I did not review core/tui/cdp implementation in this pass.

## Summary

- 🔴 Critical: 0 confirmed.
- 🟠 Major: 4 confirmed.
- 🟡 Minor: 4 confirmed.
- Renderer import guardrail: no runtime imports from `@cjhyy/code-shell-core` found; current matches are `import type` only.
- No external CDP TCP port exposure found in desktop; browser automation uses Electron `webContents.debugger`.

## 🔴 Critical

No confirmed critical findings in this pass.

## 🟠 Major

### packages/desktop/src/main/browser-driver/active-guest.ts:13 - browser automation and cookie injection target a global active guest, not the originating session

Problem: the automation target is a process-global `active` webContents (`active-guest.ts:13-35`) updated by the most recently attached/focused guest. Browser action requests do carry an originating `sessionId` (`browser-driver/intercept.ts:40-58`), but `agent-bridge.ts:375-389` passes only `parsed.request` to `handleBrowserAction`, which then resolves `deps.activeGuest()` (`automation-host.ts:130-151`). Cookie injection has the same shape: it resolves the credential against the originating session cwd, then restores the jar into `activeGuest()?.session` (`agent-bridge.ts:435-462`).

Impact: with multiple session browser panels mounted, an AI run from session A can drive or inject cookies into session B's last-focused/last-attached webview. That can leak authentication state across sessions and perform browser actions in the wrong project/session context. This is amplified by renderer behavior that keeps hidden session panel buckets mounted (`App.tsx:3521-3536`) while each bucket gets its own browser partition (`PanelArea.tsx:425-429`).

Suggested fix: register each guest with owner metadata: engine session id, panel bucket, and/or partition. Propagate `parsed.sessionId` through `handleBrowserAction` and credential injection, then select the guest/session for that owner instead of the global active guest. Keep the global active fallback only for explicitly user-initiated, no-session actions, and update active status on visible panel activation rather than attach/focus alone.

### packages/desktop/src/renderer/browser/useBrowserTabs.ts:280 - browser tab/reload events are broadcast to every mounted browser panel

Problem: every `BrowserPanel` instance subscribes to the global `browser:open-tab` event and calls `openInNewTab` (`useBrowserTabs.ts:280-284`). Every instance also subscribes to the global `browser:reload` event and reloads its current webview (`useBrowserTabs.ts:287-290`). The dock explicitly allows multiple tabs of the same kind and keeps all tabs mounted (`PanelArea.tsx:113-120`, `PanelArea.tsx:442-452`), and hidden buckets stay mounted across session switches (`App.tsx:3521-3536`). Main sends unscoped messages for popups (`index.ts:1128-1131`) and cookie-restore reloads (`index.ts:1714-1717`; `agent-bridge.ts:463-465`).

Impact: a `target=_blank`/`window.open` from one webview can open duplicate tabs in every mounted browser panel, including hidden session buckets. Credential switching and AI cookie injection reload unrelated panels. That is a correctness bug and a resource leak vector because hidden panels can grow tabs/reload webviews without user intent.

Suggested fix: include source identity in the IPC payload, such as guest `webContents.id`, browser panel instance id, bucket, or partition. Have only the matching `BrowserPanel` handle `browser:open-tab`. Scope `browser:reload` to the affected bucket/partition/session instead of broadcasting to all windows/panels.

### packages/desktop/src/main/browser-driver/policy.ts:75 - desktop sensitive-action approval gate is effectively inert

Problem: `automation-host.ts:164-168` calls `isSensitiveAction(req)` before executing browser actions. That function only flags `type` actions whose text looks like a card/long numeric secret (`policy.ts:75-78`, `policy.ts:81-86`). The declared sensitive words for payment/delete/credential surfaces are defined but unused (`policy.ts:45-65`). The approval callback passed by the bridge always returns true (`agent-bridge.ts:375-386`).

Impact: the desktop main-process defense described in `policy.ts:1-9` does not actually gate clicks on "delete", "pay", "checkout", "confirm", etc., nor does it gate `selectOption` or `pressKey` submissions. If the worker-side tool permission is permissive, bypassed, or misclassified, desktop executes the CDP action without a second main-side confirmation.

Suggested fix: implement a real main-to-renderer approval path for sensitive browser actions, and classify action sensitivity using the current snapshot element metadata/text/role/url for `click`, `selectOption`, and `pressKey`, not only typed literal text. Either remove the unused word list or wire it into the element/action classifier and add tests for delete/payment/credential controls.

### packages/desktop/src/main/index.ts:1443 - credentials and captured cookie jars remain plaintext at rest

Problem: the main process explicitly does not install `SafeStorageCipher`; the default remains `PlaintextCipher (0o600)` (`index.ts:1443-1453`). The credential IPC writes user-supplied credentials through `CredentialStore.save` (`index.ts:1628-1632`), and cookie capture can store full browser cookie jars (`index.ts:1680-1690`, `credentials-service.ts:92-100`).

Impact: API tokens, bearer tokens, and captured cookies are stored unencrypted under user/project `.code-shell` locations. File permissions help against other OS users, but not against same-user malware, synced backups, indexing tools, or accidental disclosure. For a desktop client with credential capture/injection, this is a significant secret-leakage risk.

Suggested fix: complete the main/worker cipher bridge noted in the comment. Use versioned encrypted envelopes for new secrets, migrate existing plaintext entries on read/write, and keep the worker from persisting raw secrets. For cookie jars, consider narrower per-domain capture by default and clear UI labeling for full-partition captures.

## 🟡 Minor

### packages/desktop/src/main/index.ts:2816 - PTY write/resize/kill IPC does not enforce sender ownership

Problem: `pty:start` records the owning `WebContents` (`pty-service.ts:197-231`), but subsequent `pty:write`, `pty:resize`, and `pty:kill` handlers pass only `sessionId` (`index.ts:2816-2823`). The service methods then operate on `sessions.get(sessionId)` without comparing the caller to `Session.webContents` (`pty-service.ts:251-254`, `pty-service.ts:271-289`). The renderer adds a window token to the session id (`TerminalPanel.tsx:28-30`; `preload/index.ts:780-793`), but that is a renderer-side convention rather than a main-process authorization check.

Impact: any renderer context that learns or guesses a PTY session id can write to, resize, or kill that shell. Normal UI paths make collision unlikely, but the main IPC boundary should enforce ownership because PTYs are long-lived, command-capable resources.

Suggested fix: pass `e.sender` into `ptyWrite`, `ptyResize`, and `ptyKill`, and require it to match the stored `Session.webContents` before acting. Prefer opaque, server-generated PTY ids over renderer-composed ids, and keep the window token as a compatibility/debugging aid rather than the authorization mechanism.

### packages/desktop/src/main/safe-read.ts:13 - skill/agent markdown reads are not bounded to known roots or realpaths

Problem: `skills:read` and `agents:read` accept renderer-supplied file paths (`index.ts:1858`, `index.ts:1884-1886`). The guard only checks that the resolved string contains a `.code-shell` path segment and ends in `.md` (`safe-read.ts:13-20`), then `readSkillBody`/`readAgentBody` read that path (`skills-service.ts:67-69`, `agents-service.ts:89-91`).

Impact: a compromised renderer can read any markdown file under any `.code-shell` directory, not just files returned by `listSkills`/`listAgents` for the current user/project/plugin roots. Because the check does not use `realpath`, a symlink with a `.md` name inside an allowed-looking `.code-shell` tree can point outside the intended root.

Suggested fix: validate against canonical realpaths for the allowed roots: user skills/agents, current project skills/agents, and read-only plugin roots. Reject symlinks or resolved targets outside those roots. Ideally, issue opaque ids from the list APIs and read by id instead of accepting arbitrary paths from the renderer.

### packages/desktop/src/renderer/App.tsx:2917 - browser popout anchor operations mutate the currently active bucket, not the popout's origin bucket

Problem: main tracks only popout webContents id to parent window id (`index.ts:1347-1371`) and forwards add/remove/update anchor messages without bucket/session metadata (`index.ts:2522-2527`, `index.ts:2552-2568`). The parent renderer handles those messages by mutating `activeAnchorBucketRef.current` (`App.tsx:2917-2935`). Opening the popout also sends only the current URL (`BrowserPanel.tsx:253-256`; `index.ts:2500-2503`).

Impact: if a user opens a browser popout for session A, switches the main window to session B, then pins/removes/edits an element in the popout, the operation lands in session B's anchor state. That can attach the wrong web evidence to a prompt or remove the wrong annotation.

Suggested fix: include the source bucket/partition/session in `browser:popout` and store it in `popoutParents` metadata. Forward that bucket with anchor add/remove/update events and mutate that bucket in `App.tsx` instead of `activeAnchorBucketRef.current`.

### packages/desktop/src/renderer/types.ts:701 - replayed sub-agent timestamps use replay time instead of persisted event time

Problem: transcript replay passes a persisted timestamp clock into `applyStreamEvent` (`automation/foldTranscript.ts:13-53`), and tool timestamps already use that clock (`types.ts:536-550`, `types.ts:601-626`). Sub-agent start/end still call `Date.now()` directly (`types.ts:701-724`, `types.ts:767-792`). Agent group wall time is calculated from those fields (`messages/agentGroup.ts:49-82`).

Impact: reopening historical transcripts stamps sub-agent cards/groups with the time of replay instead of the time the agents actually ran. Durations and wall-clock summaries can drift or collapse incorrectly, especially for completed fan-out groups.

Suggested fix: use the reducer clock for `agent_start` and `agent_end`, matching the tool timestamp fix. Add a `foldTranscript` regression test with persisted `agent_start`/`agent_end` timestamps to assert `startedAt`, `endedAt`, and group `wallMs`.

## Verification Notes

- Read repository guidance in `AGENTS.md` and `CODESHELL.md`; this report is confined to `packages/desktop/`.
- Main process areas checked: window/webview preferences and CSP/permissions, browser-driver guest registry and automation host, browser/credential action bridge, credentials service, PTY service, settings writer, skills/agents reads, MCP probe/list wiring, auto-updater status flow, browser popout/anchor routing, file service path resolution, and desktop service shell/open helpers.
- Renderer areas checked: `App.tsx` panel bucket persistence, `PanelArea`, `BrowserPanel`, `WebviewHost`, `useBrowserTabs`, PTY terminal lifecycle, browser element-picking/idle eviction, settings resource hooks, MCP settings UI, markdown/link handling, stream reducer/fold rendering, and agent group rendering.
- Renderer import guardrail verified with `rg`: all `@cjhyy/code-shell-core` imports under `packages/desktop/src/renderer` are `import type`; no runtime import violation found.
- CDP exposure verified with `rg`: no `--remote-debugging-port` or TCP CDP server exposure found in desktop. Automation uses Electron `webContents.debugger` with attach/detach helpers.
- Already-fixed/not re-flagged examples: main window uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` (`index.ts:1166-1174`); app renderer CSP and permission handler are scoped to renderer origins (`index.ts:1195-1271`); `fs-service.ts` resolves file-browser reads within the selected root with realpath/symlink checks.
