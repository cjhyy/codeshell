# Explicit output-journal backup and repair

This is an offline maintenance command for persistent Sessions. It does not start
an Engine, select a provider, read a default HOME, or clear coverage failures.
It is an unreleased implementation until its reviewed commit is included in a
published Core package.

Stop the Session's writers before maintenance. The command takes the existing
`state.json.lock` lease, refuses a competing lease, and never waits while holding
it. Every argument is explicit; the root is the directory containing Session
subdirectories, rather than a Session directory or application HOME.

```sh
code-shell-output-journal inspect /absolute/path/to/sessions SESSION_ID
code-shell-output-journal backup /absolute/path/to/sessions SESSION_ID /absolute/path/to/new-bundle
code-shell-output-journal restore /absolute/path/to/sessions SESSION_ID /absolute/path/to/bundle
```

The executable ships with `@cjhyy/code-shell-core`. A source checkout can use
`node packages/core/dist/cli/output-journal-repair.js` after building Core.
Successful commands print one JSON result. Invalid arguments, unsafe paths,
incomplete backups, missing authority, and failed writes produce a refusal on
stderr and a nonzero exit code. `inspect` prints an `ok` or `incomplete` diagnostic;
its exit code alone is not a coverage verdict.

## Create a complete bundle while the journal is healthy

`backup` accepts only a new destination outside the Session. It verifies the
actual reader from the current retention floor through the current published
head, then copies all bytes of `state.json`, the anchor, the durable-head file,
and, for segmented storage, the manifest and every retained segment. The bundle
manifest records original file identities, lengths, SHA-256 values, the canonical
root and Session incarnation, the exact head, and the retention floor. It
independently verifies the copied chain and rechecks the actual reader and head
before returning.

Files are private regular files; symlinks, hard links, unsafe inventory names and
unexpected bundle files are refused. Each file is bounded to 128 MiB and the
whole bundle and each manual source-evidence attempt to 512 MiB. This is separate
from the automatic unpublished-tail evidence budget of 128 MiB cumulative. Segmented storage retains its existing 16-segment and
32 MiB segment bounds. Bundle creation is synchronous and can scan/copy the full
retained journal. Keep the bundle in durable storage before damage occurs.

A bundle is a precise checkpoint, rather than an arbitrary history import. If
new output is published or rotation advances the manifest/floor, create a new
bundle. A bundle from another root, copied Session, replacement anchor, different
published head, or different manifest cannot restore this Session. An unchanged
head does not permit reversing an advanced retention floor.

## Restore only admitted authority

`restore` requires the original Session directory, anchor inode, state identity
pin, version-2 durable-head inode/checksum proof and, when present, manifest inode.
The bundle must prove the exact current published identity, sequence, logical
offset and hash. A lost/replaced/damaged head, missing anchor, replaced existing
segment, or an unproved current manifest/floor is refused without guessing a new
authority. Copying a bundle to a new root does not preserve the original cursor.

Before modifying output bytes, repair saves the entire damaged source in a new
`.output-manual-repair-UUID/source/` directory inside the Session. Its sealed
`receipt.json` records full-byte hashes and explicitly records proved missing
segments. These copies and the receipt are flushed before publication of
`output-journal-repair-pending.json`. A durable source-verification checkpoint
prevents a rejected, subsequently changed source from gaining overwrite
permission merely because a pending marker exists.

The pending marker blocks current readers and writers. The anchor's first byte
is then set to an invalid JSON byte and flushed, so historical readers/writers
also refuse the intermediate state. Existing output and manifest files are
restored on the same inodes; the durable head and `state.json` are never rewritten.
A missing retained segment named by the proved current manifest can be prepared
from the complete bundle and published exclusively. A durable creation receipt
pins its new inode before the manifest's physical pin is updated. Logical
positions, hashes, cursors and the retention floor remain unchanged. An unknown
file appearing at that path is preserved and refused, including on retries.

Only after all restored bytes and physical pins have been flushed and verified
does repair restore the original header byte, flush it, publish `result.json`,
and remove/flush the pending marker. The actual consumer then verifies the
retained range. Old cursors continue to address retained pages; expired cursors
remain expired. After a missing-segment repair, create a fresh bundle to capture
the new physical segment identities.

## Diagnose and retry

A failed operation keeps complete source evidence and the pending barrier once
published. Rerun `inspect` and retry the **same explicit root, Session and bundle**.
Valid complete receipts permit retry after interrupted file flushes, partial
manifest writes, header writes, exclusive publication, and marker removal. A
partial receipt is never published as a valid marker. Do not delete, edit or
replace pending markers, source evidence, creation receipts, or authority files
to force recovery. Malformed/replaced receipts or changed authority intentionally
remain blocked for diagnosis.

The result includes the source-evidence directory and `coverage: "ok"` or
`"incomplete"`. Repair never clears `outputRecoveryIncomplete`, unpaired coverage,
or recorded input gaps. Restoring bytes alone cannot prove that an unrecorded
output was durably published. A sticky failure therefore remains incomplete even
when the proved bytes were restored successfully.

Evidence directories are retained; no automatic evidence garbage collection is
performed. Each attempt's source copy is bounded, but repeated failed attempts
can consume additional disk space. Keep receipts with their source files when
archiving evidence. The command is designed for a stopped writer and cooperative
state-lock users. Arbitrary filesystem writes outside that lock retain a TOCTOU
boundary after the last bounded identity/hash check.
