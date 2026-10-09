# Desktop owned external Runtime output

The existing Desktop `ExternalRuntimeService.send` route now commits one output
journal for each logical submission, including its automatic Goal continuations.
Chat and `PanelAppBridge.agent.submitPrompt` use this same service. Task Inbox
continues to project the canonical Session status and the service's actual live
turn state. This adds no UI, navigation or sidebar entry.

## Commit and ownership boundary

Before the first physical CLI request, the recorder appends and syncs the real
canonical user record, claims that record's id as `runId`, and journals its display
projection. Provider thread ids are resume keys only. Hidden Goal continuations
append their own canonical input while retaining the first submission's run id;
they do not create a new logical run or another journal terminal.

Each input/output check binds the recorder's registered close epoch, directory
device/inode, Session id and `startedAt`; an already present cost accounting
Session identity is also retained. Output/state writes additionally require the
actual run id. Core's existing journal checks, bounds, hash chain, identity pin,
durable cursors and repair barrier remain authoritative. These checks do not
claim a new cross-process transaction spanning canonical transcript and journal,
or protection from arbitrary filesystem writes after their verification point.

Every visible provider event is journaled before Main snapshots or owner-window
delivery. Canonical transcript flush/sync, journal and finalization failures set a
sticky live fence even when the producer catches callback exceptions. The service
returns a failed outcome, emits one explicitly incomplete failure boundary if it
still owns the run, and starts no queued/next physical request. A failed disk
write can also prevent the durable failure flag itself; the live fence still
applies, and the existing journal reader must prove completeness on recovery.
There is no automatic repair/reset operation.

An already recorded client message id is an application conflict: it makes zero
new physical requests, preserves the existing successful outcome/journal, and
does not poison healthy storage. A different payload with the same id is also
rejected. An ordinary provider start failure fences queued reuse of that failed
process without marking the journal damaged; the existing `ensure`/start path
must replace it before another submission.

Accounting updates recompute this provider turn's delta against the latest
Session state on each CAS attempt. They preserve auxiliary usage and domain
metadata, including title, workspace, Profile, Goal and cost ledger state. The
provider's own cumulative baseline is separate from Session aggregate usage;
a cold resumed thread's first `total - last` identifies its pre-existing history.
Repeated/out-of-order snapshots do not add the same reported usage twice. Partial
notifications without request identity retain conservative per-turn snapshots.
The change does not create native model-request or provider-billing receipts for CLI
traffic, and reported CLI usage remains subject to the existing upstream limits.

## Actual producer and consumer paths

The coding composition captures a concrete output sink before each tool call's
first await. Runtime callbacks bind both the logical run and physical provider
turn; late output from a closed/replaced turn cannot borrow a later turn. A tool
started outside a provider turn receives no run-output sink. Claude's per-process
translator and Codex's existing turn tombstones retain their protocol roles.

The production Main ingress appends once to `SessionSnapshotStore`, then sends
`agent:streamEvent` with that store's epoch/sequence to the exact live owner.
Another window does not receive that real-time stream. Existing local history
read authorization is unchanged: this is not a new owner-only history policy.
Recovery uses the existing `sessions:outputJournal` IPC and Desktop reducer, not
raw CLI history or a made-up transcript-id/transport-sequence mapping.

Goal events created by this logical send capture its publisher; its automatic
continuations and finalization share the same journal. Independent Goal control
edits, observational background-job output and other events outside an owned run
are not journaled by borrowing whichever run happens to be active. Shared output
coverage must keep such unpaired visible output behind its recovery barrier.

`agent.task.start` remains an ephemeral native worker path. CCRoom's raw CLI
observer, arbitrary transcript imports and other hosts/producers are not adapted
by this change. In particular, paired Mobile's worker-outbound mirror does not
subscribe to this Desktop owner-window ingress; external CLI real-time delivery
and its corresponding Mobile recovery remain a separate adapter gap. Physical
Electron GUI/relaunch, real logged-in CLIs, provider accounts, billing and weak-network/device acceptance are separate gates. Existing
journal limits, bounded legacy cutover, retention/rotation and repair TODOs remain.

## Verification

The guarded unit shard covers actual input/delta/final transcript or journal path
failures, swallowed producer callbacks, duplicate/queued inputs, stale sinks,
CAS interference with auxiliary accounting, close epochs, in-place Session-state
replacement and delete/reuse. It includes the existing Task Inbox projector and
isolated actual Panel bridge: failed external outcomes release the submit slot
without native fallback or a duplicate error.

`node scripts/run-external-output-journal-smoke.mjs` compiles the actual Main
adapters and runs compiled Core/coding in a fresh private HOME. Synthetic Codex
and Claude stdio children each produce over 8 MiB; a distinct Node Main process
recovers the exact hash through the actual IPC/reducer after RAM eviction. Other
cases cover the three physical disk failure stages, queued rejection, failed
provider-start replacement, live stop/replacement, two-round Goal output, and a
real loopback MCP tool that starts without a turn and returns during a new turn.
An actual Claude result-before-process-exit fixture separately verifies interrupt,
stop and replacement of the still-open logical Goal: exactly one aborted terminal,
failed submission outcome, and no cold phantom active run. A final Goal journal
write failure overrides a previously successful provider outcome.

The preload runs before Core/host imports and inherits into every actual Node
child. Four negative probes cover HTTPS, wrong loopback HTTP, a raw wrong-port
socket and a non-fixture subprocess. Only task-owned exact loopback listeners,
hash-pinned synthetic CLI wrappers and the exact cold Main entry are allowed;
all Node interpreters are pinned to the parent's executable. The launcher bounds
compilation and the whole fixture, and cleans only its detached process group.
PID/PPID/UID/private-HOME hash, Node version/executable/binary hash and observed
transport/process decisions are recorded. This is a JavaScript fixture guard,
not an OS sandbox or system-wide proof of zero external I/O. No model/provider
request, real account or production operation is used.

Local final source checkpoint: `17df6446d8015824321624ada5f42ac434e3b832`, combined
with Mobile main `8dd491d0`. The [receipt](external-runtime-output-journal-receipt.json)
records the exact source/tree/lock and 68 regular raw evidence files. Package
release passed 9 tarballs, 47 typed entries and 45 runtime imports; all 12
workspace typechecks plus Web SPA passed. The focused shard passed 163 tests
with zero skips. Lint remained at 0 errors/105 baseline warnings. Owned files
passed formatting; the global check retained 416 style warnings in files that
were byte-identical to main, without formatting unrelated code.

The final external fixture passed all 18 cases under Node 22.16. Both providers
recovered exactly 9,439,680 UTF-8 bytes in separate cold Main processes. The raw
guard recorded 23 actual Node pre-import identities, each with four negative
probes and the same private HOME/interpreter hash; its request/cold-process
aggregate includes 22 PIDs because one allowed CLI instance has no physical-turn
request record.
The combined Native Core Mobile fixture also passed authenticated reconnect,
same-epoch gap, actual AgentServer inputs and frozen append joining. That separate
regression does not demonstrate a Mobile external CLI adapter.

The earlier PR checkpoint's type error, missing exact internal export entry and
export-budget failure are retained in the raw evidence. Their explicit fixes and
26 targeted passing regressions precede the final combined gates. Earlier local
harness failures also remain separately labelled. Final CI is evaluated on the
exact final [PR99](https://github.com/cjhyy/codeshell/pull/99) head, separately
from this local source receipt; no old failed head is treated as acceptance.
