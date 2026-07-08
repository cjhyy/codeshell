# Tests and Dependency Audit - 2026-07-08

Scope: read-only audit of test coverage and dependency/supply-chain posture. This intentionally does not re-list application-logic bugs already documented in `docs/todo/review-*.md`; master-file bugs are cited only as the regressions that missing tests would fail to shield.

No full test suite was run. No `bun audit` was run. The review covered `tests/`, `packages/*/src/**/*.test.ts`, root/package manifests, `bun.lock`, `.github/workflows/release.yml`, and selected source files needed to interpret coverage.

## Summary

- Stronger coverage: protocol ask/approval session isolation, chat-session concurrency/cancel isolation, POSIX safe-spawn/process-group cleanup, credential store scope partition at the store layer, markdown raw-HTML sanitization, and plugin archive zip-slip path rejection.
- Highest test-coverage gaps: async context cleanup in turn-loop/compaction, MCP manager lifecycle/abort/resource/image-spill behavior, plugin install trust and variable-rewrite paths, credential egress/scope/browser-partition routing, and prompt-injection wording around `<system-reminder>`.
- Highest dependency/supply-chain risks: desktop packaging resolves production dependencies outside the frozen lockfile, npm publishing lacks provenance/trusted publishing and is token-based, Electron is pinned to an old major, and direct `esbuild@0.24.2` is in the affected range for GHSA-67mh-4wv8-2f99.
- Intentional note: the root React override to `19.2.6` is present and intentional, so it is not treated as a finding (`package.json:39-41`, `package.json:88`, `packages/desktop/package.json:146-147`).

## Section A - Test-Coverage Gaps

### Coverage map

Solid or mostly solid areas:

- Protocol server session isolation: ask-user approvals are scoped by `sessionId` and `requestId`, with negative coverage for mismatched session/request pairs (`packages/core/src/protocol/server.askuser-session-isolation.test.ts:69-140`). Chat sessions also cover concurrent sessions and canceling one session without aborting another (`tests/chat-session-isolation.test.ts:60-130`).
- Safe-spawn and POSIX process-group cleanup: abort, timeout, grandchild stdout-pipe hang, and process-group kill coverage exists (`tests/safe-spawn.test.ts:77-132`; `packages/core/src/runtime/spawn-common.test.ts:213-266`). The implementation includes guardrails against bogus process group IDs (`packages/core/src/runtime/spawn-common.ts:317-335`, `packages/core/src/runtime/spawn-common.ts:386-390`).
- Credential store scope partition at the persistence layer: project scope hides host/user credentials in `list`, `resolve`, and `listMasked` (`packages/core/src/credentials/store.test.ts:55-70`).
- Markdown raw-HTML sanitization: the Electron renderer intentionally runs `rehypeRaw` immediately followed by `rehypeSanitize` with an explicit security comment (`packages/desktop/src/renderer/Markdown.tsx:66-98`, `packages/desktop/src/renderer/Markdown.tsx:170-184`) and tests script/event/iframe/style stripping (`packages/desktop/src/renderer/Markdown.test.tsx:66-90`).
- Plugin archive path traversal: archive install has direct `safeJoin` tests rejecting parent traversal and absolute-ish escapes (`packages/core/src/plugins/installer/installFromArchive.test.ts:127-139`).

Under-tested high-risk areas:

- Async context cleanup in production turn-loop compaction.
- MCP manager post-handshake failure cleanup, discovered-tool abort forwarding, resource owner metadata, and image-spill retention/home layout.
- Plugin install paths outside marketplace install, executable trust gates, and insecure direct transports.
- Credential plaintext egress, `InjectCredential` scope partition, and desktop browser partition/session ownership.
- Prompt-level steer/system-reminder spoofing.
- Session teardown for process-global approval/path/credential caches.

### A1. Turn-loop / compaction: async context cleanup is not regression-tested

- Subsystem: production turn-loop context management and compaction.
- What is untested: `ContextManager.manage()` runs `dedupeFileReads` and `maskOldObservations` before microcompaction (`packages/core/src/context/manager.ts:295-314`), but `manageAsync()` jumps from tool-result budgeting directly to microcompaction (`packages/core/src/context/manager.ts:406-430`). Existing tests cover the pure helper behavior for dedupe/masking and cover many turn-loop behaviors, but they do not assert that the async production path applies the always-on cleanup passes.
- Risk: a fix to async compaction could regress silently and reintroduce stale repeated file reads or old browser snapshots into the model context. This is especially risky because `manageAsync()` is the production path used between turns when LLM summarization is available.
- Master-file bug shielded: "Async context management skips always-on cleanup" (`docs/todo/review-master-2026-07-08.md:39`).
- Evidence: `tests/hooks-post-compact.test.ts` explicitly says full turn-loop wiring is pending coverage once integration lands (`tests/hooks-post-compact.test.ts:5-11`).
- Recommended regression tests: add a `ContextManager.manageAsync` test with duplicate `Read` results and multiple browser observations under the microcompact floor, and add a turn-loop-level test proving the async-managed messages sent to the next model call have old reads/snapshots masked.

### A2. MCP manager: lifecycle, abort, resources, and image retention are under-tested

- Subsystem: MCP manager, generic MCP tools, discovered MCP tools, and MCP image spills.
- What is untested:
  - Discovered tools registered by `discoverTools` call `client.callTool` without a test proving the executor receives and forwards the run abort signal (`packages/core/src/tool-system/mcp-manager.ts:517-522`). Existing tests only prove `stripInternalToolArgs` removes `__signal` from argument payloads (`packages/core/src/tool-system/mcp-manager.test.ts:192-202`).
  - A connection is stored before `discoverTools` completes (`packages/core/src/tool-system/mcp-manager.ts:495-498`), but tests cover connect coalescing/reconcile rather than discovery-failure cleanup (`packages/core/src/tool-system/mcp-manager.test.ts:86-159`).
  - `ListMcpResources` gating expects resource owner metadata (`serverName` or `server`) and drops unknown-owner resources (`packages/core/src/tool-system/builtin/mcp-tools.ts:67-90`). Existing gate coverage only asserts that the allowlist set is injected, not that real resources are tagged and survive filtering (`packages/core/src/tool-system/mcp-manager.test.ts:514-520`).
  - `spillMcpImage` caps one image by size but has no retained-file cap and uses `CODE_SHELL_HOME` as a parent of `.code-shell` (`packages/core/src/tool-system/mcp-manager.ts:168-204`). Tests cover write, extension, filename sanitization, and oversized single images, but not retention or shared home layout (`tests/mcp-image-spill.test.ts:19-74`).
- Risk: Stop can hang on direct discovered MCP tools, failed discovery can leave stale connections/tools that block reconnect, allowed sessions can see no resources because owner metadata is missing, and repeated MCP screenshots can fill disk silently.
- Master-file bugs shielded: discovered MCP tools drop abort signal, failed MCP discovery leaves half-connected server, `ListMcpResources` filters out allowed resources, MCP image spills have no retained-file cap, and MCP image spills ignore `CODE_SHELL_HOME` layout (`docs/todo/review-master-2026-07-08.md:36-40`, `docs/todo/review-master-2026-07-08.md:62`).
- Recommended regression tests: fake MCP client whose `callTool` observes an abort signal; fake client whose `listTools` rejects and then assert maps/registrations are cleaned; multi-server `listResources` test asserting `serverName` is attached; spill retention/home-layout tests using `CODE_SHELL_HOME`.

### A3. Plugin install and executable trust: composed install paths are under-tested

- Subsystem: plugin installer, plugin command hooks, remote source parsing, and plugin MCP/hook executable surfaces.
- What is untested:
  - `rewritePluginVars` is tested as a standalone helper (`tests/plugin-var-rewrite.test.ts:17-70`), but install tests for local dirs, zips, direct installs, and Codex conversion assert copied files/metadata only (`packages/core/src/plugins/installer/install.test.ts:24-101`; `packages/core/src/plugins/installer/installFromArchive.test.ts:31-120`). The materialized install path does not call the rewrite helper before registration (`packages/core/src/plugins/installer/install.ts:45-90`).
  - Plugin command hooks run `spawn(spec.command, [], { shell: true })` with plugin environment variables but no explicit trust gate (`packages/core/src/plugins/pluginCommandHook.ts:91-115`). There is no test suite asserting remote/local plugin executable code remains disabled until trusted.
  - Direct plugin source parsing accepts `http://`, `git://`, and `file://` as remote installs (`packages/core/src/plugins/installer/parseSource.ts:28-36`). Existing parser tests cover paths, GitHub shorthand, HTTPS, and SSH, but not rejecting or warning on insecure transports (`packages/core/src/plugins/installer/parseSource.test.ts:18-93`).
- Risk: fixes to marketplace-only variable rewriting, per-plugin trust, or transport policy can regress silently on local/zip/direct-git paths. This is a supply-chain boundary because installed plugins can provide shell hooks and MCP stdio commands.
- Master-file bugs shielded: plugin executable surfaces lack trust gate, local/zip/direct-git plugin installs skip var rewrite, and insecure plugin transports are allowed silently (`docs/todo/review-master-2026-07-08.md:34`, `docs/todo/review-master-2026-07-08.md:59`, `docs/todo/review-master-2026-07-08.md:75`).
- Recommended regression tests: parameterized install tests for local dir, zip, and direct git/cache paths containing `CLAUDE_PLUGIN_ROOT`; hook/MCP load tests requiring an explicit trust flag; parse-source policy tests rejecting cleartext transports unless an unsafe option is passed.

### A4. Credentials: plaintext egress, scope partition, and browser ownership are under-tested

- Subsystem: credential tools, credential partitioning, and desktop browser cookie injection.
- What is untested:
  - The current `UseCredential` unit test pins the insecure behavior by expecting `{ kind: "value", value: "tok-123" }` after approval (`packages/core/src/credentials/use-credential-tool.test.ts:55-58`), matching the plaintext return in implementation (`packages/core/src/credentials/use-credential-tool.ts:191-194`). There is no transcript/log/UI regression asserting approved secrets are redacted or represented as non-persisted handles.
  - Store-level scope partition is covered (`packages/core/src/credentials/store.test.ts:55-70`), but `InjectCredential` reads full-scope settings and resolves without scope (`packages/core/src/credentials/inject-credential-tool.ts:81-88`, `packages/core/src/credentials/inject-credential-tool.ts:118-123`). Injection tests cover prompt/denial/auto-inject/availability, not `settingsScope: "project"` behavior (`packages/core/src/credentials/inject-credential-tool.test.ts:115-178`).
  - Browser automation targets a process-global active guest (`packages/desktop/src/main/browser-driver/active-guest.ts:13-36`). Credential cookie capture/restore tests cover explicit Electron partitions, but no test proves AI injection/browser automation routes by originating session/bucket/partition.
- Risk: secret-redaction fixes can regress at the transcript boundary, project-isolated SDK embeddings can regain access to host credentials through injection, and one session can inject cookies or drive automation into another session's active webview.
- Master-file bugs shielded: credential values persisted as tool output, `InjectCredential` ignores settings scope, browser automation targets global active guest, and desktop credentials remain plaintext at rest (`docs/todo/review-master-2026-07-08.md:31`, `docs/todo/review-master-2026-07-08.md:35`, `docs/todo/review-master-2026-07-08.md:41`, `docs/todo/review-master-2026-07-08.md:44`).
- Recommended regression tests: end-to-end tool-result transcript redaction; `InjectCredential` project-scope list/resolve/auto-approve denial; multi-session webview ownership tests where a background session cannot target the foreground session's partition.

### A5. Protocol server session isolation is strong, but teardown/global-cache cleanup is not covered

- Subsystem: protocol server sessions, approvals, path policies, and per-session credential grants.
- What is covered: ask-user approvals are scoped to matching session/request and leave the legacy server-level approval map empty (`packages/core/src/protocol/server.askuser-session-isolation.test.ts:103-129`). Chat sessions cover concurrent starts and cancel isolation (`tests/chat-session-isolation.test.ts:60-130`).
- What is untested: process-global approval/path/credential allow maps are not exercised through session close/teardown. The strong protocol tests do not prove grants are pruned when a session ends.
- Risk: stale approval grants can survive after a session is closed and affect a later session, even though request routing itself is isolated.
- Master-file bug shielded: session approval caches are not pruned (`docs/todo/review-master-2026-07-08.md:63`).
- Recommended regression tests: close a protocol session after granting a path/tool/credential permission, then create a new session and assert no grant is inherited.

### A6. Safe-spawn/process-group cleanup is covered, but host-sensitive tests reduce confidence

- Subsystem: safe-spawn, background shell process groups, and Windows kill shims.
- What is covered: abort/timeout/grandchild hang tests exist (`tests/safe-spawn.test.ts:77-132`); POSIX process-group kill covers child reaping, idempotence, and bogus pgid guards (`packages/core/src/runtime/spawn-common.test.ts:213-266`); Windows branches are simulated to prove no negative-pid signaling (`packages/core/src/runtime/kill-win32.test.ts:1-48`).
- What is untested: the background-shell home resolver has the same nested `CODE_SHELL_HOME/.code-shell` layout pattern (`packages/core/src/runtime/background-shell.ts:139-142`) but no home-layout regression test equivalent to the missing MCP spill home-layout test.
- Risk: process-tree cleanup itself has reasonable coverage, but path/home artifacts for background shells can keep regressing without detection.
- Master-file bug shielded: background shell artifacts use nested home (`docs/todo/review-master-2026-07-08.md:64`).
- Recommended regression tests: add a `CODE_SHELL_HOME` fixture test for background shell log/pid root and keep existing process-group tests targeted rather than broadening them into slow integration coverage.

### A7. Steer/system-reminder injection: mechanics are covered, prompt spoofing is not

- Subsystem: steer queue, turn-loop steer backfill, transcript injection markers, and base prompt safety wording.
- What is covered: steer queued during a tool batch is consumed before the next model call without splitting tool adjacency (`packages/core/src/engine/turn-loop-steer-backfill.test.ts:107-170`), with additional tests in the same file for shutdown, max-turn accounting, and duplicate client IDs.
- What is untested: the base prompt tells the model that tool results and user messages may include `<system-reminder>` and that tags contain system information (`packages/core/src/prompt/sections/base.md:7-11`). There is no prompt-composition or adversarial content regression proving embedded untrusted tags are distinguished from runtime-injected reminders.
- Risk: a wording fix can regress silently, and tool/user content that contains fake `<system-reminder>` tags may be over-trusted by the model.
- Master-file bug shielded: `<system-reminder>` wording is spoofable (`docs/todo/review-master-2026-07-08.md:60`).
- Recommended regression tests: add prompt snapshot tests with untrusted user/tool content containing `<system-reminder>` and assert the system prompt names runtime-injected reminders as a separate, authenticated channel.

### Test-quality issues

These are not application bugs; they are tests whose design is host- or timing-sensitive.

- Git Bash / Windows shell discovery is simulated by mutating `process.platform` and neutralizing host discovery paths (`packages/core/src/runtime/shell-invocation.test.ts:7-18`, `packages/core/src/runtime/shell-invocation.test.ts:76-124`). This is useful coverage, but it is not equivalent to a real Windows runner with real Git Bash/PowerShell discovery.
- Windows kill behavior is simulated on non-Windows by redefining `process.platform`; the test explicitly depends on `taskkill` being absent and exercises the spawn error path (`packages/core/src/runtime/kill-win32.test.ts:4-7`, `packages/core/src/runtime/kill-win32.test.ts:42-47`).
- Safe-spawn tests invoke real `sleep`, use wall-clock thresholds, and depend on host PATH/process scheduling (`tests/safe-spawn.test.ts:77-132`). They are valuable but can be slow/flaky under load.
- POSIX process-group tests spawn `/bin/sh` or discover `sh` through MSYS tools on Windows (`packages/core/src/runtime/spawn-common.test.ts:15-23`, `packages/core/src/runtime/spawn-common.test.ts:213-241`), then use short sleeps to wait for process-group state (`packages/core/src/runtime/spawn-common.test.ts:224-233`).
- Sandbox integration coverage is deliberately platform- and host-state-dependent: `seatbelt` integration runs only on macOS, `bwrap` assertions skip when unavailable, and sandbox startup uses a 4s timeout (`tests/sandbox.test.ts:4-13`, `tests/sandbox.test.ts:112-183`, `tests/sandbox.test.ts:194-197`).

## Section B - Dependency / Supply-Chain

### High severity

#### B1. Desktop `predist` resolves production dependencies outside the frozen lockfile

- Dependency/path: `packages/desktop/scripts/predist.ts` materializes `@cjhyy/code-shell-core` and then runs a fresh production install.
- Concern: release CI installs the workspace with `bun install --frozen-lockfile` (`.github/workflows/release.yml:90-95`), but the predist step writes a minimal package manifest and runs `bun install --production --linker=hoisted` inside the materialized core directory (`packages/desktop/scripts/predist.ts:120-139`). That second install is not shown using the committed root `bun.lock`, frozen mode, offline mode, or a precomputed production closure.
- Risk: the packaged Electron app can ship dependencies resolved at packaging time rather than the audited lockfile graph.
- Master-file context: "Electron predist resolves deps outside lockfile" (`docs/todo/review-master-2026-07-08.md:33`).
- Fix: materialize the core runtime closure from the root frozen lockfile, or run a lockfile-controlled production install with the committed lock present and `--frozen-lockfile`/offline constraints. Add CI verification that the packaged app dependency tree matches the lockfile-derived SBOM.

#### B2. npm publish lacks provenance/trusted publishing and uses a long-lived token

- Dependency/path: `.github/workflows/release.yml` `npm-publish` job.
- Concern: the job has no `needs: verify-version`, installs/builds, and publishes with `NPM_CONFIG_TOKEN` from `secrets.NPM_TOKEN` (`.github/workflows/release.yml:190-237`). It does not request `id-token: write`, does not use npm trusted publishing, and does not pass a provenance-producing publish flow.
- Risk: consumers get no registry provenance attestation tying packages to the GitHub workflow, and a long-lived npm token is exposed to the whole publish step environment. The workflow-level `contents: write` permission also applies broadly (`.github/workflows/release.yml:22-24`), matching the existing infra review concern.
- Master-file context: npm publish not gated by version check and release jobs inherit `contents: write` (`docs/todo/review-master-2026-07-08.md:32`, `docs/todo/review-master-2026-07-08.md:57`).
- Fix: make `npm-publish` depend on version verification for tag pushes, verify every publishable package version, move permissions to job scope, add `id-token: write`, use npm trusted publishing or `npm publish --provenance` after building with Bun, and remove/restrict the long-lived npm automation token.
- External references: npm provenance docs explain provenance statements identify where and how a package was built (https://docs.npmjs.com/generating-provenance-statements/). npm trusted publishers use OIDC and avoid long-lived tokens (https://docs.npmjs.com/trusted-publishers/).

#### B3. Electron major is old for a security-sensitive desktop app

- Dependency: `electron`.
- Concern: desktop declares `electron: ^33.0.0` (`packages/desktop/package.json:138`), and the lockfile currently resolves `electron@33.4.11` (`bun.lock:860`). Electron bundles Chromium and Node, so stale Electron majors carry browser/Node security exposure in the shipped app.
- Risk: an Electron app with browser automation, credential injection, markdown rendering, local files, PTY, and auto-update surfaces has a large attack surface if Chromium/Node security fixes are missed.
- Fix: upgrade to a currently supported Electron major, pin the exact major/minor used for release builds, and keep a regular Electron upgrade cadence with node-pty rebuild validation. Recheck native-module rebuild paths after the upgrade.
- External reference: Electron documents that supported versions are the latest three stable major versions and security fixes are backported only to the latest three stable series (https://www.electronjs.org/docs/latest/tutorial/electron-timelines).

#### B4. Direct `esbuild@0.24.2` is in a known advisory range

- Dependency: `esbuild`.
- Concern: desktop build scripts call the direct `esbuild` binary for main/preload bundling (`packages/desktop/package.json:13-14`) and declare `esbuild: ^0.24.0` (`packages/desktop/package.json:141`). The lockfile resolves direct `esbuild@0.24.2` (`bun.lock:902`).
- Risk: GHSA-67mh-4wv8-2f99 affects `esbuild <= 0.24.2`; the advisory describes a development-server CORS issue that can let any website read from the dev server. This is mostly dev/build-time rather than shipped-runtime risk, but Electron development commonly runs local servers and source-bearing dev endpoints.
- Fix: bump the direct `esbuild` dependency to at least `0.25.0` and preferably the same current family used transitively by Vite. Keep dev servers bound to localhost and avoid exposing Vite/esbuild endpoints to the LAN.
- External reference: GitHub Advisory Database GHSA-67mh-4wv8-2f99 lists affected versions as `<= 0.24.2` and patched version `0.25.0` (https://github.com/advisories/GHSA-67mh-4wv8-2f99).

### Medium severity

#### B5. Security-sensitive runtime dependencies use broad ranges

- Dependencies: core SDKs/parsers and desktop runtime/build dependencies.
- Concern: core runtime dependencies use caret ranges for model/network/IPC/archive/schema packages including `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `openai`, `yaml`, `yauzl`, and `zod` (`packages/core/package.json:29-43`). Desktop uses caret ranges for Electron/electron-builder/electron-updater/node-pty/ws and markdown/HTML tooling (`packages/desktop/package.json:109-158`). The root lockfile pins the current install, but B1 means packaging can resolve outside the committed root lockfile.
- Risk: normal caret ranges are acceptable with a strict lockfile, but they are risky when release packaging performs an extra production install. A semver-compatible transitive change can enter the packaged app without code review of the root lockfile.
- Fix: make the release package closure strictly lockfile-derived. For externally reachable/runtime packages, consider exact pins plus scheduled update PRs, or require CI to prove all release packaging installs use `--frozen-lockfile`.

#### B6. `node-pty` is a native runtime module shipped in the Electron app

- Dependency: `node-pty`.
- Concern: desktop ships only `node_modules/node-pty/**/*` from node_modules (`packages/desktop/package.json:36-44`), declares `node-pty: ^1.1.0` (`packages/desktop/package.json:109-112`), and rebuilds it in `postinstall` (`packages/desktop/package.json:9-10`). The rebuild script invokes `bunx --bun @electron/rebuild ... node-pty` (`packages/desktop/scripts/rebuild-native.ts:108-122`), and the lockfile resolves `node-pty@1.1.0` (`bun.lock:1410`).
- Risk: native addons are high-impact supply-chain surface for an Electron app because they execute native code and are loaded at runtime. The rebuild script intentionally does not fail install on rebuild failure, which is operationally convenient but can hide broken native state.
- Fix: pin exact `node-pty`, keep rebuild tooling locked, generate/check an SBOM for shipped native artifacts, and fail release packaging if the expected Electron-ABI native binary is absent or wrong-arch.

#### B7. MCP SDK is a broad process/network surface

- Dependency: `@modelcontextprotocol/sdk`.
- Concern: core and desktop declare `@modelcontextprotocol/sdk: ^1.12.1` (`packages/core/package.json:31`, `packages/desktop/package.json:115`), while the lockfile resolves `@modelcontextprotocol/sdk@1.29.0` (`bun.lock:326`). MCP can start stdio servers, connect over network transports, and relay tool/resource output into the model.
- Risk: this is less about a specific CVE and more about blast radius: untrusted plugin MCP entries can introduce new executable/network surfaces at session startup if trust gating is weak.
- Fix: exact-pin the SDK for releases, keep MCP transports default-off unless trusted by plugin/session, and pair dependency updates with the MCP regression tests listed in A2.

#### B8. Archive extraction is security-sensitive beyond zip-slip

- Dependency: `yauzl`.
- Concern: core declares `yauzl: ^3.4.0` for plugin/archive installs (`packages/core/package.json:41`), and the lockfile resolves `yauzl@3.4.0` (`bun.lock:1846`). Existing tests cover path traversal through `safeJoin` (`packages/core/src/plugins/installer/installFromArchive.test.ts:127-139`) but not archive bomb behavior.
- Risk: malicious plugin archives can stress disk/CPU with high file counts, large uncompressed size, or compression ratio even when path traversal is blocked.
- Fix: cap total extracted bytes, file count, per-file size, and compression ratio before registration. Add tests for over-limit archives.

#### B9. Raw HTML markdown rendering is a maintained security boundary

- Dependencies: `react-markdown`, `rehype-raw`, `rehype-sanitize`.
- Concern: desktop declares raw HTML markdown tooling (`packages/desktop/package.json:148-151`), with lockfile entries for `react-markdown@9.1.0`, `rehype-raw@7.0.0`, and `rehype-sanitize@6.0.0` (`bun.lock:1536-1560`). Current usage is correctly ordered as raw -> sanitize -> highlight and has XSS guard tests (`packages/desktop/src/renderer/Markdown.tsx:172-184`; `packages/desktop/src/renderer/Markdown.test.tsx:66-90`).
- Risk: this is a high-value security boundary in an Electron renderer because assistant/tool output can include untrusted markdown/HTML. The current tests are good; the risk is future dependency or pipeline changes.
- Fix: keep the sanitization tests required in CI, avoid custom `urlTransform` changes without tests, and update these packages together with explicit security review.

#### B10. Direct plugin source parsing accepts insecure transports

- Dependency/path: plugin installer source parser.
- Concern: `parseSource` treats `http://`, `git://`, and `file://` as remote sources (`packages/core/src/plugins/installer/parseSource.ts:28-36`). Existing parser tests do not enforce policy rejection/warning for cleartext or local-file transports (`packages/core/src/plugins/installer/parseSource.test.ts:18-93`).
- Risk: plugin install is a supply-chain ingestion point; cleartext Git/HTTP and arbitrary file URLs weaken provenance and replay resistance.
- Master-file context: insecure plugin transports allowed silently (`docs/todo/review-master-2026-07-08.md:75`).
- Fix: default to HTTPS/SSH, require an explicit unsafe flag for `http://`, `git://`, and `file://`, and prefer pinned immutable refs or commit SHAs.

#### B11. `bun.lock` workspace metadata is stale relative to manifests

- Dependency/path: lockfile/package version metadata.
- Concern: manifests report `0.6.0-rc.14` for root and packages (`package.json:3`, `packages/core/package.json:3`, `packages/desktop/package.json:3`, `packages/tui/package.json:3`, `packages/cdp/package.json:3`), but `bun.lock` still lists workspace entries as `0.6.0-rc.12` (`bun.lock:28-60`).
- Risk: this undermines release reproducibility checks and makes it easier for version-gating/publish steps to reason over inconsistent metadata.
- Fix: refresh the lockfile in a dedicated change with frozen install verification, and add CI that checks root/package manifests and lockfile workspace metadata agree before publish.

### Low severity / notes

- Root `preinstall` only runs `node scripts/check-node.cjs` (`package.json:18`), and the script only checks Node version and exits with help text (`scripts/check-node.cjs:1-21`). No network or file mutation was observed.
- `packages/cdp` has zero runtime dependencies by design (`packages/cdp/package.json:1-40`).
- TUI has a broad UI/rendering dependency set (`packages/tui/package.json:27-53`), but no security-sensitive install scripts were found in its manifest. `marked`/`marked-terminal` are markdown/terminal-rendering surface and should remain covered by renderer/TUI escaping tests.
- The React override to `19.2.6` is intentional and is not a bug (`package.json:39-41`).

## Verification notes

- Read repository instructions: `AGENTS.md` points to `CODESHELL.md`, and `CODESHELL.md` was read before auditing.
- Read the master bug index: `docs/todo/review-master-2026-07-08.md:30-76`.
- Surveyed tests under `tests/` and `packages/*/src/**/*.test.ts` using `rg` and targeted file reads. No full test suite was run.
- Inspected manifests: `package.json`, `packages/core/package.json`, `packages/tui/package.json`, `packages/desktop/package.json`, and `packages/cdp/package.json`.
- Inspected release and packaging flow: `.github/workflows/release.yml`, `packages/desktop/scripts/predist.ts`, `packages/desktop/scripts/rebuild-native.ts`, and relevant lockfile entries in `bun.lock`.
- Did not run `bun audit`, because this pass was requested as read-only and audit tooling can be lockfile-sensitive.
- External references consulted for dependency/security interpretation:
  - Electron support policy: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
  - esbuild advisory GHSA-67mh-4wv8-2f99: https://github.com/advisories/GHSA-67mh-4wv8-2f99
  - npm provenance: https://docs.npmjs.com/generating-provenance-statements/
  - npm trusted publishers: https://docs.npmjs.com/trusted-publishers/
