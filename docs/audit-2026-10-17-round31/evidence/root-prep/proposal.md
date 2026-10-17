# Round31 search prep — candidate only

Root parent context19efab9225723c76af447f8b9d9f65aace3b0780, not future formalbaseline. **0formal /1candidate /0new-related**, SEARCH-R31-C1.

findRowSearchMatches lowercases each cell independently, but scanPositions/applySearchHighlight lowercase the entire query. For ordinary two narrow grapheme cells `Ο`,`Σ` and identical query `ΟΣ`, contextual final-sigma rules yield row `οσ` but query `ος`. Source indexOf thus derives no match despite the documented case-insensitive helper contract. This is a static derivation, never an observed function result or terminal screenshot.

[Primary references](external-sources.json) identify ECMAScript lowercasing and Unicode context-sensitive final-sigma rules. No installed runtime/ICU version was tested. [Source scope](source-manifest.json) separates full leaves/tests and selected consumers. warn.ts first durable hash was after its read; other6 source pins preceded declared ranges. Existing9 parameterized search cases include ASCII/CJK/emoji/combining/dotted-I/exclusion/row-local but not sigma; none ran.

Independent source review supports P3 helper defect, but independent entry tracing has not found an App caller or package-public surface: hook is unexported/unused, Ink query starts empty, root Instance does not expose setter/scan. Root keeps candidate because an actual production/public consumer is unestablished. It does not claim real users triggered broken UI. Original reviewer assessments are preserved, not rewritten to match Root classification.

[History](history.json) includes2851 MD/JSON files and recursive JSON value scalars, excludes mutable30/future31; search-leaf6, Greek-case0 and broad case-map5155 occurrences, retained6/0/100. Exact6 contexts were read; broad capped context is not semantic exhaustion. Earlier scanner/code-unit and dotted-I work is distinct, no exact Greek cause found. Independent reviewer uses more precise21/29 contextual/case navigation counts; no conflicting new old-cause evidence.

[Classification](classification.json) and [validation](validation.json) preserve0product/import/function/fixture/Intl/TTY/native/test executions,0pass/expect. No fixture was authored or run; old failed Slice/i18n/TUI directions remain skipped. This prep stays outside repository until a fresh task branch formally binds then-current sources/history.
