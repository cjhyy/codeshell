# Visible output recovery coverage

This increment fixes false-complete recovery; it does not make wrapper-external,
no-run Goal or background results durable. The producer-journal prototype stays
inactive. Journal rotation, import and repair remain separate work.

Main and Hub persist bounded coverage before publishing uncovered visible output.
The existing Session directory and state lock own the proof. `outputCoverageIdentity`
requires its detail field and binds canonical sessions root, directory dev/ino and
startedAt; the detail additionally binds the existing immutable journal header pin.
Without a journal pin recovery remains unavailable. Deletion removes proof with the
Session; stale same-ID bindings cannot silently adopt a replacement directory.
No proof writer creates a missing Session or borrows an active run.

Proof uses an exclusive private temporary file, file fsync, rename and directory
fsync, under the existing synchronous state lock. Whole-state saves preserve the
current protected proof. A failed commit/publication does not produce a successful
coverage result or set the run-blocking `outputRecoveryIncomplete` flag. Windows
retains the existing journal's platform durability boundary (no directory fsync).

Only metadata is stored: an uncovered flag and at most 128 stable input IDs / 32 KiB.
Actual fsync-completed canonical journal user anchors remove their pending ID under
the same lock; ordinary cursor chunks do not write proof. Metadata never contains
result text, tools, credentials or a fabricated terminal/cursor.

Legacy Sessions with neither coverage field retain existing journal compatibility;
this cannot certify no-run events emitted by earlier binaries. Once a proof is
required, missing/malformed detail or mismatched incarnation blocks replacement.
This is a forward producer-observation guarantee, not historical import.

Desktop, paired Mobile and Hub must join the latest authoritative coverage and
cursor before publishing a rebuilt candidate. RAM eviction, run finish and a new
Host generation cannot erase known gaps. Pending IDs must match rebuilt user
anchors. Healthy journal-only recovery remains supported. Background completion
must actually display through the consumer, and its missing cursor must be covered.

At the final join, a modern journal page requires the same Session incarnation and
header pin in the final Host proof. Deletion between a valid page and the final
snapshot cannot fall back to legacy compatibility. An unavailable journal still
checks known persisted gaps and pending inputs; a genuinely legacy Session with
no journal and no known gap keeps its existing transcript fallback.

Publication failure is isolated: Main/Hub withhold that event, retain uncertainty
for the current Host and continue handling subsequent recorded runs. Missing
Sessions are never created for background/Goal output. Hub commits its preliminary
user-echo flag only after actual publication, allowing the later canonical user
anchor to appear when a new Session did not yet exist. Ended Hub sessions release
RAM coverage once disk owns its proof (including a known gap without a journal);
a final authenticated query freezes the real journal head and rereads coverage.
State file reads use nonblocking regular-file validation, so a FIFO cannot hold
Main or Hub indefinitely.

Finite acceptance in this task:

- 17 guarded integration cases exercise actual journal writes, Main publication,
  transcript IPC, Desktop/Mobile recovery and Hub replay. They include 140 actual
  input/anchor acknowledgements within a run, 32 completed journal-backed Sessions,
  a completed no-journal gap, delete/reuse and final-page deletion, context-compaction
  display boundaries, a bounded FIFO child and a real Core Engine fixture. A real
  MobileOutputClient/Main-service case holds a preliminary input before the first
  journal and commits only after its later canonical input/boundary arrives.
- One guarded transport case exercises authenticated Hub HTTP/WS, an owned stdio
  child, workspace/revocation checks, run finish, pre-state user echo, publication
  lock failure and Host restart. The child emits controlled events with real Core
  journal cursors; it does not invoke a model or simulate journal storage.
- 174 existing recovery/session/export/reducer cases pass. Two pending-input
  expectations now require actual canonical acknowledgement to clear pending IDs
  while retaining the exact recorded user identity/text. Pure live-mirror fixtures
  remain in-memory; real journal fixtures use the real persistent coverage store.
- The final pending-input correction passes a 70-case related shard covering the
  17 integration cases plus Mobile client, Main Mobile, Desktop and Hub recovery.
  Valid unavailable-journal input IDs retain the typed pending retry; malformed
  IDs and actual uncovered output remain failures.
- Changed-file formatting, ESLint and whitespace checks pass. Full package builds,
  authoritative workspace types and compiled consumer smokes belong to integration.
  The local source-only override resolves package sources because this task did not
  build dist; normal CI builds workspace exports before running these test files.

The guards precede Core/Host imports and include two denied network probes per
parent fixture (and two in the controlled Hub child). These tests do not certify
an actual Electron UI, paired-device UI, real model, arbitrary filesystem attacker,
or concurrent older binaries. No-run payload durability, historical import,
rotation and repair remain pending rather than being represented as complete.
