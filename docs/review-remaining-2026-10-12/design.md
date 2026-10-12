# Design Studio substantive review — 2026-10-12

Frozen repository: `/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps`, HEAD `aabba34ca94f7081fd7de4e20c52443f08f36d5e`.

Review only. Read Panel `AGENTS.md`, `CODESHELL.md`, `CONTRIBUTING.md` and Design README first. No product edits, install/build, publish, real Host/account/model requests, command-permission tests or exploit tests. This agent wrote only `/tmp/codeshell-panel-design-*` for this wave. Parent had already completed npm ci. Execution: macOS, Node25.8.1, cached Playwright Chromium headless executable, disposable browser profiles and maintained CodeShell isolated HOME runner.

## Outcome and exact counts

**7 grouped executed findings recommended: 5 P2 + 2 P3.** D1/D2 are the highest-confidence loss-of-edit findings. Remaining items have executed product-code evidence, with layers and limits stated below; they are not a claim that all Design branches are tested.

Final custom suite: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-run9.log` — **11 tests, 11 pass, 0 fail/cancelled/skipped/todo**. Eight tests launch an actual Design app in a browser with an in-memory Host (including the font-export test's setup), and three exercise pure production layout/export/PRD modules. Eight owned browser processes exited, cleanup `liveChromePids: []`. Assertions in this review intentionally establish the observed faulty behavior; passing does not mean these defects are fixed.

Existing normal/failure controls: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-existing-run1.log` — **19 tests, 19 pass, 0 fail/cancelled/skipped/todo**, comprising the repository's `portable-backup.test.mjs` (6), `legacy-backup.test.mjs` (6), and `recovery-session.test.mjs` (7), imported only after the network guard. Final unique case total for this wave is **30**, not a sum of repeated investigation runs. No assert-call count claimed.

Full source/support inventory: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-inventory.txt` — **48 paths: 34 Design application/support paths (including hidden manifest), 7 Design test files, 7 Design-specific scripts**. Inventory is not a line-by-line coverage count.

## Confirmed findings

All abbreviated source paths below are relative to the frozen repository above.

### D1 [P2] A rejected indexed-page transaction leaves its deletion in the cache, then the next save persists it

Primary location: `apps/design-studio/app/app.js:7457`–7461. Supporting mutation: `app.js:7443` (`currentPageCache.remove`); rebuild: `app.js:716`–739 and `page-runtime.mjs:78`–95.

Actual production chain: registered `use_design` → `enqueueAgentMutation` → `applyAgentDesignOperations` → `delete_page` mutates both design and page cache → subsequent `rename_page` references a nonexistent page and throws → catch restores only `design` → `compactIndexedPageRuntime` materializes pages from the still-mutated cache manifest. The deleted page is absent from that manifest, so restoring `previous` is immediately undone.

Trigger: valid indexed design, operations `[{op:"delete_page",page_id:"page-2"},{op:"rename_page",page_id:"page-missing",name:"Missing"}]`, `save:false`, current expected state revision. The API returns `页面不存在：page-missing`, but **12 pages become 11**, the page's real text `Page two payload` disappears, and metadata still says **dirty=false**. A subsequent actual registered `save_design` writes an index with that page absent. Thus the failure is not confined to a stale UI list or a transient cache count.

Normal control: the same sequence against a single-file design rejects, retains **2→2 pages**, retains the payload, and subsequent save retains the page. Evidence: `failed_transaction` records in run9. The fixture never edited product code; Host writes are in-memory protocol equivalents with revision/create-only checks. Actual CodeShell IPC, disk fsync, and a real Agent are outside this execution.

Recommendation: stage page-cache changes until the whole operation batch validates, or snapshot and restore manifest, entries and protection state alongside design on every error path. Include validation failure and save failure tests; this run dynamically proved the validation failure path only.

### D2 [P2] Editing while an opened indexed document's parts load is overwritten by the open result

Primary location: `apps/design-studio/app/app.js:3986`–3991; revision validation happens only at 3983 before the awaited resolver. Indexed resolver: `app.js:3624` (`pageCache.ensure`).

Actual production chain: file dialog row → `openDocument` → primary `workspace.readText` → revision check → async `resolveWorkspaceDesignSource` / indexed page part reads → assign new document / reset history. The canvas remains editable during these part reads. There is no second document/state check before assignment.

Trigger: start from saved document A, select indexed document B through the actual file dialog, delay B's active page part response, then change A's heading through the real Inspector to `Edited while opening`. Before release the current app context contains that edit. Releasing the part switches to B and removes the edit. The user did not approve abandoning this new edit: the dirty confirmation ran while A was still saved. `open_edit`, delayedPart=true, retained=false, path=other.codesign.json, no browser errors.

Normal control: delay B's primary file response instead; the same edit is retained and open is refused (`delayedPart=false`, retained=true, original path). `checkExternalChange` has a post-resolver state/document check at 4084–4094; explicit open is missing that corresponding check. Browser/Host latency is controlled, with all actual app handlers and parsers intact. No claim of an actual IPC race frequency or cross-project overwrite.

Recommendation: capture document epoch and state revision and recheck both after the complete resolver and before swapping design; alternatively freeze editing for the full open transaction while preserving any draft produced before freeze.

### D3 [P2] Frontend export permanently emits the ellipsized display string instead of the full editable source

Primary location: `apps/design-studio/app/frontend-export.mjs:373`–374; ellipsis CSS also absent at 315–328. Real producer: `html-capture.mjs:935`–938 sets both truncated `text` and full `textSource`. UI/API callers: `app.js:4385` onward (`generateFrontendFile`).

Trigger: valid imported text with `text="Truncated…"`, `textSource="Complete original content that must remain editable"`, `textOverflow:"ellipsis"`. Actual `exportDesignFrontend` output includes only `Truncated…`; full source is absent from all HTML, and `text-overflow` CSS is absent. Widening this exported element cannot reveal the lost suffix. This is editable-export content loss, not only an approximate pixel difference.

Normal control: ordinary text without this split exports its complete `A heading`. Evidence: `frontend_text` run9. Product export function and valid document structure executed directly; the entire HTML import→Host frontend write flow was statically traced, not executed end-to-end. No source `.codesign.json` loss is claimed.

Recommendation: use `textSource` for responsive/ellipsis HTML text and map overflow/white-space to CSS so full content stays available in the delivered frontend.

### D4 [P2] Frontend export drops project font bytes and renders with a fallback font

Primary locations: `apps/design-studio/app/frontend-export.mjs:319` and 428–445. `fontRef` descriptors/resource URLs never generate `@font-face`; resource URL handling only serves image nodes at 377. By contrast SVG's font rules are explicit in `document.mjs:1492`–1497.

Trigger: valid text with a project font descriptor, a unique alias `Review Owned Font`, and the available data URL passed through `resourceDataUrls`. Actual HTML exporter does not include the font bytes. In a fresh browser document made from that HTML, `document.fonts.size=0`; loading the **valid local system Arial.ttf bytes** under the exact alias succeeds (`size=1`) and changes a measured string width from **202.6875 to 202.59375**. The small difference is reported exactly; no large visual-error magnitude is claimed. Evidence: `frontend_font` run9.

Normal control: actual SVG exporter embeds a separate tiny synthetic font-data URL (serialization control only). The valid Arial font's SVG would exceed the existing 384KiB SVG budget, so that was not used as a rendered SVG control; original run6 preserves this expected budget rejection. The actual HTML browser/font load control uses valid font bytes. All font bytes are read-only from the local system, never downloaded or written into the repository/report.

Recommendation: embed verified used fonts in frontend HTML with descriptor family/weight/style and honor fontRef family selection. Verify in a new browser context without fonts already installed by the editor.

### D5 [P2] Responsive wrap never breaks the first long token, including ordinary Chinese paragraphs

Primary location: `apps/design-studio/app/layout.mjs:65`–67; `pushLongToken` is only reached for a later token at 70–71. Actual caller: `applyResponsiveText` at 813–817 and Inspector reflow.

Trigger: actual app with imported wrapped Chinese heading `这是没有空格的中文长段落`, source width 200; change its vertical Auto Layout frame width to 50 through the real Inspector. The resulting node has width 50 but remains **one line, height 19.2**, with the whole paragraph still in `text`. The SVG canvas does not perform browser text wrapping itself, so the text cannot fit its claimed box. Evidence: `ui_chinese_wrap` run9, no browser errors.

Normal control: production layout helper with `x ABCDEFGHIJKLMNO` wraps its later long token into multiple segments (`x\nABCDE\nFGHIJK\nLMNO`, height76.8). The same long token alone remains one line (height19.2). This isolates the first-token branch rather than font-metric approximation. Additional direct model observation: `one\ntwo` at width100 becomes `one two`; whitespace tokenization discards hard line breaks. This supplementary symptom is not a second formal finding and was not independently exercised through imported preformatted HTML.

Recommendation: process every overlong token, including the first, and preserve paragraph/newline boundaries according to the text source contract. The actual UI case proves common Chinese behavior; no exhaustive script/font/grapheme coverage claimed.

### D6 [P3] Undoing an indexed edit to its exact saved content still leaves the document dirty

Primary location: `apps/design-studio/app/app.js:1267`; state comparison: 939–950 and 987. Undo marks every loaded page dirty, while saved indexed serialization replaces clean page nodes with sourceSha256 references.

Trigger: open saved indexed design, change heading through Inspector, focus canvas and press real Meta+Z. Serialized repository document is **deep-equal to the pre-edit saved document**, yet save-state reports `data-kind=dirty`. Same sequence on single-file document reports `saved`. Evidence: `undo_baseline` controls run9.

User effect: false unsaved-change warnings/status and recovery work after a complete undo; no content loss asserted. Recommendation: calculate dirty page state against the saved descriptor/content baseline, instead of assuming every restored page differs. Whole-document dirty comparison must not change merely because a cache representation moved between clean-reference and full-node form.

### D7 [P3] PRD non-goal headings are classified as goals or requirements

Primary location: `apps/design-studio/app/product-brief.mjs:29`–32; ordered aliases at 3–9. Actual callers: `app.js:4344`–4352 / registered `read_product_brief` at 7928 and PRD prompt builder.

Trigger: ordinary PRD with an explicit `需求` section, then `## 非目标` or `## Non-goals` containing `不支持支付`. Earlier substring alias `目标` / `goals` wins, so parser returns that item in goals and constraints=[]; `Out of scope` is classified under requirements because `scope` wins first. `productBriefPrompt` includes these misclassified records in its generated handoff. Normal `## 约束` puts the item in constraints, with the explicit requirement list remaining one item. Evidence: four `prd_section` records in run9.

This is an executed parsing/prompt-contract defect. No real Agent was contacted and no claim is made that a particular model builds a forbidden feature. Recommendation: prioritize exact/longer non-goal aliases before generic goal/scope substring matches and add bilingual classification controls.

## Coverage and limits

| Surface | Files actually read/traced | Execution / unexecuted boundary |
| --- | --- | --- |
| Entry and app lifecycle | manifest entry/permissions/tool names, index.html controls, app.js document/page/cache helpers, save/open/external-sync, undo/redo, clipboard, HTML replacement, Agent page/resource mutation and rollback, delivery callers | Actual app Inspector, Meta+Z, file dialog, registered use_design/save_design; no full Host IPC or actual Agent |
| Indexed document/resource contracts | document-index.mjs, page-runtime.mjs, resource-store.mjs, repository.mjs; document.mjs normalization/state nesting/font-reference/SVG paths | Actual indexed app loads and saves; portable/legacy controls exercise parts, hashes, invalid/missing resources and create-only writes; not every schema/scale branch |
| Layout | layout.mjs wrapping/responsive text, sizing/fill, flex/grid placement, absolute constraints, reflow loops; targeted geometry functions | Actual Inspector Chinese resize and four pure text observations; no exhaustive flex/grid/touch/rotation/fidelity run |
| Import/export/delivery | html-import.mjs source/CSS/frame flow; selected html-capture.mjs text producers; frontend-export.mjs; product-brief.mjs; portable-backup.mjs/portable-backup-ui.mjs | HTML export and font loading executed; whole HTML capture UI, PRD Agent submission, frontend Host write and compare UI not executed |
| Recovery/history | app.js recovery/save baseline callers and rollback; selected legacy-backup.mjs; parent already reviewed operation-log.mjs, recovery-session.mjs, document-bundle.mjs | 19 existing portable/legacy/CAS recovery controls; this agent did not claim an independent full-line review of the parent's three modules or full browser recovery suite |
| Supplemental surfaces | targeted geometry.mjs transforms, audit.mjs text overflow, design-compare.mjs comparison semantics | Static tracing only; pixel-comparison thresholds, accessibility sampling, component-effect geometry not broadly executed |
| Inventory only / limited reads | schema/format guide/check-design tool, panel-select.js/css, style.css, Design Agent skill/reference files; 7 Design scripts and UI test files catalogued | No independent complete audit or execution of these files; no live Host storage scripts, HTML fidelity/large-doc scripts, touch/connection suites |

Read-only normal controls also rule out these immediate candidates within their tested scope: portable restore overwriting nonidentical files; missing/altered resource accepted as a complete backup; primary file committed before a failed part; lost write receipt blindly resent; recovery CAS writes/deletes silently overwriting another window; save-as legacy recovery using the destination as its baseline. They are **not** proofs of every UI/transport branch. No unexecuted static suspicion is promoted to a confirmed finding; possible cache restoration after *save failure* and resource-cache/history synchronization remain untested extensions of the reviewed area, not extra findings.

Old 86 de-duplication source: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/{README.md,priority-and-coverage.md}`. Checked the old issue inventory and Panel/source scope: these seven concern Design application data/exports/parsing in the separate Panel repository. They do not repeat old browser/Host draft ACK recovery, Panel native-worker cleanup, clipboard/Quick Chat or shared package contracts. D1 and D6 both mention indexed caches but retain separate root causes/fixes (transaction rollback versus saved-equivalence); D3/D4 both concern frontend export but lose different persisted content and require separate mappings. Prior coding/TUI/chat/link report is separate and not recounted here.

## Evidence, initial failures and cleanup

- Repro source: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-fixture.mjs` (final11 tests; uses actual repository modules and existing polish fixture's Host protocol setup, expanded with exact-path pauses).
- Normal suite launcher: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-existing.mjs`.
- Final logs: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-run9.log`, `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-existing-run1.log`.
- Original investigation logs retained: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-run1.log` through `run8.log`. Not summed into final test totals.
- run1: **1 pass/5 fail** — 4 browser tests failed because isolated HOME correctly hid Playwright's default browser cache; the text newline fixture was too narrow and happened to wrap at the same boundary. No product finding from these harness failures. Fixed with an explicit already-installed cached executable and a width100 newline control.
- run2: **4 pass/2 fail** — file dialog inventory cached before the added fixture file. Fixed by invoking the real refresh control before opening the dialog; not a product defect.
- run3/run4: **9/9 pass**; run4 added nonempty deleted-page payload and actual subsequent save proof. run5 **10/10 pass**, adding real Inspector Chinese resize.
- run6: **9 pass/1 fail** — valid Arial font embedded in SVG exceeded the existing 384KiB export budget (1008KiB). Kept original failure. Revised the SVG serialization control to small synthetic bytes, and used the full valid Arial only for actual HTML/font loading. No budget defect claimed.
- run7 **10/10 pass**, with exact owned browser spawn tracking; run8 **11/11 pass** added PRD controls; run9 **11/11 pass** used an explicit ordinary requirement alongside non-goal headings and logged the isolated HOME.
- Network controls load **before product/Playwright imports**: deny Node fetch/http/https/TCP/tls; browser context intercepts every page request, fulfills only exact `https://panel.test` + read-only application-root paths, aborts every other origin. Chromium background networking/component updates/pings disabled. This is fixture-layer isolation, not a claim of an OS firewall or network-sandbox penetration test. No local HTTP listener is started.
- Node child spawn restricted to the exact cached Chromium executable with the isolated HOME. Product Host data exists only in in-memory maps; each browser closes via awaited test cleanup. Final log: 8 owned PIDs, `liveChromePids: []`. Maintained runner removes its temporary HOME. Independent exact-PID and HOME-removal evidence is recorded in `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-cleanup.log`.
- Final `git diff --stat` and `git status --short` empty, frozen HEAD unchanged. No product changes to undo.

Exact final execution commands (working directory: the frozen Panel repository):

```sh
node /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/scripts/run-isolated-node-smoke.mjs /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-fixture.mjs
node /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/scripts/run-isolated-node-smoke.mjs /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/design/codeshell-panel-design-existing.mjs
```
