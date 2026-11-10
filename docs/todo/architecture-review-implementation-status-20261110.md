# Architecture review implementation status — 2026-11-10

## Candidate and environment

- Baseline: `origin/main@fcd8406d5`; initial fetch succeeded.
- Requested worktree: `/Users/admin/Documents/个人学习/代码学习/codeshell-worktrees/architecture-review-20261110`, branch `codex/architecture/review-20261110`. It remains unchanged, with only its original untracked checklist.
- Writing the requested status file there was rejected: `patch rejected: writing outside of the project; rejected by user approval settings`.
- Actual task repository: `/private/tmp/codeshell-architecture-review-20261110`, independently cloned from the local repository and checked out at the exact baseline. Origin points to GitHub. All edits and commits live in the allowed temporary directory; the primary checkout and other sessions remain untouched.
- Local clone uses a read-only object alternate to the primary repository. Preserve it until a bundle or remote push has made commits independent.
- CC review is pending and will be initiated by the host coordinator. No agent CLI has been started and no PR will be merged in this phase.
- E3 awaits an explicit decision in the original worktree's `docs/todo/architecture-review-e3-decision-20261110.md`. No evidence has been removed.

## Task ledger

Implementation and validation are tracked separately. No PR exists: GitHub create_pull_request returned `MCP tool call requires approval, but approval policy is never`. Do not route around this restriction. Authorized branch pushes can succeed, although network resolution is intermittent.

| Task | Status | Branch / commit | PR / base | Validation / next step |
| --- | --- | --- | --- | --- |
| T1 | Implemented; environment-blocked full acceptance | `codex/architecture/t1-run-option-forwarding` / `68eca438f` (pushed) | No PR / main | First red 5 pass + 1 fail, then green 6/0; full build and workspace typecheck passed; combined regression + multi-session + three contracts 36/0; lint 0 errors/98 warnings; shard and engine guards passed |
| T2 | Implemented | `codex/architecture/t2-typed-declarations` / `594fe4d81` | No PR / T1 | 62 declarations/50 files; build, workspace typecheck, lint 0/98, guard probes, 18 targeted + 27 contracts passed |
| T3 | Implemented; environment-blocked full acceptance | `codex/core/t3-settings-locks` / `0e27d8f4d113c17a2d4339eb48fdb749fa069343` | No PR / main | build, workspace typecheck, lint 0/98, shards and engine guard; targeted 37/0 and contracts 27/0 |
| G1 | Implemented | `codex/architecture/g1-ipc-budget-scan` / `dcf469b3a` | No PR / main | Full scan 472/481; build/contracts/negative probes passed |
| G2 | Implemented | `codex/architecture/g2-core-layers` / `6d7aa7e1f` | No PR / G1 | 29 upward edges, 6 same-layer cycles; 28 contracts; negative syntax/resolution probes passed |
| G3 | Pending R1/R2 | — | — | — |
| G4 | Implemented | `codex/architecture/g4-mock-module-ratchet` / `63c19a06e` | No PR / G2 | 73 files incl. 7 MJS fixtures; 29 contracts and negative probes passed; final candidate ratchet after R1/R2 pending |
| C1 | In progress | `/private/tmp/codeshell-architecture-g1` | No PR / G4 | Preserve distinct path root semantics and compatibility exports |
| C2 | Queued after C1 | `/private/tmp/codeshell-architecture-g1` | No PR / C1 | Only mechanical upward edges |
| C3 tests | Implemented | `codex/protocol/c3-query-contract-tests` / `b737ca119` | No PR / main | 51 query tests / 4 files and 27 contracts passed before extraction |
| C3 migration | Implemented; verification in progress | `codex/protocol/c3-query-registry` / uncommitted | No PR / C3 tests | 19 handlers; server 4892→4246 lines, budget 5000→4500; build and 74 query+architecture+golden+package tests passed |
| C4 | Implemented; final probes/commit in progress | `codex/testing/c4-shared-engine-fake` | No PR / T1 | All protocol: baseline 395 pass/11 fail; migrated 397 pass/same 11 fail; sandbox diskutil/listen failures |
| H1 | Implemented; environment-blocked full acceptance | `codex/server/h1-headless-worker-env` / `e2952dff58061a039a8ed36a8c60405820553f5b` | No PR / main | build, Desktop/mobile typecheck, ESLint, shard guard; contracts 27/0, targeted 46/0, 10 env comparisons passed |
| H2 | Implemented | `codex/web/h2-focused-server-imports` / `1935b9c78` | No PR / main | build/typecheck, 45 targeted+contracts; package-release reached 52 runtime imports then HTTP listen EPERM |
| H3 | Pending H2/G3 | — | — | — |
| D1 | Queued after C4 | `/private/tmp/codeshell-architecture-t3` | No PR | Parse once, preserve routing order |
| D2 | Guardrail stop: owner decision required | `codex/desktop/d2-preload-type-contract` / `709d09652` | No PR / main | Exactly 21 diagnostics exceeds 20; source reverted, full report committed at architecture-review-d2-mismatches-20261110.md; no pilot edits |
| D3 | Queued after R2 | `/private/tmp/codeshell-architecture-h1` | No PR | One non-Pet/non-AgentBridge domain |
| E1 | Implemented | `codex/testing/e1-host-link-typecheck` / `8ca3bb3d4` | No PR / main | host/link test tsc zero errors, negative TS2322 probe, 97 tests/10 files, shards/eslint passed; other-package survey in PR draft |
| E2 | Pending R1/R2/T1 | — | — | — |
| E3 | Awaiting user decision | — | — | Preserve all evidence |
| R1 | Implemented; lockfile regeneration blocked | `codex/architecture/r1-remove-arena` / `f667c728e` | No PR / main | build/typecheck/lint0/90, contracts32, preserved guards72, clean committed shard inventory2664 passed; package-release HTTP EPERM; registry refuses Bun install |
| R2 | Implemented; validation/commit in progress | `codex/architecture/r2-remove-legacy-cdp` | No PR / R1 | build, contracts27, host32, pure helpers12, shards2660 passed; browser launch sandbox failure; Desktop cached CUA signature verification failure; lockfile pending |

## Validation record

- Read AGENTS.md, CODESHELL.md and the entire checklist including appendices.
- `bun install --frozen-lockfile` initially failed because the inherited temp directory is not writable.
- Retrying with temporary/cache paths under `/private/tmp` failed on registry connections (`ConnectionRefused` / `FailedToOpenSocket`). No dependency versions have been changed.
- Preparing independent copies of existing dependency artifacts from the primary checkout; no source checkout files are changed by this copy. Builds will regenerate this candidate's own dist files.
- Task validation results are in the ledger. Logs live in `/private/tmp/codeshell-{t1,t3,h1,g1,h2}-*.log`.
- Copied Desktop workspace dependencies were stale packaged directories. Replaced only these ignored local copies with symlinks to each checkout’s own packages; workspace typecheck then passed. No source workaround.
- T1 core-engine/core-rest partitions were attempted and stopped with status 130 after repeated environment failures/timeouts. They did not pass.
- T3 plugins partition completed: 360 pass / 2 fail. Both failures were reproduced with production files restored to the exact baseline, and report `/usr/sbin/diskutil info -plist /dev/disk3s5`: DiskManagement/DiskArbitration unavailable. See `/private/tmp/codeshell-t3-baseline-model-error.log` and `/private/tmp/codeshell-t3-baseline-plugin-errors.log`.
- H1 HTTP/WS integrations failed at loopback listen; independent Node probe reports EPERM while Bun reports EADDRINUSE. They did not reach normal worker behavior.
- These are distinct from the checklist’s known Electron E2E promise garbage-collected failure. No Electron E2E has passed or been rerun here yet.
- Full final build/typecheck/lint/all shards/package-release/browser/desktop/server acceptance and CC review remain outstanding.

## Evidence differences

- C3 has 19 named switch cases plus default. The checklist says 21 but enumerates the same 19 cases.

## Recovery

Continue all authorized items in dependency order. Preserve separate task commits and branches; use explicit stacked PR bases where required. Final synchronization into the requested worktree requires a host session with write access. Do not treat this checkpoint as completion.

## Review artifacts

- T1 branch is pushed at `68eca438f`; no PR number. Its three code paths are the only implementation changes in that branch.
- H1 PR draft: `/private/tmp/codeshell-h1-pr.md`.
- T3 PR draft: `/private/tmp/codeshell-t3-pr.md`.
- Protocol investigation (T1/C3/C4): `/private/tmp/codeshell-protocol-inventory-20261110.md`.
- G1 exact inventory: `/private/tmp/codeshell-g1-count-inventory-20261110.json`.
- Candidate branch: `codex/architecture/review-candidate-20261110`, currently at `c46cc0d38` (T1/T3/H1/G1/H2/T2/R1/E1/G2/C3-tests/G4 plus status and D2 report); later independent commits will be cherry-picked onto it. Original task refs remain available for review and later PR publication.

## Additional review evidence

- Original task refs remain available in the coordinating repository; cherry-pick hashes on the candidate differ. No checklist item is marked ✅ because no real PR exists.
- PR drafts currently `/private/tmp/codeshell-{t1,t2,t3,h1,h2,g1,g2,g4,r1,e1}-pr.md`; final handoff will preserve copies in the candidate repository.
- R1 shard check was repeated on a clean detached checkout of its committed ref after an initial unstaged-deletion ENOENT; the clean check passed (2664 files).
- E1 package survey diagnostics are transitive source-test compilation counts, not package-owned error counts: browser-devtools1, cdp0, chat98, coding6, core248, desktop634, optimization-lab14, pet25, server556, tui4, web65, retired arena3. Only host/link join the CI check.
