# Read-only aggregate review — round 13

Reviewer: `/root/search_selection_round13`. Frozen baseline `7927a7c8b80b4aec710dee1f6d831ad1982bb466`. **Accept after one metadata correction, now resolved.** The current aggregate supports **2 P3 findings, 4 candidates and 1 old-family association** at the stated evidence levels. This review executed no tests or product code and wrote only this file; final evidence-index refresh and integration remain root's responsibility.

## Independent checks

- Read README, findings, candidates, related, validation, source-manifest, worker-integrity and assembler; additionally read the history report/fixture/raw log, groups report/failure/skip receipt, earlier root/search materials, and latest integration-plan/root-final-qc.
- Findings `reportLine` values **5** and **13** resolve to the exact `HIST-R13-01` and `HIST-R13-02` headings in history.md. All current Markdown local links resolve; the old R2-08 fragment corresponds to its actual heading. No candidate or old-related row is counted as a confirmed finding.
- Independently parsed all **5 raw logs and their exits**. Clean rows are 8/17, 7/31, 18/32, 33/66 (tests/expectations): **66 tests, 146 expectations, 4 completed zero-failure shards**. **54 existing = 8 root + 13 search + 33 groups**; **12 focused = 7 history + 5 search**. The same history log is counted once despite supporting two findings and one candidate.
- The failed groups log is separately retained as **0 pass / 1 fail / 1 error, exit 1, no Completed marker**. Its unchanged fixture has seven planned test bodies and the original wrong relative import; none loaded. The summary consistently says source-only candidates and entire focused direction SKIP, with no fixture repair, retry, alternate parser/VM/fixture, or substitution of the earlier successful baseline.
- Verified all **69 unique source pins** against recorded bytes/SHA256 and actual frozen Git blobs; current files match. Verified **40 worker artifact hashes** with zero mismatches. The **71 worker source checks** include repeated sources and are correctly distinguished from 69 unique pins.
- Full-history dedup counts agree across reports: **1075 MD + 641 JSON = 1716 files**, 0 JSON parse errors. Root/Search string-leaf count 171493 and History/Groups scalar-leaf count 240534 are explicitly separated. Historical grouping DD6-04, i18n, Git A03/A04 and other failed/known directions remain excluded.
- Assembler only reads saved artifacts, computes metadata, performs read-only audit Git blob lookups, and writes aggregate files. It does not launch the guarded runner or product helpers. This review did not rerun the assembler.

## Evidence boundaries

- History order and stale navigator snapshot are distinct actual helper behaviours with ordinary static submit/Esc consumers. The homedir-only pre-import mock directs real fs to owned temporary JSONL; fs and nextTick are real, environment HOME/home/CODEX_HOME is not reassigned. README/findings do not claim React/Ink/real-key execution, permanent content loss, every component lifecycle, or cross-start undo durability.
- Same-tick flush reachability and stronger search UI validation contract remain unproven candidates. Search parser and memory callback observations do not claim actual UI/Main/IPC/debounce execution or active default-model persistence.
- Both patch-summary candidates and Move association remain source-only after the focused loading failure. Existing baseline success does not validate those unexecuted cases. Failed Bun fixture loading is not misreported as a product defect.
- Integration plan records unchanged selected sources and preserved primary dirty state, and QC explicitly keeps the goal ongoing. This aggregate review does not independently certify the future commit/main fast-forward. The evidence index is expected to be refreshed after this review is added.

## Resolved metadata correction

Initial review noticed README said validation explicitly listed each command, while `validation.runs` then contained only log/exit pointers. Root updated the metadata-only assembler to preserve `command` from the existing first JSON exit receipts, or Search's existing first receipt for its text exit file. Independently rechecked all **5 command arrays**: each exactly matches its first receipt and starts with `node scripts/run-bun-test-shard.mjs --timeout 30000`. No product or fixture rerun occurred. README's statement is now supported; no remaining required correction identified.

Reviewed final aggregate SHA256 pins:

| Artifact | SHA256 |
|---|---|
| README.md | `47ca0fea8fc0c669a418c1fa28afa41f9603d59f312f16b6f24088aef6bb8870` |
| findings.json | `41ad5276ff72d719749da96ec7a5a3a81a7e4baff4fe58b9bc436225f541ef42` |
| candidates.json | `4492a55b99ee993e6b63e142105ed719fe90b82d573b903f2a2b95a084fdd071` |
| related.json | `6ee3374a8ff13a9b4a8fd5fd5caf607c0cca50826749a896e75ff359e19c2ced` |
| validation.json | `93eafe0d1497421715ce170ca852a990da05dd679bca326aeca25663800ec3de` |
| source-manifest.json | `5d8162f50e27b504164e10a321d1bceaf7c31ef2ba8008554b2619281fb80762` |
| worker-integrity.json | `65bd3a4ea310710548628bf2c0476c77fac6b53a6ce007a37854440f0900c800` |
| evidence/assemble-audit.py | `391956271561e78322f0f72cd3c83d7c1ecd13090890f1199f0de8939507505a` |
