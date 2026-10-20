# PR #190: main synchronization — 2026-10-20

This update merges `origin/main` at `77a846cfcfe0a3925702971f380d97b803887655`
into the shared-services branch at `c8a372b7dc7490b45ac638532b4110101629ad1a`.
It preserves the eight follow-up fixes already pushed to PR #190.

## Conflict decisions

- Keep all main changelog entries and put the shared-service changes under
  Unreleased. Preserve main's roadmap additions and the more recent Host batch status.
- Keep both sets of internal export contracts and their public/extension exclusion
  checks. The two new Host-only export statements raise the statement budget from
  121 to 123; they expose three runtime values.
- Retain the shared MCP probe while passing `serverUrl` through the Desktop OAuth
  resolver. The resolver's endpoint binding from main remains enforced. Update the
  old OAuth fixtures with metadata/resource/issuer bindings, assert the exact URL
  on initial and refreshed credentials, and reject a different path on the same
  origin before resolving credentials or sending Authorization.
- Retain Host session-file custody and bounded reads while using main's single
  comparator for both disk-session sorting and cursor pagination. Non-object state
  continues to be skipped.
- Pin only the reviewed MCP target/cwd signature growth: Main 7330 to 7334 lines,
  preload types 2984 to 2988. Other main budgets remain unchanged.
- Add main's twenty existing Host-only trace/Link types to the compiled declaration
  smoke's exact list. No production export is added by this correction.

## Verification

All unit invocations use the guarded runner. MCP transports and model calls use
fixtures; no real provider account or paid request is used.

| Check | Result |
| --- | --- |
| Frozen installation | Passed, Bun 1.3.11 |
| Complete package-release | Passed: 10 tarballs, 49 typed and 47 runtime entries; packed owner-auth HTTP and uploaded-document consumers reached and passed |
| Full workspace typecheck | Passed, all 14 workspaces |
| Desktop build | Passed: main, preload, renderer, mobile and Chrome extension |
| Ordered DOM/model/MCP/credentials/Hub/Cookie group | 171 passed, 0 failed, 0 skipped |
| Reverse MCP/HTTP/Cookie group | 77 passed, 0 failed, 0 skipped; overlaps the ordered group |
| Host session-file Node smoke | Passed: bounded retries, identity replacement, closed handles, candidate scan budget and safe size diagnostics |
| Core compiled-export Node smoke | Passed: 285 runtime and 135 internal type exports |
| Lint / baseline | 0 errors, 99 warnings, unchanged baseline |
| Engine/workflow guards | Passed; 97 literal workflow test paths exist |

The initial ordered group retained one failure from an OAuth fixture without the
new endpoint metadata; the corrected full group above passed. The initial Node
export smoke retained a missing-type-list failure; the complete corrected smoke
passed. Both fixes update test contracts without weakening production checks.

The complete core-rest/rest shards and the remote CI result are recorded in the
PR description after they finish. The earlier 2026-10-15 review record remains
historical evidence; its EPERM restriction does not describe this execution.
