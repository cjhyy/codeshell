# Guarded fixture preparation (not executed)

Purpose: prove successful actual ProjectAuthority create/rename/remove changes real private ProjectStore/recents.json/loadRecents while one installed actual menu snapshot stays stale; direct same-A install is an internal normal control only. One owned A, no focus switch, separate from R82/D23-1.

Execution remains 0 until root reviews these exact sources. Proposed maintained command from frozen workspace cwd:

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-menu-recents-round23/menu-recents.test.ts
```

Guard first, no product static imports: network-guard.ts verifies maintained private HOME, installs exact dummy-origin guard, then denies even that origin plus fetch/http(s)/net/tls/dgram/WebSocket/Bun serve/listen and child_process/Worker/Bun spawn; Electron module is an owned directory with denied utilityProcess.fork. This is an in-process guard and private state directory, not OS isolation or a universal direct-native-network claim.

Actual import graph:

- ProjectStore -> Core public/internal via existing built dist, desktop SessionCwdIndex/mounted-project-root/logger, coding/git adapter.
- Core public/internal barrels include definitions for Engine/providers/MCP. Fixture constructs actual SessionManager with owned sessions directory but never constructs/calls Engine, LLM client, Core server, Host or worker. Core import follows network/child guard. Existing dist is read, not rebuilt.
- ProjectAuthority IPC actual module -> actual ProjectStore/renderer-project-path/legacy-project-migration; type-only AgentBridge is erased. Its unrelated profiles-service and session-workspace-service leaf exports are throw-only adapters with a full named list in fixture/observations; calls must remain zero.
- Actual recents-store -> real fs/path/owned homedir/logging + only coding/git.resolveProjectRoot mocked to realpath identity for owned ordinary non-Git folders. Actual production helper would attempt git then fall back for these folders; forbidden subprocess is avoided, and the limitation excludes Git/worktree/alias behavior. Recents arrays/parsing/live filtering/sorting/disk projection are not mocked.
- Actual menu.ts -> owned Electron Menu template storage and actual recents-store. MenuItem/native UI not executed.

Core/desktop source + built Core entry hash manifest generated only if authorized fixture runs; all evidence snapshots in observations. No App is mounted/extracted: stale item sends actual menu message to owned A, actual registry:list empty is dynamic if run, App missing-target return remains linked static source. No ownership/security or project revival claim.

R29 recovery wording should require an item already in the installed menu snapshot or later menu rebuild. Existing actual rename broadcast recovery and P3 remain unchanged.
