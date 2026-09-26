# Optimization Lab

Private, experimental CodeShell capability. The foundation validates and freezes
evaluation datasets locally. It does not call models, optimize Skills, authorize
spending, or provide a Desktop page yet.

Desktop loads `createOptimizationLabModule` only when the **user-scope**
`featureFlags.optimization_lab` setting is `true` at the next worker start. The
default is off. Project settings cannot enable this worker-wide module; TUI and
server do not load it.

## Queries

The existing `agent/query` protocol supports these types when the module is loaded:

- `optimization_lab_validate_dataset`: `{ type, dataset }` validates without writing.
- `optimization_lab_freeze_dataset`: `{ type, cwd, dataset }` validates and writes an
  immutable manifest under `codeShellHome()/optimization-lab/<project-key>/datasets/<hash>/`.

The worker must already be running. Starting it from the forthcoming Lab page is
part of the Desktop integration plan, not the foundation.

## Dataset contract

A dataset has `schemaVersion: 1`, `title`, `taskFamily`, and `cases`. Each case has
`id`, positive integer `version`, `sourceGroupId`, `provenance` (`real` or
`synthetic`), `caseRole` (`target_failure` or `regression`), `split` (`dev` or
`holdout`), `input`, and `readiness` (`runnable` or `analysis_only`).

Optional criteria include `hardAssertions` (`contains`, `not_contains`, or
`json_field_equals`) and `rubric`. Criterion IDs must be unique within a case,
including across assertions and rubric items. `expected`, `fixtureRefs`, and
`missingEvidence` preserve supporting information.

Runnable cases require criteria and no missing evidence. Their materials must be
inlined in `input`: nonempty `fixtureRefs` are rejected because external contents
are not frozen. Both splits need runnable cases. Duplicate case IDs, duplicate
inputs, and source groups spanning both splits are rejected. Fewer than three
runnable holdout source groups produces an exploratory warning; no regression
cases also produces a warning. These counts do not establish statistical validity.

Freeze normalizes defaults and sorts cases by ID before hashing. Reordering cases
does not change the hash. Repeated freezes preserve the original timestamp and
file bytes. Existing manifests are validated against their content, case hashes,
summary, and directory hash; corrupted content is rejected, never overwritten.

## Development

From the repository root, use `bun test packages/optimization-lab` for local
contract tests. Follow [the foundation plan](../../docs/superpowers/plans/2026-09-26-optimization-lab-foundation.md)
and [engine plan](../../docs/superpowers/plans/2026-09-26-optimization-lab-engine.md)
for delivery scope and subsequent work. Build dependencies before package-local
typechecking. Runtime imports from Core must use `/extension`.
