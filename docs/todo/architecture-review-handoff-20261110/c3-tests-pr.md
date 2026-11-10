C3 PR 1 — Freeze built-in query response contracts

Base: main@fcd8406d5. Branch: codex/protocol/c3-query-contract-tests. Commit: b737ca119.

Add 31 protocol contract cases to the existing server.query-session.test.ts before extracting handleQuery. Record request/response shape and error codes for config_get/set, permission_set, provider/model CRUD, provider cache and redaction, local OpenRouter refresh, model limits/names, sessions/detail/journal, usage bounds, extension fallback and Object.prototype-like query names. Existing compact/archive tests retain success, failure and notification sequencing coverage. No production changes, mock.module, golden changes or extra test files.

Evidence correction: handleQuery contains 19 named cases plus default; the checklist's list also enumerates 19 despite saying 21. Existing tools/config, models/providers, identity sessions, compact, archive_range/archive_marker and engine usage tests provide the remaining coverage. The journal boundary is frozen with a scoped read spy restored after the test; it checks exact bounded read arguments and serialized response, while existing storage tests retain disk integration. Real missing-journal behavior is also exercised.

Validation before migration: isolated runner 51 pass/0 fail across query-session/compact/archive-range/archive-marker; all three required contracts 27/0; changed-test ESLint and shard inventory passed. An exploratory run including engine.cost-ledger.test.ts failed six environment-dependent cases (diskutil DiskManagement/DiskArbitration unavailable); it is not counted as a pass. No live credentials or paid requests.

PR creation is blocked by approval policy never; no PR number or GitHub CI exists. CC review pending host initiation.
