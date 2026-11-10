# Architecture review implementation status — 2026-11-10

This is an implementation/validation handoff, not CC review and not a completion claim. No PR has been merged. The original checklist is preserved without false ✅ markers.

## Candidate and isolation

- Source baseline: `fcd8406d51bf34696417dd9dd90c609f1d5ca640` (the user-provided, fetched main).
- Final code candidate: `d65afec5b2af55ee3ed4f9de657005edd90fb0ea`, branch `codex/architecture/review-candidate-20261110`. The final handoff commit adds only these documents/receipts; its exact HEAD is recorded in the delivery manifest.
- All38 initial CI partition attempts used fixed `b7062fba47282d823e52bb29ea81aed686b0eb3f`; final affected checks use d65afec5b. Results are not relabeled across refs.
- Repository: `/private/tmp/codeshell-architecture-review-20261110`. User-requested worktree `/Users/admin/Documents/个人学习/代码学习/codeshell-worktrees/architecture-review-20261110` is outside this session's write roots; its attempted write was rejected by approval settings. It and primary checkout/other Mimi worktrees remain untouched.
- The temporary repository is a shared clone; new refs/objects are preserved in the verified incremental bundle described below. Baseline objects remain in the original repository.
- Local `origin/main` initially inherited the primary checkout's stale `2d1c0b638`. It was explicitly refreshed from the requested worktree's already-fetched tracking ref to `fcd8406d5`; all task code was based on `fcd8406d5` throughout.
- E3 decision source: original requested worktree `docs/todo/architecture-review-e3-decision-20261110.md`. Absence is not consent.

Worktree aliases (sequentially reused only by this task): W0 = coordinating repository above; W1 = `/private/tmp/codeshell-architecture-h1`; W2 = `/private/tmp/codeshell-architecture-h2`; W3 = `/private/tmp/codeshell-architecture-t3`; W4 = `/private/tmp/codeshell-architecture-g1`; W5 = `/private/tmp/codeshell-architecture-d2`. Task refs are preserved even where the worktree now checks out a later task.

## Task ledger

All PR URLs: **none**. GitHub create_pull_request explicitly returned `MCP tool call requires approval, but approval policy is never`; no alternate route was used to bypass that denial. T1 branch was pushed; other publication is not claimed. PR bodies are preserved in [handoff drafts](architecture-review-handoff-20261110/).

| Item | Original task commit(s) | Branch | Worktree | Intended PR base | State | Evidence / verification |
|---|---|---|---|---|---|---|
| T1 | 68eca438f | codex/architecture/t1-run-option-forwarding | W0 | main@fcd8406d5 | Implemented | red 5/1 → green 6/0; build/typecheck; targeted+contracts36/0; forwarding negative compile probe |
| T2 | 594fe4d81 | codex/architecture/t2-typed-declarations | W3 | T1 | Implemented | 62 declarations/50 files; build/typecheck/lint;18 targeted+27 contracts; guard negative probes |
| T3 | 0e27d8f4d | codex/core/t3-settings-locks | W3 | main | Implemented | 37 targeted+27 contracts; build/typecheck/lint; plugins360/2 with baseline-reproduced diskutil failures |
| G1 | dcf469b3a | codex/architecture/g1-ipc-budget-scan | W4 | main | Implemented | 472 main/481 preload; positive/exclusion/negative probes; contracts27/0 |
| G2 | 6d7aa7e1f | codex/architecture/g2-core-layers | W4 | G1 | Implemented | 29 upward/6 same-layer initial baseline; AST syntax/resolution negative probes; contracts28/0 |
| G3 | 4b1345783 | codex/architecture/g3-workspace-import-guards | W2 | R2 (equivalent parent1af1317f7) | Implemented | exact manifest fields; declared imports;3 new ESLint probes; contracts29/0; lint0/90;2 negative package probes |
| G4 | 63c19a06e + f170248a8 | codex/architecture/g4-mock-module-ratchet; codex/architecture/g4-post-removal-ratchet | W4/W0 | G2; combined candidate5cbf73d1b | Implemented | 73 initial files incl7 JS fixtures →72 after R1; negative new TS/MJS probes; final guard6/0 |
| C1 | 7982e8767 | codex/core/c1-path-helpers | W4 | G4 | Implemented | path semantics preserved; targeted122/0, contracts29/0, exports/build/typecheck; G2 29→28/6→5; large partitions failed/incomplete; attribution recorded separately |
| C2 | b7e37d007 | codex/core/c2-lower-mechanical-dependencies | W4 | C1 | Implemented | 35 declaration AST comparisons;158 targeted+188 projection/automation+29 contracts; G2 28→18/5→2; build/typecheck/lint |
| C3 PR1 | b737ca119 | codex/protocol/c3-query-contract-tests | W2 | main | Implemented | 31 new frozen protocol cases; four query suites51/0 before extraction; contracts27/0 |
| C3 PR2 | 924d58afc | codex/protocol/c3-query-registry | W2 | C3 PR1 | Implemented | 19 handlers exactly match transformed originals; server4892→4246/budget5000→4500; query51/0, golden+contracts; full protocol425/11 = baseline failure set |
| C4 | ccd556101 + 0a6fa12df + f38da41f8 | codex/testing/c4-shared-engine-fake; codex/testing/c4-strict-fake-defaults; codex/testing/c4-query-fixture-integration | W3/W1 | T1; C4; combined f31986b4 with C3 | Implemented, integrated and retested | strict65-method table; explicit fixture absences; final428/11 exact known failure set;31 C3 additions pass; no unexpected/hook/dispose logger errors; negative setter probe |
| H1 | e2952dff5 | codex/server/h1-headless-worker-env | W1 | main | Implemented | 10 AST env comparisons;46 targeted+27 contracts; build/desktop/mobile typecheck; HTTP/WS blocked at listen |
| H2 | 1935b9c78 | codex/web/h2-focused-server-imports | W2 | main | Implemented | focused replay/coverage exports;45 targeted+contracts;build/typecheck;package-release52 imports then HTTP EPERM |
| H3 | 188882aec | codex/web/h3-panel-contracts | W2 | codex/architecture/h3-dependencies@c55c08829 (G3+H2) | Implemented | clean type closure; verbatim moved162 lines;121 tests/6files;build/typecheck/lint;Desktop main/renderer/mobile pass;package-release53 imports then HTTP EPERM |
| D1 | fa7c752cd + e563a6944 | codex/desktop/d1-parse-worker-line | W3 | codex/architecture/d1-dependencies@9c77751df | Implemented, both commits integrated | 22 lines→22 parses; deep-frozen shared input; final113/0 across9 files;29 task contracts; Desktop main build/typecheck/lint |
| D2 | 709d09652 | codex/desktop/d2-preload-type-contract | W5 | main | Guardrail stop; owner decision required | 21 distinct diagnostics exceeds20; source reverted; detailed report committed; no main pilot edits |
| D3 | 4207e8aa8 | codex/desktop/d3-runtime-module-registry | W1 | R2 | Implemented | only ExternalRuntime domain;start/dispose order and134 targeted/contracts/source-reader tests;build/typecheck/lint;index4589→4576 so5000 budget remains per formula |
| E1 | 8ca3bb3d4 | codex/testing/e1-host-link-typecheck | W5 | main | Implemented | host/link test tsc zero;97 tests/10files;negative TS2322 probe; CI step preserves job names; other-package survey recorded |
| E2 | 172ad8bba | codex/docs/e2-architecture-drift | W4 | codex/architecture/e2-dependencies@27373f5e7 | Implemented | 9 docs/comment/description paths;history bodies unchanged;12 workspaces/10 public release units/373 commits;contracts30/0; no fabricated T1 PR/merge |
| E3 | — | — | original requested worktree | user decision | Awaiting explicit decision | Decision file absent at latest check. No evidence removed; no Git history rewritten. |
| R1 | f667c728e | codex/architecture/r1-remove-arena | W1 | main | Implemented except Bun lockfile regeneration | build/typecheck/lint0/90;contracts32+preserved guards72;clean committed shards2664;package-release HTTP EPERM; registry refused Bun install |
| R2 | b92e6dfa2 | codex/architecture/r2-remove-legacy-cdp | W1 | R1 | Implemented except Bun lockfile regeneration | 11 production symbols retained;32 host+12 pure helper+27 contract tests;shards2660;Desktop main/renderer/mobile/extension build;browser launch blocked;package-release HTTP EPERM |

## Final validation results

- All38 CI unit partitions attempted at b7062fba4: **16 passed / 18 failed / 4 incomplete**. Incomplete:3 (600-second cap),4,5,24 (listener failure leaves fixture waiting). Shard11 first failed11/1; full retry passed12/0, with both attempts retained. Exact per-partition counts and failure inventories: [Core](architecture-review-handoff-20261110/final-core-shards.md), [Desktop](architecture-review-handoff-20261110/final-desktop-shards.md), [Server/rest](architecture-review-handoff-20261110/final-rest-shards.md). No incomplete/nested summary is treated as a whole-shard pass.
- `bun run test:package-release` on combined implementation: all clean builds/packs/extracts, strict NodeNext declarations, **53 runtime imports** and strict owner-auth consumer passed; final packed owner HTTP lifecycle failed with `listen EPERM 127.0.0.1`. Overall result is **failed**. Its public package/runtime sources are unchanged by the later test followups.
- After D1/C4 strict integration at f31986b4, `bun run build` and full root `bun run typecheck` passed. Final d65afec5b adds only the query-test fallback field; its `bun run typecheck:workspaces` and `bun run typecheck:tests` both passed with stable dist. `bun run lint` is0 errors/90 warnings; guards pass (2660 files, largest764, engine bypass pass).
- At final d65afec5b: three required repository contracts + composition golden + ESLint guard suite + Core export contract: **47/0 across6 files**,573 assertions. Golden fixtures unchanged.
- At final d65afec5b: D1 **113/0**, missed Desktop tests **54/0**, Host tests **14/0**; total **181/0 across16 files**, with guarded completion receipts. [Exact followup results](architecture-review-handoff-20261110/final-followup-summary.md).
- At final d65afec5b: complete protocol **428 passed / 11 failed**,439 cases/74 files. Failure names exactly match the original C4 baseline; all31 C3 additions pass. Actual logger output has zero unexpected fake/hook/disposal diagnostics. [Protocol result](architecture-review-handoff-20261110/c4-final-integrated-summary.md).
- Real integration regression found and fixed: strict C4 defaults exposed absent `getComposition` in C3's legacy query fixture (397/42 first run). One explicit fixture absence fixes the31 extra failures. This was not labeled an environment failure. C3 count corrected by AST-expanded inventory: baseline2→33 cases, therefore31 added, not the earlier30.
- Scheduling mistake retained: root `typecheck` internally rebuilds; one concurrently started test-typecheck saw transient missing Link declarations. All affected readers were rerun after builds ended, and first receipts are labeled scheduling-overlap, not accepted passes. [Receipt](architecture-review-handoff-20261110/final-followup-scheduling-note.json).
- Native/browser/server smokes at b706 use separate W2. Desktop main, renderer, mobile and Chrome extension builds passed. Full Desktop build failed pinned CUA download; Server smoke failed listen EPERM; full Electron suite failed its first loopback fixture; recovery-only smoke failed diskutil seed; native/worker operation-batch scripts stopped at private metadata-reference preflight. Browser partitions33–35 failed browser launch. [Smoke exits](architecture-review-handoff-20261110/final-smoke-results.json). None is represented as passing E2E.

The only b706→d65 changes are D1 test/fixture coverage plus one comment, the internal test-only fake helper/fixtures and its query-fixture correction. Production behavior/public package exports remain unchanged. The full38-partition sweep is not claimed to have run again on d65; affected tests and final contract/type/lint checks are recorded separately.

## Genuine blockers and evidence differences

- D2: [21 concrete mismatches](architecture-review-d2-mismatches-20261110.md); no fixes beyond the task's20-item cap. Owner decision needed before satisfying the preload/main pilot acceptance.
- E3: explicit user destination decision still missing. No audit evidence has been deleted.
- R1/R2 lockfile: Bun could not fetch registry metadata (`ConnectionRefused` / `FailedToOpenSocket`) after frozen/lockfile-only/cached/prefer-offline attempts. `bun.lock` is unchanged, so retired workspace entries remain. A network-capable host must regenerate with Bun and review only expected removal; no handwritten lockfile or dependency upgrades.
- macOS disk identity calls fail because DiskManagement/DiskArbitration are unavailable. T3/C4 original-baseline comparison logs reproduce the relevant Engine failures. Local TCP/Unix sockets are denied (Node EPERM, Bun often EADDRINUSE). Unexplained failures must still be compared individually, not blanket-attributed to the environment.
- Full Desktop build cannot download the pinned CUA driver; an existing checksum-matching cached archive also fails its strict signature check. No verification bypass was introduced. Puppeteer/Playwright browser startup is denied in this sandbox. Electron recovery fails at diskutil seed, before the known promise-garbage-collected location. No GitHub Electron job exists to rerun because PR creation is blocked; no14-check green claim.
- T1's two native operation-batch scripts require a private default-Keychain metadata reference and interactive native approval. No real user credentials/reference have been read or synthesized. Final preflight attempts are recorded separately.
- G1 actual preload count481 includes2 accountFeatures calls missed by the old ipc.invoke scan; checklist479 was incomplete. G4 initial73 includes7 JS fixture files beyond the checklist's66 TS files. C3 actually has19 named query cases plus default.
- C1 needed a minimal additional relocation of shared process-tree primitives to avoid introducing runtime↔utils; implementations/re-exports preserved. C2 leaves18 explicitly out-of-scope behavioral upward edges and2 I/O-dependent same-layer cycles.
- D3 only removes13 index lines (createWindow54; module lets31→29). Dropping5000→4500 would violate the required100-line headroom; the existing5000 cap is correctly retained.

## Publication and CC recovery

No agent CLI or CC was started. Host coordinator must initiate independent CC review of the complete final candidate, including integration resolutions (T3/C1 persist-active-model import; C3/C4 query test import). Original task refs and explicit stacked bases above are retained. After dependencies are approved and merge is authorized in a later phase, rebase in dependency order: T1→T2/C4; G1→G2→G4→C1→C2; R1→R2→G3, plus H2→H3; C3 tests→C3 migration; D1/D3/E2 on their recorded dependency refs. Refresh main and rerun exact-candidate required CI then; no merge is authorized in this phase.

## Delivery and resumption

- Final code ref: `d65afec5b2af55ee3ed4f9de657005edd90fb0ea`. Integration followups: D1 `3cf8228f2`, C4 strict `f31986b42`, query fallback `d65afec5b`. Original task commits/branches remain in the table.
- Final incremental bundle: `/private/tmp/codeshell-architecture-review-20261110-final.bundle`. It includes all task refs plus final handoff documents and requires baseline fcd8406d5. Verify with `git bundle verify <bundle>` in a repository containing that baseline, then fetch its `refs/heads/codex/*` into unused task refs and create a fresh review worktree. Do not overwrite another checkout or its untracked checklist.
- Raw validation archive: `/private/tmp/codeshell-architecture-review-20261110-validation.tar.gz`. Only this task's new logs/receipts are archived; no E3 evidence is moved or deleted.
- Delivery manifest: `/private/tmp/codeshell-architecture-review-20261110-delivery.json`; records the actual final handoff HEAD, all branch SHAs, bundle/archive SHA256 and paths. The bundle is built after the metadata commit, so its hash lives in this external manifest rather than a circular self-hashed commit.
- [CC handoff](architecture-review-handoff-20261110/cc-review-handoff.md) names integration seams and validation limits. Host coordinator starts CC separately. No source change, PR or main merge is pending in this sandbox other than the explicit blockers above; remaining acceptance needs owner decisions, Bun registry access, publication permission and a capable native/CI runner.

The primary and requested worktrees still contain only their original untracked checklist; all three checklist copies have SHA256 `6c1558f604a1024e8695fb937c6fc54bf13198016aa1c1f08f4e9388667aa81d`. No original evidence, Mimi worktree or Git history was changed. No task receives a false ✅/PR marker.
