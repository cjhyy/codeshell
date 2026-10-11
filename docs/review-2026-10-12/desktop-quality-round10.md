# Desktop-flow quality audit — round 10

Scope: independent reachability, ownership and recovery review of existing R04 / R05 / R07 / R13 / R28 / R29. Latest source snapshot is `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`, commit `a66f4ef291f304ee4df9da8095a90671d9a8f140`. Read CODESHELL.md, the old main report, Desktop rounds 1/3, quality-audit notes, existing portable fixtures and logs. No product source, repository report, build output or goal state was changed. All six relevant implementations listed below have no source diff between `84740d56` and `a66f4ef2`; these are not newly introduced by the latest snapshot.

第二十轮依据触发范围与既有恢复将R29降为P3，见[后续交叉裁定](r29-priority-round20.md)；下文六项P2是第十轮历史裁定，原证据与恢复仍成立。

**Historical verdict: retain all six P2 findings.** This round adds no new defect. Strong counterevidence narrows R05 to stale path/metadata plus blocked execution, R07 to a Core `exited` event while an independent external turn remains active, R13 to a throwing submit handler rather than permanent renderer failure, and R29 to a recoverable live projection error rather than durable project deletion. R28 requires an incomplete authoritative initial refresh; ordinary post-load toggles preserve unrelated entries.

## Targeted controls and evidence

Evidence directory: `/tmp/codeshell-review-20261012-desktop-quality-round10/`.

| Fixture and matching `.log` | Latest result | New evidence |
| --- | --- | --- |
| `composer-recovery-controls.test.tsx` | 3 pass / 16 assertions / 0 fail / 0 skip | Actual ChatView: remove stale path chip before sending B; same-session plugin expansion; late expansion after React unmount |
| `question-recovery-control.test.tsx` | 1 pass / 9 assertions / 0 fail / 0 skip | Actual ChatView: selecting B's valid visible option does not remove hidden A index; an intervening session with no question remounts the sticky view and B submits once |
| `plugin-settings-durable-controls.test.tsx` | 2 pass / 17 assertions / 0 fail / 0 skip | Actual ManagePage + PluginsTab + real Main writeSettings/readSettings under isolated HOME: initial race durably replaces arrays; normal loaded toggle preserves alpha; observed actual React mount IPC call order is plugins:list, skills:list, settings:get |
| `project-recovery-control.test.tsx` | 1 pass / 9 assertions / 0 fail / 0 skip | Existing real-store startup migration repro extended through actual useSessionNavigation.handleRenameProject for the still-visible original project: Main's new broadcast restores both projects while active B is retained |

Total: **7 targeted tests / 51 assertions / 0 failures / 0 skipped**. This is not a full-suite rerun. Each was run separately from the latest workspace with `node scripts/run-bun-test-shard.mjs --timeout 15000 /tmp/codeshell-review-20261012-desktop-quality-round10/<name>.test.tsx`. Runner completion was checked in every final log. The project fixture's two expected Git “not a git repository” probes concern owned plain temporary directories; they are not product failures or failed tests.

Safety and limits: guarded runner supplies an isolated real HOME and removes inherited provider credentials. Fixtures install fetch/http/https/net/tls connection guards **before local Core-facing dynamic imports**. Plugin writes touch only isolated user settings; project stores use owned temporary directories. No real models/APIs, third-party downloads, user plugins, microphone, browser account or running user service. UI tests use the repository mini DOM and actual React handlers, not a real Electron/browser click session. Network guards cover the tested in-process APIs, not an OS network sandbox.

## R04 — retain: delayed expansion has a live route to B's draft

Primary evidence: `packages/desktop/src/renderer/ChatView.tsx:978–987` and `packages/desktop/src/renderer/App.tsx:376–383`.

Production App renders its main ChatView without a session identity key (`App.tsx:2442`); changing engineSessionId/sendBucket keeps that component mounted. Expansion captures A's pluginCommandTarget and awaits IPC at ChatView:981, then checks only mountedRef before calling setDraft(:986–987). App's setter picks activeBucketRef.current *when applying the update*, which is now B. The actual IPC handler `packages/desktop/src/main/index.ts:3989–4000` awaits rendererConfigurationCwd before expansion; even a local command has a real asynchronous IPC/authority boundary. This does not depend on an external model or network operation.

The local expanding flag disables composer controls (`ChatView.tsx:838–839`), but does not block sidebar navigation: App:2195 calls navigateFromSidebar; that callback comes from useResponsiveSidebar (`App.tsx:234`) and simply executes or defers the navigation until drawer close (`packages/desktop/src/renderer/app/useResponsiveSidebar.ts:46–55`). It has no knowledge of ChatView's expansion state. Thus “A expansion pending, switch directly to B containing a pre-existing draft, successful late result” is reachable. Do not claim the user must type B's draft during the disabled interval.

Original portable `reproductions/desktop/composer-session.test.tsx` second case proves A target and B overwrite (5 assertions). New controls establish normal same-session completion updates A only; React unmount before resolution leaves both source command and B draft intact. Those guards are real but do not protect same-mounted session changes. A retains its original slash command, while the overwritten prior B draft is not restored by the success path. Confidence high.

## R05 — retain: local reference state crosses sessions, Core prevents reading A's file

Primary evidence: `packages/desktop/src/renderer/ChatView.tsx:443–444,1082–1097`; unkeyed App main surface at :2442. Parent text/image draft maps are per-bucket (`App.tsx:372–394`), but localFilePaths/inputReferences remain in the same ChatView. addLocalFilePaths attaches A's session metadata at ChatView:882–909. No switch-specific reset was found.

A can drag/select a workspace file, switch to B without sending, and submit B's own prompt. Original portable composer fixture confirms bucket B, a literal A path in B's prompt, and structured attachment sessionId A. Strong counterevidence: actual Core `packages/core/src/engine/input-attachments.ts:131–143` rejects the mismatch and continues **before stat/read at :149+**. Therefore the demonstrated impact is path/metadata crossing and B's input being rejected, not A file contents read under B's authority. Existing R06 separately explains native error invisibility; R05 remains a distinct composer-state root cause.

New actual ChatView control clicks the carried file chip's real remove handler before B's Enter. Both literal path and structured reference disappear; B sends its original text with no attachment errors (6 assertions). This matches removeLocalFilePath at ChatView:912–916 and visible remove button :1774–1777. Recovery is available by removing the visible stale chip; normal send also clears local paths/references after submission (:1106–1109). This does not preserve the original attachment draft per session. Confidence high.

## R07 — retain: native-worker lifecycle clears common busy state without stopping the independent runtime

Primary evidence: `packages/desktop/src/renderer/app/useHostSubscriptions.ts:1026–1036` and shared route insertion `packages/desktop/src/renderer/app/useRunController.ts:263–268`.

send() sets busy, runningBucketRef and engineToBucketRef before choosing native versus external execution. External branch at useRunController:435–452 invokes runExternalRuntimeTurn against the Main externalRuntime bridge. Main owns that service separately from Core: external events are ingested by the external bridge and sent to the owner window (`main/index.ts:1639–1647`); closing the owner window explicitly stops its external runtimes (:1542–1543). AgentBridge's Core onExit path at `main/agent-bridge.ts:395–409` broadcasts native `exited`/`gave_up`; it has no external-service stop call. A non-final Core crash can therefore occur while the external turn is still active.

On **exited**, the renderer deletes every route's busy key and clears runningBucketRef, including external entries. The existing worker-external fixture uses actual useHostSubscriptions and confirms both native and external keys removed (3 assertions). App derives active busy directly from busyKeys at App:346, so the external Stop/running UI disappears. Do not claim the external process itself was killed, all output is lost, or every ordinary clean run exits its worker; those are not demonstrated. The `gave_up` branch has different cleanup and is not this exact trigger.

Strong recovery counterchecks: externalRuntime.onSessionState in useRunController:994–998 **only** drops the started-runtime binding when active=false; it does not restore busy. Ordinary text deltas also do not restore it. A subsequent valid session_started sets the target busy again (useHostSubscriptions:321–330), and normal external completion clears busy through its own promise (:467–472). Routes remain intact, so later output still has a route. A prematurely attempted follow-up is subject to the Main runtime's own turn serialization; no duplicate/concurrent process execution is claimed by this finding. Confidence high for the crash/state mechanism; process survival is grounded in the independent Main ownership, not a real CLI/model run in this audit.

## R13 — retain: invalid old indexes survive a direct question change; remount recovers

Primary evidence: `packages/desktop/src/renderer/ChatView.tsx:1568–1577` and `packages/desktop/src/renderer/messages/AskUserMessageView.tsx:33,106–110`.

Two concurrent native sessions may each be waiting for a question. Directly selecting A (three-option multi-select, pick index 2) then B (one-option multi-select) keeps an unkeyed sticky AskUserMessageView mounted while message props change. Local picked retains index 2, enables submit, and submitMulti dereferences B.options[2].label. The ordinary submit async catch handles answer transport failures but cannot catch that earlier synchronous calculation. Historical MessageStream questions are keyed by message id (`MessageStream.tsx:528–531`); that correct path does not key the separate sticky question.

New actual ChatView test confirms the original TypeError; clicking B's visible option adds index 0 without removing hidden index 2, and submission still throws with zero answers sent. Switching to C with **no pending question** unmounts the sticky view. Switching back to B starts with submit disabled, selecting B enables it, and exactly one answer submits. This is a blocked submit handler on that reused surface, not evidence that the whole Electron renderer crashes or restart is necessary. Confidence high (9 assertions, with working recovery).

## R28 — retain: incomplete authoritative initialization permits whole-array replacement

Primary evidence: `packages/desktop/src/renderer/extensions/ManagePage.tsx:70–83,104–120`; independently interactive list in `PluginsTab.tsx:82–123,460–463`.

ManagePage starts disabledSkills/disabledPlugins as empty Sets and only installs the authoritative arrays after Promise.all(skill list, settings). PluginsTab independently loads rows and exposes live switches before this refresh completes. The actual mount in the new fixture calls **plugins:list first, skills:list second, settings:get third**. Toggling beta then computes both full arrays from empty local state; the real Main writer replaces existing `[alpha]` / `[alpha:skill]` with `[beta]` / `[]`. Its cross-process lock and read-modify-write serialization protect file integrity, but cannot infer omitted array members (`main/settings-service.ts:131–169`, deepMerge :183+). Late initial refresh can also display the opposite of those persisted settings.

Production timing qualification: `main/skills-service.ts:45–80` scans synchronously once its handler's async authority lookup completes; do **not** describe listSkills and listPlugins as parallel Main scans. Renderer is a separate process, its plugin list IPC can have completed first, and its switches are not gated on the later refresh; Main settings:get separately awaits an actual fs.readFile (`main/index.ts:6527–6530`, `main/settings-service.ts:34–44`). Thus the valid trigger is “plugin rows already visible while the authoritative initial refresh remains incomplete,” whether due to skill completion/IPC delivery or settings read. The fixture controls that IPC completion ordering; it does not measure real disk latency or claim every extension page load exposes a long window.

The durable comparison now uses actual Main writeSettings/readSettings under guarded HOME. The race persists the two damaged arrays and paints alpha disabled / beta enabled after the old refresh. Normal loaded control starts from the same alpha state, disables beta, and durably keeps `[alpha,beta]` / `[alpha:skill]` with both switches disabled. A page reload fixes the display only; manually disabling alpha/its skill repairs lost entries. Any project-level deny, dedicated hook disable or missing trust can still prevent execution, so this is removal of these user disable entries, not proof of arbitrary untrusted code execution. Confidence high.

## R29 — retain: awaited migration can publish an older project projection; a new real event repairs it

Primary evidence: `packages/desktop/src/renderer/app/useProjectRegistrySync.ts:49–62`; live apply at :32–43.

The original real-store fixture uses cached legacy project id A remapped to its existing durable registry id, plus a stored transcript. migrateLegacyProjects does already re-read the current registry (`renderer/projects.ts:303–304`), which is good counterevidence; however that read precedes awaited per-bucket transcript migration. The latter has genuine persistence.flush awaits (`renderer/transcripts.ts:800–806,821–830`). During that await, native Add Project may create/select B (`app/useSessionNavigation.ts:120–135`; App menu has no migration gate at :1426–1427). Main's live event correctly paints A+B first. Initial continuation later publishes its captured A and leaves activeProjectId B, because only remapped ids are adjusted at useProjectRegistrySync:71–73.

New control retains all six original assertions: copy pending, normal Add Project selected B, Main A+B durable, renderer only A after completion, active B. It then calls the **actual hook's handleRenameProject on still-visible A**, routed to actual ProjectStore.rename and its onChanged event. That reachable action repaints A+B, preserves active B, and displays A's new name (3 added assertions). Sidebar exposes this normal rename entry (`Sidebar.tsx:270–277`, App:2203; useSessionNavigation:174–179). Open Recent can also read/reconcile the durable registry again (`App.tsx:1434–1442`); restart is not the only recovery.

No project was deleted from disk and transcript-copy logic specifically retains source authority until the copy/index patches are durable. This finding concerns startup/live-project projection ordering, not a claim that the migration's transcript safeguards are absent. Confidence high, with a real migration wait and working production recovery entry.

## 主代理收束

四份专项源码已改为便携相对导入，保存在 [reproductions/quality-round10](reproductions/quality-round10/)，并在两基线各自重跑，均7测试51断言、0失败0跳过。上文 /tmp 命令和路径是原作者阶段证据，日后可用本目录通用 runner 重跑归档副本。R05 段的 native 错误关联已校正为 R06。
