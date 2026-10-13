# Frozen output cursor concurrency correction

PR 146's Linux Node 22.23.3 CI reached the real durable-output smoke and returned
`cursor_invalid` while an independent worker appended during frozen pagination.
The failure was not a TypeScript error. The concurrent assertion remains strict.

A segmented view captured the active descriptor's end during construction, while
`currentSize()` subsequently obtained a later physical file length. An append at
that boundary made verification scan beyond the view's old active end. Its read
method reported an artificial EOF, so intact frozen cursors looked truncated.

The reader now extends only the last active descriptor's readable range when the
requested position lies beyond its captured end and a fresh `fstat` proves bytes
are physically present in that same descriptor. Closed segment ranges, manifest
chain/inode checks, publication watermark verification, retention floors and
repair barriers keep their existing authority. Actual truncation or a missing
segment still fails closed. No cursor, gap or corruption status is synthesized.

The new deterministic regression schedules a real durable `writer.append` after
the view opens its descriptors and before its size capture. It fails on the old
production code with exactly `cursor_invalid`; the corrected code preserves the
frozen through/next cursor and subsequently recovers the appended event. The
native concurrent smoke also retains page index, requested cursors, storage pin
and actual worker progress in any future assertion failure.

Validation uses isolated HOME and actual compiled Core/Main/Hub consumers with
exact-origin guards installed before Core imports. The full journal/storage shard
passes 41 tests / 418 assertions. Manual repair passes 18 tests / 1144 assertions,
including all real flush/write/truncate/link/unlink and historical-v1 fault cuts.
The full native durable-output smoke passes SDK, no-run stdio, compiled Main,
segmented retention expiry and Hub restart recovery with the original output hash.
Core typecheck, involved ESLint and build pass. The adjacent JSON receipt records
repeated independent native-process pagination pressure; CI on the release branch
remains the final integration gate. No production migration or release is claimed.
