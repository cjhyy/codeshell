# Durable output journal: recovery boundary

This change gives newly started persistent Core runs a Session-owned output
journal. Desktop's existing history hydration and the standalone Hub Web app
consume its frozen pages when Main/Hub RAM has evicted a stream prefix. It adds
no navigation entry, sidebar, Panel policy, or mobile UI.

## Persistence and identity

`session/output-journal.ts` writes each complete logical StreamEvent before the
shared `engine/run-stream.ts` forwards it. Every published cursor follows a
successful `fsync` of that event, including terminal events. First creation also
flushes the journal's directory entry and an atomic Session-state identity pin.
The pin is written under the same short synchronous state lock used for run
ownership. An already pinned journal that disappears, becomes empty, or changes
its header fails recovery and new writers; it cannot fall back to legacy history
or silently start a new journal.

The immutable header/record hash chain is independent of physical placement.
Cursors additionally bind the current canonical storage root, Session directory
incarnation, journal header and file inode. A restored copy retains verifiable
records while old-root/file cursors become invalid. Main/Hub transport epochs and
their sequence numbers are separate domains. Child forwarding creates a parent
record and retains the child's cursor as origin metadata.

Each append checks the current run owner and Session directory identity under
the state lock, then checks them again after flushing. Existing Desktop deletion
quiesces the worker before deleting Session files. A late writer cannot recreate
a deleted/reused Session. Archive retains the existing read policy. Ephemeral
Sessions keep their ordinary process-local stream and never create this file.
The writer retains the nanosecond file stamp of its last successful flush. An
unexpected stamp change requires rechecking the pinned header and complete old
prefix before another cursor can be published, including same-length in-place
damage with restored mtime. Ordinary owned appends update their own stamp and do
not rescan the full prefix per chunk. Recovery also rechecks header identity on
changed stamps and the Session pin/sticky failure before returning a page; a
new run owner alone does not invalidate an older frozen prefix. A continuously
appending worker may change the whole-file stamp during that check: recovery
verifies the pinned header and frozen prefix hash rather than requiring a
globally stable file. Arbitrary writes bypassing the owner lock retain the
filesystem TOCTOU limitation after the bounded verification point.

Only an unfinished final logical event may be isolated after a crash: either an
unterminated line, or complete newline records belonging to a fragment group
whose final member was never committed. Interior damage is not skipped. EOF is
pagination coverage; only a recorded terminal event can finish a run.

An I/O, event-size or journal-budget failure sets the sticky
`outputRecoveryIncomplete` barrier. The actual Engine emits a failed terminal
without a durable cursor, even when a provider swallows the original callback
exception. Later intents fail before another model request until the Session's
damaged output is repaired; successful live completion cannot hide that barrier.
This change does not provide an administrative repair/reset operation.

## Bounds and Main responsiveness

- One journal: 128 MiB. It fails closed instead of deleting a prefix or extending
  a RAM fallback when the budget is exhausted.
- One logical event: 16 MiB of serialized UTF-8. Larger events fail before
  publication. The writer holds that bounded serialized event and its bounded
  record assembly during the synchronous append.
- One fragment: 64 KiB decoded bytes. One journal record: at most 256 KiB.
- One page: at most 1 MiB of frame JSON and 512 frames, plus cursor/envelope
  metadata. The exact old transcript cutover base is separately capped at 1 MiB
  and 4,096 records.
- Browser recovery retains at most one 16 MiB fragment assembly plus one page.
  Completed events enter the existing transcript/chat state; that user-visible
  history is distinct from the bounded auxiliary replay buffers.
- Main retains at most 2,000 frames/8 MiB per Session and 64 MiB of frames across
  Sessions. Hub retains its existing bounded RAM replay policy. Both retain the
  latest durable pointer independently of an oversized/evicted frame.

The first read or any changed file stamp verifies the entire current bounded
journal synchronously; it is **not** a constant-I/O/CPU page operation. A cache
holds verified positions and hashes for at most 16 files, never event bodies.
Sparse checkpoints are at most 512 frames or about 1 MiB apart. Reuse requires
matching canonical file identity, size and nanosecond ctime/mtime. Unchanged logs
seek near `after`/`through` and read a bounded page. Changed logs must reverify
the prefix, including damage before `after`; an append during a query also
revalidates the frozen upper bound. Continuous appends can therefore cost a full
bounded scan per page and may keep recovery behind its existing failure barrier.
This is not a background I/O/indexing service.

## Consumers and compatibility

Desktop uses the real `sessions:outputJournal` registrar, optional preload method
and `recoverDesktopOutputJournal` adapter inside `useTranscriptBuckets`. Hub
handles owned `output_journal` queries without starting a model worker, and its
`session_detail(outputRecovery: true)` returns the bounded cutover base instead
of sending the huge latest assistant reply in one RPC response. The existing
Web controller then uses `chatFromOutputJournal` and the shared whole-event page
validator.

The replay-only user anchor retains canonical input display metadata and stable
submission identity. The shared browser projection reuses `transcriptUserDisplay`
for files, directories and images; image records retain MIME/decoded size and
paths, never a second base64 payload. Injected or agent/system/policy input keeps
its hidden origin and an empty identity marker rather than exposing a machine
prompt as a user bubble. Actual Engine input fixtures verify text with file and
image attachments, attachment-only turns, and hidden injected/agent turns through
Desktop's existing hydration hook after RAM eviction and Hub's existing adapter.

Recovery freezes `(from, through]`, verifies consecutive positions, and joins to
actual live durable pointers before releasing the current hydration barrier.
New append heads do not change an older page's upper bound. Renderer-local
decisions retain stable submission/request identities; no reply-content dedup
or invented Transcript-ID-to-transport-sequence mapping is used.

Old peers and old in-flight producers without durable cursors retain the legacy
conservative recovery path. A missing/oversized legacy cutover base keeps the
barrier closed. This change does not adapt the frozen mobile/paired Panel flows,
external-runtime output producers, arbitrary historical imports, unlimited
history, automatic journal retention/rotation, or a damaged-journal repair UI.
Those limits remain TODOs; the complete long-stream recovery item is not marked
finished by this slice.

## Verification

Unit shards run only through `scripts/run-bun-test-shard.mjs` with private HOME
and completed JUnit validation. Coverage includes frozen pagination with append,
same-file prefix corruption after a cached read, header pin loss/truncation,
copy/replacement domains, run-owner supersession, delete/reuse, archive,
ephemeral output, UTF-8 fragments, unfinished tails, byte/frame/event/storage
bounds, and actual Engine failure despite a swallowed callback error.
The ordinary `Engine.run(task)` overload without options or an external stream
observer also has actual success/persisted-terminal and swallowed-write-failure
regressions; its internal wrapper is independent of user observers.

An actual Engine regression invokes a custom tool returning `sensitive: true`,
a raw sentinel in both its result and content blocks, and explicit display and
transcript placeholders. The next model round consumes the raw sentinel, while
the live tool-result event, saved transcript, journal bytes and every recovery
page contain only the placeholder. This verifies the existing sensitive-result
boundary at the new persistence sink; it does not classify arbitrary model text
or expand unrelated tool metadata semantics.

`bun run test:output-journal` runs the compiled Core through the actual OpenAI
SDK against one exact `127.0.0.1` fixture origin. It restores 9,060,345 UTF-8
bytes from 2,212 live events through the actual Desktop IPC/reducer adapter and
authenticated Hub WebSocket/client adapter. It verifies full-text SHA-256,
frozen multipage coverage, fresh Main snapshot epochs, two restarted stdio
processes with actual PID/private-HOME/origin receipts, and a restarted Hub with
a stable durable cursor and changed Hub epoch. These are controlled adapter
fixtures, not a claim of a physical Electron renderer/relaunch or mobile test.
The fixture makes one healthy SDK request and one separate physical write-denial
request on supported non-root POSIX hosts. That second actual Engine run fails
instead of publishing a completed terminal, and a later intent makes no further
HTTP request while the sticky recovery barrier remains set.

The native fixture also prints cold first-page time/read bytes and full pagination
time/read bytes for the real model journal and a journal above 120 MiB. It checks
the reconstructed hashes and requires static near-budget pagination to read
less than eight journal lengths, including metadata and sparse seek reads.
Measured timings and final CI results must be recorded after the final source
and package build; no real model/provider account or third-party write is used.

Local Node/macOS measurement for checkpoint `09dceb2f` (controlled fixture;
not a cross-machine latency guarantee):

| Journal | Cold first page | Cold read bytes | All pages | Total time | Total read bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 33,863,048 B / real 9,060,345 B model response | 73 ms | 35,093,098 | 35 | 979 ms | 98,588,786 |
| 126,245,314 B / near 128 MiB budget | 173 ms | 127,425,705 | 131 | 4,030 ms | 344,240,041 |

The near-budget result reads about 2.73 journal lengths, rather than one full
journal per page. The cold verification still blocks its calling thread for the
measured scan duration; active file changes can require additional full scans.

Queued attachment steering uses the same generic input display projection as
initial user input. The existing `steer_injected` event retains its queued id,
Session and submit identity; image payloads stay in model/canonical transcript
storage. The shared browser projection runs on both live reducer entrances and
durable replay. Actual Engine tests enqueue file+image guidance during the first
response, prove a subsequent model request consumed both attachments, evict the
RAM prefix, and compare live/recovered display fields in Desktop and Hub.

Cache admission also binds the verified file stamp to the captured scan size:
an append between size capture and stamp capture cannot cache an older head
under the new full-file identity. A scheduled real writer regression proves
the next fresh query sees that last durable append even if no further output
changes the stamp. Attachment-steer live/recovery tests enter through the actual
ChatSession queue; its envelope preserves the queued input's own submit id while
retaining the parent run id, so the original user bubble is not overwritten.
