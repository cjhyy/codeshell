# Security Review: Local Unpushed Commits, 2026-07-08

Scope: `da84f435~1..HEAD` on `main`, 43 commits, inspected with `git log --oneline da84f435~1..HEAD` and `git show <hash>`.

Verdict: no new obvious direct RCE, SSRF, unsafe deserialization, or prototype-pollution hole found in the batch. The settings prototype-key sanitization appears to block `__proto__`, `constructor`, and `prototype` recursively through file loads, flag overrides, saves, and deep merge. The CDP fixes are security-positive: JS click fallback was removed, click coordinates are constrained to the visible viewport, and the image `maxDim` is sanitized before interpolation into page JavaScript.

However, several commits do not fully close their intended security boundary. The main residual risks are renderer-to-main PTY takeover by reattach, incomplete TUI settings redaction, desktop credential injection re-resolution outside the core scope check, symlink escape in desktop markdown reads, and unsafe plugin transports remaining active on update.

## Findings

### 🟠 PTY ownership can be bypassed by reattaching with `ptyStart`

Commit: `c621140a fix(desktop): require pty sender ownership`

The new ownership gate is only applied to `ptyWrite`, `ptyResize`, and `ptyKill` via `sessionForOwner` (`packages/desktop/src/main/pty-service.ts:180`, `packages/desktop/src/main/pty-service.ts:288`, `packages/desktop/src/main/pty-service.ts:308`, `packages/desktop/src/main/pty-service.ts:318`). But `ptyStart` still treats an existing `sessionId` as a reattach and unconditionally overwrites the owner:

- `packages/desktop/src/main/pty-service.ts:234`
- `packages/desktop/src/main/pty-service.ts:236`
- `packages/desktop/src/main/pty-service.ts:238`
- `packages/desktop/src/main/pty-service.ts:241`

Exploit path: a non-owner renderer that can call the exposed preload IPC (`packages/desktop/src/preload/index.ts:787`) with an existing terminal `sessionId` can become the owner, receive replayed scrollback, then write/resize/kill the PTY. The renderer-generated ids include `windowToken` (`packages/desktop/src/renderer/panels/TerminalPanel.tsx:30`), which reduces accidental collision, but it is not enforced as a main-process capability.

Test gap: `packages/desktop/src/main/pty-ownership.test.ts:65` starts as owner, then tests only direct non-owner write/resize/kill (`packages/desktop/src/main/pty-ownership.test.ts:67`). It does not assert that non-owner `ptyStart(existingSessionId)` is rejected.

### 🟠 `/config` redaction only catches exact secret key names

Commit: `4e2f5454 fix(tui): redact secrets in config output`

`redactSettingsSecrets` only redacts when the final path segment lowercases exactly to one of `apikey`, `api_key`, `api-key`, `secret`, `token`, `password`, or `authorization` (`packages/tui/src/cli/commands/builtin/core-commands.ts:17`, `packages/tui/src/cli/commands/builtin/core-commands.ts:27`). This misses common settings shapes where the key name contains the secret marker but is not exactly equal:

- top-level `env.OPENAI_API_KEY`
- `env.MY_SECRET`
- `mcpServers.<name>.env.GITHUB_TOKEN`
- `mcpServers.<name>.headers.X-Api-Key`
- camelCase fields such as `authToken`, `accessToken`, `refreshToken`, `clientSecret`

Exploit path: `/config show` (`packages/tui/src/cli/commands/builtin/core-commands.ts:745`) or `/config get env.OPENAI_API_KEY` (`packages/tui/src/cli/commands/builtin/core-commands.ts:754`) prints plaintext secrets that are explicitly supported settings (`packages/core/src/settings/schema.ts:487`, `packages/core/src/settings/schema.ts:500`; MCP env/header shapes at `packages/core/src/settings/schema.ts:279`, `packages/core/src/settings/schema.ts:282`). I confirmed a local probe leaves `OPENAI_API_KEY`, `GITHUB_TOKEN`, and `authToken` unredacted.

Test gap: the tests cover only exact `apiKey` fields (`packages/tui/src/cli/commands/builtin/core-commands.test.ts:41`, `packages/tui/src/cli/commands/builtin/core-commands.test.ts:47`, `packages/tui/src/cli/commands/builtin/core-commands.test.ts:67`). They do not cover compound env/header names.

### 🟠 Desktop credential injection re-resolves with full credential scope

Commit: `a8158866 fix(core): scope browser credential injection`

The core tool now resolves credentials with the engine setting scope (`packages/core/src/credentials/inject-credential-tool.ts:113`, `packages/core/src/credentials/inject-credential-tool.ts:129`) and only sends the credential id to the host bridge (`packages/core/src/credentials/inject-credential-tool.ts:157`; request payload at `packages/core/src/protocol/server.ts:2104`). The desktop bridge then independently re-resolves that id with `new CredentialStore(sessionCwd).resolve(parsed.credentialId)` and no scope argument (`packages/desktop/src/main/agent-bridge.ts:435`, `packages/desktop/src/main/agent-bridge.ts:439`), which defaults to full user+project scope.

Exploit path: a project-scoped engine should never access host user credentials. If the project credential that passed the core check is removed or changed before the bridge lookup, or if an internal credential-action line is forged on the worker channel, the bridge can fall back to a same-id user-scope cookie and inject it. The boundary should carry the scope or the already-resolved credential material, not just an id that is re-looked-up under a broader scope.

Test gap: `packages/core/src/credentials/inject-credential-tool.test.ts` verifies the core tool rejects user credentials for project scope, but no desktop bridge test verifies that `maybeHandleCredentialAction` also resolves with project-only scope.

### 🟡 Markdown read allowlist can be escaped through listed symlinks

Commit: `90fb6c0f fix(desktop): restrict markdown reads to listed paths`

The guard canonicalizes with `realpathSync(path.resolve(filePath))` (`packages/desktop/src/main/safe-read.ts:15`) and then checks only that the canonical target has some `.code-shell` path segment and a `.md` suffix (`packages/desktop/src/main/safe-read.ts:17`, `packages/desktop/src/main/safe-read.ts:21`). `rememberCodeShellMarkdownPath` then allowlists that canonical target (`packages/desktop/src/main/safe-read.ts:27`).

Direct absolute paths, stale paths, and `..` traversal are blocked. The remaining escape is symlink-based: a project skill/agent path can be a symlink to another markdown file under an arbitrary `.code-shell` directory outside the active project/user roots. Listing follows the symlink, registers the target, and the subsequent read succeeds because the target is now allowlisted. I confirmed this with a local symlink probe.

Test gap: `packages/desktop/src/main/safe-read.test.ts:48` covers an unlisted absolute path and `packages/desktop/src/main/safe-read.test.ts:57` covers `..`, but there is no symlink test and no assertion that the real target is contained under the expected project/user/plugin roots.

### 🟡 Unsafe plugin transports are blocked on install but still allowed on update/check

Commit: `0d175ef0 fix(plugins): reject unsafe source transports by default`

The default parser rejects lower-case `http://`, `git://`, and `file://` (`packages/core/src/plugins/installer/parseSource.ts:44`, `packages/core/src/plugins/installer/parseSource.ts:68`). The TUI install command requires `--allow-unsafe-transport` for those schemes.

But installed metadata is parsed with `allowUnsafeTransport: true` during update and update checks:

- `packages/core/src/plugins/installer/update.ts:100`
- `packages/core/src/plugins/installer/checkUpdate.ts:28`

Exploit path: a plugin installed before this hardening, or a plugin whose `.cs-meta.json` is edited, can continue to update over `http://`, `git://`, or `file://` without a fresh user opt-in. For `http://`, this preserves the MITM-able supply-chain path the commit is trying to close. For `file://`, it preserves local clone semantics in update/check paths even though new installs reject it by default.

Test gap: `packages/core/src/plugins/installer/parseSource.test.ts:95` covers install parser rejection only. Existing update tests were changed to opt in to `file://`; there is no test asserting that unsafe metadata updates are blocked or require an explicit update flag.

## Security-Positive Checks

- `46d2e826` settings sanitizer: recursive `sanitizeSettingsValue` drops forbidden keys in arrays and objects (`packages/core/src/settings/manager.ts:82`, `packages/core/src/settings/manager.ts:91`), save paths sanitize loaded objects (`packages/core/src/settings/manager.ts:399`), config parsing sanitizes JSON/YAML (`packages/core/src/settings/manager.ts:579`), and merge skips forbidden keys at every merge level (`packages/core/src/settings/manager.ts:607`). I did not find a remaining `__proto__`/`constructor`/`prototype` nesting bypass.
- `be7a393b` CDP image fetch: `maxDim` is sanitized before it is interpolated into `Runtime.evaluate`; the test includes an injection-shaped value and asserts it is not present in the expression.
- `da84f435` CDP click: no-box clicks now fail stale instead of calling DOM `click()` through page JavaScript.
- `949cb6fb` release permissions: repo write permission is isolated to the release job and non-release checkout steps disable persisted credentials.
- `9aa19ecd` provider API key input masking: protects the interactive ProviderModelFlow display path, but it is not a general secret redaction boundary.
- `aa71492e` input history: skips `/login <arg>` entries before JSONL persistence (`packages/tui/src/ui/input-history.ts:192`, `packages/tui/src/ui/input-history.ts:214`). This is scoped to `/login`; it does not redact arbitrary secret-bearing prompts or non-login commands.

## Remaining Unguarded Shapes / Traversal Notes

- Secret-shaped key names not exactly equal to `apiKey`, `token`, etc. remain unredacted in `/config` output: `OPENAI_API_KEY`, `GITHUB_TOKEN`, `X-Api-Key`, `authToken`, `accessToken`, `refreshToken`, `clientSecret`.
- String values containing embedded secrets under benign keys are not scrubbed by the TUI config redactor. The desktop logger already has a stronger `redactSecrets` implementation with substring and token-pattern matching; `/config` does not reuse it.
- Markdown reads are safe against direct `..` and unlisted absolute paths, but not against a path that was listed through a symlink whose real target is outside the active roots and merely contains a `.code-shell` segment.
- Plugin source handling does not recognize `git+ssh://` as a remote source in `parseSource`; it is treated as a local path and will fail as a local install rather than being explicitly accepted or rejected. Lower-case `http://`, `git://`, and `file://` are rejected for fresh installs by default.
