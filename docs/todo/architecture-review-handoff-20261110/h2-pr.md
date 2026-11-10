# refactor(server): use React-free web replay subpaths

Server replay paths previously imported the Web root entry, which also exports React hooks and QR components. Add focused `./transcript-replay` and `./output-coverage` exports, matching root TS paths, and migrate the two production imports. Web root exports and behavior remain unchanged.

Branch: `codex/web/h2-focused-server-imports`; base `main@fcd8406d5`; commit `1935b9c78`. Worktree: `/private/tmp/codeshell-architecture-h2`. No PR: GitHub creation requires approval while this session's approval policy is never. Independent CC review remains pending.

The package-boundary test uses the existing TypeScript dependency to distinguish type-only imports from runtime imports, re-exports, import(), require(), and import-equals. It names offending files. Probes passed for allowed type-only forms and correctly failed for four runtime forms; all probe files were removed.

Validation:

- Root build and workspace typecheck passed (including Desktop/mobile/Web SPA).
- Guarded targeted replay tests plus all three repository contracts: 45 passed, 0 failed across 5 files. `outputCoverage.test.ts` does not exist; no direct suite by that name is claimed. Coverage remains through replay driver suites.
- ESLint for the two production files passed. Shard guard passed; no test files added.
- `test:package-release` completed clean package builds, packs, strict NodeNext declarations and runtime imports of all 52 entries, including the two new Web entries. It then failed at the packed owner-auth HTTP lifecycle because the sandbox denies listening on 127.0.0.1 (EPERM). It is **not** reported as a fully passing package release.
- `test:server-smoke` failed at the same loopback restriction. Its existing failure reporter also throws on undefined `lastRpc`; no unrelated source fix made.
- An initial release attempt collided with a temporary negative probe file and was rerun only after probes were removed. The rerun is the result described above.

Logs: `/private/tmp/codeshell-h2-{build,typecheck,targeted,package-release,server-smoke,shards}.log`; probe logs `/private/tmp/codeshell-h2-guard-*.log`. Full unrestricted CI and CC review remain required.
