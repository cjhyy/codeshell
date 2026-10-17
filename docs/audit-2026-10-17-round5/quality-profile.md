# Independent read-only quality review — prompt and Web

Reviewer: profile subagent, independently reviewing the other authors' `prompt.md`, `root-web.md`, four fixtures, original logs/exits, prompt receipts/source manifest, historical dedup ledgers, and the cited production source. Frozen source: `9a421b3e65d5bfe662b78062cb86bd99483a683a`. No tests, experiments, product edits, native applications, network, models, credentials, or user data operations were performed for this review. The profile finding is self-authored and is not represented as independently reviewed here.

## Disposition

| Item | Assessment |
| --- | --- |
| PROMPT-01 — P3 | Supported. The current scanner explicitly promises `managed → user → project (root→cwd) → local` at `instruction-scanner.ts:57`, but appends each ancestor's local entry inside the depth loop at `:108–112`. The fixture verifies scanner/combiner output and actual `PromptComposer.buildUserContextMessage()` propagation. The report confines consequence to ordering and does not claim observed model obedience or permission consequences. |
| WEB-R5-01 — P2 | Supported as one agent-scope family. Actual reducer detail branches change the global run state, while child completion preserves it. Actual background `Agent` forwards details through the real wrapper, with only the spawner injected; the parent terminal is explicitly simulated. Child-error loss of the main live accumulator is a second symptom of the same scope failure and is appropriately not counted separately. Desktop/Mobile impact is static consumer wiring, not UI or Host/WS execution. |
| WEB-R5-02 — P3 | Supported within the stated supported-order condition. The reducer and its existing test explicitly handle result-before-start. The orphan branch preserves raw result text while the normal branch strips reminders; the two same-data fixture paths produce different final tool text. The report does not claim production WebSocket reordering, a security issue, or sensitive-data exposure. |

The current evidence supports **three findings across these two reports: one P2 and two P3**. No additional finding is suggested by this quality review.

## Documentation correction requested

The first Web finding's line list should reference the actual global `run: "running"` assignments at `streamReducer.ts:206,218,239,250,269,300`. The child `turn_complete` guard that preserves global state is at `:482–485`; `:478–481` only seals the child items. The report's broader function ranges locate the right logic, but these exact lines are preferable for the final audit. This correction was sent to the author; it does not require a test rerun or change the finding.

## Evidence count and custody checks

The four raw logs all end in guarded `Completed Bun shard` receipts, and all four first exit files contain `0`:

| Shard | Tests | Assertions | Outcome |
| --- | ---: | ---: | --- |
| prompt-instruction-order | 2 | 14 | 0 failures, 0 skipped |
| prompt-composition | 4 | 19 | 0 failures, 0 skipped |
| root-web-state | 4 | 15 | 0 failures, 0 skipped |
| root-web-background | 1 | 8 | 0 failures, 0 skipped |
| Total reviewed existing execution | 11 | 56 | 0 failures, 0 skipped |

These are the authors' original executions, not additional independent reproductions. Prompt receipts correctly total 6 tests/33 assertions, and the two Web logs total 5 tests/23 assertions. No repeated test is counted. Prompt receipt fixture/log SHA-256 values match the files read by this review. Its manifest records 28 frozen-source matches. Its documented count-parser `AssertionError` is preserved separately and is properly distinguished from a fixture/test failure; no test repair or rerun is claimed.

SHA-256 of the reviewed original logs:

- `prompt-instruction-order.first.log`: `6115fe83e3466a0a9d1413dd21195f431060538f000ffd30e2f69e0b3fe55bf8`
- `prompt-composition.first.log`: `31708a8ee0d435dd3d177c9be9449dc749294c43c67164a30753b6ccabcd7e66`
- `root-web-state.first.log`: `6e6c55423b5b5a9f98cce6d434f0ef7668e2441bc5d6edbe9abef34744f813a2`
- `root-web-background.first.log`: `7be27f8160087b5bdf857fc8161cf16cea15096e5c35b61b6c69934c5a816d2a`

At review time, a separate root/Web JSON receipt/source manifest had not yet been assembled. The Web assessment therefore relies on the existing fixtures, raw completed logs/exits, dedup ledger, and directly inspected source; it does not attest a later assembled root manifest.

## Contract, duplication, and limit checks

The prompt report distinguishes its current scanner API contract from archived implementation guides. The custom-system-prompt precedence issue is explicitly excluded as a historical duplicate. Reused-composer cache speculation is not promoted because the production Engine creates a composer per run. The coding preset check is correctly described as source/data passed to the real loader, without a claim that the coding capability or adapters were instantiated.

The Web dedup ledger's parsed-record recheck distinguishes old orphan-result loss from the present normalization omission. It also distinguishes old headless subagent-output fallback and provider retry text from current Web lifecycle projection. The reports retain candidate and unavailable-production-timing boundaries instead of converting them to findings.

The actual background Agent fixture uses its real registry, queue, forwarding branch, and reducer, while an in-memory spawner controls timing. It writes only under the guarded runner's own HOME and resets the registry/queue. The simpler reducer fixture contains no transport or child process. Source UI send/stop wiring corroborates potential user consequence, while the report correctly leaves actual DOM, Engine, Host/WS, and user-button behavior unexecuted.
