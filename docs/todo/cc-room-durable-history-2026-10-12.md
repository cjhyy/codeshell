# CCRoom frozen history and recovery acceptance

Branch: `codex/desktop/cc-room-durable-recovery-20261012`, based on `8ce3d2c8`.

## Room history phase

`RoomManager.getHistoryPage` freezes a validated complete JSONL copy before returning the first page. Its room-local signed cursor binds the room, immutable snapshot, physical offset and sequence. Copies and manifests are fsynced and survive a new Host process; appending to the live room does not move a frozen boundary. Eight copies are retained per room; expired cursors fail explicitly. An invalid record, sequence gap, torn final record, invalid UTF-8, modified snapshot, unsafe file or resource limit is an error, never an empty successful catchup.

The archive freeze limit is 256 MiB, a bounded implementation limit rather than a completeness guarantee beyond it. Views validate the entire requested frozen range before applying it and cap one catchup at 50,000 messages; both limits produce visible errors. Large-history archival/compaction and background streaming rendering remain future work. Legacy `getMessages`/`roomHistory` keep their old bounded array contract for compatibility; current Desktop and Mobile consumers use the new pages.

Room appends fsync before `onMessage`, first-file and metadata creation sync their directories. Active-writer external modifications and uncertain write failures latch a local failure; cold sequence seeding strictly scans the complete log. This does not claim protection against a malicious privileged process racing every filesystem operation or hardware that lies about fsync.

Desktop fetches all pages, validates continuity, buffers live messages and repairs a later sequence gap from its last contiguous room seq. Mobile requests pages with a viewer request id, ignores stale replies, buffers live messages, and only commits a validated frozen range. Page replies are sent to the requesting device. Neither path manufactures a native Session, Run, producer epoch or native output cursor.

Validation so far: guarded 75/75 Room history/scaling/existing Room/accumulator tests; guarded 113/113 Desktop/Mobile/validator/existing Room tests. Server build passes. Full build initially exposed a TypeScript overloaded Stats return-type issue; fixed and Server rebuilt. Remaining workspace/Desktop build and transcript checkpoint acceptance follow in the next phase.
