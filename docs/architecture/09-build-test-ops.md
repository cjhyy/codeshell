# Build, Test, and Operations

## Runtime and Package Manager

The project is TypeScript ESM, built for Node 20+ and developed with Bun.

Important files:

- [`package.json`](../../package.json)
- [`tsconfig.json`](../../tsconfig.json)
- [`tsup.config.ts`](../../tsup.config.ts)
- [`eslint.config.js`](../../eslint.config.js)
- [`bun.lock`](../../bun.lock)

## Common Commands

```bash
bun install
bun run dev
bun test
bun run lint
bun run typecheck
bun run build
```

`CODESHELL.md` notes that `bun run typecheck` is currently a global health signal rather than a clean gate, because there are pre-existing repo-wide issues.

## Build Pipeline

`bun run build` runs:

```text
bun run sync-models
  -> bun run tsup
  -> bun run build:dts
```

`tsup` builds ESM entries:

- `src/index.ts`
- `src/cli/main.ts`
- `src/run/index.ts`
- `src/arena/index.ts`
- `src/product/index.ts`

Production bundling is minified and tree-shaken, with selected optional cloud SDKs externalized.

## Package Exports

The package publishes:

- root API: `@cjhyy/code-shell`
- run API: `@cjhyy/code-shell/run`
- arena API: `@cjhyy/code-shell/arena`
- product API: `@cjhyy/code-shell/product`
- CLI binary: `code-shell`

The shipped file list includes `dist`, `scripts/check-node.cjs`, `skills-builtin`, README, LICENSE, and CHANGELOG.

## Tests

Tests use Bun's test runner. Current coverage areas include:

- tool-result storage and context compaction;
- model cache, model pool, model fetcher, provider catalog, provider kind/capability rules;
- settings migration and provider settings;
- permissions and sandbox behavior;
- session manager, transcript, file history, memory;
- tool registry, hooks, built-in tools, apply-patch fixtures;
- protocol client query mapping;
- run store and run manager lifecycle;
- cost tracking and skills.

Run:

```bash
bun test
```

Run a focused test by pattern:

```bash
bun test -- -t "PermissionClassifier"
```

## Logging

Logs live under:

```text
~/.code-shell/logs/
  engine-YYYY-MM-DD.log
  ui-ink-YYYY-MM-DD.log
```

Useful environment variables:

- `CODE_SHELL_DEV=1`: local dev mode, enables more debug behavior.
- `CODE_SHELL_LOG_LEVEL=debug|info|warn|error`: override log level.
- `CODE_SHELL_DEBUG=<category>`: narrow debug categories.
- `CODE_SHELL_LOG=0`: disable file logging.

[`scripts/logs.sh`](../../scripts/logs.sh) is the intended helper for querying logs.

## Sandbox

Shell tool execution can run through:

- `off`
- `auto`
- `seatbelt`
- `bwrap`

Defaults:

- REPL: sandbox off, because a human approval loop is active.
- Headless: sandbox auto, with platform-specific backend selection when available.

Configuration lives under `settings.sandbox`.

## Release/Publishing Notes

- `preinstall` runs [`scripts/check-node.cjs`](../../scripts/check-node.cjs).
- `prepublishOnly` runs `bun run build`.
- `build:dts` currently allows declaration emission failure with `|| true`, matching the repo's current tolerance for type declaration issues.
- `sync-models` is part of build, so network/model catalog failures can affect publishing.

## Operational Caveats

- Settings schema is newer than the legacy `Settings` interface in `src/types.ts`; some command paths locally cast to access `models`, `providers`, and `activeKey`.
- REPL comments often say Ink, but the implementation imports from the local custom renderer in `src/render`.
- Session storage and run storage are intentionally separate; do not assume a run ID and session ID are interchangeable.
- MCP connection failures are logged and skipped per server; one bad MCP server should not prevent the Engine from starting.
- Context compaction can replace large tool results with file references, so debugging old turns may require reading `tool-results/`.

## Maintenance Checklist

When changing architecture, update this docs set if the change affects:

- Engine wiring or turn-loop stages;
- preset/tool exposure;
- permission modes or approval flow;
- protocol methods or stream events;
- settings schema or storage layout;
- model/provider resolution;
- RunManager states or store layout;
- Arena phases or participant resolution;
- public package exports.
