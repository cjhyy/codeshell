# R28 blank conversation Files — independent contract counterreview

Conclusion: **do not promote a blank-before-first-send Files failure candidate**. The unknown-session workspace response is real, but Files has a second, valid project/root fallback. Once that response settles, the body mounts with the complete UI project; Files derives the current primary's actual path and issues a coherent project-authorized request. This is a source proof of the production path, not a bare-props test advertised as full-App execution.

Scope: read-only frozen primary 84740 product and latest a66f trees. No fixture/test/product import, app/worker/model/provider, Git, build/install, network, or real HOME/user-data access. Only this owned `/tmp` draft is written. New dynamic executions and formal findings: 0. Parent owns the full App/ID producer audit; relevant upstream lines are recorded here to make the contract boundary reviewable. Current material report is R01–R86 (86/251), not the older R26 85/250 banner.

## Current contract and the strongest counterevidence

- Opening the panel before sending is an explicit current-source intention: `renderer/TopBar.tsx:34–36` says draft chats may expose the panel because opening materializes their session. `renderer/App.tsx:2152–2154` allows a chat draft to open it. `renderer/app/usePanelBuckets.ts:657–661` explicitly avoids requiring a throwaway first message; `:663–712` opens the requested panel in the materialized bucket.
- UI materialization is not Core-session creation. `renderer/App.tsx:647–666` creates a UI summary in the project's current primary, and `:669–672` returns the existing or newly materialized bucket. `renderer/transcripts.ts:863–887` writes `pendingFirstRun: true` with no engine binding; the shared marker contract at `shared/session-catalog.ts:17–27` distinguishes explicitly unstarted UI rows from legacy rows. `renderer/app/useRunController.ts:1000–1015` still resolves this bucket's engine ID to the UI ID. The marker does not suppress that ID.
- **The active configuration fallback is genuine but separate.** `renderer/sessionUiAuthority.ts:53–58` distinguishes persisted session authority from a draft's current primary. `:248–276` passes `allowProjectFallback` from the local-creation set and passes `pendingFirstRun` only for a marked row with no engine binding. `:188–201` restores project configuration after Main confirms exactly `unknown session: <id>` (including Electron's wrapped form); corrupt-state, other transport failures, and authoritative removed roots do not qualify. `:122–138` refreshes when the session's top-level run starts. This keeps pre-run configuration available, but PanelArea does not consume that hook's workspaceRoot or draft flags.
- `renderer/panels/usePanelWorkspaceRoot.ts:92–132` separately asks Main for the materialized UI ID. An absent disk session can produce root=null, mainRootId=null, ready=true, error=unknown. That result **does not mean Files' internal cwd remains null**.

## Why null panel workspace does not block the real Files body

1. `renderer/app/SessionPanelDock.tsx:161–186,212` looks up the full project by the target bucket's projectId and passes it independently of the engine-session authority response. A normal live registered project survives the unknown-session lookup.
2. `panels/PanelWorkspaceRootConsumer.tsx:4–15` sets `mountBody = workspace.ready || workspace.root !== null`. The caught unknown response sets ready=true, so mountBody is true and the loading overlay is false. While the RPC is pending there can be the normal loading state; this audit does not call that a failure.
3. `panels/PanelRegistry.ts:95–126` gives Files `enabled: alwaysEnabled` and forwards project/cwd/engineSessionId/mainRootId. Files has no repository or engine existence availability gate. `getPanelEntry` returns the builtin entry without a project resolver (`:404–410`), while `getEnabledPanelEntries` consumes its enabled predicate (`:412–413`).
4. `panels/PanelArea.tsx:195–215,235–242` only filters tabs by enabled IDs and duplicate IDs. Adding Files at `:254–270` does not require cwd. At `:474–502` the ready body receives the full project and the null workspace values. `PanelBody` at `:643–668` checks only whether the entry exists, then forwards project/cwd/rootId to `entry.render`; it does not reject `workspace.error` or null cwd. The wrapper `panels/DesktopBuiltinPanelApp.tsx:89–174` returns its children unconditionally; Files has no lifecycle descriptor requiring a host.
5. In `panels/FilesPanel.tsx:140–153`, project existence is enough to build options. Absent sessionMainRootId selects `project.primaryRootId`; the selected root's path is `workspaceCwd ?? primary.path` (`:146`). For the blank case workspaceCwd=null, so it retains the **actual primary.path**. It retains all other registered roots with their own unchanged ID/path pairs (`:150`).
6. Files computes its own activeRoot/cwd at `:174–176`. The blank sequence therefore has cwd=project.primary.path despite the incoming workspace cwd being null. The unavailable-project early return at `:306–311` does not apply. The directory tree can mount at `:315–347` when the ordinary persisted tree preference is open; a user's deliberate hidden-tree preference is not an unknown-session defect.
7. `FilesPanel.tsx:177–194` needs both engine ID and sessionMainRootId to select Session APIs. The blank UI ID exists but root ID does not, so it chooses **project APIs**. Its actual initial directory effect (`:345–347,461–474`) calls `readProjectDir(P, primary.id, primary.path)`. Selecting another mounted root uses that root's coherent ID/path pair. No first model send or durable Core binding is needed for this fallback.
8. Preload forwards all three parameters (`preload/project-authority-api.ts:100–103`). Main's exact fsRoot handler (`main/index.ts:6486–6488`, latest `:6492–6494`) authorizes the live project/root via `main/renderer-project-path.ts:59–83` and calls real `readDirectory` with the authorized root and requested same-root path. Healthy mounted roots pass normal containment (`main/fs-service.ts:30–54`). Thus the static chain reaches a real production FS read, not a hypothetical return from the unknown-session service.

## Older TODO and tests: useful limits, no invented receipts

The old workspace plan `docs/todo/small-features-2026-07-10/review-panel-wrong-cwd.md:28–34,81–99` intended draft main-root fallback and initially proposed falling back to repoPath even after RPC failure. Current `usePanelWorkspaceRoot` deliberately fails closed instead; its test source `panels/usePanelWorkspaceRoot.test.tsx:213–234` explicitly expects root=null/ready=true/error. The old TODO is not evidence that every unknown persisted ID should inherit session authority. Current Files project APIs provide the legitimate independent project authority in the healthy blank case.

Existing source tests have separate coverage boundaries:

| Existing test source | What it actually supports | What it does not prove |
| --- | --- | --- |
| `renderer/AppQuickChat.test.tsx:927–957` | Product intent to materialize a draft on panel opening, preserve composer draft, pass the new UI ID to PanelArea, with no run calls | Actual Files behavior: PanelArea is mocked at `:181–194`; workspace authority is always successful at `:495–502` |
| `panels/usePanelWorkspaceRoot.test.tsx:29–65` | A hook with sessionId=null uses projectPath without IPC | The full App panel path after App materializes a non-null UI ID |
| Same test `:213–234` | A failed workspace read returns null fields and ready=true | Whether Files subsequently uses its own valid project fallback |
| `panels/FilesPanel.workspace.test.tsx:334–360` | Files project/root selector and Project API calls, with cwd=/repo and no engine/root ID | Full App or the input-cwd=null/non-null-UI-ID combination; the decisive null case here is from actual source `FilesPanel.tsx:146,174–194` |
| `renderer/sessionUiAuthority.test.tsx:78–114,116–185` | Exact Main-confirmed absent marked draft configuration fallback, refusal for corruption/transport/root_removed, only unbound marked rows qualify | Panel workspace/Files, which do not consume this hook |
| `panels/PanelRegistry.test.ts:39–61` | Files remains enabled in null context while Review is omitted until a repository is confirmed | Actual directory reads |

All were **read only**, not run or counted. The source proof above uses actual PanelBody/Files logic rather than merging these disjoint tests into an imaginary full-App pass.

## Dedupe and exclusions

- R26 Review scope remains a design observation. `panels/useReviewAvailability.ts:63–64,140` deliberately gives no target when the session/workspace key is unavailable, and Review's registry predicate requires confirmed repository status. That gate cannot be used to infer the same behavior for always-enabled Files with project APIs.
- R86/F27-1 is distinct and already formal: the summary target has **non-null inherited workspace A** but no root ID, while current project primary is B. `FilesPanel.tsx:146` overwrites B's registered path with A. A blank target has **null workspace**, so `?? primary.path` preserves B's correct path. This is the precise normal control, not a second R86 trigger.
- R65 concerns a real directory rejection being displayed like an empty directory. The healthy blank tuple is coherent and does not require such a rejection. No extra error-state finding follows merely from the internal unknown-session workspace response.
- Scope is healthy existing project roots. No-repo buckets, unavailable/removed projects, terminal startup, arbitrary forged IDs, image preview, corrupt state, and pending IPC that never settles are not expanded into this conclusion. No fixture is justified solely to confirm a Files failure contradicted by this production fallback.

## Baseline/source fingerprints

The following per-path SHA-256 table is from standard-library byte reads only. Product/source/test/TODO rows are compared across both frozen trees; report-deduplication documents are primary-stage material and listed separately when absent/different in latest. Main index's fsRoot block remains identical (primary6486/latest6492), SHA-256 `f237e505b949a33c5257a3052513eafc0e353cfdf5ff062af74f4d81ac545510`. No source import or dynamic assertion accompanied hashing.

| Repository-relative path | Primary SHA-256 | Latest SHA-256 |
| --- | --- | --- |
| packages/desktop/src/renderer/TopBar.tsx | f9864bd96aafea54cccb8100bdd9c5a60149c719575c4a8e87b1496f2f3e2aab | f9864bd96aafea54cccb8100bdd9c5a60149c719575c4a8e87b1496f2f3e2aab |
| packages/desktop/src/renderer/App.tsx | 556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8 | 556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8 |
| packages/desktop/src/renderer/app/usePanelBuckets.ts | 3fd2e6d8b7f37f09e23614278bc1f0f5ee9673f954bacf9b9d0313dd4762887b | 3fd2e6d8b7f37f09e23614278bc1f0f5ee9673f954bacf9b9d0313dd4762887b |
| packages/desktop/src/renderer/transcripts.ts | fc74dcbf603c15d9bb27da517ff46b0a7805811e712a0e6a29d5cfb3a974c100 | fc74dcbf603c15d9bb27da517ff46b0a7805811e712a0e6a29d5cfb3a974c100 |
| packages/desktop/src/shared/session-catalog.ts | 511a9b119749cc79bbe3832b508293b421e3ec07766561cae245305914d79568 | 511a9b119749cc79bbe3832b508293b421e3ec07766561cae245305914d79568 |
| packages/desktop/src/renderer/app/useRunController.ts | 5bcf8b21e139ddd644175d0eedd528c7a32789f67771d056c3c71f52bd3cf5b2 | 5bcf8b21e139ddd644175d0eedd528c7a32789f67771d056c3c71f52bd3cf5b2 |
| packages/desktop/src/renderer/sessionUiAuthority.ts | 3c9f357c7e7cc9a52dfab14ca5fcdddcfc3d53712674ff8b969f50351ecf7850 | 3c9f357c7e7cc9a52dfab14ca5fcdddcfc3d53712674ff8b969f50351ecf7850 |
| packages/desktop/src/renderer/app/SessionPanelDock.tsx | f518df5cbe17cb378b98add2db4b997c766e8092e50b34ada8be45f9b3e69972 | f518df5cbe17cb378b98add2db4b997c766e8092e50b34ada8be45f9b3e69972 |
| packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts | fe07534fed9fbdb9dcb53fc74ef7365a16d58d607449b9c49c5b5e0144c85fc7 | fe07534fed9fbdb9dcb53fc74ef7365a16d58d607449b9c49c5b5e0144c85fc7 |
| packages/desktop/src/renderer/panels/PanelWorkspaceRootConsumer.tsx | f043db36541fa16368f0aa31b8ba9bfe7b31bf21370f1074258c76e7afbf22d4 | f043db36541fa16368f0aa31b8ba9bfe7b31bf21370f1074258c76e7afbf22d4 |
| packages/desktop/src/renderer/panels/PanelRegistry.ts | c440f537f5918a16842dd32ca52761e5f54d6b2e2d6e951c48aa6022290fd3f1 | c440f537f5918a16842dd32ca52761e5f54d6b2e2d6e951c48aa6022290fd3f1 |
| packages/desktop/src/renderer/panels/PanelArea.tsx | b7b292627c1f54b0928983df20c3d85b159fce9729def903800dcef4338f9026 | b7b292627c1f54b0928983df20c3d85b159fce9729def903800dcef4338f9026 |
| packages/desktop/src/renderer/panels/DesktopBuiltinPanelApp.tsx | 8957b98efb1a10f069308a73598171a45e72809f7214c9b44c55f9414f0ff9f4 | 8957b98efb1a10f069308a73598171a45e72809f7214c9b44c55f9414f0ff9f4 |
| packages/desktop/src/renderer/panels/FilesPanel.tsx | 525f58f77436ab8e84f8df46942925feffbd5a118f91556884db924a3d90d0d3 | 525f58f77436ab8e84f8df46942925feffbd5a118f91556884db924a3d90d0d3 |
| packages/desktop/src/preload/project-authority-api.ts | 4e2398a2b0e34999499989084bbd3c98654d9c46e465ccafe2a8ce8fce7da07c | 4e2398a2b0e34999499989084bbd3c98654d9c46e465ccafe2a8ce8fce7da07c |
| packages/desktop/src/main/index.ts | cf5ba2f931c816cb44b598d54ef173793e40f554335de75d103f7b0ee5a2c26a | 426bfe5ccc8387db82f5bbe47ce1b83681995e7192f37bb03775f4eca37d0d80 |
| packages/desktop/src/main/renderer-project-path.ts | cf7d7fb3cbbc3ae472630a0f19293d53c9931c767c334438dc8ffe89bb062c8d | cf7d7fb3cbbc3ae472630a0f19293d53c9931c767c334438dc8ffe89bb062c8d |
| packages/desktop/src/main/fs-service.ts | 3857afa4c216971bb67ecb3bb0dadfc2264f316f497d8274b22eaef7cda7afc4 | 3857afa4c216971bb67ecb3bb0dadfc2264f316f497d8274b22eaef7cda7afc4 |
| packages/desktop/src/renderer/panels/useReviewAvailability.ts | c25b41aa6099aee42f6786432222fcc0d2cfe7dca94c82d117b9d3e7ba827862 | c25b41aa6099aee42f6786432222fcc0d2cfe7dca94c82d117b9d3e7ba827862 |
| packages/desktop/src/renderer/AppQuickChat.test.tsx | 4ec0eeb7be1c24af1deedc8c1913c66f4e971cf5ee23c2e2c27b8698420d361b | 4ec0eeb7be1c24af1deedc8c1913c66f4e971cf5ee23c2e2c27b8698420d361b |
| packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.test.tsx | 98d94ec017568bb61681be494ec38ba538d44e807639d14720bb2e2884e3023c | 98d94ec017568bb61681be494ec38ba538d44e807639d14720bb2e2884e3023c |
| packages/desktop/src/renderer/panels/FilesPanel.workspace.test.tsx | 6012655279240e86128e662c0324789d2ed69601744a844c3e36984ae9943ea5 | 6012655279240e86128e662c0324789d2ed69601744a844c3e36984ae9943ea5 |
| packages/desktop/src/renderer/sessionUiAuthority.test.tsx | 5bdd700f8c62e09f697a145ba7fb7458f93ba329c5d61608396891e9a5f11ee9 | 5bdd700f8c62e09f697a145ba7fb7458f93ba329c5d61608396891e9a5f11ee9 |
| packages/desktop/src/renderer/panels/PanelRegistry.test.ts | d35e641bf68b24af7790c945fadb03119c1048415ecc39d7419f29dfa725cae7 | d35e641bf68b24af7790c945fadb03119c1048415ecc39d7419f29dfa725cae7 |
| packages/desktop/src/renderer/panels/PanelArea.workspace.test.tsx | 4d8d50c11a3fd0ec9e7f05252091d9083965b2f42ce83905615b1db5cf2ad3a5 | 4d8d50c11a3fd0ec9e7f05252091d9083965b2f42ce83905615b1db5cf2ad3a5 |
| docs/todo/small-features-2026-07-10/review-panel-wrong-cwd.md | 171cc6cab7750b1f435d1e4d5e3835f6806c3ee1207fc637122247b81c089808 | 171cc6cab7750b1f435d1e4d5e3835f6806c3ee1207fc637122247b81c089808 |
| docs/todo/multi-folder-local-project-plan.md | 440edd29d618f7871f5e490ebf11afd4df7937bb8b834f64c66dee9c586d7961 | 440edd29d618f7871f5e490ebf11afd4df7937bb8b834f64c66dee9c586d7961 |
| docs/review-2026-10-12/session-continuation-round26.md | 0a62a74ebef8c320ab8ed6697d533a464f3faac7519b33bfc984b66d63f8e44b | absent |
| docs/review-2026-10-12/fork-authority-quality-round26.md | 5aa3206e3a14c7b624f424ab9d9c7cd32286e3da1708a914b9d948da923da7fd | absent |
| docs/review-2026-10-12/file-root-round27.md | a032a7897961f673d11b0529b3cb25b6713c64f3e3d301ff88c625872b9b6be8 | absent |
| docs/review-2026-10-12/README.md | 7ccb197e01a333456bfef2966bae5fae5dc6d34f319d75d1a3bc7456c85647da | absent |
