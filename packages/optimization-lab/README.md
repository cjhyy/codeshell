# Optimization Lab

Private, experimental CodeShell capability. P1a runs a bounded, single-Skill text
experiment: original development trials, one reflection producing 1–2 candidate
bodies, development screening, fixed paired holdout trials, and immutable JSON /
Markdown effect, diff and cost reports. Semantic criteria use human grading;
model judging and ordinary-chat adoption are deferred.

## Desktop workflow

1. Set **user-scope** `featureFlags.optimization_lab` to `true` and restart the
   Desktop worker/application. The default is off; project settings cannot enable
   this worker-wide module. TUI and server do not load it.
2. Open **Optimization Lab** in the sidebar with a trusted local project selected.
   Choose a single-file Skill and eligible target/optimizer text connections.
3. Edit the dataset form or raw JSON, or import a local JSON file. Add/copy cases,
   edit rubric and hard assertions, then validate/freeze and prepare a plan.
   Drafts stay isolated per project in the current window; export JSON to retain
   them across restarts. Review external data,
   model endpoints, request/time limits, final-stage allocation and unknown bounds.
4. Confirm the native authorization dialog, then explicitly start. Preparing,
   cancelling authorization and granting alone send no model requests.
5. At each human-grading checkpoint, export JSON, fill reviewer/verdict/evidence,
   and import it. Import never resumes execution: use **Continue** separately.
6. Read/export the report. Stop is terminal; revocation aborts active work.
   Interrupted work requires explicit continuation; budget exhaustion requires
   renewed authorization. Renewal preserves all consumption and unknown attempts.

Closing the page leaves the worker running. Quitting/restarting the worker does
not replay paid steps. Reports survive restart. Candidates remain outside Skill
scanner roots and do not change active Skill, Memory or dream files.

## Current adapter and evidence limits

Supported provider kinds are OpenAI-compatible, OpenRouter and Anthropic, through
reviewed non-streaming, non-reasoning text adapters. Unsupported thinking/model
families, arbitrary headers, auth commands, extra parameters, tools and images
fail preflight. Discovery explains ineligible connections. The exact selected
connection is required; it cannot silently fall back to the default.

All actual HTTP attempts, including SDK retries, pass the persisted budget gate.
Requests and operation time windows are reserved before dispatch. Unknown usage
retains reservations, including after crashes. Final original/candidate holdout
allocation cannot be spent on search. The ledger is experiment/plan-bound,
hash-chained and anchored against missing/truncated/rolled-back history.

Token/fee thresholds are estimates, not billing guarantees. Current adapters do
not prove an input-token upper bound and have no frozen price table, so worst-case
Token/fee bounds remain **unknown**; a finite threshold requiring unavailable
estimates is rejected. Only actual provider-reported dollars are called reported
cost. Unknown model/usage, missing human grades, unrun cases or incomparable cache
conditions cannot establish improvement or cost savings. Small samples remain
exploratory, and `text_fragment` does not validate Skill loading or an Agent run.

No paid provider experiment or real-world benefit is claimed by the automated
acceptance. The P1b dataset editor and JSON file exchange are implemented; run
evidence import, in-lab trial UX and P2 isolated execution,
scoped adoption and rollback remain separate work.

## Host queries and storage

The loaded module exposes `optimization_lab_` queries: `validate_dataset`,
`freeze_dataset`, `discover`, `list`, `prepare`, `get`, `status`, `grant`, `start`,
`continue`, `stop`, `revoke`, `export_grading`, `import_grading`, and `report`.
Desktop Main alone mints the trusted native-confirmed grant request. Generic chat,
renderer-supplied cwd/authority flags, mobile and remote RPC cannot write grants.
Renderer accesses the dedicated `window.codeshell.optimizationLab` preload API.

Artifacts live under `codeShellHome()/optimization-lab/<project-key>/`, separated
into `datasets/<hash>/` and `experiments/<id>/`. Plans, grants, trials, grades and
reports are immutable; state revisions and persistent generation-fenced leases
coordinate writers. Corruption fails closed rather than resetting consumption.

## Dataset contract

A dataset has `schemaVersion: 1`, `title`, `taskFamily`, and `cases`. Each case has
`id`, positive integer `version`, `sourceGroupId`, `provenance` (`real` or
`synthetic`), `caseRole` (`target_failure` or `regression`), `split` (`dev` or
`holdout`), `input`, and `readiness` (`runnable` or `analysis_only`).

Criteria include `hardAssertions` (`contains`, `not_contains`, or
`json_field_equals`) and `rubric`. Criterion IDs are unique within a case.
`expected`, `fixtureRefs`, and `missingEvidence` preserve supporting information.
Runnable cases require criteria and no missing evidence. Materials must be inlined
in `input`; external fixture files are rejected. Both splits need runnable cases;
duplicate inputs and source groups crossing splits are rejected. Analysis-only
cases stay in the report denominator. Fewer than three runnable holdout source
groups and missing regression cases produce exploratory warnings.

Freeze normalizes defaults and sorts cases by ID before hashing; reordering cases
does not change the hash. Repeated freezes preserve timestamps/bytes. Existing
manifests are verified against content, case hashes, summary and directory hash.

The Desktop form covers all dataset fields and preserves JSON scalar assertion
values, segmented paths and absent versus empty `expected`. Copying a case assigns
a new ID while retaining its source group. Unsupported structure and invalid JSON
remain editable as raw text without silently discarding fields. Backend validation
is authoritative; editing invalidates old results and never changes frozen plans.
Native JSON import/export is bounded to 16 MiB regular UTF-8 files and makes no
model requests. See [editor delivery](../../docs/todo/optimization-lab-editor-2026-10-08.md).

## Development

From the root, run `bun test packages/optimization-lab tests/optimization-lab-composition.test.ts`. Build dependencies before
package-local typechecking. Runtime Core imports use `/extension` only.

After building the root and Desktop, run
`bun run --cwd packages/desktop test:e2e:optimization-lab` for real Electron +
production worker acceptance with a local fake HTTP provider and isolated HOME.
See [delivery evidence](../../docs/todo/optimization-lab-acceptance-2026-10-08.md),
[design](../../docs/todo/optimization-lab-mvp.md) and
[engine plan](../../docs/superpowers/plans/2026-09-26-optimization-lab-engine.md).
