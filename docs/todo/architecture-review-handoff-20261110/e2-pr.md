# E2 — Refresh architecture and package release documentation

Base: coordinator candidate `27373f5e7` (after T1, R1/R2, H2 and C1 integration). Branch `codex/docs/e2-architecture-drift`; worktree `/private/tmp/codeshell-architecture-g1`. Final candidate should also include H3 `188882aec` because the package chapter documents its React-free `/panels` contract. No PR created by this delegated worker; do not merge before independent CC review.

Updates all seven requested documentation areas:
1. Refreshes the package graph and release-unit section against `scripts/package-release-audit-config.ts`: 12 workspace packages + root meta = 13 versioned entries, 10 public units in the exact Link → Core → Host → Pet → Coding → Web → Server → TUI → Chat → meta order, and 3 private/version-only units. Includes Host ownership, post-R1/R2 inventory and H2/H3 narrow Web imports. Earlier August size/export figures remain explicitly historical. Existing example unit-test commands now use the required guarded runner.
2. Adds an expired notice to the July 7 engine-split plan, linking the current task list; original body unchanged.
3. Adds a historical-date notice to the July 14 architecture debt record; original body unchanged.
4. Corrects Desktop's `//deps`: exact five main-build externals and the explicit `DESKTOP_MATERIALIZED_WORKSPACES` / `predist.ts` Link copy. Link is also a Core production dependency; packaging does not rely on an accidental workspace hoist. No dependency changes.
5. Refreshes TODO's main snapshot to fetched `origin/main@fcd8406d5` and 373 commits after `v0.9.52`, preserving older merge history and separating source/candidate/publication status.
6. Describes Web's reusable client surface plus complete SPA in its description, CODESHELL's existing 12-package list, and the obsolete entry-file comment. The Web executable entry contents are unchanged.
7. Marks T1 as implemented only in candidate `68eca438fbfa449c4f1267d0900c4c9a5fbb8ed2` / `codex/architecture/t1-run-option-forwarding`, pending PR, independent review and merge. No invented PR number or merged claim; the eventual PR must be recorded after it exists/merges.

Evidence difference: the temporary clone retains old `origin/main@2d1c0b638` (323 commits). The original task worktree, already fetched by the coordinator, resolves `origin/main@fcd8406d5`; read-only `git rev-list --count v0.9.52..origin/main` there is 373. No refs or original checkout were modified. The package list now has Host in place of retired Arena; legacy CDP is absent. No new release or real-device claim.

Validation:
- Static checks: only Desktop `//deps` and Web `description` JSON values change; both parse; historical documents' original bodies are byte-for-byte unchanged; Web entry code after the opening comment is byte-for-byte unchanged.
- Manifest/inventory check: CODESHELL names match all 12 top-level workspace manifests; 10 release-table rows exactly match `bun scripts/package-release-smoke.ts --list` order. Logs `/private/tmp/codeshell-e2-{static-check,inventory-check,release-list}-20261110.log`.
- Three whole-repo contracts via isolated HOME runner: 30 pass / 0 fail, `/private/tmp/codeshell-e2-contracts-final-20261110.log`.
- First contract attempt had 10 missing-manifest failures caused by our older branch's ignored `packages/cdp/dist` and `packages/arena/node_modules` remaining after branch switch. Confirmed no tracked files, moved those generated directories outside this worktree to `/private/tmp/codeshell-e2-retired-package-builds`, then reran successfully. No source/test workaround.
- `git diff --check`: PASS. Only the changed package chapter was Markdown-formatted.

No build, typecheck, platform E2E or full package-release run was repeated for this documentation-only change. Implementation/packaging checks belong to the final integrated candidate. No user credentials, paid eval, new tests, mock.module, evidence deletion or checklist completion markers.
