# First navigation failure — old fixture reference only

The following combined read was attempted once with exec_command:

```sh
sed -n '1,115p' docs/audit-2026-10-17-round8/evidence/plugins-parsers.test.ts && sed -n '1,100p' packages/core/src/llm/capabilities/index.ts && sed -n '1,105p' packages/core/src/llm/capabilities/param-specs.ts && sed -n '1,120p' scripts/run-bun-test-shard.mjs
```

First tool response transcription (not a separately captured process log):

```text
sed: docs/audit-2026-10-17-round8/evidence/plugins-parsers.test.ts: No such file or directory
exit_code: 1
```

The guessed historical fixture reference is skipped. The later `&&` reads did not execute in this call. No Bun command, product import, product assertion, or product validation ran; no fixture was repaired or retried. This is navigation evidence only and is not a product failure. Current-source dependency inventory and tests use independently inventoried actual current paths; the failed historical fixture is neither recovered nor used as evidence.

## Second independent navigation failure — guessed runner environment module

Attempted once:

```sh
sed -n '1,90p' docs/audit-2026-10-17-round11/evidence/root-composition-controls.test.ts && sed -n '1,125p' scripts/bun-test-env.mjs
```

First tool-response transcription:

```text
sed: scripts/bun-test-env.mjs: No such file or directory
exit_code: 1
```

The earlier existing historical fixture read completed, but the guessed environment module did not exist. That metadata-reference direction is skipped without alternate recovery. No product import or test was executed. Current tests will use the prescribed guarded runner directly and do not depend on or assert the guessed module or a guessed runner marker.

## Third independent metadata failure — optional Node root semver resolution

After both guarded Bun shards had completed successfully, an optional installed-library metadata lookup was attempted once from the checkout root:

```sh
node -p 'require.resolve("semver/package.json")'
```

First tool-response transcription (not a Bun log):

```text
node:internal/modules/cjs/loader:1478
  throw err;
  ^

Error: Cannot find module 'semver/package.json'
Require stack:
- /Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/[eval]
    at Module._resolveFilename (node:internal/modules/cjs/loader:1475:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1093:12)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1093:12)
    at require.resolve (node:internal/modules/helpers:209:31)
    at [eval]:1:9
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/[eval]'
  ]
}

Node.js v25.8.1
exit_code: 1
```

This optional Node/CJS metadata lookup is skipped without trying another base directory, resolver, library path, or package import. It did not import product code or run Bun. The two preceding first Bun shards have their own intact Completed/exit-0 receipts; their runtime observations remain unchanged, but the installed semver package version/path is not pinned by this lane. No dependency repair or product rerun was performed.
