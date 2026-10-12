# Candidate backup/restore pre-Core guard handoff

The Services acceptance now requires a private, hash-pinned guard manifest.
`smoke-cloud-backup.mjs` accepts its original five arguments followed by
`--guard <manifest-path> <sha256>` and forwards the same explicit guard to the
installed Services acceptance. There is no unguarded fallback. The original
four complete backup/restore checks remain exact, and the wrapper additionally
requires three protected controller processes, seven protected real CLI
processes, two native ACK/bootstrap pairs, zero child processes, and confirmed
firewall helper removal. It waits for actual child close, rejects interruption,
and preserves wrapper custody on failure.

The outer candidate gate can import:

```js
import { writeCloudRestoreGuardManifest } from "./cloud-restore-guard-manifest.mjs";
const guard = writeCloudRestoreGuardManifest(privateManifestPath, {
  hostScripts, // canonical checkout/scripts directory, fixed source provenance
  hostHead, // exact source HEAD already verified by the outer candidate gate
  dockerPath, // canonical pinned native executable
  dockerEndpoint, // local Unix socket only
  runtimeImage, // immutable sha256 image ID
  containerCore, // optional installed Core path inside that runtime
});
// Append ["--guard", guard.path, guard.sha256] to the original backup arguments.
```

The writer uses builtins and the test guard's file hashing utility only. It does
not install a guard, launch a process, import Core/Server, or run Docker. It
pins ten fixed Host test modules and three helper build inputs. The new private
manifest must live under an owned private directory and is published with
`wx`/0600. Source/package provenance and image construction still belong to the
outer candidate gate; a supplied `hostHead` string alone cannot prove them.

Services creates and owns an independent firewall helper from these inputs;
the prior project fixture's removed helper image is never reused. Separate
source/restored/failed Node controllers avoid weakening the shared controller
adapter's sticky installation authority. The Services fixture uses shared guard
`7c48ced01dca80b3eac93a7bd7895551b3fd47bc`, including strict origin revocation,
public native-entry protection and explicitly pinned independent child HOMEs.

Targeted wrapper validation passes **12/12 tests, 18 assertions**. It rejects
zero-exit incomplete proofs, wrong image/source, missing stages, missing native
ACK, unclosed children, stale receipts and interrupted apparent success.
Services actual Node/pure contract validation passes **10/10** (including real
independent HOME child custody and normal/unexpected close revocation). No
Docker, Core, Main, provider or browser ran for this checkpoint. Full guarded
Docker archive/runtime/business acceptance remains pending integration.
