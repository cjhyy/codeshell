G3 — Guard workspace dependencies and source imports

Base: R2 b92e6dfa2 (equivalent local parent 1af1317f7), stacked after R1. Branch: codex/architecture/g3-workspace-import-guards.

Add the exact per-manifest dependency-field table for all 12 remaining packages plus root meta package. AST scan of non-test src and Web app imports (including type imports, re-exports, import types, import(), require and import-equals) requires workspace names to be declared. Self-imports are permitted; retired Arena/CDP have no exceptions.

Extend the existing ESLint boundary rule to every package src and Web app, rejecting relative imports into another workspace. Exclude tests, fixtures and test-utils from the new generic rule. Explicit exceptions are Desktop's intentional mobile→Web SPA entry and six Web→Server Panel files scheduled for H3. Web can import Core contracts only as types; static, inline type and dynamic/require paths are checked. Existing specialized Core/capability/renderer restrictions remain.

Evidence: the requested table matches current manifests after R1/R2. The desktop/scripts/cloud-chooser-server.ts relative references are outside the src/app rule scope and already declare Server; no new exception hides them. Source scan has no undeclared production imports after Arena deletion.

Validation: full build passed; lint 0 errors/90 warnings (baseline allows98), package boundary19/0, all three required contracts29/0, shard inventory2660/764max passed. Three new lint probes plus existing five all pass (8/0). Negative probes: adding Web→Server dependency fails exact table; a temporary undeclared type-only Web→Server import fails source inventory. All temporary probes restored. Final combined candidate validation and GitHub CI remain pending; no PR exists because creation is approval-blocked.
