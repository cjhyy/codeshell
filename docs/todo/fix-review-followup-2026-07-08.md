# Fix Review Follow-up 2026-07-08

1. PTY ownership and reattach bypass
   - Commits: `368f40e9` (`fix(desktop): deny pty reattach by non-owner`), `4fa70e8b` (`test(desktop): isolate pty ownership cwd`)
   - Test added/repaired: `packages/desktop/src/main/pty-ownership.test.ts` now asserts non-owner `ptyStart(existingSessionId)` is denied and cannot take over write access.
   - Verification: `bun test packages/desktop/src/main/pty-ownership.test.ts` passed; full `bun test` shows both PTY ownership tests passing.

2. VirtualMessageList scroll-away regression
   - Commits: `5e1475cd` (`test(tui): stabilize scroll-away notification coverage`), `9f7e6901` (`test(tui): wait for virtual list ref`), `cccdd7a9` (`test(tui): avoid persistent render root mock`)
   - Test added/repaired: `packages/tui/src/ui/components/VirtualMessageList.test.tsx` explicitly provides fullscreen context and waits for the real list handle before calling `scrollBy(-3)`. `packages/tui/src/ui/index.test.tsx` no longer leaves a persistent render-root module mock behind.
   - Verification: `bun test packages/tui/src/ui/index.test.tsx packages/tui/src/ui/components/VirtualMessageList.test.tsx` passed; full `bun test` shows the scroll-away test passing.

3. Plugin unsafe transport bypass and update/check-update gap
   - Commit: `bec64e44` (`fix(plugins): reject unsafe transports on update paths`)
   - Test added/repaired: `packages/core/src/plugins/installer/parseSource.test.ts` covers uppercase unsafe schemes including `HTTP://`, `FILE://`, and `Git+SSH://`; `update.test.ts` and `checkUpdate.test.ts` cover unsafe installed metadata rejection by default.
   - Verification: `bun test packages/core/src/plugins/installer/parseSource.test.ts packages/core/src/plugins/installer/update.test.ts packages/core/src/plugins/installer/checkUpdate.test.ts` passed.

4. CDP click coordinate regression after scroll
   - Commit: `6b44c57f` (`fix(cdp): dispatch scrolled clicks in viewport coordinates`)
   - Test added/repaired: `packages/cdp/src/driver.test.ts` adds `dispatches viewport-relative coordinates after page scroll`, asserting a non-zero `layoutViewport.pageY` dispatches the viewport point.
   - Verification: `bun test packages/cdp/src/driver.test.ts` passed.

5. Path approval grants recreated after session close
   - Commit: `b90dfc7a` (`fix(core): ignore path grants after session close`)
   - Test added/repaired: `packages/core/src/protocol/chat-session-manager.permission.test.ts` covers in-flight session and project path approvals resolving after close and verifies no remembered grant is created.
   - Verification: `bun test packages/core/src/protocol/chat-session-manager.permission.test.ts` passed.

6. `/config` secret redaction misses secret-shaped keys
   - Commit: `9a339a47` (`fix(tui): redact secret-shaped config keys`)
   - Test added/repaired: `packages/tui/src/cli/commands/builtin/core-commands.test.ts` covers `OPENAI_API_KEY`, `GITHUB_TOKEN`, `X-Api-Key`, `authToken`, `accessToken`, `refreshToken`, `clientSecret`, and benign `keyboardShortcut`/`keymap` non-redaction.
   - Verification: `bun test packages/tui/src/cli/commands/builtin/core-commands.test.ts` passed.

7. Desktop credential injection re-resolves outside core scope
   - Commit: `bc9f8d6b` (`fix(desktop): preserve credential injection scope`)
   - Test added/repaired: `packages/desktop/src/main/credential-action.test.ts` verifies project scope does not fall back to a same-id user cookie credential; `browser-driver/intercept.test.ts` verifies `credentialScope` parsing.
   - Verification: `bun test packages/desktop/src/main/browser-driver/intercept.test.ts packages/desktop/src/main/credential-action.test.ts packages/core/src/credentials/inject-credential-tool.test.ts` passed.

Required gates:
- `bun run build`: passed.
- `bun run lint`: passed with `0` errors and `167` warnings.
- Full `bun test`: `4902 pass`, `6 skip`, `1 fail`, `11051 expect() calls`, `4909 tests across 712 files`; the remaining failure is the known `public VERSION > matches package.json version` mismatch.

Final line: full-suite pass/fail counts are `4902 pass / 1 fail / 6 skip`; the PTY ownership and VirtualMessageList scroll-away regressions are resolved in the full suite.
