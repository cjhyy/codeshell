# Round 15 — server connection/revocation/outbound recovery

Completed. Review-only, latest frozen `a66f4ef291f304ee4df9da8095a90671d9a8f140`; one formal finding R68/W26/P2. No product/report/build/goal changes. Root reviewed the Desktop start/stop control UI separately; CLI room exit was excluded.

Read `CODESHELL.md`, current R01–R65 README/flow coverage, `auth-round7.md`, first-round server findings, current MobileRemote Host/Relay/Hub/Web close/reconnect paths. W26 is independent of existing upload, auth revocation, room approval, retry-intent and CLI lifecycle findings.

## R68 / W26 / P2 — paired Desktop live output has no application backlog bound while a slow socket remains open

**Production entry and trigger.** The user enables Desktop mobile access, pairs/authenticates a browser, leaves that browser connected while it stops or greatly slows reading (for example a suspended tab or stalled network), and continues a session on Desktop. The Main worker subscription in `packages/desktop/src/main/index.ts:1739–1755` mirrors every `snapshotEntry` with `mobileRemote.broadcast({type:"session.stream", ...})`; other worker lines use `broadcastRaw`. Both go through `packages/server/src/mobile-remote/remote-host-manager.ts:484–485` and **546–550**, which test only OPEN/authenticated before `client.send(payload)`. There is no per-socket or total outbound backlog gate. `sendToDevice:492–499` and `sendRawToDevice:535–540` have the same independent entry to that unbounded path; the latter is used for approval replay at `packages/desktop/src/main/mobile-remote-orchestrator.ts:245–248`.

The replay cache is separately bounded (`SessionSnapshotStore.ts:82–83,147–163`) but Main still returns every appended entry (`:165`) for forwarding. Evicting replay entries does not remove copies already queued in ws. This is a live transport queue issue, not a transcript-storage or missing-output recovery issue.

**Measured result.** `outbound-native.mjs` runs on actual Node v25.8.1/darwin with the built unmodified Host. It creates its own loopback listener and temporary trusted-device file; two actual ws clients authenticate using valid `auth.device` credentials and issue valid `session.list`. It pauses one client using the ws public `pause()` method (real TCP reader pause); it does not replace server `send`, `bufferedAmount`, Socket write or Host logic. It sends legitimate `session.stream` / `text_delta` frames through actual Host send APIs, with a strict **24 MiB text payload maximum, 384 × 64 KiB frames**:

| Measurement | Bytes / state |
| --- | ---: |
| Slow peer after 16 MiB through `broadcast` | `bufferedAmount=13,859,059` |
| Same peer after 8 MiB more through `sendRawToDevice` | `22,266,483` |
| After an ordinary `sendToDevice(session.list.ok)` | `22,266,525` |
| Slow connection | still `OPEN`, viewer still authenticated, no offline event |
| Healthy peer | all 384 stream frames received; backlog `0` |

This measures bounded queue growth past existing limits; it does **not** run until OOM or claim an actual Main crash, total RSS measurement, physical phone test, relay-cloud test, real worker/model session, or exact accumulation rate on a user's network. Main worker→Host wiring is source evidence; the native fixture calls the actual public Host output APIs directly. Confidence: high in the missing transport bound and resource-retention behavior, high in the source entry, limited to measured LAN loopback transport for the dynamic result.

**Visible/practical impact.** The slow browser remains an online authenticated recipient while every further output is retained in the shared Desktop/Main process's ws write queue. Long sessions can keep increasing this allocation, independent of the bounded replay store and healthy viewers. Memory exhaustion or process termination is a risk inferred from the absent bound, not an observed outcome. The Desktop can continue normally in the bounded fixture; do not describe this as an immediate all-client outage.

**Normal counterexamples and actual recovery.** The same actual slow server socket is retired immediately when it receives a selected-viewer reply through `sendToViewer`: its existing `:524–527` 4 MiB gate releases the viewer and terminates the socket. The healthy peer remains authenticated and online. Reconnecting/reauthenticating gives a different viewer and receives a selected reply normally. Hard-deleting the device then calling `revokeDevice` closes its remaining sockets; retrying the removed credential returns `auth.failed`. These are actual native controls in the same fixture. A user may close the stale browser connection, remove the device, or stop the remote Host to release it; routine live output alone does not invoke the existing selected-viewer gate. Resuming a slow reader can drain the queue if it catches up; this fixture resumes the first reader only after the cap has terminated it and does not measure a natural catch-up time.

`HubOutboundTransport` already has distinct 8 MiB per-socket/128 MiB total defaults (`packages/server/src/hub/outbound-transport.ts:24–27,55–70`) and retires lagging peers while keeping healthy peers. `hub-outbound-control.test.ts` verifies this policy with an explicitly mocked backlog and transports; it is not a second native measurement. Thus the issue is narrowed to the paired Desktop RemoteHost live/device send methods, not the Hub outbound implementation.

**Suggested fix.** Route all RemoteHost output methods through a shared bounded outbound transport; include per-socket and aggregate limits, retire/release a lagging viewer, and retain a supported authenticated reconnect/resync path. Preserve the existing large-history/paging rules rather than blindly dropping any large valid frame. Relevant minimal review comment range is `remote-host-manager.ts:546–550`; do not fix only `sendToViewer`, which is already bounded.

**Dedup/baseline.** This is not R10's missing CLI pending-approval snapshot, R17's uploaded attachment quota, R31's native shutdown wait, R34's browser upload request lifetime, or R41's unconfirmed in-memory intent. Auth revocation itself passed. `git diff 84740d56..a66f4ef2 -- packages/server/src/mobile-remote/remote-host-manager.ts packages/server/src/hub/outbound-transport.ts` is empty: the root cause predates 0.9.33. This agent executed only a66f; portable fixtures use cwd and require no 0.9.33-only API. Root may independently rerun the older baseline.

## Other reviewed paths / no new finding

- Relay control socket uses setup deadline, ping/pong timeout and generation identity (`connector.ts:149–170`). On close it closes owned streams and clears timers; `close():254–273` fences running/generation, aborts credential acquisition, clears reconnect, terminates control and closes streams before waiting for tracked work. `RELAY_MAX_STREAMS` guards admission (`:232`). Static review only this round; no actual public HTTPS Relay, tunnel process or credential provider was used.
- Mobile Host `releaseSocket:554–563` removes bindings before emitting offline, so repeated close/revoke is idempotent. Main `index.ts:1214–1215` releases viewer-scoped recovery/command resources. Native controls above confirmed isolated slow-viewer retirement and all same-device revocation; they do not independently execute every optional HTTP/upload cleanup callback.
- Host `stopOnce:614–640` releases/terminates WS, clears identity/state, settles both optional cleanups and closes HTTP connections/listener even when a cleanup fails. This round's native finally closes only its owned listener/clients. The detailed optional-cleanup failure tests were read, not rerun or recounted.
- Web `useRemoteSocket.ts:225–254` handles actual close with offline/backoff and performs focus/visibility resync on a still-OPEN online connection. Auth/re-pair/HTTP owner revocation recovery has already been measured in round7; this review does not invent a new half-open auth failure based on absent heartbeat alone, nor count these old controls again.

## Evidence and final totals

Directory: `validation/original-connection-recovery-round15/`.

- `native-outbound.test.ts`: guarded Bun wrapper, **1 pass / 0 fail / 2 expect**, `Completed Bun shard: 1 tests, 0 skipped; 0 failures.`
- `outbound-native.mjs`: called only through `scripts/run-isolated-node-smoke.mjs`; actual local Node WS fixture, **33 native assertions**, `outbound-native.log` and `outbound-native-observed.json` contain final measurements.
- `hub-outbound-control.test.ts`: independent explicitly mocked Hub-policy normal control, **1 pass / 0 fail / 9 expect**, matching Completed line in `hub-outbound-control.test.log`.

Final current-baseline total: **2 Bun files, 2 completed tests, 0 failures/skips, 11 Bun expect calls; additionally 33 native assertions inside the one wrapped native test**. Do not count native script as an extra Bun test. No full-suite execution.

Commands from the reviewed checkout root:

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/connection-recovery-round15/native-outbound.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/connection-recovery-round15/hub-outbound-control.test.ts
```

The native fixture asserts isolated HOME, installs the repository exact-origin HTTP/fetch guard **before any Core/Host import**, then permits only the fixture endpoint for ws's standard HTTP connection bootstrap. For that exact endpoint it removes ws's stock `netConnect` property so Node uses its ordinary HTTP connector; arbitrary custom transports remain rejected. No provider, worker or model is started. This is a test-level guard, not OS network confinement. All real sockets/listeners and owned files are released in finally; native fixture has its own 12s cleanup deadline and guarded wrapper has 18s process timer.

`diagnostics/bun-outbound-attempt.ts.txt` and `.log` preserve a discarded Bun compatibility diagnostic. It reached a real auth/stream exchange using a manual loopback Upgrade plus stock ws Receiver/Sender, but measured `bufferedAmount=0` under Bun at 12 MiB while its native write semantics differed; initial ordinary Node-style ws Upgrade also failed in Bun. These failures are **harness/runtime diagnostics**, are not active `*.test.ts` fixtures, are excluded from final successful totals, and imply neither a production Node defect nor production safety. The final native measurement above replaces them.

## 主审便携复核 / 两基线

主审在84740与a66f分别执行 `reproductions/connection-recovery-round15/{native-outbound.test.ts,hub-outbound-control.test.ts}`，各2测试11个Bun断言、0fail/skip；每基线wrapped native另33断言，不额外算一个Bun测试。下表是便携最终运行，前文表格保留代理原始运行数值，不要求不同运行的TCP缓冲字节完全相同。

| 基线 | broadcast后backlog | device发送后backlog | 普通列表回复后backlog | 健康reader |
| --- | ---: | ---: | ---: | --- |
| 84740 | 15,304,063 | 23,711,487 | 23,711,529 | 384帧 / backlog0 |
| a66f | 14,647,243 | 23,054,667 | 23,054,709 | 384帧 / backlog0 |

初始便携[原生记录](reproductions/connection-recovery-round15/outbound-native-observed.json)、[原生日志](reproductions/connection-recovery-round15/outbound-native.log)；a66f [原生记录](validation/latest-a66f4ef2/connection-round15__outbound-native-observed.json)、[日志](validation/latest-a66f4ef2/connection-round15__outbound-native.log)。两次均在24MiB payload上限停止、cap/重认证/撤权恢复正常，没有执行真实Main worker或测量OOM。独立结论见[连接质量复核](connection-recovery-quality-round15.md)。

主要源码：[broadcastRaw:546](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:546)、[设备发送:492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:492)、[已有viewer保护:524](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:524)、[Main直播入口:1739](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1739)。

质量复核补充：owned-external selected stream经output-recovery.ts:105的reply→sendToViewer，已有cap正确保护，R68仅普通native worker mirror及device/live发送入口。网络守卫约束HTTP/fetch与本origin的标准ws bootstrap，并未普遍封锁direct net/tls、不是OS sandbox；没有启动真实worker/provider。成功wrapper exit0/Completed发生在native finally结束之后，支持本次清理，不据此宣称timeout分支所有子进程强杀均验证。
