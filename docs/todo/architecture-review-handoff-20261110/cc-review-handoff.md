# Host handoff for independent CC review

This is the implementation agent's handoff, not a CC review. No agent CLI was launched and no merge is authorized. The host starts CC separately. Read the adjacent task ledger before treating any task as accepted.

## Candidate and scope

Baseline: `fcd8406d51bf34696417dd9dd90c609f1d5ca640`. Final code is `d65afec5b2af55ee3ed4f9de657005edd90fb0ea`; review the final `codex/architecture/review-candidate-20261110` ref delivered in the bundle (which additionally contains the handoff documents), including its integration commits; original task refs are also preserved. The fixed candidate used for all38 initial CI partition attempts is `b7062fba47282d823e52bb29ea81aed686b0eb3f`. Later D1/C4 test followups have their own validation receipts and must not be represented as part of that earlier run.

The original checklist remains unchanged. D2 stopped at21 concrete mismatches, above its20-item cap. E3 needs an explicit destination decision. R1/R2 still require Bun-generated lockfile cleanup in a network-capable environment. These are outstanding work, not review approvals or completed acceptance.

## Integration seams to examine

- T1 preserves explicit field forwarding and fixes only the multi-session path; the compile-time coverage check must fail for a new unforwarded TurnOpts field.
- T3/C1 both touched persist-active-model imports; the candidate retains SettingsManager's existing settings mutation path and the moved path helpers without reintroducing an upward dependency.
- C3 freezes the old query behavior before moving19 named handlers. Check prototype-like unknown method names, redaction, errors, journal fallback and the lazy chat-manager context. Compare the before/after evidence, not just the line reduction.
- C4 replaces protocol Engine double casts with a compile-time exhaustive test helper. Methods that are not intentional defaults must fail by name; fallback fixtures explicitly declare absent capabilities. No production exports or mock.module additions are authorized.
- D1 shares one parsed worker value across the existing dispatch order. Deep-frozen regression fixtures cover shared-input mutation and22 lines/22 parses, including invalid JSON. It must preserve consume/return and annotation behavior without modifying Mimi/Pet business logic.
- D3 owns only ExternalRuntime and its approvals. Check startup timing, lazy captured dependencies, unchanged authority callbacks, reverse disposal and multi-window ownership. Existing shutdown uses Promise.allSettled for service cleanup; no wider service registry migration is intended.
- G2/G3/G4 guards must reject new violations and stale allowances. Core relocation keeps legacy public re-exports; G2 leaves18 behavioral upward edges and2 I/O cycles intentionally outside the mechanical scope.
- R2 removes the legacy driver/package but retains live Electron-CDP compatibility. Production page/key helpers moved verbatim, Host tests remain, and actual browser coverage is blocked at browser startup here. Do not infer browser behavior from fake-only tests.
- H3 preserves Server compatibility re-exports and keeps Web browser-neutral types free of Server runtime imports. Package-release declarations/imports passed; its actual packed HTTP lifecycle did not.

## Validation limits

Build, typecheck, lint and selected contract/targeted results are in the ledger. Failed/incomplete full partitions remain failed/incomplete. Some failures are individually reproduced at baseline; others are only accompanied by environmental errors or remain unexplained. Do not convert those distinctions into a blanket baseline exemption.

Rerun final-candidate CI and required native/browser/package release smoke in a capable environment. Use the repository's isolated HOME runner, build Core before dist consumers, and serialize package-release (which deletes dist) with Desktop and SDK checks. Do not use real credentials or paid eval to bypass the recorded constraints. The known upstream Electron promise-garbage-collected location was not reached here; startup/seed failures occurred earlier.

## Recovery and publication

The host can inspect/verify the final bundle in an existing repository that has baseline fcd8406d5, fetch its task refs, then create a fresh review worktree. This avoids altering the primary checkout or the original untracked checklist. Preserve local branch mappings from the ledger. PR bodies are adjacent drafts; no real PR number exists. The GitHub create action was rejected because approval policy is never, so no alternate publishing route was used.

Use task-specific stacked PRs in the documented dependency order, including two C3 PRs. Rebase onto then-current main only after dependent PRs have been reviewed and their later merge authorized, rerunning checks after conflict resolution. Do not merge this implementation-stage candidate.
