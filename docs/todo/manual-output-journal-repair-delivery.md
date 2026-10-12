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

The final result and combined-base checks are recorded below after execution.
There is no claim of power-loss hardware simulation: fault cases intercept the
actual filesystem calls and fail each enumerated operation in turn, followed by
real read/consumer/retry verification. The supported proof remains the filesystem
fsync/identity contract.

## Outstanding integration and external acceptance

At this checkpoint the implementation awaits the final Main/barrel integration,
independent review, CI and inclusion in an authorized release. It does not add a
repair UI, arbitrary historical import, replacement authority, sticky-gap reset,
or automatic evidence cleanup. Those are separate work. Cross-platform native
acceptance and real-device/cloud production acceptance are not inferred from this
controlled macOS fixture.
