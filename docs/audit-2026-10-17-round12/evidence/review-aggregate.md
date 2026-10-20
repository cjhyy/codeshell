# Read-only aggregate review — round 12

Reviewed README, aggregate findings/candidates/related observations/validation/source pins/worker integrity, the metadata assembler, the four scope reports, and the six preserved raw logs and exits. Result: **pass; no actionable aggregate correction identified**. No product tests or assembler were rerun during this review.

## Classification and report correspondence

The structured records contain exactly **4 distinct P3 findings, 2 distinct candidates, and 1 old-related observation**, with seven unique identifiers. These match README and the scope reports. Formal findings point to the correct report headings:

| Finding | Report heading line |
| --- | --- |
| TUI-R12-01 | `tui-input.md:5` |
| TUI-R12-02 | `tui-input.md:13` |
| DESKTOP-R12-01 | `desktop.md:7` |
| PATCH-R12-01 | `patch.md:5` |

The ANSI width discrepancy remains a candidate because the identified current consumer does not read width. The Write byte label remains source-only. The header-only diff identity loss is explicitly associated with old R2-10 and contributes neither a new finding nor a candidate. Root schedule/time scope contributes zero findings and zero candidates.

## First-run accounting

Independently parsed each raw log's pass/expect counts and guarded completion footer, checked its recorded SHA256 and corresponding exit artifact, and confirmed that the runtime raw-log inventory is exactly these six distinct files:

| First shard | Pass | Expectations | Classification |
| --- | ---: | ---: | --- |
| root-time-display-existing | 12 | 16 | Existing baseline |
| tui-key-events | 7 | 121 | Focused observations/controls |
| tui-text-data | 7 | 165 | Focused observations/controls |
| desktop-display-contracts | 9 | 41 | Focused observations/controls |
| desktop-existing-metadata | 23 | 39 | Existing baseline |
| patch-leading-context | 8 | 31 | Focused observations/controls |
| Total | **66** | **413** | **35 existing + 31 focused** |

All six have exit 0, 0 failures, 0 skipped, and a Completed footer. Shared logs for the two TUI findings and the Desktop finding/old-related observation are counted once. Characterization assertions include wrong behavior; aggregate materials do not claim fixes or a complete suite. First-run preservation is represented by the retained receipts and documentation; this review did not create another execution.

## Hashes, links and assembler boundaries

- Independently verified all **69 selected source pins** against frozen Git blobs at `d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`, byte counts, and current working-tree equality flags. All current source bytes still match. No unresolved source reference is recorded.
- Independently reconstructed all **70 worker source-check rows** from the four worker manifests and verified each frozen-blob SHA256. Their multiset exactly matches `source-manifest.json`; overlap is intentional, not 70 unique source files.
- Independently reconstructed and checked all **45 worker artifact-check rows**, including each receipt's byte count and SHA256. They exactly match `worker-integrity.json`, whose `productTestsRerun` flag is false.
- All **79 local Markdown links** in README and the four scope reports resolve after removing line anchors. Formal report-line references contain the expected heading identifiers. Remote official-document links remain source citations, not live producer captures.
- Read `assemble-audit.py` without executing it. Its subprocess calls read Git blobs/revisions; it parses existing worker JSON/log/exit data, computes hashes, and writes audit metadata. It invokes no Bun runner, product module, build, or test. Its explicit six-log list and count assertions match the retained data. The evidence index may be refreshed after this review file is added, as planned; this review does not require its own file to appear in a prior index snapshot.

## Evidence limits and latest integration metadata

The aggregate consistently separates actual pure parser/helper/event execution from static consumers. It retains the TUI text shard's pre-import Core-barrel redirection and zero-call throwing OSC stub, without claiming full Core/Ink validation. Desktop Git-format inputs are synthetic standard-format strings, not installed Git captures. Patch applier/tool/file writes and TUI dispatcher/Button/TextInput are not executed. Root executes only existing relativeTime/timezone tests; scheduleModel, localization and scheduler backend remain source-only. Prior failed directions remain skipped; metadata/navigation transcriptions are not counted as Bun failures.

Also checked the `stringWidth.ts` runtime selection and the text fixture's imports after root's scope clarification: the preserved Bun 1.3.11 run uses the production `stringWidth` export, which selects `Bun.stringWidth` when available. The candidate's actual width comparison does not validate the JavaScript fallback. Existing aggregate wording says actual `stringWidth` output and makes no fallback claim; root will retain this runtime detail in final QC. No fallback test or alternative validation was performed.

Reviewed the latest README integration paragraph plus `integration-plan.json` and `integration-final-before.json`. The integration plan records end-fetch completion, unchanged reviewed main at the frozen commit, and the owned-directory-only disjoint fast-forward constraint. The initial and final-before snapshot JSON objects compare exactly equal, including HEAD, porcelain hex, tracked/staged diff hashes and four untracked file records. This supports the recorded preintegration preservation state; it is not a post-merge preservation receipt or a claim that integration already completed. Root still owns final integration and after-state verification. No product runtime was resumed for these metadata additions.

Only this review file was written. No product, other report, Git state, raw log, exit receipt, or worker artifact was modified. This review contributes zero runtime tests to the totals.
