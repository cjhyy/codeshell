# Existing validation log durability audit

Only pre-existing metadata and raw task-owned `/tmp` log bytes were read. New tests, product imports, findings, and archives created: **0**. No original metadata/log or repository document was modified.

| Existing metadata group | Unique files/logs | Completed tests | Fail / skip | Raw log bytes |
| --- | ---: | ---: | ---: | ---: |
| server-web-results.json | 141 / 141 | 1428 | 0 / 0 | 179,726 |
| desktop-renderer-results.json | 282 / 282 | 2397 | 0 / 0 | 310,398 |
| desktop-main-results.json | 283 / 283 | 2461 | 0 / 0 | 338,509 |
| Total | 706 / 706 | 6286 | 0 / 0 | 828,633 |

All 706 metadata rows carry `code: 0` and `signal: null`. All 706 source file names, raw log paths, and resolved raw log paths are globally unique. Every raw log contains exactly one anchored `Completed Bun shard` marker with zero skipped/failures; its test count agrees with the Bun `pass`, `0 fail`, and `Ran … across 1 file` summaries. Every referenced log is an existing file contained in its expected task-owned group directory.

The machine receipt records every raw log SHA-256, exact byte size, original path, group/member name, and parsed completion counts. Its SHA is `73ad4e09fdb09e15673e0c5e7a585f46d48e7756438c63635f853b7b289be9af`. Original metadata SHA/size:

- `server-web-results.json`: `e6c2ae23f2c342a0dee9ec9ad417f9c74a6a369920aa6719b136f564b8031209`, 30,974 bytes.
- `desktop-renderer-results.json`: `56d401b51a87edae7c87e0e90cf6784b8aeb37215abf20a3f79aa294f0007ac1`, 68,411 bytes.
- `desktop-main-results.json`: `203cbbd482c666c62e154b4da44e6f28884424938654a221bfc1acc6c0401326`, 69,602 bytes.


The three metadata files total 168,987 bytes; the 706 raw logs total 828,633 bytes. Their combined byte size is 997,620. Hashes use exact raw bytes, without trimming or newline normalization. Each group also has a canonical sorted per-log hash-manifest digest in the receipt to support subsequent deterministic archive checks. No archive bytes were generated or inspected here.

The status claim is artifact-bounded: existing metadata supplies process code/signal, and raw logs corroborate Bun completion/counts. This does not rerun any test, establish an independent process-status trace from text alone, prove current-snapshot compatibility, cryptographically bind all tested source/dependency bytes, or expand earlier test-scope claims. A later `.tar.gz` is evidence preservation and should match all member bytes in this receipt; it must not be counted as a new test/finding.

Raw receipt: `existing-test-logs.receipt.json`. Build/UI raw-log parity is audited separately by the delegated static countercheck; it is not inferred from these 706 test logs.
