# Output storage research fixture

This private prototype is retained from `codex/core/producer-journal-storage-spike`
(original tip `8d497ff53`). It is not imported by production session storage or
exported from the public SDK, Host entry, or extension entry. Its marker and
custody checks deliberately reject ordinary production journal files.

The synchronous and asynchronous fixture implementations explore bounded WAL
records, cancellation, receipts, identity indexes, and descriptor custody. Their
passing tests do not establish a production migration, complete crash durability,
or compatibility with existing session directories. Activation requires a
separate reviewed implementation and migration decision.

Run the isolated fixture tests from the repository root:

```sh
node scripts/run-bun-test-shard.mjs --timeout 60000 packages/core/src/session/output-storage-prototype/
```

The guarded runner supplies a private test home and strips provider credentials.
Never point this fixture at an operator's real session directories.
