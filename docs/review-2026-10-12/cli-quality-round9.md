# CLI-flow quality audit — round 9

Scope: independently challenge the production reachability and impact of existing R02 / R08 / R15 / R16 / R18, rather than add new defects. Source snapshot `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell` at `a66f4ef2`; original findings/reproductions in the old review workspace were read. Product files and report files in the repository remain unmodified. Relevant flow files have no diff from `84740d56` to `a66f4ef2`.

**Verdict: retain all five; explicitly narrow R02's trust condition and R18's recovery description.** R15 is delayed progression until re-selection, not lost input. R08's production authority guard prevents cancelling the old native task; the defect is inability to stop the selected CLI room. R16 is authenticated same-device tab interference / stale navigation, not a cross-device access bypass.

## Targeted evidence

Temporary fixtures/logs: `/tmp/codeshell-review-20261012-cli-quality-round9/`.

| Fixture | Result | Purpose |
| --- | --- | --- |
| `cli-normal-controls.test.tsx` / `.log` | 3 pass, 31 assertions, 0 failures/skips, 929ms | Actual server trust resolver; actual failed-spawn and existing restart recovery; actual queueInput and normal foreground/reselect progression |
| `room-control-recheck.test.tsx` / `.log` | 2 pass, 11 assertions, 0 failures/skips, 657ms | Relevant existing R02/R08 cases, extracted unchanged in behavior and retargeted to latest source |
| `room-navigation-recheck.test.tsx` / `.log` | 2 pass, 5 assertions, 0 failures/skips, 374ms | Relevant existing R16 cases, extracted unchanged in behavior and retargeted to latest source |

Total **7 targeted tests / 47 assertions / 0 failures / 0 skipped**. Each invoked separately from latest snapshot as `node scripts/run-bun-test-shard.mjs --timeout 15000 /tmp/codeshell-review-20261012-cli-quality-round9/<file>.test.tsx`. This is not a full-suite rerun.

All use the guarded runner's isolated HOME. Before Core-facing dynamic imports they deny fetch and in-process http/https/net/tls connections. Real settings writes affect only isolated user settings. The only child process is an owned inert temporary shell script that consumes stdin; it is stopped/cleaned after test. No real CLI/model, paid APIs, external services, user plugins or hardware. Hooks use mini DOM/fake authenticated sockets and a fake externalRuntime bridge; actual server routing/guards and RoomManager/ResidentAgentProcess source run where described. No real Electron UI/browser/sockets are claimed.

## R02 — retain P2, require actual trusted-room bypass

Reachable current mobile production entry is `packages/desktop/src/mobile/main.tsx:4,14` → shared DesktopApp, not legacy mobile/App. `packages/web/app/Workbench.tsx:606` always renders supplied controls; DesktopApp supplies DesktopChatControls at `:529`; `DesktopControls.tsx:32–58` puts permission select before its room branch and binds **native** `app.permissionMode`. `useRemoteApp.ts:1587–1591` immediately changes that state and sends native `permission.setMode`; no room identity/restart is sent. `ccRoom.opened` clears native binding at `useRemoteApp.ts:1003` without adopting room permission mode.

Strong counterevidence: production `handle-cc-room-event.ts:61–68` resolves requested mode before opening. `handle-room-event.ts:41–48` **downgrades explicit bypass in untrusted cwd to default**, while trusted explicit bypass is honored. New real-resolver test writes isolated settings and verifies all four paths: untrusted bypass→default, trusted bypass→bypassPermissions, trusted explicit default→default, trusted acceptEdits→acceptEdits. Therefore the mismatch finding requires a room actually admitted as bypass (normally a configured trusted workspace), not merely a phone requesting bypass anywhere.

The existing hook test independently confirms room metadata bypass while native selector state default; native mode frame and a host error do not change the room. In production after room open, `external-runtime-commands.ts:78–85` revokes native selection, and `handle-client-event.ts:432–446` rejects unselected external/native-control fallthrough. Without that guard, the control could update a native preset/previous session, still not the room. The guard limits harm; it does not make the displayed room permission accurate.

Room permission changes **are supported through reopening**: `room-manager.ts:804–812` restarts if a new mode is chosen, and `DesktopControls.tsx:237–245,252–300` exposes a CLI mode picker when reopening from sidebar. Thus do not say room modes cannot be changed at all. The defect is that the visible in-chat select does not use this acknowledged restart route. No P1 claim: initial trusted bypass was explicit and not introduced by merely displaying default.

## R08 — retain P2; current production rejects native cancel, current room is not stopped

`Workbench.tsx:238,816–824` uses controller.stop for a visible running Stop button. `DesktopApp.tsx:505` supplies `app.stopRun` with no room override. A live room tool message is reduced through `useRemoteApp.ts:861–875`, making the shared controller run state active. `stopRun` at `:1364–1366` emits `{type:'run.stop',sessionId:boundSessionRef.current}`; open cleared that ref, so serialized frame has no session/room identity.

Production `handle-client-event.ts:295–298,487–509` resolves the previous device/native context, not the room. Opening ccRoom revokes native authorization (`external-runtime-commands.ts:78–85`); the actual guard therefore rejects `External cancel authority unavailable`. The recheck drives actual hook/controller Stop then actual handleClientEvent + actual MobileExternalRuntimeCommands, checking no room close and no injected native cancel.

Keep impact **“provided Stop does not stop running CLI room”**, not “wrong native task is cancelled” under the present guard. The old fixture title says routes to native cancel; its final assertions correctly assert rejection/no native cancellation. `leaveRoom` (`useRemoteApp.ts:1605–1623`, exposed by DesktopControls:61–63) unsubscribes/clears local feed and is not a stop workaround. In contrast, selecting a CodeShell business session backed by externalRuntime uses accepted selection and the existing `externalCommands.stop` route; that distinct producer path should not be described as broken by this room-specific finding.

## R15 — retain P2; queue is retained and resumes when A becomes foreground

Actual composer uses onQueueInput while busy (`ChatView.tsx:1087–1092`), App connects it to the same controller (`App.tsx:2484–2493`), and `useRunController.ts:804–835` stores items per bucket. Foreground busy derives only from active bucket (`App.tsx:346`). Queue effect reads only `queuedInputs[activeBucket]` (`useRunController.ts:664–667`), deliberately does not steer an external model (`:673–677`), and later sends serial turns only for active bucket (`:767–797`). No other production writer/drain was found that sends unsubmitted background entries on busyKeys changes. They have not reached the service FIFO yet, so the service's own queued-turn implementation is not a recovery mechanism.

New control invokes **actual queueInput** instead of preloading a queue. With codex model it verifies zero steering, foreground completion sends once through the external bridge, then another queued item before switching A→B remains in A after A busyKeys clears, with zero additional submission. Selecting A immediately sends it to A; runtime start count stays one. Exact observed summary:

```json
{"firstForegroundSend":"queued while foreground","whileBackgroundSendCount":1,"afterReselectSendCount":2,"runtimeStarts":1}
```

Therefore no data loss, permanent stall after re-selection, or restart claim. Background progression is genuinely absent despite the code's stated next-serialized-turn contract at `:673–675`; original severity depends on that intended workflow rather than an execution-safety failure. Native already-steered input may be consumed by Engine in the background, so do not generalize this to every native text queue; external entries, which cannot steer, are the verified core case.

## R16 — retain P2; same-device reply scope and absent open-intent correlation

Actual handler `handle-cc-room-event.ts:29–32,61–74` sends opened through sendToDevice. `remote-host-manager.ts:492–497` intentionally sends to **all authenticated sockets sharing that device ID**; sendToViewer exists separately at `:514–526`. Thus broadcasting to two browser tabs is a real route, not a fake-socket invention. It does not send to another paired device under this branch.

`useRemoteApp.ts:962–1006` handles every successful ccRoom.opened, including unrequested opens, writes activeRoom, resets viewed chat and clears displayed approvals. Unlike explicit native selection at `:1373–1400`, the opened handler does not check conversationRevision or an outstanding request ID. New/latest recheck retains the two existing cases: unsolicited second tab never sent open but navigates to room, and a delayed open switches away from a later native selection.

Scope counterevidence: CLI probe/list replies **do** have kind/cwd guards (`useRemoteApp.ts:948–960`); transcript subscription reply checks room+session (`:1023–1042`), and native session-list reply has its own later-navigation guard (`:643–650`). Do not characterize all CLI responses/history as unguarded. These correct protections do not gate ccRoom.opened itself. Switching can influence subsequent room.send (`:1276,1307–1317`), but neither test establishes irreversible draft loss or execution of an unintended task without another user submit.

Reconnect resynchronization (`useRemoteSocket.ts:197–205` → `useRemoteApp.ts:1195–1219`) restores room transcript/history. That correctly recovers output; it neither correlates an earlier open intent nor changes the native-only permission/stop callbacks. No new general reconnect defect is asserted here; pending approval recovery remains covered separately by R10/R11.

## R18 — retain P2; same-mode retry is broken, existing mode-change/close recovery must be stated

Production desktop creates actual ResidentAgentProcess for Claude rooms (`main/index.ts:1138–1159`), with command claude; paired open invokes same manager (`handle-cc-room-event.ts:61–68`), desktop IPC also calls openForSession (`main/index.ts:5634–5644`). `resident-agent.ts:186–192` assigns a child immediately; async failed-spawn error (`:207–215`) only emits nonterminal error, whereas child cleanup/exit event is only in `:216–218`; isRunning at `:236–237` checks object presence. `room-manager.ts:1009–1034` only constructs a new agent if the map is empty. Actual error processing appends text (`:1081–1083`), while terminal exit clears the map (`:1130–1132`).

New test uses actual missing executable → failed-spawn error → creates an inert executable at exactly that path → **openForSession with same external session and same mode** returns running without a second agent and send=false. This reproduces through the production reopen entry, not only low-level open().

Strong normal recovery counterevidence, now reproduced with real children:

- Changing default→acceptEdits when reopening the same session triggers existing `openForSession:804–812` close/restart. Agent creation advances to 2 and send succeeds.
- Explicit close at `:1212–1225`, then same-mode reopen, advances creation to 3 and send succeeds.

Thus avoid “unrecoverable” or “must explicitly close” as an absolute. Suggested wording: **“failed CLI spawn leaves stale running state; fixing CLI and reopening in the same mode does not retry; switching mode, explicit room close, or Main restart can recover.”** The report need not recommend changing a permission level as a repair UX, but should acknowledge it works. Ordinary CLI probes hide session choices when unavailable (`DesktopControls.tsx:208–218`), so a missing-command trigger needs stale/previously successful probe, a binary/permissions/cwd change after selection, or another genuine spawn resource failure; it is not “any fresh missing CLI can always be opened from current sidebar.”

Only async spawn failures are demonstrated. Synchronous `agent.start()` throw already clears the map (`room-manager.ts:1018–1028`), and a proper exit event already retires it; do not generalize those to R18. Nonfatal stderr error messages share the nonterminal event path and must not be treated as proof to retire a healthy agent. Fix should specifically retire the exact failed ChildProcess and publish a terminal failed-start lifecycle, keeping the existing stale-process identity protection (`:1012–1015`).

## 主审便携复核

新增正常控制脚本已收录 [`reproductions/quality-round9/`](reproductions/quality-round9/)，仓库相对导入，在两基线分别 guarded 通过；本附录已有缺陷用例的重查不重复累计。CLI控制3测试31断言、reviewed overwrite控制1测试21断言；没有新增发现编号。
