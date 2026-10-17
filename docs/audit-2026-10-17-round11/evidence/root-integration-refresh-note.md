# Preintegration guard detected concurrent main advancement

The first final-snapshot guard required the complete current primary snapshot to equal the initial snapshot. It returned exit 1 before any integration or primary mutation. The complete tool diagnostic is transcribed here as metadata, not a product/Bun log:

```text
Traceback (most recent call last):
  File "<stdin>", line 10, in <module>
AssertionError
```

An independent read-only comparison then established that only HEAD changed: initial `b8b776d56e5982e59b18de0262d5c49367746625`, now `9cbd3a34c8c3249d87a2a31b2edf538e0448c365`. Porcelain, tracked/staged binary diff hashes and all four untracked byte hashes remained equal. The eight incoming paths were other tasks' Desktop acceptance harness/AppImage/startup scripts, CI and documentation.

Root preserved that observed snapshot in `integration-current-observed.json`, fast-forwarded only its own branch to current main, and captured a fresh final preintegration snapshot. No old primary bytes were restored, no unrelated changes staged, no fixtures/raw logs changed and no product validation rerun. The original source baseline remains the reference for every first observation.
