# Explicit verified-backup output repair delivery

This increment adds an executable filesystem-only backup/inspect/restore path.
The earlier automatic unpublished-tail repair and the Main producer/rotation
increment keep their separate owners. No production account, provider request,
operator HOME, physical phone, or release artifact is exercised by these tests.

See [operator instructions](../output-journal-repair.md) for the exact CLI,
authority requirements, retained evidence, retry behavior and refusal boundaries.

## Implemented contract

- Complete private bundles include original root/Session/anchor/head identities,
  state, exact published head, whole-byte SHA-256 receipts, and every current
  manifest/segment. Both a separate chain verifier and the real paged reader
  verify the current retained range.
- Manual repair holds the existing state lease and preserves the damaged source
  in full before output writes. A persistent pending marker plus invalid anchor
  header fences current and historical algorithms during mutation.
- Same-inode anchor/segment/manifest restoration preserves admitted cursors.
  Known missing retained segments can be exclusively recreated with durable
  creation receipts and updated physical manifest pins. Existing unknown
  replacements and concurrent paths are refused and preserved.
- Durable evidence, marker and source-verification checkpoints support retries
  after real syscall failure injection. A changed source after capture remains
  refused on retry before the mutation checkpoint.
- Retention floors never move backwards. Sticky output failure, unpaired coverage
  and input-gap evidence remain intact; neither the head nor state is rewritten.

## Verification status

The dedicated guarded integration shard is
`tests/output-journal-manual-repair.test.ts`. It uses real Session creation,
actual durable writers/readers, real storage rotation, the historical v0.9.34
reader/writer fixture, the actual Web page consumer, and the executable CLI with
network denial installed before imports. Test HOME/state and all business data
are private fixtures.

The manual source checkpoint is `fa07796d7aa40874e14b8d06a488a08cb7cfee1f`,
which contains the implementation commit `424daf73` and a normal merge of Main
checkpoint `dfe8d28b` (own merge `a4fa57ff`). The combined Main delivery remains
[PR #139](https://github.com/cjhyy/codeshell/pull/139); a separate duplicate PR
was intentionally not created. Its owner integrates the three internal API
exports and owns the final complete package/Host/Mobile/Hub gates.

The following completed checks ran on macOS with Node `v25.8.1` and Bun `1.3.11`:

| Check                                                        | Completed result                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Dedicated guarded manual repair shard                        | 18 passed, 0 failed, 0 skipped; 1,144 assertions                                                         |
| Existing journal/storage/Web recovery shard                  | 42 passed, 0 failed, 0 skipped; 429 assertions                                                           |
| Core no-emit TypeScript and owned-file ESLint/Prettier       | Passed                                                                                                   |
| `bun install --frozen-lockfile` in an empty private HOME     | Passed, no lock changes                                                                                  |
| Own-worktree Core build and isolated compiled Node CLI smoke | Passed: single-file corruption and a missing retained segment; frozen cursors and anchor inode preserved |
| Core tarball inventory/mode                                  | Passed: CLI, manual-repair and backup-format JavaScript included; bin is executable                      |

The dedicated shard enumerates and fails each actual operation in turn:

| Storage/operation                                        | Real cuts retried successfully |
| -------------------------------------------------------- | -----------------------------: |
| Single-file fsync                                        |                             20 |
| Segmented/missing-segment fsync                          |                             28 |
| Segmented write                                          |                             29 |
| Segmented truncate                                       |                              3 |
| Exclusive link publication                               |                              6 |
| Unlink, including marker removal                         |                              7 |
| Historical v1 after actual durable-head migration: fsync |                             20 |

Additional cases cover poison/unpoison writes, partial marker/manifest writes,
multiple missing segments, same-inode corruption, unknown concurrent segment
creation, replacement pending markers, a competing lease, source changes after
capture, and retention-floor advancement without a new published head. They use
actual filesystem calls and full consumer/retry verification.

The controlled Core tarball is
`cjhyy-code-shell-core-0.9.35.tgz`, SHA-256
`4c0a220f33e0a66ce105c22bd77cbad368754ca5827dc7a2c12d2760ecfdbb73`.
It was built from this manual checkpoint before the separate Main barrel/API
integration. This local test tarball is **not** a published artifact or a new
version claim; the final merged release must be rebuilt and audited independently.
The [machine-readable receipt](manual-output-journal-repair-receipt.json) records
successful commands, exact checkpoints and these boundaries.

The first own-worktree Main/independent-consumer attempt encountered prerequisite
load errors because Server dist had not been built and the earlier Core dist
lacked the new Main export. That whole shard is **not** recorded as passed. Its
11 Engine cases did pass. The Main owner is building the final dependency graph
and rerunning the source/Main/Hub/Mobile combination on the integrated branch;
those final results belong to its exact commit.
There is no claim of power-loss hardware simulation: fault cases intercept the
actual filesystem calls and fail each enumerated operation in turn, followed by
real read/consumer/retry verification. The supported proof remains the filesystem
fsync/identity contract.

## Historical-reader maintenance boundary

The dedicated historical fixture uses the unmodified v0.9.34 writer to create
real v1 records, then the actual current constructor to admit a version-2
head-file proof without changing any journal byte or cursor. It backs up that
complete prefix, physically truncates a published final event, and verifies
recovery after all 20 real flush cuts through both the old algorithm and actual
Web consumer.

A historical v1 reader ignores the published head and pending marker. It can
already report the pre-existing truncated source complete before repair starts.
Before durable evidence permits poisoning, early failures preserve that exact
source and its pre-existing old-reader limitation. Once the invalid header byte
is present, the old reader and writer refuse; a clear header is exposed only with
the complete restored bundle bytes. Current readers reject the damaged head or
pending marker throughout. Maintenance requires stopping historical clients and
writers, including after a failed attempt. This explicit boundary does not claim
that a new v2 fixture proves safety of a historical reader before its barrier.

## Outstanding integration and external acceptance

At this checkpoint the implementation awaits the final Main combination gates,
independent review, CI and inclusion in an authorized release. It does not add a
repair UI, arbitrary historical import, replacement authority, sticky-gap reset,
or automatic evidence cleanup. Those are separate work. Cross-platform native
acceptance and real-device/cloud production acceptance are not inferred from this
controlled macOS fixture.
