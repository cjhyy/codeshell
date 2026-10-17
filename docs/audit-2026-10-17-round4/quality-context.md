# Independent read-only quality review — Coding and root slices

Frozen base: `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`. Independently read `coding.md`, `root.md`, their fixtures/raw logs/exits, the Coding receipts/dedup records, and current production caller/implementation ranges. **No tests or new experiments ran in this review; no product or original evidence files were changed.** One read-only lookup checked the official LSP 3.17 didOpen specification.

**Verdict: retain the existing 3 findings — Coding 2 P2, log retention 1 P3. This review adds 0 findings and 0 executed tests.** The four CLI candidates remain unconfirmed and excluded. The reports accurately separate source evidence, in-memory adapters and behavior actually exercised.

## Coding findings

**CODING-R4-01 / P2 is supported.** `tools/lsp.ts:91` correctly creates the request URI; 96–110 routes normal Definition/References responses through the shared formatter; 199–210 strips `file://` without decoding. A normal Location URI for an existing path containing spaces, Chinese characters, `%` and `#` therefore becomes a different filesystem path. Coding capability registration at `index.capability.ts:190–202` uses this implementation, so this is not a dead helper. The fixture goes through the real tool and actual per-workspace manager, substitutes only `getClient`, creates its own real file, and checks that the formatted path differs and does not exist. ASCII and 1-based line controls are meaningful. Two action manifestations are correctly merged into one formatter finding. No GUI click/read/edit, real server, Windows or UNC result is claimed.

The prior May record is the manager's spawn cwd conversion, not this output consumer: `lsp/root-path.ts:11–12` now uses `fileURLToPath`, and the new test verifies that normal conversion. Record-level historical JSON inspection and the Coding dedup receipt support keeping the remaining formatter defect as a separate residual finding. Old launch/readiness/liveness failures are excluded.

**CODING-R4-02 / P2 is supported with the report's stated limit.** `tools/lsp.ts:135–158` rereads current disk text, but every call issues `didOpen` version 1 without `didChange` or `didClose`. `manager.ts:42–43,253–258` reuses a live client for the same workspace; `client.ts:122–127` forwards notifications without inserting document lifecycle operations. This is a repeated-open sequence on one protocol session, not a fresh client per check.

The [official LSP 3.17 didOpen source](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/textDocument/didOpen.md) states: “An open notification must not be sent more than once without a corresponding close notification send before.” Its preceding text also assigns content management to the client after opening. Thus invalid synchronization is source- and contract-supported. The strict adapter's stale diagnosis is one plausible consequence, **not proof that a particular real server rejects or retains duplicate opens**; both report and receipt disclose that distinction. No 10-second timeout branch ran. The report appropriately keeps duplicate open plus stale output as one finding, and does not expand this into unrelated server startup or notification collection failures.

The fixture's protocol notifications and both disk contents are explicitly asserted. Its `beforeExit` observation logger did not run under Bun; `coding.md` and `coding-receipts.json` already disclose that no raw observation payload was appended. A stale fixture comment claiming otherwise does not change the retained assertions/logs and should not be cited as an observation receipt.

## Log retention

**LOG-R4-01 / P3 is supported.** `logger.ts:69` caps the total at seven files; 353–361 creates two bucket prefixes per date; 439–445 sorts entire basenames and deletes the lexical prefix. `ui-ink-*` sorts after `engine-*` regardless of date. The real `rotateLogs` fixture therefore deletes today's existing engine file while retaining a six-day-old UI file, and real `getRecentLogs` sees only the UI event afterward. The single-bucket eight-day control isolates the cross-bucket sorting cause.

The startup path is current: `tui/src/cli/main.ts:218–227` invokes `setup` in ordinary command preAction, and `bootstrap/setup.ts:24–31` rotates before recording startup. That comment explicitly says recent seven days. The old logging module document describes a seven-file cap; that does not justify deleting a newer engine record in favor of an older UI record. Scope remains diagnostic history loss, not transcript/session/project loss. P3 matches the narrow impact. TUI startup execution itself was not tested, and the report says so.

Recent audit/review scans and the reviewed historical records did not disclose an earlier confirmed cross-bucket lexical deletion finding. The separate `/log` candidate concerns a reader filename mismatch; retention concerns deletion order. Their code and failure mechanism differ, so the retention shard does not retry or validate the failed CLI candidate by an alternate route.

## Receipts and failed CLI accounting

| Retained execution | Actual first log | Count accepted here |
| --- | --- | --- |
| Coding LSP data | 8 pass, 0 fail, 32 expect; Completed; exit 0 | Existing 8 tests / 32 assertions |
| Root log retention | 2 pass, 0 fail, 7 expect; Completed; exit 0 | Existing 2 tests / 7 assertions |
| Root CLI data | 0 pass, 1 fail, 1 error; no Completed; exit 1 | Failed fixture import only; 0 business tests / assertions / confirmed findings |

The CLI failure is at fixture line 13, assigning to the readonly ESM namespace export `http.request`. All product dynamic imports are later, starting at line 19; all four authored test bodies occur after those imports. Consequently none of the four CLI candidate assertions ran. The runner's “Ran 1 test” summary is the load error and must not be recast as an executed candidate or successful test. `root.md` currently keeps this correct boundary and states there was no guard repair, alternate import or rerun.

The two completed shards above total **10 existing tests / 39 assertions**, not 14 tests with CLI candidates included. This independent read-only review must not add those tests a second time to batch totals. The failed CLI shard remains a separate failure receipt, not a product failure or a passed/fully covered area.

Read-only hash verification matched all **15 Coding source receipts and all 4 Coding artifact receipts**. Current raw-log hashes are:

- `coding-lsp-data.first.log` — 1176 bytes; SHA-256 `096abbde3548c3f04585b0ca1fced8e3870edf1f9abce196d660e6e0a14a5fa1`.
- `root-log-retention.first.log` — 414 bytes; SHA-256 `e013373c2de1a1a37f0329cf3feec0d58ff70f13e7bb49b37bdd2e12a2a129d0`.
- `root-cli-data.first.log` — 737 bytes; SHA-256 `92529ee3c186f7e39c9f61e859a6028419638021f91d1fc31616ac26f92f0c7f`.

Original raw logs were only read, never rewritten. Review coverage is source/contract/evidence assessment; it does not independently rerun a language server, full TUI, watcher, timeout, native platform, provider or network fixture.
