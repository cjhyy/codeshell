These are the standalone production manifests and Bun locks used by Desktop's
materialized Core and Optimization Lab packages. They are generated artifacts to
version together with dependency changes; do not edit individual resolutions.

The install manifests deliberately omit the application release version. A
version-only release bump therefore leaves these four artifacts unchanged, so
the existing release staging list remains complete without an additional Bun
invocation. The generator still requires workspace versions to match the root
lock, and predist still compares the complete generated artifacts. Installation
restores the full workspace manifest with its actual release version.

From the repository root, using the `packageManager` version of Bun:

```sh
bun packages/desktop/scripts/production-dependencies.ts --write
bun packages/desktop/scripts/production-dependencies.ts --check
```

The generator checks source production declarations and overrides against the
root `bun.lock`. It seeds Bun with the complete root resolution table, removes
workspace links that predist materializes separately, and lets Bun prune and
rehoist the closure. Every resulting package record (including integrity and
dependency metadata) must come from the root lock. All platform optional records
remain in the lock. No package is specially pinned by this generator.

Predist checks that both saved manifests and locks exist, regenerates them in
temporary directories, and compares the complete files before building or
changing workspace targets. This also detects deleted transitive records and
incorrect rehoisted versions that still exist elsewhere in the root lock. Each
target then installs with `--production --frozen-lockfile --linker=hoisted`, before
restoring its full runtime manifest. The temporary install lock is removed so it
is not shipped next to an incompatible restored manifest.

Focused validation (isolated HOME, no application build):

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/scripts/production-dependencies.test.ts
bun scripts/run-isolated-node-smoke.mjs tests/fixtures/desktop-production-install.ts
```

The second command downloads the frozen production closures into disposable
directories and checks dependency resolution; it needs registry access. Run it
on Linux as well as the other release platforms. Lock generation and frozen
dry-run validation alone do not prove successful downloads or packaged runtime
behavior.
