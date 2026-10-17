# Root independent read-only review — Search/selection

Reviewed search.md, actual parser/Main gate source, focused fixture, first raw log/exit, validation/dedup and skipped-direction notes. No additional product execution.

Keep **0 formal findings and SEARCH-R13-C1 as a candidate**. The parser actually preserves trailing whitespace and uses untrimmed minimum length without an upper bound. Main source trims and rejects lengths outside 2–128. The first fixture's one-character-plus-space and 128/129 controls establish the pure parser behavior, while Main/IPC/debounce/UI remain unexecuted. A stronger frontend acceptance requirement is missing, so a confirmed UI failure or severity would overstate the evidence.

Engine/local mapping controls follow the explicit archive/no-repo/fallback order contract. modelSelection callbacks operate on owned memory and cannot demonstrate a real UI caller that the search did not find. The round6 modelPicker grouping failure remains skipped; the new tests do not restore it through an alternate import or render route.

First raw output confirms **18 pass, 32 expectations, 0 fail/skip**, guard completed; 13 existing plus 5 new focused cases. No shared output is counted twice. No report correction requested. Root integration will additionally verify worker/source/artifact pins against frozen Git blobs.
