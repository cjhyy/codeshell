# Architecture review handoff

This directory preserves reviewable PR bodies and exact validation receipts. No PR number, merge or CC review is claimed. The [implementation status](../architecture-review-implementation-status-20261110.md) is the authoritative task ledger. The original [checklist](../architecture-review-tasks-20261110.md) remains intact.

- `*-pr.md`: task-specific drafts with original dependency bases, evidence differences and validation limits. C3 deliberately has two drafts.
- `final-*-shards.md` and `final-*-results.json`: fixed-ref full CI partition attempts. Failed and incomplete results are distinct; nested child summaries are not whole-shard totals.
- `final-*-analysis.md`: baseline comparisons and limits of attribution.
- `final-smoke-results.json`: exact-ref Desktop/Server/Electron/native-batch attempts; see the main ledger for the additional full Electron-suite attempt and startup blockers.
- `c3-baseline-comparison.json`, `c4-baseline-comparison.json`: per-case protocol baseline comparisons, not blanket environment exemptions.
- `integrity-audit.json`: protected checklist/evidence/golden integrity and test-file inventory.

Raw logs live in the task-owned `/private/tmp` validation artifacts. The final handoff bundle and compressed validation archive are named in the implementation status. Host coordinator initiates CC separately; these are implementation-stage checks.

Final code candidate: `d65afec5b2af55ee3ed4f9de657005edd90fb0ea`. [Machine-readable verification summary](final-verification.json) preserves all38 initial partition outcomes and final targeted reruns. The external delivery manifest records the later docs-only handoff HEAD and artifact checksums.
