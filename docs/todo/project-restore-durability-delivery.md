# Project installation restore durability

Offline restore now persists the revoked Hub auth replacement and its `hub/`
directory before renewing the installation namespace. The restore marker is
durable before control data is copied, copied directory entries are synchronized
from children to parents, and marker removal is followed by a root directory
fsync before success is returned.

This closes a legacy authority gap: Hub session tokens are not bound to the
installation ID. A namespace change alone cannot prevent an old auth file from
reviving snapshot sessions after loss of an unflushed rename.

The publication sequence is:

1. Exclusively create the destination, write its restore marker, and fsync the
   marker, destination directory and parent directory.
2. Verify/copy control files. Revoke all Hub sessions through the actual
   `HubAuthStore`, then fsync the resulting `hub/auth.json` and `hub/` directory.
3. Renew the actual registry, retaining its existing file and directory fsyncs.
   Restore volumes through the existing path and remove obsolete runtime state.
4. Fsync copied directories from children to parents, remove the marker, and
   fsync the installation root. Return success only after that final barrier.

Any failure synchronously attempts to re-establish and fsync the marker before
asynchronous volume cleanup. This also covers failure after unlink but before
its directory flush. If a second I/O failure prevents confirming the rearmed
barrier, an `AggregateError` preserves both causes and explicitly requires keeping
the destination offline. It does not claim durability under persistent storage
failure. Source backups are never changed; incomplete destinations remain as
evidence and are not reused automatically.

Controller startup now uses `lstat` and an explicit ENOENT-only catch before
creating a registry or Hub auth store. Any marker entry, including a dangling
symlink or directory, blocks startup. Permission, I/O and ENOTDIR errors also
abort. The restore validator rejects nested inventory entries under obsolete
state paths that would otherwise be removed before directory synchronization.
Previously valid top-level obsolete files, including `environment.json`, remain
accepted and are removed during restore.

Run the dedicated regression through the guarded runner:

```sh
node scripts/run-bun-test-shard.mjs --timeout 120000 \
  packages/server/src/project-runtime/restore-durability.test.ts
```

The parent compiles actual Server exports into its private directory and executes
a native Node child with strict unhandled rejection handling. The child installs
network and process guards before importing Server/Core. The sole process
exception is its own fake Docker executable, pinned by path, content, device,
inode and single-link identity, with exactly three permitted inventory/image
argument lists and a fresh HOME-only environment. It cannot access a Docker
daemon, create containers, pull images or invoke paid providers. The positive
fixtures use an unstarted retained project; Docker volume extraction is not part
of this acceptance claim.

Final Node 22.19.0 evidence is recorded in the adjacent JSON receipt:

- Four scenarios pass with 24 parent assertions. The actual native restore path
  covers 11 fsync failure points, marker removal before/after unlink, and all three
  rearm fsync failures. The recorded success order is marker → root → parent →
  auth replacement → Hub directory → registry file → control directory → copied
  directories → root → unlink → root.
- Failed restores retain a startup barrier, including when test code reinstates
  snapshot auth bytes behind it. Successful cold startup returns 401 for the old
  Hub session; a fresh administrator login can still list the retained project.
  Original auth and backup bytes remain unchanged.
- Marker file/directory/dangling symlink, injected EIO/EACCES/ENOTDIR, and a real
  parent-file ENOTDIR fail before registry or Hub side effects.
- SHA-pinned historical sources from `9c4f23c0` are compiled as actual old
  algorithms with unchanged control flow. The same publication assertion rejects
  their missing auth flush; native observation also confirms missing Hub/root
  directory flushes. The real previous controller starts through a dangling
  marker and creates a registry. These tests do not rely on Git history at run
  time, so shallow CI checkouts can reproduce them.
- A deliberate exception after actual restore produces child exit 1 and a
  complete owned-process exit receipt. The parent removes private state only
  after the expected exit and verified child receipt. An unexpected failure or
  timeout without that receipt preserves its private root and reports the path;
  it cannot delete HOME while an unconfirmed grandchild may still be running.

Related backup/registry/controller regressions pass 20 tests and 112 assertions.
Server build, no-emit type checking, targeted lint and formatting pass. Independent
review also reran the final four native scenarios on Node 25.8.1 successfully.
Initial Bun-only
monitor attempts were rejected as evidence because native builtin replacement
semantics differed; the final regression executes real Node instead.

The change is limited to `backup.ts`, `control-server.ts`, the manifest regression,
the isolated restore fixture and historical source evidence. `lock.ts` and the
shared `HubAuthStore` are unchanged. No production restore, Docker run, public
package release or deployment was performed.
