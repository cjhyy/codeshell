# 12 · Package Boundaries & Release Units

> Audit date: 2026-07-17. Scope: workspace manifests, package entry points,
> production imports, build outputs and publish dry-runs. This chapter explains
> why the current packages exist, where the boundaries are sound, and which
> boundaries should be tightened before adding more product capabilities.

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
3. `server` remains one install unit, but its reusable kernel now has focused
   `/storage`, `/worker`, and `/mobile-remote` entries with no static Coding or
   Web imports. The `/serve` entry deliberately owns ready-made Coding worker
   and Web app resolution.
4. `chat` is logically standalone, but its install unit is too coarse: every
   platform SDK is a mandatory dependency even when a consumer uses one
   adapter.
5. Package builds must clean `dist` before compiling. Before this audit,
   `@cjhyy/code-shell-core` would have published stale Arena/Pet code and lint
   probes left by earlier refactors.
6. A clean-build tarball audit of all nine public packages — Core, Pet, Arena,
   Coding, Web, Server, TUI, Chat, and the root meta package — verifies every
   export/bin target, workspace-version rewrite, focused-entry identity, and
   required copied asset. It also caught declaration-only dependency leaks.
7. That audit is now automated by `bun run test:package-release`. The release
   workflow runs it as a dedicated nine-tarball job before npm publication,
   without adding pack work to the normal targeted unit-test job.

## Current dependency graph

Workspace edges from production code and manifests:

```text
@cjhyy/code-shell (meta manifest)
  ├─> core
  └─> tui ──────────────> core + coding + arena

coding ─────────────────> core/extension
arena ──────────────────> core/extension

generated meta runtime
  ├─> core (SDK re-export)
  └─> tui  (CLI shim)

desktop (private)
  ├─> core + core/internal
  ├─> coding / arena / pet
  ├─> server / web / chat / cdp
  └─> Electron + renderer dependencies

server
  ├─> core
  ├─> coding
  └─> web

pet ────────────────────> core/extension
web ────────────────────> core types
chat                     (no CodeShell package dependency)
cdp                      (zero runtime dependencies)
```

There are no workspace dependency cycles. The intended layer order is:

| Layer | Packages                        | Meaning                                                   |
| ----- | ------------------------------- | --------------------------------------------------------- |
| L0    | `core`, `chat`, `cdp`           | Foundations with no dependency on another product package |
| L1    | `coding`, `arena`, `pet`, `web` | Capabilities or clients built on core contracts           |
| L2    | `tui`, `server`                 | Composition hosts                                         |
| L3    | `desktop`, root meta package    | Product/distribution composition                          |

`web -> core` is type-only in browser source, although the manifest currently
declares core as a regular dependency so emitted declarations can resolve.

## Package-by-package assessment

| Package   | Current release boundary                                                                  | Assessment                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core`    | Public `.`, trusted `/extension`, in-repo `/internal`, plugin runtime and worker subpaths | Correct three-surface model. The root barrel remains broad, so the documented stable API table must stay the compatibility authority.                                                                  |
| `coding`  | Compatibility root plus `/capability`, `/git`, `/orchestration` and worker bin            | Correct physical capability split. Focused host imports no longer evaluate unrelated LSP, patch, Git, or external-agent surfaces, while the root preserves the existing SDK.                           |
| `arena`   | Compatibility root plus `/runtime`                                                        | Correct capability split. Normal hosts use the runtime API without evaluating Iterate mode and advanced phase/strategy barrels; the root preserves those advanced exports.                             |
| `pet`     | Compatibility root plus `/capability`, `/protocol`, `/team`                               | Correct extraction from core. Focused subpaths keep one release unit while preventing new consumers from depending on its implementation-wide root barrel.                                             |
| `server`  | Compatibility root plus `/storage`, `/worker`, `/mobile-remote`, `/serve`, and CLI bin    | Correct evaluation boundary within one release unit. Kernel consumers avoid Coding/Web composition; `/serve` retains the ready-made product defaults.                                                  |
| `web`     | Browser logic root plus bundled SPA assets                                                | Good browser boundary: no Electron and no core runtime import. Keeping the reusable state/reducer layer and SPA in one package is reasonable at current scale.                                         |
| `tui`     | Public root plus `code-shell` bin                                                         | Correct host boundary. Its extensive `/internal` use is acceptable for an in-repo, version-locked host, but prevents independent versioning from core.                                                 |
| `desktop` | Private app                                                                               | Correct composition root. Code loaded only through bundling may live in dev dependencies, while worker-loaded packages must remain runtime dependencies and be copied by `predist`.                    |
| `cdp`     | Private package                                                                           | Good zero-dependency technical boundary. It is intentionally not an npm release unit today; documentation must not call it published.                                                                  |
| `chat`    | Root plus per-platform subpaths                                                           | Good domain independence. `/factory` now dynamically imports only the selected adapter, but all platform SDKs remain one default installation unit.                                                    |
| root meta | Core re-export and TUI CLI shim                                                           | Correct compatibility package. Its direct runtime dependencies now match the generated artifacts: Core for the SDK re-export and TUI for the CLI shim. Coding and Arena remain TUI-owned dependencies. |

## Why Pet is a package

Pet is a product capability, not a core subsystem.

Its four responsibilities move together:

- `profile.ts` defines Mimi's manager-only prompt, tool allowlist, permission
  posture, MCP/plan restrictions and run-scoped services.
- `delegate-work.ts` implements the Pet-only `DelegateWork` contract.
- `projection-extension.ts`, `session-index.ts` and
  `pending-decision-index.ts` maintain Pet's cross-session read model and
  protocol notifications.
- `team.ts` and the delegation types define Pet-led digital-human teams.

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

No. `pet` is small and internally cohesive. Splitting projection, delegation
and teams into separate npm packages now would create multiple manifests,
versioning decisions and cross-package tests for code that is released and
consumed together.

The package keeps its compatibility root and now exposes three focused stable
subpaths:

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

Hosts that only store or render a `DigitalHumanTeam` should import
`@cjhyy/code-shell-pet/team`; the worker should import
`@cjhyy/code-shell-pet/capability`; bridges should take snapshot/delta contracts
from `/protocol`. The root remains for existing consumers and the current
dynamic capability loader. Source aliases are exact rather than wildcarded, so
in-repo consumers cannot accidentally turn an internal Pet module into a
de-facto public subpath.

Only create a separate team/catalog package if that model gains non-Pet
consumers or an independent release cadence.

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
coding / arena / pet -> @cjhyy/code-shell-core/extension
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
importing Coding policy. `/storage`, `/worker`, and `/mobile-remote` therefore
have no static Coding or Web imports. Desktop injects
`CC_COST_GUARD_PROMPT` when it creates the Claude resident-agent process.

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

`PluginLifecycleRuntime` was audited as browser-safe: its implementation has no
module imports and uses only standard ECMAScript collections, promises and
objects. Core now publishes it through the explicit
`@cjhyy/code-shell-core/browser/plugin-runtime` subpath. The previous
`/plugin-runtime` entry remains available for compatibility, but the renderer
guard allows only the browser-named entry at runtime. Other core runtime
imports, including other `/browser/*` paths, remain rejected.

A browser-target bundle contract test protects the entry from acquiring Node or
Electron dependencies, and the ESLint boundary test separately proves that the
exact reviewed path is allowed while the legacy/general paths are denied. Host
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
entry contracts are the right model. Pet, Coding, Arena, and Server now retain
their roots for compatibility while offering focused host entries.

Suggested shape/status:

| Package  | Primary entry      | Focused subpaths / status                                         |
| -------- | ------------------ | ----------------------------------------------------------------- |
| `coding` | compatibility root | Implemented: `/capability`, `/git`, `/orchestration`, worker bin  |
| `arena`  | compatibility root | Implemented: `/runtime`; advanced algorithms/Iterate stay at root |
| `pet`    | compatibility root | Implemented: `/capability`, `/protocol`, `/team`                  |
| `server` | compatibility root | Implemented: `/storage`, `/worker`, `/mobile-remote`, `/serve`    |

### Release package source and publish order

`scripts/package-release-audit-config.ts` is the single declaration for every
versioned workspace package. Nine entries are public release units; `cdp` and
`desktop` are private but still participate in synchronized version and
lockfile verification.

The public list is also the npm publish order:

```text
core -> pet -> arena -> coding -> web -> server -> tui -> chat -> root meta
```

Independent packages may appear anywhere after their dependencies; the
enforced invariant is that every public workspace dependency is published
before its consumer. `scripts/release.ts`, CI tag verification, tarball smoke,
and the npm publish helper all consume this declaration. Adding a workspace
manifest without adding it to the declaration fails version verification.

### P2 — package metadata and local entry documentation

- Core, Coding, Arena, Pet, Server, Web, TUI and Chat now publish repository
  metadata and a Node `>=20.10` engine contract.
- Web now has a package-local README. Pet, Coding, Arena, Server and Web
  document their focused entry contracts locally.
- Older architecture docs still described four packages and called CDP
  published even though `packages/cdp/package.json` is private.

Package metadata, local READMEs, and the meta package's redundant dependency
edges are fixed. The remaining item is documentation cleanup rather than a
runtime boundary defect.

## Enforced dependency rules

The repository guard now encodes these invariants:

| Source                              | Allowed CodeShell imports                                                |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `core` production                   | None; use relative self-imports                                          |
| `coding`, `arena`, `pet` production | `@cjhyy/code-shell-core/extension`                                       |
| coding worker composition entry     | Above plus core's stdio worker bin                                       |
| TUI/Desktop main                    | core public/internal and explicitly composed capabilities                |
| desktop renderer                    | Type-only CodeShell contracts and reviewed browser-safe runtime packages |
| `web`                               | Type-only core protocol contracts                                        |

This guard is deliberately about **direction**, not package size. A large,
cohesive leaf package is safer than several small packages with cycles or
host-to-core back references.

## Recommended execution order

Completed in these boundary passes: clean-first package builds; focused Pet,
Coding, Arena, and Server subpaths; chat adapter lazy loading; and the
renderer's explicit browser-safe plugin-runtime entry.

Remaining order:

1. Measure whether Server's Coding/Web install dependency justifies a separate
   `code-shell-serve` release.
2. Add chat adapter availability diagnostics, then evaluate independently
   installable adapter packages without breaking the default CLI install.
3. Keep the root meta package limited to dependencies its generated SDK/CLI
   artifacts directly consume.

Useful checks:

```bash
bun test tests/eslint-boundary-guard.test.ts
bun test packages/core/src/plugins/runtime.browser-contract.test.ts
bun test packages/pet/src/index.exports.test.ts
bun test packages/coding/src/index.exports.test.ts packages/arena/src/index.exports.test.ts
bun test packages/server/src/index.exports.test.ts
bun test packages/core/src/utils/lockfile.test.ts
bun run test:package-release -- --list
bun run test:package-release -- --dry-run
bun run test:package-release
bun run scripts/verify-release-versions.ts "$(node -p "require('./package.json').version")"
bun run scripts/release.ts 0.7.2 --dry-run
bun run scripts/publish-release-packages.ts --list
bun run scripts/publish-release-packages.ts --tag next --dry-run
bunx eslint packages/core/src packages/coding/src packages/arena/src packages/pet/src --quiet
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
