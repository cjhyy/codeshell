# Root independent read-only review — Patch

Reviewed `patch.md`, focused fixture, first raw log/exit, findings/validation/source metadata, and the frozen parser grammar, wrapper handoff, and applier matcher consumption. No additional product execution.

**Accept PATCH-R12-01 as P3.** The grammar explicitly permits both a space marker with empty content and omission of the first `@@`. The outer `trim()` skip at parser lines 149–152 removes that marked context before the chunk parser, while an explicit `@@` bypasses the skip for the same data. The eight first-run cases include nonblank, interior blank, explicit-marker, tab and Add-content controls. Actual pure matcher positions 0 versus 2 support changed matching scope; filesystem corruption remains unexecuted/static and the report says so.

The old May 30 item concerns acceptance of *unmarked* blanks inside `parseUpdateChunk`; this new defect concerns losing *marked* leading blank context in `parseOneHunk`. The branches and corrective changes differ. Full historical corpus supplement is explicitly recorded rather than silently replacing the initial selected subset. First log confirms 8 pass, 31 expectations, 0 fail/skip and guard completion. Selected source pins will additionally be checked against frozen Git blobs during root integration.

No corrective report changes requested. Existing mixed applier tests were source-only and are correctly excluded from executed totals.
