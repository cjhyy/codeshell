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
| T2 | In progress at T3 worktree | `codex/architecture/t2-typed-declarations`, based on T1 | No PR / T1 branch | AST inventory, annotations and ESLint guard |
| T3 | Implemented; environment-blocked full acceptance | `codex/core/t3-settings-locks` / `0e27d8f4d113c17a2d4339eb48fdb749fa069343` | No PR / main | build, workspace typecheck, lint 0/98, shards and engine guard; targeted 37/0 and contracts 27/0 |
| G1 | Implemented; final contract rerun/commit in progress at `/private/tmp/codeshell-architecture-g1` | `codex/architecture/g1-ipc-budget-scan` | No PR / main | 472 main / 481 preload; negative main/preload and exclusion probes passed; original preload missed 2 existing ipcRenderer calls |
| G2 | Next after G1 in its worktree | `codex/architecture/g2-core-layers` | No PR / G1 branch | — |
| G3 | Pending R1/R2 | — | — | — |
| G4 | Pending | — | — | — |
| C1 | Pending G2 | — | — | — |
| C2 | Pending G2/C1 | — | — | — |
| C3 tests | Coverage inventory in progress | — | — | Separate test and migration PRs required |
| C3 migration | Pending tests | — | — | — |
| C4 | Pending | — | — | — |
| H1 | Implemented; environment-blocked full acceptance | `codex/server/h1-headless-worker-env` / `e2952dff58061a039a8ed36a8c60405820553f5b` | No PR / main | build, Desktop/mobile typecheck, ESLint, shard guard; contracts 27/0, targeted 46/0, 10 env comparisons passed |
| H2 | Implemented; validation running at `/private/tmp/codeshell-architecture-h2` | `codex/web/h2-focused-server-imports` | No PR / main | focused exports/imports + AST guard; build underway |
| H3 | Pending H2/G3 | — | — | — |
| D1 | Pending | — | — | — |
| D2 | Pending | — | — | Enumerate and stop fixing if more than 20 mismatches |
| D3 | Pending | — | — | One domain; exclude Pet and AgentBridge |
| E1 | Pending | — | — | host/link only |
| E2 | Pending R1/R2/T1 | — | — | — |
| E3 | Awaiting user decision | — | — | Preserve all evidence |
| R1 | In progress in former H1 worktree | `codex/architecture/r1-remove-arena` | No PR / main | — |
| R2 | Pending R1 | — | — | — |

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
- Candidate branch: `codex/architecture/review-candidate-20261110`, currently starting from T1; subsequent independent commits will be cherry-picked onto it. Original task refs remain available for review and later PR publication.
