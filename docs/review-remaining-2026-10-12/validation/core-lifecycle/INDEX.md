# Evidence index

Baseline: 62a58ac8702835f848108e152234a6bdd6c3eb3f.

- `lifecycle.test.ts`: portable guarded review fixture, 11 cases / 49 reported expectations.
- `lifecycle-final.log`: authoritative final fixture output, 11 pass / 0 fail / 0 skipped and network denied 0.
- `normal-controls-final.log`: authoritative existing suite output, 79 pass / 188 reported expectations / 0 fail / 0 skipped and network denied 0.
- `deny-network.mjs`: zero-origin fetch/http/https/net/tls/dgram denial installed before Core imports.
- `assert-guard-preload.ts`: same guard with final no-network assertion/receipt for existing suites.
- `lifecycle.log`: historical first 9-case diagnostic, not additive to final totals.
- `normal-controls.log`: historical first 79-case run without printed counter receipt, not additive to final totals.

Report: `/tmp/codeshell-remaining-core-lifecycle-report.md`.
Fixtures and logs only: no product source or native account/tool execution.
