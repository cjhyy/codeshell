# Paired Mobile and owned external Runtime output

This increment uses the existing Mobile conversation and `ExternalRuntimeService`.
It adds no screen, sidebar, provider login, grant, or vendor CLI integration.
It follows PR98's authenticated journal pages and PR99's durable CLI producer;
those earlier receipts keep their original acceptance boundaries. This source
increment is separate from any published release or production deployment.

## Actual producer and selected viewer

The actual Main ingress appends once to `SessionSnapshotStore` and delivers only
to the owning Desktop window. An independent tap passes that same entry's
Session, owner, epoch, and sequence to Mobile recovery. It never routes the event
through native worker outbound or appends a second snapshot entry.

A viewer is the actual authenticated WS socket, not a device-wide subscriber.
Selection binds that viewer/device to the Session directory/incarnation and the
current mounted project/root authority. Every live delivery rechecks authority
before and after its async work, and compares the exact current Desktop owner.
A second tab selecting another Session receives no external output, even when
it shares the paired device. Removed/replaced projects, changed owners,
reselection, rooms and revoked/offline sockets retire captured work.

The live pump has at most eight active authority reads globally, one per viewer,
128 selected viewers and one latest header per viewer. It keeps no additional
output queue. It fetches only the exact Main sequence observed at external
ingress; interleaved native worker frames are not repeated. A retained frame of
at most 512 KiB uses the existing `session.stream` wire. A coalesced/evicted or
larger committed frame advertises only its actual durable cursor in the existing
snapshot control; the client repairs missing sequences with pages. A frame with
no durable proof fails closed. A still authenticated viewer receives `ready:false`
when its live binding is retired; revoked sockets receive no output payload.

## Input, attachments, cancel and retries

Command authority is checked independently from the read selection. The actual
paired socket must select this Session, retain the same project/incarnation and
live Desktop owner, and find the exact existing Runtime object and cwd. Mobile
does not call `ensure`, allocate a replacement CLI, or inject a native worker for
an external Session. An external selection remains classified as external when
its state disappears or its ID is reused; it cannot silently switch producers.
Missing state or a cold Main without a live instance rejects input. A new native
Mobile Session still follows its existing producer route.

Input uses the existing server attachment transaction: resolve authorized cwd,
claim/materialize validated image bytes, submit the stable message ID, then mark
sent/finalize only after canonical input and the output journal commit. Image
paths are revalidated against the same project inside the actual service queue.
The final synchronous socket/selection/owner/Runtime fence runs after async
checks and before canonical/Goal/run mutation. The actual canonical image
projection carries display paths and metadata, never image base64. Provider input
still receives the original text and validated paths.

Acceptance means durable input, not model completion. A five-second pre-accept
queue deadline fences that queued submission before any later physical request;
attachment claims are released. After a committed acceptance, mark-sent failure
cannot resubmit a CLI request or turn the commit into a rejection. A repeated or
conflicting message ID makes zero additional requests, preserving the existing
journal/outcome. Mobile's optimistic bubble and the canonical user projection
share that stable ID.

Cancel captures the actual existing Runtime and open run, rechecks authority,
then calls its existing interrupt path with that expected pair. A later run or a
replacement Runtime cannot be cancelled by the stale request. The ordinary
service persists its aborted terminal. External approval, permission, model and
Goal controls continue to require the Desktop owner; Mobile rejects those
native-only control routes instead of forwarding them to another producer.

## Live gaps and recovery

Initial selection, a same-epoch sequence gap, reconnect, coalesced cursor heads
and terminal output all use the existing verified frozen journal join. The
private candidate replaces visible history only after full coverage is proved.
RAM eviction above 8 MiB does not cause another CLI/model request. A new Main
can recover pages with empty RAM without constructing an external Runtime.
Cold input remains explicitly unavailable until its Desktop owner starts one.

The existing limits remain: 1 MiB / 512 frames per page, 64 KiB fragments,
16 MiB assembled events, 128 MiB journal, 1 MiB legacy cutover and 2048 total
client pages. Every eight catch-up rounds yields for 25 ms behind the barrier,
retaining the verified candidate and the same page budget. Each continuation
requires cursor advancement; it also consumes a terminal already observed in
the last round, without waiting for another event. One request is outstanding,
with a 10-second watchdog. Corruption, unknown cursor, missing progress,
unpaired/no-run visible output and revoked authority retain sticky failure;
a new run does not clear that proof. Client cancellation clears its timer and
pending continuation. Main's existing coverage ID and socket backpressure bounds
remain authoritative.

## Acceptance and remaining work

The task-owned native fixture uses actual production `ExternalRuntimeService`,
synthetic Codex stdio, Main ingress, project authority, `RemoteHostManager` paired
WS, server input/attachment boundary and the real `useRemoteApp` hook with a
minimal DOM. A separate actual Node Main exercises empty-RAM paired page
recovery. It is not vendor CLI, physical-phone, browser GUI, weak-network or
provider-account acceptance. Its fixtures contain only synthetic credentials.

The Node preload installs before Core/host imports and inherits into actual CLI
and cold Main children. It permits only owned exact loopback listeners,
hash-pinned synthetic CLI entries/the cold Node entry and three read-only Git
metadata commands in the owned workspace. All Node interpreters are pinned to
the launcher's executable. Four negative probes reject external HTTPS, an
unowned loopback HTTP port, raw socket and unrelated subprocess. PID/PPID/UID,
HOME hash, interpreter identity and guard decisions are recorded. This is a
JavaScript guard, not an OS sandbox or global I/O observation. The launcher has
a total deadline and reaps only its own process group.

The [receipt](mobile-external-output-journal-receipt.json) records exact source,
raw hashes, final gates and earlier labelled failures. Tests cover real queue
fences, live authority changes, bounded mirror work, committed attachment claims,
repeated IDs and moving-head/last-round terminal recovery. No old failed attempt
or previous producer's receipt is substituted for final combined acceptance.

Still separate: out-of-run/background producers without journal ownership,
CCRoom/raw CLI history, arbitrary history import, rotation/retention and repair,
external Mobile approval/model/Goal editing, full vendor CLI/account behaviour,
physical Mobile GUI/weak-network acceptance and multi-user Runtime/CLI HOME
isolation. These changes do not make all long-stream recovery complete.
