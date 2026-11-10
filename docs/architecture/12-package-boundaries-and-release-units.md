# 12 · Package Boundaries & Release Units

> Original audit: 2026-08-11. Release inventory, workspace graph and packaging
> notes refreshed on 2026-11-10 against the architecture-review candidate after
> R1/R2. Older size/export measurements below remain historical audit evidence.
> This source inventory does not assert that the candidate has merged or shipped.

## Executive verdict

The physical monorepo split is directionally correct. CodeShell is not suffering
from too many npm packages; it is suffering from a few packages whose **export
surface or release unit is wider than their architectural role**.

The most important conclusions are:

1. `pet` should remain outside core. It owns product policy, a specialized tool,
   a protocol projection and Pet-specific data contracts. None of those are
   generic engine mechanisms.
2. `pet` is not over-split into too many packages. At 26 TypeScript files and
   roughly 3,600 source lines including tests, a second npm package would add
   release overhead without buying meaningful isolation. Narrow subpath exports
   are the next step.
3. `server` remains one install unit, with focused kernel and host entries.
   Reusable entries avoid ready-made Coding composition and the React-bearing
   Web root; shared replay/coverage helpers use narrow Web entries. `/serve`
   deliberately owns Coding worker and full Web app resolution.
4. `chat` is logically standalone, but its install unit is too coarse: every
   platform SDK is a mandatory dependency even when a consumer uses one
   adapter.
5. Package builds must clean `dist` before compiling. Before this audit,
   `@cjhyy/code-shell-core` would have published stale Arena/Pet code and lint
   probes left by earlier refactors.
6. A clean-build tarball audit covers the ten current public packages — Link, Core,
   Host, Pet, Coding, Web, Server, TUI, Chat, and the root meta package — and verifies every
   export/bin target, workspace-version rewrite, focused-entry identity, and
   required copied asset. It also caught declaration-only dependency leaks.
7. That audit is now automated by `bun run test:package-release`. The release
   workflow runs it as a dedicated ten-tarball job before npm publication,
   without adding pack work to the normal targeted unit-test job.

> The R1/R2 candidate removes the retired Arena workspace and the legacy CDP
> driver/package. Neither is a current release unit. Historical mentions below
> describe the earlier audit; `scripts/package-release-audit-config.ts` is the
> authority for the current package inventory and publish order.

## Current dependency graph

The current tree has 12 workspace packages plus the root meta package. Runtime
manifest dependencies and Desktop's explicit bundle composition are:

```text
@cjhyy/code-shell (root meta)
  ├─> core (SDK re-export)
  └─> tui  (CLI shim) ──> core + coding

link                      (no CodeShell runtime dependency)
core ────────────────────> link
host ────────────────────> core
coding / pet ────────────> core/extension
optimization-lab (private) -> core/extension
browser-devtools (private) (no runtime dependencies)

server ──────────────────> core + host + link + coding + web
web ─────────────────────> core types + link browser-safe provider contracts
chat                      (no CodeShell package dependency)

desktop (private)
  ├─> external Core + Link + Coding; dynamically loaded Pet / Optimization Lab
  ├─> bundled Host / Server / Web / Chat / browser diagnostics
  └─> Electron + native/browser runtime dependencies
```

There are no workspace dependency cycles. Host depends only on Core and owns
host capability dispatch and shared host services; it does not depend on another
host, Electron, or a capability package. Core's only runtime workspace dependency
is the framework-independent Link contract. Coding and Pet use Core's extension
surface; Server and TUI compose the capabilities they need.

Web's Core imports are erased types, while its Link imports are browser-safe
runtime values. Its manifest declares both so the published runtime/declarations
resolve. The package includes reusable `dist/` entries and the complete `web/app`
SPA built into `dist-app/`; Server serves those assets and Desktop's mobile entry
reuses the app source. The H2/H3 candidate exposes `/transcript-replay`,
`/output-coverage` and `/panels` for shared contracts/helpers without evaluating
the React-bearing root; Server retains compatibility re-exports for its moved
Panel contracts, and the SPA consumes its own package rather than Server source.

Desktop's main bundle keeps Electron, Playwright Core, Core, Link and Coding
external (`packages/desktop/scripts/build-main.ts`). `predist.ts` explicitly
materializes Link, Core, Coding, Pet and Optimization Lab using
`DESKTOP_MATERIALIZED_WORKSPACES`, replacing workspace symlinks with package
files and installing their production dependency closures. Link is listed in
Desktop's `devDependencies`, but it is explicitly materialized and is also a
Core production dependency; it is not supplied by an accidental development
hoist. Host is bundled into main and requires no separate materialized package.

## Package-by-package assessment

| Package   | Current release boundary                                                                  | Assessment                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link`    | Public manifest/guide root                                                                | Correct framework-independent leaf boundary. Hosts consume provider metadata without pulling in Core or a UI runtime.                                                                         |
| `core`    | Public `.`, trusted `/extension`, in-repo `/internal`, plugin runtime and worker subpaths | Correct three-surface model. The root barrel remains broad, so the documented stable API table must stay the compatibility authority.                                                         |
| `host`    | Public root plus `/session-files`                                                         | Shared Core-only Host capability dispatch/services; the storage entry avoids loading probes and model clients. Published before Server and bundled by Desktop.                                |
| `coding`  | Compatibility root plus `/capability`, `/git`, `/orchestration` and worker bin            | Correct physical capability split. Focused host imports no longer evaluate unrelated LSP, patch, Git, or external-agent surfaces, while the root preserves the existing SDK.                  |
| `pet`     | Compatibility root plus `/capability`, `/protocol`, `/team`                               | Correct extraction from core. Focused subpaths keep one release unit while preventing new consumers from depending on its implementation-wide root barrel.                                    |
| `server`  | Compatibility root plus `/storage`, `/worker`, `/mobile-remote`, `/serve`, and CLI bin    | Correct evaluation boundary within one release unit. Kernel consumers avoid Coding/Web composition; `/serve` retains the ready-made product defaults.                                         |
| `web`     | Reusable browser entries plus full `dist-app` SPA assets                                  | Good browser boundary: no Electron and no core runtime import. Keeping the reusable state/reducer layer and SPA in one package is reasonable at current scale.                                |
| `tui`     | Public root plus `code-shell` bin                                                         | Correct host boundary. Its extensive `/internal` use is acceptable for an in-repo, version-locked host, but prevents independent versioning from core.                                        |
| `desktop` | Private app                                                                               | Correct composition root. Code loaded only through bundling may live in dev dependencies, while worker-loaded packages must remain runtime dependencies and be copied by `predist`.           |
| `chat`    | Root plus per-platform subpaths                                                           | Good domain independence. `/factory` now dynamically imports only the selected adapter, but all platform SDKs remain one default installation unit.                                           |
| root meta | Core re-export and TUI CLI shim                                                           | Correct compatibility package. Its direct runtime dependencies now match the generated artifacts: Core for the SDK re-export and TUI for the CLI shim. Coding remains a TUI-owned dependency. |

## Why Pet is a package

Pet is a product capability, not a core subsystem.

Its four responsibilities move together:

- `profile.ts` defines Mimi's manager-only prompt, tool allowlist, permission
  posture, MCP/plan restrictions and run-scoped services.
- `delegate-work.ts` implements the Pet-only `DelegateWork` contract.
- `projection-extension.ts`, `session-index.ts` and
  `pending-decision-index.ts` maintain Pet's cross-session read model and
  protocol notifications.
- delegation types define only bounded Workspace and reusable-Session choices;
  digital-human team templates are Desktop-owned and do not route through Pet.

Core supplies the generic mechanisms these responsibilities need:
`RunBehaviorProfile`, extension tools, run parameter validation, protocol
observers, extension result slots and hidden session kinds. The dependency is
therefore one-way:

```text
pet policy + projection + tool
              │
              ▼
      core/extension contracts
              │
              ▼
        generic engine runtime
```

Keeping Pet in core would make every SDK consumer inherit the Mimi prompt,
`DelegateWork`, Pet session semantics and Pet protocol aliases. It would also
force core releases for Pet-only iteration.

### Is Pet over-split?

No. `pet` is small and internally cohesive. Splitting projection and delegation
into separate npm packages now would create multiple manifests, versioning
decisions and cross-package tests for code that is released and consumed
together. Digital-human team templates are now Desktop-owned; `/team` remains
only as a source-compatible legacy contract.

The package keeps its compatibility root, exposes two focused runtime subpaths,
and temporarily retains one legacy data-contract subpath:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
    "./capability": {
      "types": "./dist/index.capability.d.ts",
      "import": "./dist/index.capability.js",
    },
    "./protocol": {
      "types": "./dist/index.protocol.d.ts",
      "import": "./dist/index.protocol.js",
    },
    "./team": {
      "types": "./dist/index.team.d.ts",
      "import": "./dist/index.team.js",
    },
  },
}
```

The worker should import `@cjhyy/code-shell-pet/capability`; bridges should take
snapshot/delta contracts from `/protocol`. Desktop stores and renders teams with
its own shared digital-human contract. `/team` and the root export remain for
existing consumers and the current dynamic capability loader, but new code must
not use them to route Pet work. Source aliases are exact rather than wildcarded,
so in-repo consumers cannot accidentally turn an internal Pet module into a
de-facto public subpath.

Only create a separate team/catalog package if the Desktop-owned model gains
non-Desktop consumers or an independent release cadence.

## Findings

### P0 — stale build output crossed package boundaries

Package `build` scripts previously ran `tsc` into an existing `dist` directory.
TypeScript writes new files but does not remove files whose sources were moved
or deleted.

Before the clean-first fix:

- `packages/core/dist` contained 926 files while current non-test core source
  had 349 TypeScript files.
- stale examples included `dist/arena/**`, `dist/pet/**`,
  `dist/tool-system/builtin/delegate-work.*` and
  `dist/__lint_boundary_*`.
- `npm pack --dry-run` reported a 1,328,331-byte tarball and 4,723,310 bytes
  unpacked.

After a clean core build:

- the stale examples are absent;
- the dry-run reports 1,110,278 bytes packed and 3,953,460 bytes unpacked;
- the tarball is about 16% smaller and, more importantly, matches the source
  boundary.

Every publishable package build now needs the invariant:

```text
clean dist -> compile -> copy assets -> pack
```

Generated assets must be copied only after cleaning. The root meta build already
had this behavior.

### P1 — capability dependency direction needed enforcement

The intended rule is:

```text
coding / pet -> @cjhyy/code-shell-core/extension
```

Capability runtime code must not import core's public root, `/internal`, a host
package, or another product capability. The coding stdio wrapper is the one
explicit composition exception: after registering the capability it loads
core's worker bin.

The ESLint boundary rule now checks static imports, dynamic imports and
re-exports for these packages. Tests may use `/internal` to build white-box
harnesses; production files may not.

### P1 — server kernel evaluation is split; installation remains one host bundle

The reusable Server entries are now separated without creating another npm
package:

```text
/storage       disk sessions, attachments, image probing, message IDs
/worker        transport-agnostic stdio worker bridge
/mobile-remote pairing, rooms, uploads, access gates, LAN/tunnel transport
/serve         headless host and ready-made CLI composition
```

`ResidentAgentProcess` accepts `appendSystemPrompt` from its host instead of
importing Coding policy. Desktop injects `CC_COST_GUARD_PROMPT` when it creates
the Claude resident-agent process. Reusable Server consumers do not load the
Web root or its React hooks: the H2/H3 candidate selects `/transcript-replay`,
`/output-coverage` and `/panels` where shared Web contracts are needed. This is
an evaluation boundary within one install unit, not the absence of every Web
package dependency.

`packages/server/src/serve/cli.ts` still resolves the Coding worker bin and the
Web package's built SPA. This is valid for the ready-made `code-shell-serve`
product, but it means installing the package still installs Coding and Web even
when an SDK consumer only imports transport primitives.

Recommended target:

```text
@cjhyy/code-shell-server
  core + ws transport primitives, rooms, uploads, access gates

@cjhyy/code-shell-serve (or a root-host subpackage)
  server + coding worker + web SPA + CLI defaults
```

The dependency-inversion and separate-entry portion is complete. A separate
`@cjhyy/code-shell-serve` release unit is only justified if installation size or
independent versioning becomes more important than keeping one deployable
server package.

### P1 — chat adapters are one oversized install unit

The chat root is independent of core, which is good. However the package
manifest makes Discord, Slack, Lark, DingTalk, WeCom and Teams SDKs mandatory.
The factory startup coupling has been removed: `createChannelAdapterAsync()`
dynamically imports only the configured platform, and the CLI and Desktop host
await that entry during startup. The legacy synchronous
`createChannelAdapter()` remains source-compatible through a lazy proxy,
including the webhook-path metadata that `ChatGateway` needs before it starts.

This changes module evaluation, side effects and startup cost; it deliberately
does not change the default installation contract. Moving SDKs directly to peer
dependencies would make the existing CLI fail only after a user selects a
channel. Optional dependencies would retain default install size while allowing
package-manager omit flags to create the same runtime failure. Keep them as
regular dependencies until adapter-specific installation detection and
documentation exist.

Recommended sequence:

1. keep `@cjhyy/code-shell-chat` as the gateway/contracts package;
2. **done:** dynamically import only the configured adapter and migrate built-in
   hosts to the async factory;
3. add adapter availability/install diagnostics, then move heavy SDKs to
   optional peer dependencies or adapter packages such as
   `@cjhyy/code-shell-chat-discord`;
4. keep fetch-only adapters in the base package if their maintenance and
   security cadence remains aligned.

### Resolved P1 — renderer browser-runtime boundary

The architectural rule says the desktop renderer talks to main through
`window.codeshell` and uses CodeShell packages only for erased types or
explicitly reviewed browser-safe code. `web` remains the main browser client
package.

`PanelAppLifecycleRuntime` was audited as browser-safe: its implementation has no
module imports and uses only standard ECMAScript collections, promises and
objects. Core now publishes it through the explicit
`@cjhyy/code-shell-core/browser/panel-app-runtime` subpath. The matching
`/panel-app-runtime` entry is available to non-renderer hosts, while the renderer
guard allows only the browser-named entry at runtime. Other core runtime
imports, including other `/browser/*` paths, remain rejected.

A browser-target bundle contract test protects the entry from acquiring Node or
Electron dependencies, and the ESLint boundary test separately proves that the
exact reviewed path is allowed while general runtime paths are denied. Host
capabilities still cross preload through `window.codeshell`; this exception is
only for a UI-agnostic in-memory coordinator.

### P2 — public barrels are wider than the intended contracts

Approximate export-statement counts before the focused Coding/Arena/Server
passes:

| Entry            | Export statements |
| ---------------- | ----------------: |
| `core` root      |               129 |
| `core/internal`  |                60 |
| `core/extension` |                38 |
| `arena` root     |                27 |
| `server` root    |                27 |
| `coding` root    |                20 |
| `pet` root       |                10 |

The count is not itself a defect, but broad star barrels make implementation
modules semver-visible and increase accidental initialization. Core's three
entry contracts are the right model. Pet, Coding, and Server now retain
their roots for compatibility while offering focused host entries.

Suggested shape/status:

| Package  | Primary entry      | Focused subpaths / status                                        |
| -------- | ------------------ | ---------------------------------------------------------------- |
| `coding` | compatibility root | Implemented: `/capability`, `/git`, `/orchestration`, worker bin |
| `pet`    | compatibility root | Implemented: `/capability`, `/protocol`, `/team`                 |
| `server` | compatibility root | Implemented: `/storage`, `/worker`, `/mobile-remote`, `/serve`   |

### Release package source and publish order

[`scripts/package-release-audit-config.ts`](../../scripts/package-release-audit-config.ts)
is the single declaration used by version verification, release builds, tarball
smoke and publication. It currently contains **13 entries: 12 workspaces plus the
root meta package**. Ten are public release units; three are private and versioned
but never packed or published by this release workflow.

The public entries below are in the exact declared npm publication order:

| Order | Directory         | Package                               |
| ----: | ----------------- | ------------------------------------- |
|     1 | `packages/link`   | `@cjhyy/code-shell-link`              |
|     2 | `packages/core`   | `@cjhyy/code-shell-core`              |
|     3 | `packages/host`   | `@cjhyy/code-shell-host`              |
|     4 | `packages/pet`    | `@cjhyy/code-shell-pet`               |
|     5 | `packages/coding` | `@cjhyy/code-shell-capability-coding` |
|     6 | `packages/web`    | `@cjhyy/code-shell-web`               |
|     7 | `packages/server` | `@cjhyy/code-shell-server`            |
|     8 | `packages/tui`    | `@cjhyy/code-shell-tui`               |
|     9 | `packages/chat`   | `@cjhyy/code-shell-chat`              |
|    10 | `.`               | `@cjhyy/code-shell`                   |

```text
link -> core -> host -> pet -> coding -> web -> server -> tui -> chat -> root meta
```

This is a publish sequence, not a claim that each package imports its immediate
predecessor. Every public workspace runtime, optional or peer dependency must
appear before its consumer. Host therefore follows Core and precedes Server;
Core follows Link. Private workspaces cannot be runtime dependencies of a public
release unit.

The private version-only entries are `packages/browser-devtools`,
`packages/desktop` and `packages/optimization-lab`. They participate in
synchronized version and lockfile verification. Desktop's application artifact
is packaged separately; private does not mean unused at runtime (the app
explicitly materializes Optimization Lab).

The release audit clean-builds public packages in dependency order, including
Host after Core, before packing and checking Node runtime imports and strict
consumer declarations. Build order for the whole repository also includes the
private packages and is distinct from npm publication order. Adding a workspace
manifest without declaring it here fails version verification. Arena and the
legacy CDP package are absent after R1/R2; published historical artifacts are not
rewritten by their source removal.

### P2 — package metadata and local entry documentation

- Link, Core, Host, Coding, Pet, Server, Web, TUI and Chat now publish repository
  metadata and a Node `>=20.10` engine contract.
- Web now has a package-local README. Pet, Coding, Server and Web
  document their focused entry contracts locally.
- Older architecture docs still described four packages and called CDP
  published even though that retired package was private. Its legacy driver
  and package have now been removed; shared browser helpers live in Desktop.

Package metadata, local READMEs, and the meta package's redundant dependency
edges are fixed. The remaining item is documentation cleanup rather than a
runtime boundary defect.

## Enforced dependency rules

The repository guard now encodes these invariants:

| Source                          | Allowed CodeShell imports                                                |
| ------------------------------- | ------------------------------------------------------------------------ |
| `core` production               | Link public provider contract; otherwise relative self-imports           |
| `coding`, `pet` production      | `@cjhyy/code-shell-core/extension`                                       |
| coding worker composition entry | Above plus core's stdio worker bin                                       |
| TUI/Desktop main                | core public/internal and explicitly composed capabilities                |
| desktop renderer                | Type-only CodeShell contracts and reviewed browser-safe runtime packages |
| `host`                          | Core public/internal contracts; no other host or capability package      |
| `web`                           | Type-only Core contracts and browser-safe Link provider contracts        |

This guard is deliberately about **direction**, not package size. A large,
cohesive leaf package is safer than several small packages with cycles or
host-to-core back references.

## Recommended execution order

Completed in these boundary passes: clean-first package builds; focused Pet,
Coding and Server subpaths (the historical Arena package is now removed); chat adapter lazy loading; and the
renderer's explicit browser-safe Panel App runtime entry.

Remaining order:

1. Measure whether Server's Coding/Web install dependency justifies a separate
   `code-shell-serve` release.
2. Add chat adapter availability diagnostics, then evaluate independently
   installable adapter packages without breaking the default CLI install.
3. Keep the root meta package limited to dependencies its generated SDK/CLI
   artifacts directly consume.

Useful checks:

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 ./tests/eslint-boundary-guard.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/plugins/runtime.browser-contract.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/pet/src/index.exports.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/coding/src/index.exports.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/server/src/index.exports.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/utils/lockfile.test.ts
bun run test:package-release -- --list
bun run test:package-release -- --dry-run
bun run test:package-release
bun run scripts/verify-release-versions.ts "$(node -p "require('./package.json').version")"
bun run scripts/release.ts 0.7.2 --dry-run
bun run scripts/publish-release-packages.ts --list
bun run scripts/publish-release-packages.ts --tag next --dry-run
bunx eslint packages/core/src packages/coding/src packages/pet/src --quiet
bun run --filter '@cjhyy/code-shell-core' build
(bun run --filter '@cjhyy/code-shell-pet' build && \
  cd packages/desktop && \
  node -e 'Promise.all(["capability","protocol","team"].map((p) => import(`@cjhyy/code-shell-pet/${p}`)))')
```

The full release smoke is offline after `bun install`: it clean-builds each
public package, creates real tarballs with `bun pm pack --ignore-scripts`,
checks that `workspace:*` ranges became exact workspace versions, extracts the
tarballs into an isolated consumer, and compiles every code export with strict
NodeNext plus `skipLibCheck: false`. The consumer links only declared runtime,
optional, and peer dependencies, so declarations cannot silently depend on a
package-local devDependency. Runtime-safe entries are then imported with Node.
The Core/Coding worker entries and TUI CLI entry are declaration-checked but not
executed because importing them starts a process or interactive host; Web's
`./package.json` export is checked as a packed asset.
