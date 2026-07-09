# CodeShell Review Master - 2026-07-08

Verification pass over:

- `docs/archive/todo/review-core-2026-07-08.md`
- `docs/archive/todo/review-desktop-2026-07-08.md`
- `docs/archive/todo/review-tui-cdp-2026-07-08.md`
- `docs/archive/todo/review-infra-2026-07-08.md`

## Summary

| Metric | Count |
| --- | ---: |
| Total findings reviewed | 50 |
| CONFIRMED-LIVE | 47 |
| ALREADY-FIXED | 0 |
| FALSE-POSITIVE / BY-DESIGN | 1 |
| NEEDS-DEEPER-VERIFICATION | 2 |

| Severity among CONFIRMED-LIVE | Count |
| --- | ---: |
| 🔴 Critical | 5 |
| 🟠 Major | 28 |
| 🟡 Minor | 14 |

## CONFIRMED-LIVE - Actionable

| Sev | Finding | Current file:line | Problem | One-line fix | Source review |
| --- | --- | --- | --- | --- | --- |
| 🔴 | Project settings `__proto__` smuggling | `packages/core/src/settings/manager.ts:595` | Raw parsed config is merged into normal objects, so nested `__proto__` can mutate prototypes and bypass untrusted-project stripping. | Recursively reject `__proto__`/`prototype`/`constructor`, use safe merge targets, and test untrusted project settings. | `review-core-2026-07-08.md` |
| 🔴 | Credential values persisted as tool output | `packages/core/src/credentials/use-credential-tool.ts:194` | Approved token/link secrets are returned as plaintext JSON and then written to transcript/log/prompt history. | Return a redacted handle/lease or mark sensitive results so transcripts, logs, UI streams, and future prompts redact them. | `review-core-2026-07-08.md` |
| 🔴 | npm publish not gated by version check | `.github/workflows/release.yml:190` | `npm-publish` has no `needs: verify-version`, and the guard checks only root `package.json`. | Make npm publish depend on version verification and check all release-participating package versions. | `review-infra-2026-07-08.md` |
| 🔴 | Electron predist resolves deps outside lockfile | `packages/desktop/scripts/predist.ts:136` | Packaging runs a fresh `bun install --production` in a materialized package without the committed lockfile. | Materialize from the locked root dependency graph or run a frozen/offline lockfile-controlled production install. | `review-infra-2026-07-08.md` |
| 🔴 | Plugin executable surfaces lack trust gate | `packages/core/src/plugins/pluginCommandHook.ts:108` | Installed plugin hooks run with `shell: true`, and plugin MCP stdio servers are merged/spawned at session start without a separate executable-code trust boundary. | Require explicit per-plugin trust/enablement for hooks and MCP commands, with manifest diff and default-off remote executable surfaces. | `review-infra-2026-07-08.md` |
| 🟠 | `InjectCredential` ignores settings scope | `packages/core/src/credentials/inject-credential-tool.ts:81` | Browser credential injection still reads full-scope auto-approve/list/resolve paths, unlike `UseCredential`. | Thread `settingsScope` through injection availability, dynamic descriptions, auto-approve, and credential resolution. | `review-core-2026-07-08.md` |
| 🟠 | Discovered MCP tools drop abort signal | `packages/core/src/tool-system/mcp-manager.ts:518` | Directly registered MCP tool executors call `client.callTool` without forwarding `ctx.signal`. | Register executors as `(args, ctx)` and pass SDK request options with `ctx?.signal`. | `review-core-2026-07-08.md` |
| 🟠 | Failed MCP discovery leaves half-connected server | `packages/core/src/tool-system/mcp-manager.ts:495` | `connections` is committed before `discoverTools`; a discovery failure leaves stale connections/tools and blocks reconnect. | Cleanup client/transport, registrations, and connection map on post-handshake discovery failure. | `review-core-2026-07-08.md` |
| 🟠 | `ListMcpResources` filters out allowed resources | `packages/core/src/tool-system/builtin/mcp-tools.ts:83` | Session allowlist filtering expects `serverName`, but `MCPManager.listResources` returns resources without owner metadata. | Attach `serverName` in `listResources` and keep allowlist filtering. | `review-core-2026-07-08.md` |
| 🟠 | Async context management skips always-on cleanup | `packages/core/src/context/manager.ts:419` | Production `manageAsync()` skips `dedupeFileReads` and `maskOldObservations`, unlike sync `manage()`. | Run both cleanup passes in `manageAsync()` before microcompaction. | `review-core-2026-07-08.md` |
| 🟠 | MCP image spills have no retained-file cap | `packages/core/src/tool-system/mcp-manager.ts:191` | The code caps individual images but never garbage-collects accumulated `mcp_images`. | Enforce max count/bytes per `(server, tool)` or session and delete oldest spills. | `review-core-2026-07-08.md` |
| 🟠 | Browser automation targets global active guest | `packages/desktop/src/main/browser-driver/active-guest.ts:13` | Automation and AI cookie injection select the last active webview, not the originating session. | Track guest ownership by session/bucket/partition and route actions/injection by `parsed.sessionId`. | `review-desktop-2026-07-08.md` |
| 🟠 | Browser open/reload events broadcast to all panels | `packages/desktop/src/renderer/browser/useBrowserTabs.ts:280` | Every mounted browser panel handles global `browser:open-tab` and `browser:reload` messages. | Scope IPC payloads by guest/panel/bucket/partition and have only the matching panel react. | `review-desktop-2026-07-08.md` |
| 🟠 | Desktop sensitive-action approval is inert | `packages/desktop/src/main/browser-driver/policy.ts:75` | The policy defines sensitive words but `isSensitiveAction` only catches typed card-shaped secrets, and bridge approval always returns true. | Implement main-to-renderer approval using page element metadata for click/select/press/type sensitive actions. | `review-desktop-2026-07-08.md` |
| 🟠 | Desktop credentials remain plaintext at rest | `packages/desktop/src/main/index.ts:1443` | SafeStorage encryption is intentionally not installed yet, so saved credentials and cookie jars persist under plaintext cipher. | Wire a versioned safe-storage cipher across main/worker and migrate plaintext entries on read/write. | `review-desktop-2026-07-08.md` |
| 🟠 | Ctrl+C cancellation bypassed by renderer exit | `packages/tui/src/ui/index.tsx:82` | REPL render still uses `exitOnCtrlC: true`, while child input handlers are suppressed for Ctrl+C. | Start with `exitOnCtrlC: false` and let TUI `App` own cancel-vs-exit semantics. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | `/login <api-key>` persists secret history | `packages/tui/src/ui/components/CommandInput.tsx:171` | Submitted slash command text is added to persistent input history before `/login` parses its API key argument. | Remove inline secret args or mark/redact sensitive command submissions before history write. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Provider API key input is plain text | `packages/tui/src/ui/components/ProviderModelFlow.tsx:695` | The onboarding/provider flow renders API key entry with normal `TextInput` and visible `apiKey`. | Add a masked/secret input component and show only sanitized previews after submit. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | `/config show/get` can print secrets | `packages/tui/src/cli/commands/builtin/core-commands.ts:709` | Config display paths dump raw settings values, including legacy/provider credential fields. | Apply recursive secret redaction and require an explicit unsafe debug flag for raw output. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Async slash command failures are unhandled | `packages/tui/src/ui/App.tsx:1591` | `commandRegistry.dispatch` is not awaited/caught, so rejected async commands can become unhandled promise rejections. | `await Promise.resolve(dispatch(...)).catch(...)` and render a status/error entry. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Background-agent notifications can be dropped | `packages/tui/src/ui/App.tsx:1441` | Notification queue is drained before `submitToEngine`, which may immediately return if the query guard is busy. | Reserve before draining or make submit return accepted/rejected and requeue on rejection. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Sub-agent thinking mixes into main spinner | `packages/tui/src/ui/App.tsx:576` | `thinking_delta` appends to the global thinking buffer without an `agentId` guard. | Drop or route child-agent thinking like `text_delta` does. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | CDP `clickNode` falls back to JS `.click()` | `packages/cdp/src/driver.ts:130` | No-box click paths execute synthetic `this.click()`, bypassing real input semantics. | Fail by default for no layout/visible point, or gate JS click behind an explicit unsafe option. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | CDP click target can be outside viewport | `packages/cdp/src/driver.ts:119` | Click coordinates use the full element quad center with no viewport intersection/clamping. | Choose an inset point inside the visible viewport intersection or fail when none exists. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | CDP `fetchImageData` interpolates `maxDim` | `packages/cdp/src/driver.ts:295` | Runtime `maxDim` is embedded directly into evaluated page JavaScript. | Sanitize `maxDim` with `positiveFinite` before interpolation or pass all args via serialized arguments/callFunctionOn. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | CDP video refs are not returned | `packages/cdp/src/driver.ts:646` | Videos are tagged as `vidN`, but returned `CdpVideo` entries contain only `url`. | Add `ref` to `CdpVideo` and include the assigned video ref in extracted results. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Missing image/video refs are not stale | `packages/cdp/src/driver.ts:302` | Missing `fetchImageData` refs return an error detail without `staleRef: true`. | Include `staleRef: true` for missing/vanished extract refs. | `review-tui-cdp-2026-07-08.md` |
| 🟠 | Release jobs inherit `contents: write` | `.github/workflows/release.yml:22` | Workflow-wide write permission and default checkout credentials apply to install/build/publish jobs. | Move permissions to job scope and set `persist-credentials: false` where release writing is not needed. | `review-infra-2026-07-08.md` |
| 🟠 | CI does not run lint; guardrails are bypassable | `.github/workflows/ci.yml:16` | The guard job only runs engine-bypass, and ESLint import guards miss dynamic imports/relative path resolution. | Add `bun run lint` to CI and use import rules that handle `ImportExpression` plus resolved paths. | `review-infra-2026-07-08.md` |
| 🟠 | Local/zip/direct-git plugin installs skip var rewrite | `packages/core/src/plugins/installer/install.ts:45` | Only marketplace install calls `rewritePluginVars`; other install paths can leave `CLAUDE_PLUGIN_ROOT` references broken. | Call `rewritePluginVars` for every materialized install path before registering metadata. | `review-infra-2026-07-08.md` |
| 🟠 | `<system-reminder>` wording is spoofable | `packages/core/src/prompt/sections/base.md:10` | Base prompt says user/tool content may include tags and that tags contain system information. | Distinguish runtime-injected reminders from tags embedded inside untrusted content/tool output. | `review-infra-2026-07-08.md` |
| 🟠 | `AddMarketplace` registered but unavailable in presets | `packages/core/src/preset/index.ts:34` | Tool is in `BUILTIN_TOOLS`, but absent from builtin preset whitelists, so normal sessions cannot see it. | Add it to intended preset whitelist with `permissionDefault: ask`, or remove/document it as UI/CLI-only. | `review-infra-2026-07-08.md` |
| 🟠 | MCP image spills ignore `CODE_SHELL_HOME` layout | `packages/core/src/tool-system/mcp-manager.ts:168` | `CODE_SHELL_HOME=/tmp/csh` spills to `/tmp/csh/.code-shell/mcp_images`, unlike sessions/memory. | Use a shared `codeShellHome()` helper and spill under `join(codeShellHome(), "mcp_images")`. | `review-core-2026-07-08.md` |
| 🟡 | Session approval caches are not pruned | `packages/core/src/tool-system/path-policy.ts:174` | Session path grants, ask chains, and credential allow maps are process-global and not cleared on session close. | Add per-session cleanup APIs and call them from session teardown; delete ask chains in `finally`. | `review-core-2026-07-08.md` |
| 🟡 | Background shell artifacts use nested home | `packages/core/src/runtime/background-shell.ts:139` | `CODE_SHELL_HOME` is treated as a parent of `.code-shell` for background shell logs/pidfiles. | Make `bgShellsRoot()` use the same final CodeShell home resolver as sessions/memory. | `review-core-2026-07-08.md` |
| 🟡 | PTY write/resize/kill lack sender ownership check | `packages/desktop/src/main/index.ts:2816` | `pty:start` records `WebContents`, but write/resize/kill handlers operate by session id only. | Pass `e.sender` through and require it to match the stored owner before acting. | `review-desktop-2026-07-08.md` |
| 🟡 | Skill/agent markdown reads are root-unsafe | `packages/desktop/src/main/safe-read.ts:13` | Renderer-supplied paths need only contain a `.code-shell` segment and `.md` suffix; no realpath/root allowlist. | Read by opaque listed id or validate canonical targets under allowed user/project/plugin roots. | `review-desktop-2026-07-08.md` |
| 🟡 | Browser popout anchors mutate active bucket | `packages/desktop/src/renderer/App.tsx:2917` | Popout anchor add/remove/update events carry no origin bucket and use `activeAnchorBucketRef.current`. | Store and forward source bucket/session with popout metadata and mutate that bucket. | `review-desktop-2026-07-08.md` |
| 🟡 | Replayed sub-agent timestamps use replay time | `packages/desktop/src/renderer/types.ts:702` | `agent_start`/`agent_end` still call `Date.now()` despite replay clock support. | Use reducer `now()` for sub-agent start/end timestamps and add foldTranscript regression coverage. | `review-desktop-2026-07-08.md` |
| 🟡 | Markdown render cache ignores width | `packages/tui/src/ui/components/MessageContent.tsx:23` | Render cache keys only by markdown text, and `marked-terminal` width is captured once. | Include effective width in cache key and recreate/parameterize marked renderer on resize. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | New-message pill/divider has no scroll-away source | `packages/tui/src/ui/components/FullscreenLayout.tsx:170` | `useUnseenDivider().onScrollAway` exists but is not wired from `VirtualMessageList`/`ScrollBox`. | Expose sticky/scroll-away changes and call `onScrollAway`; keep jump-to-bottom clearing. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | Compact tool-result flag is not rendered | `packages/tui/src/ui/App.tsx:2101` | Tool-result entries set `compact`, but `renderEntry` does not pass it to `ToolCallResult`. | Add `compact` to the entry type and pass it through to `ToolCallResult`. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | Delete key behaves like Backspace | `packages/tui/src/ui/components/TextInput.tsx:95` | `key.backspace || key.delete` deletes the character before the cursor. | Split Backspace and Delete handling; Delete removes at cursor without moving backward. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | REPL bypasses max-context helper | `packages/tui/src/cli/commands/repl.ts:144` | REPL duplicates the fallback expression instead of using `resolveMaxContextTokens`. | Import and use `resolveMaxContextTokens(llmConfig, settings.context.maxTokens)`. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | `/image` reads whole file before size guard | `packages/tui/src/cli/commands/builtin/image-command.ts:77` | The command stats the file but immediately `readFileSync`s it before enforcing a byte cap. | Enforce a TUI-side max size before reading/base64 encoding. | `review-tui-cdp-2026-07-08.md` |
| 🟡 | Insecure plugin transports allowed silently | `packages/core/src/plugins/installer/parseSource.ts:28` | Direct installs accept `http://`, `git://`, and `file://`; marketplace add accepts `http://...git` without policy/warning. | Default to HTTPS/SSH, require an explicit unsafe flag for cleartext transports, and prefer full SHA pins. | `review-infra-2026-07-08.md` |
| 🟡 | `copy-assets.mjs` allows zero-match globs | `scripts/copy-assets.mjs:43` | Glob inputs only require the source directory to exist; zero matched files still succeed. | Track matches per glob and exit non-zero unless a pattern is explicitly optional. | `review-infra-2026-07-08.md` |

## ALREADY-FIXED

None. Targeted `git log`/`git blame` checks did not show any reviewed finding with a resolving commit already present in `HEAD`.

## FALSE-POSITIVE / BY-DESIGN

| Finding | Reason |
| --- | --- |
| Custom ESLint rules are no-op stubs | `eslint.config.js:25` really returns empty visitors, but this is explicitly documented as intentional convention-only guidance in `CODESHELL.md:54`, not a hidden enforced guardrail. The separate CI/import-guard finding remains confirmed-live. |

## NEEDS-DEEPER-VERIFICATION

| Finding | What evidence would settle it |
| --- | --- |
| `@cjhyy/code-shell-cdp` publishability is ambiguous | Source evidence conflicts: `packages/cdp/package.json:38` has public `publishConfig` and `packages/cdp/README.md` documents npm install, while `.github/workflows/release.yml:225` publishes only core, TUI, and meta. A release-owner decision or npm release policy should settle whether CDP is intended public; if yes, publish it, if no, remove public metadata/docs. |
| Printable CDP `pressKey()` events may omit text payloads | `packages/cdp/src/keymap.ts:160` emits key/code/modifier fields but no `text`/`unmodifiedText`. A Chromium runtime repro with a focused `<input>` and `pressKey("a")` should confirm whether text inserts; if not, add payload fields or document `pressKey` as shortcut/control-key only. |
