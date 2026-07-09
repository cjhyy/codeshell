# Final Sign-off Review 2026-07-08

Scope reviewed: `git log --oneline origin/main..HEAD` returned 60 commits on
`main`, from `37eba5c0` through `e14cd42a`.

Note: the working tree was dirty during this review. The verdict below is for
pushing the committed 60-commit range; local-only modified/untracked files are
not part of that push. The required build/test/lint commands were run against
the current working tree.

## Previously Raised Issues

1. PTY ownership and reattach bypass: resolved.
   - Ownership enforcement is centralized in `packages/desktop/src/main/pty-service.ts:187`.
   - Existing-session `ptyStart` reattach now calls that ownership gate and rejects non-owners at `packages/desktop/src/main/pty-service.ts:241` and `packages/desktop/src/main/pty-service.ts:245`.
   - Write/resize/kill still go through the same owner gate at `packages/desktop/src/main/pty-service.ts:297`, `packages/desktop/src/main/pty-service.ts:317`, and `packages/desktop/src/main/pty-service.ts:327`.
   - Regression coverage asserts non-owner reattach denial at `packages/desktop/src/main/pty-ownership.test.ts:92` and `packages/desktop/src/main/pty-ownership.test.ts:102`.

2. VirtualMessageList scroll-away regression: resolved.
   - The list subscribes to `ScrollBox` and calls `onScrollAway` when sticky-bottom is broken at `packages/tui/src/ui/components/VirtualMessageList.tsx:119` and `packages/tui/src/ui/components/VirtualMessageList.tsx:123`.
   - The stabilized test provides fullscreen context, waits for the handle, scrolls away, and checks one notification at `packages/tui/src/ui/components/VirtualMessageList.test.tsx:31`, `packages/tui/src/ui/components/VirtualMessageList.test.tsx:51`, and `packages/tui/src/ui/components/VirtualMessageList.test.tsx:56`.

3. Plugin uppercase scheme bypass and update-path unsafe transport gap: resolved.
   - URL schemes are matched case-insensitively and normalized before the unsafe decision at `packages/core/src/plugins/installer/parseSource.ts:38`.
   - Non-HTTPS URL schemes are unsafe by default and rejected unless explicitly opted in at `packages/core/src/plugins/installer/parseSource.ts:74`.
   - Update and check-update paths now parse installed metadata with `allowUnsafeTransport` false unless explicitly passed at `packages/core/src/plugins/installer/update.ts:105` and `packages/core/src/plugins/installer/checkUpdate.ts:35`.
   - Tests cover uppercase schemes at `packages/core/src/plugins/installer/parseSource.test.ts:105`, unsafe update rejection at `packages/core/src/plugins/installer/update.test.ts:188`, and unsafe check-update rejection at `packages/core/src/plugins/installer/checkUpdate.test.ts:116`.

4. CDP post-scroll click coordinates: resolved.
   - `centerOf` intersects the page-space element box with the page-space viewport and subtracts `viewport.x/y` before dispatch at `packages/cdp/src/driver.ts:119` and `packages/cdp/src/driver.ts:123`.
   - Click dispatch uses the returned viewport-relative coordinates at `packages/cdp/src/driver.ts:138`.
   - `layoutViewportRect` reads `pageX/pageY` and client dimensions at `packages/cdp/src/driver.ts:352` and `packages/cdp/src/driver.ts:366`.
   - Regression coverage asserts a non-zero scroll offset dispatches `{ x: 70, y: 40 }` at `packages/cdp/src/driver.test.ts:96` and `packages/cdp/src/driver.test.ts:109`.

5. Path approvals recreated after session close: resolved.
   - `ChatSessionManager.close` clears path approvals on close at `packages/core/src/protocol/chat-session-manager.ts:98` and `packages/core/src/protocol/chat-session-manager.ts:102`.
   - Closed sessions are tracked at `packages/core/src/tool-system/path-policy.ts:176`, and late `recordPathApproval` calls return without writing session or project grants at `packages/core/src/tool-system/path-policy.ts:288` and `packages/core/src/tool-system/path-policy.ts:296`.
   - A new session reopens approvals explicitly at `packages/core/src/tool-system/path-policy.ts:365`; close adds the session to the closed set at `packages/core/src/tool-system/path-policy.ts:369`.
   - Regression coverage resolves in-flight session/project approvals after close and verifies a later access is still denied at `packages/core/src/protocol/chat-session-manager.permission.test.ts:161`, `packages/core/src/protocol/chat-session-manager.permission.test.ts:193`, and `packages/core/src/protocol/chat-session-manager.permission.test.ts:205`.

6. `/config` secret redaction: resolved.
   - Secret-shaped substrings and known env keys are detected at `packages/tui/src/cli/commands/builtin/core-commands.ts:17` and `packages/tui/src/cli/commands/builtin/core-commands.ts:26`.
   - Recursive redaction applies by path key at `packages/tui/src/cli/commands/builtin/core-commands.ts:51`.
   - `/config show` and `/config get` both pass through the redactor at `packages/tui/src/cli/commands/builtin/core-commands.ts:765` and `packages/tui/src/cli/commands/builtin/core-commands.ts:774`.
   - Tests cover env/header/camelCase secret keys and benign key names at `packages/tui/src/cli/commands/builtin/core-commands.test.ts:39` and `packages/tui/src/cli/commands/builtin/core-commands.test.ts:96`.

7. Credential injection scope widening: resolved.
   - Core derives project/full credential scope from settings scope at `packages/core/src/credentials/inject-credential-tool.ts:81`, resolves credentials with that scope at `packages/core/src/credentials/inject-credential-tool.ts:131`, and sends the same scope to the host at `packages/core/src/credentials/inject-credential-tool.ts:164`.
   - The protocol request includes `credentialScope` at `packages/core/src/protocol/server.ts:2064` and `packages/core/src/protocol/server.ts:2101`.
   - Desktop parses `credentialScope` at `packages/desktop/src/main/browser-driver/intercept.ts:96` and `packages/desktop/src/main/browser-driver/intercept.ts:123`.
   - The desktop bridge passes the parsed scope into the resolver at `packages/desktop/src/main/agent-bridge.ts:460`, and the resolver calls `CredentialStore.resolve` with that scope at `packages/desktop/src/main/credential-action.ts:14`.
   - Tests cover project scope not falling back to a same-id user credential at `packages/desktop/src/main/credential-action.test.ts:24` and scope parsing at `packages/desktop/src/main/browser-driver/intercept.test.ts:127`.

## New Findings Scan

- No new blocker found in the follow-up commits.
- ESLint guardrails: no runtime core import of `@cjhyy/code-shell-tui`; the only core hit is the guard test constant in `packages/core/src/automation/no-host-deps.test.ts:10`. Renderer CodeShell package imports found by scan are type-only imports, and `bun run lint` reported no boundary errors.
- No `debugger` or `.only` test markers found. Console logging hits are existing CLI/script/test output paths, not a follow-up blocker.
- `git diff --check origin/main..HEAD` reports trailing whitespace in doc-only memory notes (`docs/todo/memory-final-design.md` and `docs/todo/memory-simple-plan-eval.md`). I do not classify this as a push blocker because it is confined to documentation and no requested gate fails on it.
- `e14cd42a` is docs-only: it adds only `docs/archive/todo/memory-demo.html` plus `docs/todo/*.md` memory design notes. `memory-demo.html` is a 58,790-byte self-contained static demo with inline script; scan found no remote script/fetch/localStorage/credential handling.
- No committed binary files were reported by `git diff --numstat origin/main..HEAD`.
- No unintended large committed files found. The largest changed blobs are existing source files; the largest new docs artifact is `docs/archive/todo/memory-demo.html` at 58,790 bytes.
- Secret scan of the committed diff found only placeholders/test fixtures, documentation wording, and GitHub Actions `${{ secrets.NPM_TOKEN }}` usage. No literal private keys, tokens, or credentials found.

## Command Results

- `bun run build`: passed, exit 0.
- `bun test`: exit 1 with only the allowed baseline failure `public VERSION > matches package.json version`.
  Counts: 4908 pass, 6 skip, 1 fail, 11074 `expect()` calls, 4915 tests across 713 files.
- `bun run lint`: passed, exit 0.
  Counts: 167 problems, 0 errors, 167 warnings; 6 warnings potentially fixable with `--fix`.

Final verdict: SAFE-TO-PUSH
