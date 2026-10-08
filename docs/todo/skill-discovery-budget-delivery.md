# Skill metadata budget and discovery

The Engine now passes the current model context window, current task, and up to
32 recent Skill requests into prompt composition. Skill metadata remains in the
trailing dynamic context; the cached system prefix and tool definition do not
change when the visible catalog changes.

The default listing uses at most 1% of the model context window, capped at 2,048
**estimated** tokens. This uses Core's existing deterministic language heuristic,
not a provider tokenizer or billing measurement. Headings and discovery guidance
count toward the estimate. A Host can supply a smaller explicit budget. Very small
budgets can omit the listing entirely; the static Skill tool still describes
metadata discovery.

The visible catalog is filtered by the existing scanner before ranking. Priority
is explicit allowlist, project, active Profile declarations, recent requests,
local lexical task matches, then user and plugin defaults. Recent requests do not
claim successful skill execution. Matching includes CJK bigrams; there is no model
call, embedding index, or semantic relevance guarantee. Names are retained first,
then higher priority descriptions receive full or shortened metadata. Remaining
names are omitted with an explicit count. Bodies and paths are never listing data.

`Skill({query: "keywords", offset: 0, limit: 10})` searches only visible metadata.
An empty query pages through all visible skills. Results include exact names,
bounded descriptions, source, total, and the next offset. The same disabled skill,
disabled plugin, allowlist, and scanner source rules apply to discovery and exact
invocation. A catalog entry grants no authority; `Skill({skill: "exact-name"})`
continues to enforce its invocation gates and loads the body on demand. Query mode
adds no new UI entry or sidebar.

Validation includes hundreds of long multilingual descriptions, estimated budget
limits, deterministic ordering without mutating scanner output, names-only
fallback, metadata pagination, visibility gates, and an actual fake-provider
Engine request using a 64,000-token window. All model responses in these tests are
in-memory fixtures; no paid model or third-party service is called.

This completes the bounded Skill listing slice. Generalized deferred discovery
for other tool families, a stable dynamic ToolSearch catalog, provider tokenizer
calibration, and the larger Agent evaluation suite remain separate roadmap work.
