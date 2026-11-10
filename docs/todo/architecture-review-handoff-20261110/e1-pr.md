# test: typecheck Host and Link test sources in CI

Add no-emit test tsconfigs for Host and Link, package/root scripts, and a step in the existing typecheck job. No CI job or required-check names change. Host's JSON fixture bodies now have explicit minimal shapes; Link's test-only lib includes ES2024 for its existing isWellFormed assertion. Production compiler targets stay unchanged; no error baseline or suppression is needed.

Branch: `codex/testing/e1-host-link-typecheck`; commit `8ca3bb3d4`; base `main@fcd8406d5`; worktree `/private/tmp/codeshell-architecture-d2` (reused after D2 was documented and committed). No PR due to the session approval restriction. CC review pending.

Initial diagnostics: Host 17, Link 1. Final: both zero. Root build had completed before test checking. `bun run typecheck:tests` passed; deliberately adding a test-only TS2322 error failed that same CI command, then was restored and rechecked. Guarded Host/Link unit tests: 97 pass, 0 fail across 10 existing files. Changed tests ESLint passed; test-shard budget unchanged. No new test files, mock.module, dependency upgrades, or production behavior changes.

## Other package survey

Temporary no-emit configs extended each package's existing tsconfig, used types node/bun-types and rootDir repository root, and included src/**/*.test.ts(x). Counts include transitive source diagnostics; packages use different production strictness/lib settings, so these are onboarding inventories, not comparable quality scores. Web app/other JS tests are outside this TS-source survey. All temporary configs were removed. Arena/CDP are baseline numbers only and are being removed under R1/R2.

| Package | Diagnostics |
| --- | --- |
| arena | 3 |
| browser-devtools | 1 |
| cdp | 0 |
| chat | 98 |
| coding | 6 |
| core | 248 |
| desktop | 634 |
| optimization-lab | 14 |
| pet | 25 |
| server | 556 |
| tui | 4 |
| web | 65 |

Logs: `/private/tmp/codeshell-e1-{host,link}-initial.log`, `codeshell-e1-final-typecheck.log`, `codeshell-e1-negative-probe.log`, `codeshell-e1-tests.log`, `codeshell-e1-survey-*.log`. Survey JSON: `/private/tmp/codeshell-e1-survey.json`. Final combined validation remains required.
