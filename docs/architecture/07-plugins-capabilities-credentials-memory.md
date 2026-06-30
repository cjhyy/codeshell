# 07 · Plugins, Capabilities, Credentials, Memory

> The four subsystems that let CodeShell grow capabilities at runtime — installing extensions, projecting/toggling them, holding secrets, and remembering across sessions. Source-mapped against `packages/core/src/plugins/`, `capability-control/`, `credentials/`, `session/memory.ts`, and `services/dream-consolidation.ts`.

## 1. Plugins (`plugins/`)

CodeShell installs CC- and Codex-format plugins from a marketplace, git, GitHub, or an uploaded archive, then loads their hooks/MCP/agents/skills/commands into the runtime.

| File | Role | ~LOC |
|------|------|------|
| `plugins/pluginInstaller.ts` | Core install/uninstall/list, cache management | ~393 |
| `plugins/installedPlugins.ts` | `InstalledPluginsV2` manifest (CC-byte-compatible) | ~64 |
| `plugins/loadPluginHooks.ts` | Register `hooks/hooks.json` into the `HookRegistry` | ~303 |
| `plugins/pluginContent.ts` | `describePluginContent` — 5-category read-only inventory | ~96 |
| `plugins/marketplaceManager.ts` | Marketplace add/refresh/remove/load | ~231 |
| `plugins/gitOps.ts` | git clone/ls-remote/fetch wrappers — **RCE guard** | ~202 |
| `plugins/installer/detectFormat.ts` | CC vs Codex binary detector | ~8 |
| `plugins/installer/loadPluginMcp.ts` | merge `mcp-servers.json` (Codex) + `.mcp.json` (CC) | ~112 |

**Format handling.** `detectPluginFormat` is binary: `.codex-plugin/plugin.json` ⇒ Codex, else CC. CC plugins are copied largely as-is; Codex plugins are transformed (and `${CLAUDE_PLUGIN_ROOT}` is rewritten to `${CODESHELL_PLUGIN_ROOT}`). The plugin-skill-localization work covers most of this; Codex commands/prompts conversion is still a gap (the memory note).

**Install flow** (`installPlugin` → `materialize`): resolve the marketplace manifest, materialize the source (path / git / github / git-subdir — verifying a pinned SHA if declared), rewrite vars, append a `PluginInstallEntry` to `~/.code-shell/plugins/installed_plugins.json` keyed by the immutable `plugin@marketplace`. Uninstall is guarded by `resolveSafePluginPath` (realpath + strict containment, so a tampered manifest can't `rmSync` outside the cache).

**Hook registration** (`loadPluginHooks`): maps CC PascalCase events to codeshell snake_case (`PreToolUse → pre_tool_use`), registers at priority 80, and supports two disable granularities — `disabledPlugins` (whole plugin) and `disabledPluginHooks` keyed by `pluginHookKey(plugin:event:command)` (per hook, stable across reinstalls).

**Security: git arg-injection.** `gitOps.ts` always puts `--` before any user/manifest/remote value (`["ls-remote", "--", url, ref]`), because a URL shaped like `--upload-pack=<cmd>` would otherwise be parsed as a flag and execute — an RCE. (This is the git-arg-injection-rce memory note; it applies to *any* git subprocess fed external values.)

The official marketplace seed is `cjhyy/mimi-plugins`, soft-pre-installed on first launch via `bootstrap-core-plugins` (the official-marketplace-seed memory note: adding a pre-installed plugin means editing repo + marketplace.json + `CORE_PLUGINS`). Uploaded-archive install (`installPluginFromArchive`) backs the desktop "upload zip" entry point.

## 2. Capability control (`capability-control/`)

A unified, **read-only projection** over the four extension loaders (builtin tools, MCP, skills, plugins, agents), with tri-state project overlays. This is the backend for the desktop's "能力总览" (capability overview).

| File | Role | ~LOC |
|------|------|------|
| `capability-control/service.ts` | `CapabilityService` — compose projections + overlay | ~200 |
| `capability-control/project.ts` | `projectBuiltin/Mcp/Skills/Plugins/Agents` | ~300 |
| `capability-control/overlay.ts` | tri-state math, `effectiveDisabledList`, `whitelistDisabledList` | ~180 |
| `capability-control/disabled-lists.ts` | `computeEffectiveDisabledLists` — fold global + project | ~75 |

Each `CapabilityDescriptor` carries an inlined `control` ({`settingsKey`, `mode`, `token`}) so the service routes a toggle to the right key (`denylist` / `allowlist` / `record-flag`) without branching on `kind`. Project overlays are **tri-state** (`on`/`off`/`inherit`), read unmerged so inheritance works; all consumers fold through `computeEffectiveDisabledLists` for consistency. The no-repo "conversation" scope **inverts** skills/plugins to a whitelist (default-all-off, only explicit `on` survives) — that's how a pure-chat project disables `superpowers` and friends (the conversation-settings-norepo memory note). Agents are projected here too (the agent-capability-overview note: don't forget `readDisabledAgents` when folding).

## 3. Credentials (`credentials/`)

A two-scope (user/project) store for `token` / `link` / `cookie` credentials with masking, an approval gate, and safe cookie materialization.

| File | Role | ~LOC |
|------|------|------|
| `credentials/store.ts` | `CredentialStore` — user/project read/write/list/resolve | ~200 |
| `credentials/use-credential-tool.ts` | `useCredentialTool` — list/fetch + cookies.txt materialization | ~221 |
| `credentials/cookie-jar.ts` | `formatNetscapeCookies` / `parseCookieJar` | ~53 |
| `credentials/use-gate.ts` | `credentialUseGate` — three-level approval | ~90 |

A `Credential` carries `id`, `type`, `label`, `secret`, optional `exposeAsEnv`, `autoUseByAI`, and cookie `meta` (domain/scope/`switchMode`). Design invariants:
- **Two scopes** mirror settings: project scope can't see the host user's credentials (SDK-embedding safety).
- **Masked lists** — list ops return last-4-only hints; full plaintext never leaves the store.
- **0o600 files** — owner-only, written via temp+rename.
- **Three-level gate** (`use-gate.ts`): auto-approve (global or per-credential `autoUseByAI`) → session-remembered (in-memory per `sessionId`) → interactive ask ("once" / "this session" / "deny"). Headless ⇒ denied (`no-ui`).
- **Cookie materialization**: `parseCookieJar` → unique Netscape `cookies.txt` (0o600), returned as a path for `yt-dlp --cookies`/`curl -b`; stale files swept on startup. Multi-account cookies are keyed by domain (the multi-account-cookie memory note); the independent-login-window flow captures cookies for sites the embedded webview can't log into (browser-login-window note).

`safeStorage` encryption (R-2) is **deferred** — currently plaintext at 0o600. The blocker is that the secret-reading code lives in the core worker but the safeStorage key lives in the desktop main; the correct fix is for core to accept an `EncryptionCipher` interface the host feeds (the r-2-cookie-encryption-deferred memory note).

## 4. Memory & Dream

### Memory (`session/memory.ts`, ~662 LOC)
Cross-session memory is markdown files under `~/.code-shell/<scope>/` (`user` / `dream` / `pending`), each scope with a `MEMORY.md` index. A `MemoryEntry` has frontmatter (`name`, `description`, `type`, `pinned?`, `origin?`, `usageCount`, `created`, `lastUsed`). `MemoryManager`:
- **Soft-deletes** to `memory-trash/<ISO>/<scope>/` (recoverable).
- **Pinned entries** are exempt from age filtering and sort first in injection (the memory-pinned-layer note).
- **Lifecycle fields** drive TTL (`pruneByRecall`) and UI recall scoring; `origin: "auto"` vs `"manual"` distinguishes auto-extracted from curated.
- **`buildInjectionIndex`** merges global + project scopes into the compact index injected each turn (full bodies fetched on demand via `MemoryRead`).
- **Pending approval**: auto-extracted entries land in `pending`; `approvePending` promotes to global user scope, `demotePending` routes to the originating project.

### Dream consolidation (`services/dream-consolidation.ts`, ~204 LOC)
`runDreamConsolidation` is an offline, headless LLM tool-call loop (max 8 turns) that cleans up the `dream` scope — dedupe, merge, drop stale, improve descriptions. It is sandboxed by construction: only the 4 memory tools are permitted, writes are restricted to the `dream` scope (no interactive UI to approve user-scope writes), and a write budget caps mutations at 10. It runs with reasoning off. Auto-triggered every ~5 sessions / 24 h (`services/auto-dream.ts`) or manually.

Memory + Dream together (the memory-and-dream-overview note): the static `~/.code-shell/{user,dream}` files are injected each turn; writes come from manual saves + end-of-session auto-extraction (≤2 entries); Dream is the LLM cleanup pass. CodeShell's Dream is closer to Codex's consolidation than CC's auto-memory (the cc-codex-memory reference note). A larger memory-lifecycle redesign (state machine / completed-state semantics / confirmation flow) is flagged as a deliberate future project, not to be done piecemeal.

## 5. Where to read next
- Plugin hooks ride the hook chain: [05 · Presets, prompt, hooks, skills](05-presets-prompt-hooks-skills.md)
- The `UseCredential`/`InjectCredential`/`Memory*` tools and their guards: [02 · Tool system](02-tool-system.md)
- The aux model that powers Dream and the goal judge: [03 · LLM & model layer](03-llm-and-model-layer.md), [06](06-long-running-orchestration.md)
- The desktop UIs over these (Extensions, Connections, Memory): [10 · Desktop & mobile](10-desktop-and-mobile.md)
