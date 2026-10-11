# Files and history review, round 4

Baseline: `84740d56e55517b004948a0a0e07649ad6fbf998`.
Worktree: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
No product edits. Existing untracked `docs/review-2026-10-12/` was preserved.

## Confirmed finding

### [P3] Successful archive restoration is blocked by its own unsaved-change guard

Lead triage: P3 because the saved conversation is preserved and the extra confirmation can complete navigation; the misleading prompt remains a real flow defect.

Primary location: `packages/web/app/HubSessions.tsx:186`.
Supporting chain: `HubSessions.tsx:91-93, 168, 202-204`; `Workbench.tsx:199-201, 225-232, 871-878`.

Ordinary user flow: open **历史对话**, select **已归档**, then click a completed archived conversation's title. The title's `open()` calls `mutate(id, { archived: false }, true)`. While the PATCH is pending, the production `busy` state makes `onDirtyChange(true)` propagate to Workbench. After the actual production session service returns success, `mutate` calls `onOpen(id)` before its `finally` clears busy. Workbench therefore treats the completed restore's own navigation as leaving unsaved edits and opens the dialog **还有未保存的修改 / 放弃修改并离开**. It does not call `selectSession`.

This was reproduced with no title editor, chat draft, attachment, run, or other unsaved data. The actual session's `archivedAt` was removed on disk, but `selectSession` remained uncalled and the unsaved-edit dialog was visible. Clicking **放弃修改并离开** then called `selectSession` with the restored session ID. Thus the stored conversation is preserved, but opening archived history requires a misleading abandonment decision after a successful operation. Staying on the page leaves the conversation restored instead of opened.

Suggested correction: treat successful restore-and-open as a committed navigation and route it only once the busy navigation fence is truly settled, while preserving the guard for real title drafts and still-pending writes. Merely placing `setBusy("")` one line earlier may remain stale because `onDirtyChange` and Workbench rerender occur after React commits.

Reproducer: `/tmp/codeshell-review-20261012-files-round4/archived-open.test.ts`.
Observed output: `/tmp/codeshell-review-20261012-files-round4/archived-open-observed.json`.
Runner output: `/tmp/codeshell-review-20261012-files-round4/archived-open-test.log`.

The reproducer mounts the real Workbench and HubSessions components in the repository's MiniDOM, dispatches real UI handlers, and sends HTTP to a production `createHubSessions`/`SessionManager` fixture. The PATCH is delayed only long enough to let its genuine busy state commit. It asserts the observed faulty behavior as a passing characterization; it does not claim the expected UX currently passes.

## Verified ordinary paths

Production `createHubFiles` fixture: root and nested directory listing, folder-before-file ordering, Chinese/space/hash filename preservation, UTF-8 text preview, exact download bytes, empty file download, and the documented 512 KiB text preview bound.

Production `createHubSessions` + `SessionManager` fixture: 52 records with identical transcript mtimes paginate as 50 + 2 without duplicate/missing IDs; custom-title search; title and archival state survive service recreation; archive/current filtering; Markdown includes actual user and assistant text; JSON includes raw transcript; running-session exports and restoration receive 409; restoration succeeds after the fixture run stops.

Code-read coverage: ordinary directory and preview requests cancel stale responses; history search and page requests cancel superseded reads and page merge deduplicates IDs; title compare-and-set and explicit conflict review are present. Existing known issues were excluded from the finding list.

Contract fixture: `/tmp/codeshell-review-20261012-files-round4/daily-contracts.test.ts`.
Observed output: `/tmp/codeshell-review-20261012-files-round4/daily-contracts-observed.json`.
Runner output: `/tmp/codeshell-review-20261012-files-round4/daily-contracts-test.log`.

## Isolation and verification

Both fixtures ran through `node scripts/run-bun-test-shard.mjs --timeout 30000 <absolute-test-path>` in separate processes, creating fresh HOME/application/config directories and stripping inherited credentials. Each created one ephemeral `127.0.0.1:<port>` HTTP origin, installed `installLocalNetworkGuard(origin)` before any production Core/Host import, and used only temporary fixture paths. No external service, model request, real-user HOME read, or build was required.

Final fixture runs: archive-open characterization **1 pass / 0 fail**; files/history contracts **2 pass / 0 fail**. No additional confirmed file/history defect was found in this pass.
