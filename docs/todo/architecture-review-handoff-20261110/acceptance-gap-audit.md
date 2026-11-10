# Architecture implementation acceptance-gap audit — 2026-11-10

This is an Astra implementation self-check for the coordinating host, **not CC review**. It is read-only with respect to the candidate source, HEAD and dist. The only output created by this audit is this report. No CLI agent, PR, merge or source edit was started.

## Scope and conclusion

- Checklist read in full, including dependencies, exclusions, acceptance and appendices: `docs/todo/architecture-review-tasks-20261110.md`.
- Reviewed candidate: `b7062fba47282d823e52bb29ea81aed686b0eb3f` in `/private/tmp/codeshell-architecture-review-20261110`.
- Original baseline: `fcd8406d51bf34696417dd9dd90c609f1d5ca640`.
- Also read the implementation status, all 21 task PR drafts under `docs/todo/architecture-review-handoff-20261110/`, the D2 mismatch report, and final shard/smoke evidence available at audit time.
- No additional definite production-code omission was found beyond the already-known C4 strict-default correction. This does **not** establish correctness or replace the independent CC review.
- The actionable remaining work is a finite set of missed changed-test executions, integration of the already-prepared D1/C4 follow-ups, and accurate final-ref evidence/handoff. No §7/§8 work should be added.
- D2's 21-error stop, E3's absent user decision, Bun registry failure, PR approval denial, native/browser/listener restrictions and failed/incomplete checks remain genuine limitations; they cannot be marked complete merely because implementation exists.

## Concrete remaining actions available in this sandbox

### A. Run changed tests that the stopped Desktop/rest partition never reached

The final shard log headers were compared with changed test paths. Shard 3 stopped before reaching the following changed Desktop tests. Earlier task-branch passes are useful evidence but do not cover the integrated candidate. The coordinator has agreed to run this finite group after D1/C4 integration:

```sh
TMPDIR=/private/tmp/codeshell-architecture-tmp node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/desktop/src/main/browser-driver/automation-host.test.ts \
  ./packages/desktop/src/main/browser-driver/scenario-e2e.test.ts \
  ./packages/desktop/src/main/desktop-shutdown.test.ts \
  ./packages/desktop/src/main/third-party-notices.test.ts \
  ./packages/desktop/src/preload/external-runtime-routing.test.ts
```

The following E1-changed Host tests also lacked final-run headers when checked. They can be attempted separately, preserving any local-server rejection as failure rather than stopping the unrelated group:

```sh
TMPDIR=/private/tmp/codeshell-architecture-tmp node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/host/src/services/model-connection-probe.test.ts
```

`packages/desktop/src/main/agent-bridge.mcp-credentials.test.ts` is another missed changed file and belongs in the D1 follow-up targeted run (B below). The architecture/package/ESLint contracts absent from stopped partition logs already have the separate final 47/0 run; they are not an overlooked test group. `packages/core/src/plugins/installer/pruneDisabled.test.ts` should be checked against shard 31 once that still-pending run completes, then targeted only if the run never reaches it. It is not yet a confirmed omission.

`scroll.integration.test.ts` also was not reached by final shard 3, but its browser execution was attempted on the R2 branch and denied at launch; final dedicated Puppeteer/Playwright partitions independently reproduce the launch restriction. Keep this path explicitly unverified for a capable runner rather than claiming equivalent coverage from the passing pure helpers.

### B. Integrate prepared follow-ups and attach new results to the actual final SHA

- D1 follow-up `e563a6944819b05b8ff6635cfdf4d5dc834cc6ae` on `codex/desktop/d1-parse-worker-line` adds one source comment and existing-file regression tests, with no production behavior change. Its nine-file targeted run is 113/0. It deeply freezes shared decoded objects and nested params, exercises the actual snapshot store and projection path, and has a successful negative mutation probe. Integrate only after the pinned shard readers finish, then rerun those affected tests at the new candidate SHA.
- C4 strict defaults are being corrected by the h1 worker. Audit the resulting patch/commit and run the protocol tests plus its meaningful negative probe after integration. The current b706 helper results cannot certify a subsequently changed helper. Preserve C3's added query tests during integration.
- Record the new final SHA alongside the exact follow-up commit IDs and logs. Existing b706 shard results remain results for b706; do not relabel them as runs of the new SHA. It is reasonable to retain unaffected evidence with an explicit file-impact explanation for test-only follow-ups.
- Existing full build/typecheck/lint/guards and the three required contracts passed on b706. Run the appropriate final affected checks after integration; rebuild dependency dist first if any runtime Core source changes. Keep package-release serial with all dist readers. Do not repeat unrelated expensive checks without a new change or unresolved concern.

### C. Finish the pending shard sweep and preserve failed/incomplete results exactly

At this report's snapshot, core `current.json` points to shard 2; shards 31/32 remain pending. The coordinator already owns this sweep. Its remaining attempts are necessary, not optional follow-up work.

- Desktop evidence: `/private/tmp/codeshell-final-desktop-shards-20261110/summary.md` and `analysis.md`; 23 assigned partitions attempted, latest 14 PASS / 8 FAIL / 1 INCOMPLETE_TIMEOUT, with both shard-11 attempts retained.
- Server/rest evidence: `/private/tmp/codeshell-final-rest-shards-20261110/summary.md` and `results.json`; all 10 assigned partitions attempted. 4/5/24 incomplete, 25/27/28/29/37 fail, 26/30 pass. Node shard 37 has 537 tests, 531 pass, 6 fail; it is not a Bun-format missing-summary case.
- Core evidence: `/private/tmp/codeshell-final-core-shards-20261110/`; 0 and 1 finished, later results pending at audit time. Shard 1 has 2257 pass / 196 fail / 3 skip. Raw repeated `(fail)` recap lines must not be counted as distinct cases.
- Keep nested child-suite totals out of incomplete outer-shard totals. In particular, stopped shard 3 and shard 4 contain nested summaries that are not completion receipts.
- Representative baseline reproductions support only the compared failure cases. Preserve the unresolved external-runtime cases and other unclassified failures as unresolved, not as a blanket environment exemption.

### D. Finish reviewable handoff artifacts

The status file still describes final validation as running. Before handoff, update it with final candidate SHA, original and integrated task refs, each final partition's status/log, all exact blockers, and the pending-versus-integrated D1/C4 state.

Preserve an incremental Git bundle containing the original task branches, candidate and follow-ups; verify the bundle against the declared baseline, record its SHA256 and import instructions. This matters because implementation is in temporary task-owned repositories rather than the user's read-only requested worktree. This is preservation work, not permission to modify another checkout.

Minor PR-draft synchronization still needed when the final commits are known:

- C4: describe strict default behavior and its follow-up proof, not only the earlier broad fake migration.
- D1: replace the old “cherry-pick the single D1 commit” sentence with the actual two-commit plan.
- G4: preserve the original measured 73-file evidence while appending the post-R1 ratchet of 72 and its commit.
- Append integrated final validation references without erasing earlier task-branch failures or implying publication. All PR URLs remain absent; no checklist `✅ PR#` marker is warranted.

## Gap closed during this audit

The final smoke record initially lacked a separate successful Chrome extension build at b706. The full Desktop build failed at the CUA download before that result could be inferred. The coordinator has now run `bun run scripts/build-chrome-extension.ts` in W2 at exact b706, exit 0, with clean worktree. Evidence: `/private/tmp/codeshell-final-chrome-extension.log` and the updated `/private/tmp/codeshell-final-smoke-results.json`. This gap is closed. Full Desktop build remains failed; independent component successes do not turn it green.

The smoke JSON now also records the full Electron suite attempt: first managed-cloud fixture cannot listen on loopback (`EPERM`). Recovery-only smoke fails earlier at DiskManagement, so neither reaches or confirms the known main-CI “promise was garbage collected” location. There is no PR job available to rerun after the explicit PR-creation approval rejection.

## Checklist-by-checklist audit

| Item | Evidence checked / remaining acceptance distinction |
|---|---|
| T1 | Red-to-green forwarding regression and explicit field map; typed ChatSession; single-Engine path unchanged. Native/worker batch preflights attempted but blocked before private-Keychain/interactive setup; not passing smoke. |
| T2 | 62 declarations after T1, 50 files; exact nine-package source scope; negative rule probes; one genuine TurnLoop typing adjustment below the ten-real-error split threshold. Tests/fakes/TUI scope was not expanded. |
| T3 | Both settings mutations use existing locking machinery; race/corruption/YAML/permissions covered in 37 targeted tests. Disk identity failures reproduced without T1/T3 on baseline. |
| G1 | Full scan counts 472 main / 481 preload; older missed accountFeatures pair explains difference from checklist. Positive/negative/exclusion probes; IPC contract untouched. |
| G2 | Eight-layer AST guard and exact allowlists; import/re-export/resolution/type-only/exclusion/stale-entry probes. No unjustified budget increase. |
| G3 | Exact manifest dependency fields, declared source imports, cross-workspace relative-import restrictions; web type-only exceptions and negative probes. H3 removes the six temporary server-source exceptions. |
| G4 | Initial 73 includes JS fixtures missing from checklist's 66 TS count; negative new-file probes. Post-R1 ratchet is 72, with addendum needed in original draft. |
| C1 | Distinct path semantics and public re-exports preserved; process-tree primitive relocation prevents a new utils/runtime cycle; targeted proof and export guards present. |
| C2 | Mechanical imports removed with 35 declaration AST comparisons; G2 allowance 29→18 and cycles 6→2; golden unchanged; remaining behavioral dependencies correctly out of scope. |
| C3 | Two separate commits/branches, tests before extraction; 31 added frozen cases, 19 named queries plus default rather than checklist's miscount; 51/0 before/after; server 4892→4246 and budget 5000→4500. Protocol failure set compared. |
| C4 | Shared internal helper, no runtime Engine/compile import, no public export, 54 files migrated and protocol double casts zero. Known strict-default correction and combined rerun remain active, not a new audit discovery. |
| H1 | Four environment sites, ten AST scenarios, final spawned values equivalent; intermediate Desktop difference disclosed. Capability-default differences recorded without redesign. Loop implementation gives zero literal undefined hits; semantic acceptance explained. |
| H2 | Focused no-React subentries; web root exports unchanged; packed export imports succeed. Overall package-release and server-smoke fail on local listener denial. |
| H3 | Clean shared Panel closure; 162 verbatim moved lines, retained exports and six source-relative imports removed. Build/import proof exists; overall package-release remains failed. |
| D1 | Parse-once carrier includes explicit failed-parse state, original ordering/early returns, newer quick-chat route. Follow-up verifies shared-object immutability; integrate and rerun at final SHA. |
| D2 | 21 concrete diagnostics exceed the 20-item guardrail; source reverted and inventory retained. Stopping before preload/main pilot is correct, not an actionable unauthorized omission. |
| D3 | Single ExternalRuntime pilot; lifecycle remains at first-window startup and original shutdown point. Index 4589→4576; 5000 cap is correct because ceil((4576+100)/500)*500 = 5000. Do not migrate extra domains to force 4500. |
| E1 | Host/Link test configs and CI invocation; 97 tests/10 files and negative TS2322 probe. Other-package survey present; two changed Host files need the limited final attempt in A. |
| E2 | Required current docs/comments refreshed; history bodies and archify output unchanged; actual release/workspace counts verified; T1 described without fabricated PR/merge. |
| E3 | User decision absent. Do not delete, archive speculatively or rewrite history. Remains pending rather than “implemented.” |
| R1 | Arena source/config/current docs removed, regression guards and last-containing SHA retained; old current references absent apart from known Bun lock records. Lock regeneration remains externally blocked. |
| R2 | Eleven production declarations byte-identical and browser-safe, electron-cdp compatibility path retained, typed host fakes, removed coverage enumerated, 12 direct pure-helper tests. Final browser runs fail at launch; limited host/notices tests in A and successful extension gap closure noted. |

## Items deliberately not added to scope

No changes are proposed for §7 undecided architecture/product items, §8 withdrawn work, independent Mimi/Pet work, remaining behavioral import edges, unused public extension exports, unrelated persistence writers or baseline diskutil behavior. No source change is justified merely to make a sandbox failure green. The owner must make the D2/E3 decisions, and a capable host/CI must resolve the known dependency/publication/native-environment limitations before full acceptance can be claimed.


## Coordinator closure of actionable gaps

This audit is retained as the pre-followup snapshot. Final code candidate is d65afec5b2af55ee3ed4f9de657005edd90fb0ea. D1 and both C4 followups are integrated. All38 initial partitions finished or were explicitly stopped as documented (16 passed,18 failed,4 incomplete); Core's five partitions completed with failure reports. The missed changed tests were cleanly rerun: D1 113/0, Desktop54/0, Host14/0. Final protocol428/11 matches the known11-case failure set; all31 C3 additions pass. Final workspace/test typechecks and47 contracts pass. Initial dist-reader scheduling overlap and the separately discovered C3/C4 fixture omission are preserved in the adjacent evidence. Publication, D2/E3, lockfile and native/CI acceptance blockers remain.
