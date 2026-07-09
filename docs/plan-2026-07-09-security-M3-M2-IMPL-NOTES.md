# Security M3 + M2 Implementation Notes

Date: 2026-07-09

Scope: `docs/plan-2026-07-09-security-M3-M2.md` Stage 0 -> 7, plus desktop M1/M4/M5.

## Stage Summary

### Stage 0 - Characterization

- Added failing characterization around bucket-aware browser routing, missing `sessionId` parse behavior, worker ciphertext fail-closed behavior, credential env exposure, MCP credentialRef resolution, and guard visibility.
- Initial red coverage confirmed the old behavior could treat `enc:safeStorage:*` as plaintext in worker-local paths and had no bucket-aware registry contract.

### Stage 1 - M3 Registry And Renderer Registration

- Replaced the global active-guest-only registry with `sessionId -> bucket -> guest/partition` tracking.
- Renderer browser panels now register `{sessionId,bucket,partition}` and attached guest ids with main.
- Browser open-tab/reload events carry bucket and renderer listeners filter by bucket.
- Popout/default global active guest is no longer a routing fallback for automation.

### Stage 2 - M3 Browser Action Routing

- `agent/run` now passes main-only `bucket` and `browserPartition`; main registers the session bucket before forwarding to worker.
- Browser actions fail closed when `sessionId` or bucket mapping is missing.
- `list_tabs` and `switch_tab` are bucket constrained; cross-bucket tab ids do not focus.
- `openBrowserPanelForSession` opens the target bucket and waits for that bucket's guest instead of using global active guest.

### Stage 3 - M3 InjectCredential / Cookie Restore

- InjectCredential hidden action now requires session bucket mapping and resolves the target partition from that mapping.
- If the target browser guest is live, cookies are restored into that guest session.
- If no live guest exists, cookies are restored into `session.fromPartition("persist:browser:<bucket>")`, per decision #4; no global active guest fallback.
- Browser reload notifications carry only the target bucket.

### Stage 4 - M2 Core CredentialAccess

- Added `CredentialAccess` abstraction with local and IPC-backed implementations.
- Core credential tools, env exposure, MCP header building, and tool guards now use metadata/resolver access instead of directly treating disk secrets as plaintext.
- Local/headless core keeps `CredentialStore + PlaintextCipher` as default, but foreign `enc:*` values are unavailable and never returned as secrets.

### Stage 5 - M2 Desktop SafeStorage Service / Worker IPC

- Desktop main installs `SafeStorageCipher` on app ready.
- Worker installs IPC credential access on stdio startup.
- Main sends `desktop/credentialSnapshot` metadata/env snapshots before `agent/run` and after credential mutations.
- Worker asks main for plaintext only through internal `desktop/credentialResolve` and `desktop/credentialMaterializeCookie`; these messages are intercepted by `AgentBridge` and are not sent to renderer/transcript.
- Cookie materialization is done by main, returning only `{cookiesFile,count}` to worker.

### Stage 6 - M2 Migration / Fallback

- Added startup migration for known project credential stores plus user store.
- Added lazy migration from credential list/snapshot/restore paths.
- Legacy bare plaintext and `plain:` credentials rewrite through active cipher; fake safeStorage tests verify `enc:safeStorage:*`.
- SafeStorage unavailable path falls back to `plain:` without blocking save and without UI prompt, per decision #3.
- Deviation recorded: the plan mentioned `credentials:securityStatus`; this implementation did not add a UI/status surface because the final decision explicitly requested no UI prompt/status friction for plaintext fallback.

### Stage 7 - Full Chain Regression

- Added/extended tests covering:
  - UseCredential token and cookie through host access.
  - `exposeAsEnv` from provider snapshot plus settings override precedence.
  - MCP `credentialRef` through async credential access.
  - InjectCredential availability/execution via metadata and host restore.
  - Tool guard visibility from metadata and empty snapshot fail-closed.
  - Desktop safeStorage-backed encrypted disk -> metadata snapshot -> resolver/materializer.

## Desktop Major Fixes

### M1 - `images:readDataUrl`

- Factored image reading into `image-read-service`.
- IPC now requires renderer to pass workspace context `{cwd, sessionId?}`.
- Main validates absolute image extension, size, final path not symlink, and realpath containment under the session workspace; no-context legacy calls return `null`.
- Renderer call sites now pass cwd from file panel, markdown, attachment cards, and file-panel attach flow.

### M4 - `skills:uninstall`

- Main no longer deletes an arbitrary renderer-provided path.
- New renderer contract sends `{scope,cwd,skillName}`.
- Main resolves the visible listed skill and validates the real skill directory is a direct child of allowed user/project skill roots before `rm -r`.
- Legacy path form is retained only if it exactly matches `listSkills(..., includeDisabled:true)` for that cwd/source.
- Symlink skill directories are refused.

### M5 - Desktop Typecheck

- Fixed `ChatView` picker upload origin.
- Fixed `file-search-service` `done` type.
- Fixed `settings-service` nullable worktree handling.
- Fixed `index.ts` migration log spread.
- Built `@cjhyy/code-shell-cdp` so desktop typecheck resolves CDP types.
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck` is green.

## Worker Plaintext / Derived Links Verified

- UseCredential token: worker gets plaintext only through `CredentialAccess.resolveValue`; covered by `packages/core/src/credentials/use-credential-tool.test.ts` and `packages/core/src/credentials/access.test.ts`.
- UseCredential cookie: main materializes cookies.txt and worker receives path/count only; covered by `use-credential-tool.test.ts` and `packages/desktop/src/main/credential-access-service.test.ts`.
- `exposeAsEnv`: snapshot carries derived env values; engine merges them and lets settings override; covered by `packages/core/src/engine/engine.shell-env.test.ts`.
- MCP `credentialRef`: HTTP headers resolve via async credential access with user-scope semantics preserved; covered by `packages/core/src/tool-system/mcp-manager.test.ts`.
- InjectCredential: worker sees metadata and sends id/scope/session only; main decrypts/restores cookie jar to target bucket/partition; covered by `packages/core/src/credentials/inject-credential-tool.test.ts` and `packages/desktop/src/main/credential-action.test.ts`.
- Tool visibility guard/dynamic description: metadata snapshot controls visibility and does not leak secret; covered by `packages/core/src/tool-system/builtin/tool-guards.test.ts`, UseCredential, and InjectCredential tests.

## Review fixes (pre-beta-06)

- B1: Added sensitive `ToolResult` semantics (`sensitive`, `displayResult`, `transcriptResult`) plus shared redaction helpers. `UseCredential` token/link builtin results keep plaintext only in the model-facing `result`; transcript, stream events, renderer snapshots, tool summaries, dev recorder output, and hook payloads use the placeholder projection. TurnLoop skips context summarization while an unconsumed sensitive result is pending, sends plaintext to the next model call once, then redacts the in-memory history so resume only sees the placeholder. Covered by `packages/core/src/engine/turn-loop-sensitive-result.test.ts`, `packages/core/src/tool-system/executor-sensitive-result.test.ts`, and `packages/core/src/credentials/use-credential-tool.test.ts`.
- M1: Desktop credential snapshots no longer call legacy `CredentialStore.envExposures()`; env maps are built with `isCredentialSecretAvailable()`. MCP probe credentialRef headers now use the same availability guard and fail closed for unreadable `enc:*` values. Covered by `packages/desktop/src/main/credential-access-service.test.ts` and `packages/desktop/src/main/mcp-probe-service.test.ts`.
- M2: Browser guest registration is now pending-attach based. `did-attach-webview` records the owner window, guest id, and main-normalized partition; renderer metadata is accepted only when owner and partition match. Renderer `browser:register-session-bucket` can only confirm an existing main-owned `agent/run` mapping and cannot create or rebind `sessionId -> bucket`. Covered by `packages/desktop/src/main/browser-driver/active-guest.test.ts`.
- M3: Shared `agent/run` metadata handling now strips main-only bucket/partition fields, registers session buckets, records `sessionCwd`, pushes credential snapshots, and injects main-owned trust for both renderer IPC and `injectWorkerMessage()`. InjectCredential cwd resolution now uses `sessionCwd` or persisted `SessionManager.readCwd(sessionId)` and fails closed without `lastRunContext` fallback. Covered by `packages/desktop/src/main/agent-run-metadata.test.ts`.
- m1: Added the requested negative security tests for sensitive UseCredential stream/transcript/history redaction, unreadable `enc:safeStorage:*` env/header fail-closed behavior, and forged browser guest/session metadata rejection.
- n1: Updated the `UseCredential` file header to reflect desktop host credential-access IPC instead of the old "no cross-process" wording.

## Verification

Stage/focused:

- `bun test packages/desktop/src/main/browser-driver` -> 60 pass.
- `bun test packages/core/src/credentials` -> 62 pass.
- `bun test packages/core/src/engine/engine.shell-env.test.ts` -> 17 pass.
- `bun test packages/core/src/tool-system/mcp-manager.test.ts` -> 46 pass.
- `bun test packages/desktop/src/main/credential-action.test.ts` -> 2 pass.
- `bun test packages/desktop/src/renderer/browser` -> 24 pass.
- `bun test packages/desktop/src/main/image-read-service.test.ts packages/desktop/src/main/skills-service.test.ts` -> 10 pass.
- `bun test packages/desktop/src/main/credential-access-service.test.ts packages/desktop/src/main/credential-migration.test.ts` -> covered earlier during Stage 5/6, green.

Final:

- `bun test` -> 5186 pass, 6 skip, 0 fail.
- `bun run typecheck` -> pass.
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck` -> pass.
- `bun run --filter '@cjhyy/code-shell-core' build` -> pass.
- `bun run --filter '@cjhyy/code-shell-cdp' build` -> pass.
- `bun run lint` -> exit 0; 0 errors, existing warnings only.

## Notes / Residuals

- No commit, push, or tag was created.
- Existing dirty `TODO.md` was present before this work and was not part of the implementation.
- The full `bun test` output includes plugin-hook stderr from locally installed plugins during run-manager tests, but those tests passed and the final summary was green.
