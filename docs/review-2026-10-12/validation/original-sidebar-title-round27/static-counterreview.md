# R27 sidebar/session-title static counterreview — phase note

Scope: pure source/document reads of the frozen primary 84740 product tree and latest a66f tree. No fixture, product import, Git, provider/model, build, install, network, or real user-data access. No formal finding is proposed. Work paused here at the parent's request to prioritize Files root identity.

## Source result

The sidebar manual rename path does not write the canonical session-title registry:

- `packages/desktop/src/renderer/Sidebar.tsx:323–330` invokes `onRenameSession(projectId, s.id, trimmedTitle)` from the real context-menu prompt.
- `renderer/app/useSessionNavigation.ts:223–229` calls only `renameSessionLocal(..., true)` and updates the local index.
- `renderer/transcripts.ts:1017–1038` changes the matching UI-row title, manual flag, and updatedAt, then saves the index. The file's introductory contract at `:1–21` calls this the short sidebar label and distinguishes the UI session ID from the engine session ID.
- In production, `transcripts.ts:468–475` delegates to SessionPersistence. `renderer/sessionPersistence.ts:270–290,334–347` turns this into a catalog patch, updates the projection, and invokes `bridge.apply`.
- `main/session-catalog-store.ts:121–165,179–206` applies that patch to `desktop/session-catalog.json`, increments its revision, and notifies snapshot listeners. It imports no title registry. `main/session-catalog-ipc.ts:33–35,45–53` broadcasts `sessionCatalog:changed` to application windows; it does not call a title writer.
- `renderer/sessionPersistence.ts:202–259,278–290` and `renderer/app/useSessionIndices.ts` consume those catalog snapshots into sidebar indices. This is a valid cross-window sidebar synchronization path, not a reverse registry write. Main's other catalog listener (`main/index.ts:6960`, latest `:6966`) schedules task-inbox refresh.

The history view uses a separate title projection even when freshly opened/refreshed:

- Main `sessions:list` directly calls server `listSessions()` (`main/index.ts:6735`, latest `:6741`). `packages/server/src/sessions-service.ts:60–114` reads state summaries, with `title = state.title || state.summary` at `:94–95`; it does not consume the Desktop catalog. Its `DesktopSessionSummary.title` comment at `:15` explicitly permits a UI renamed-title override.
- `main/session-titles-store.ts:6,13–14` delegates the registry to the shared server store at `desktop/session-titles.json`; `main/index.ts:6851–6858` (latest `:6857–6864`) exposes its list/set handlers.
- `renderer/sessions/SessionsView.tsx:51–71` loads `listSessions()` and `listSessionTitles()` together and merges durable state titles with the registry at `:61–64`. It does not read catalog titles. Its specific history search at `:96–102` matches session ID and this title map.
- In the normal reverse direction, history commit calls `window.codeshell.renameSession` before `onSessionRenamed` (`SessionsView.tsx:121–155`). `renderer/app/useSessionHistorySync.ts:40–64` then finds catalog rows by canonical engine ID and calls `renameSessionLocal(..., true)`. This supports registry-to-catalog propagation after a successful history rename.
- The registry implementation (`packages/server/src/session-titles-store.ts:133–188`) serializes registry writes but exposes no broadcast/callback which could turn catalog metadata back into registry titles. `renderer/app/useHostSubscriptions.ts:348–365` also guards manual sidebar titles from LLM title replacement; it is not a registry backfill.

## Important counterevidence and scope

`docs/superpowers/specs/2026-06-01-llm-session-title-design.md:21–25` explicitly made touching `desktop/session-titles.json` a non-goal for the old LLM-title work and called SessionsView's title system independent from sidebar localStorage. This is meaningful design counterevidence against assuming every sidebar title must be the shared history title. The document scoped that decision to the LLM automatic-title feature; it does not explicitly promise permanent independence for manual rename, but neither does this audit establish a current universal manual-rename synchronization contract.

The global session picker is a normal control: `renderer/shell/SessionSearchModal.tsx:54–81` reads the supplied sidebar indices and filters `hit.session.title`. A sidebar rename therefore remains searchable in that title-mode picker. The static discrepancy is specifically the separate SessionsView history list/local title search, not all search or content search. Existing R17 history rename failure controls, R56 full-text candidate-cap review, and R61 catalog/window selection review do not establish this reverse-write contract and are not new findings here.

## Baseline check and limit

Standard-library byte/hash reads found 15 reviewed files identical across the frozen trees (Sidebar, navigation, transcripts, SessionPersistence, index subscription, catalog store/IPC/preload, both title-store layers, sessions service, SessionsView, history sync, host subscriptions, and the design document). `main/index.ts` differs overall; the relevant title/catalog registration points occur six lines later in latest and retain the same wiring. No dynamic observation or count increment follows from this source result. Parent/root should resolve the modern UI contract before deciding whether the history/title divergence is actionable.
