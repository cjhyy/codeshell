# Mobile 大旧基线分页：批次 2 交接（2026-10-26）

当前状态（2026-10-27）：来源批次已获原 CC **361 pass / 0 fail**，现已精确转入[2026-10-27 组合候选](audit-integration-20261027.md)，原 CC session `3e34f601-e67b-4de4-a43f-eba9cf0283f3` 最终组合验收已 PASS，已快进合入本地 main；未推送、未发行。
以下基线、实施与日志均为 2026-10-26 独立来源阶段历史。
本记录独立于批次 1 NSIS；没有修改批次 1 worktree 或其交付文档。

## 基线与实施边界

- 指定 worktree：`/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/mobile-legacy-base-pages-20261026`。
- 指定分支：`codex/web/mobile-legacy-base-pages-20261026`。
- 基线：本地 main `55dce40442926c83995d1c76c78e47f10d71c625`；开始时本 worktree 干净。
- 已读 `CODESHELL.md` 与 `docs/todo/recovery-windows-audit-20261026.md`。用户指定本地基线与禁止集成的约束优先于仓库默认 fetch/新建分支/合并流程；本批未 fetch、未切换分支。
- 本会话是唯一写手。辅助代理仅只读复核当前 worktree；未启动外部 CLI 写手或原 CC 验收进程。
- 写入仅限本 worktree 与 `/tmp/mobile-base-pages-*` 日志/隔离夹具/安装缓存。使用 guarded Bun runner 隔离 HOME 和凭据；没有改真实 HOME、账号、Secrets、workflow、CI 或生产，没有付费调用。
- `bun install --frozen-lockfile` 成功，使用 `/tmp/mobile-base-pages-bun-cache`；无依赖或锁文件变更。

## 协议与真实接线

实际 wire DTO 位于 `packages/core/src/protocol/mobile-remote-types.ts`；server 的 `mobile-remote/types.ts` 是 re-export，未重复定义协议。

- `auth.ok` / `pair.ok` 的现有 capability 对象增量为 `legacyBasePages?: 1`。
  `RemoteHostManager` 使用独立可选 `legacyBasePages` 开关，且要求原 `outputJournal` 同时开启；仅实际 Desktop host 开启新位。旧 host 不会因启用 journal 自动广告分页。
- `session.legacyBase` 请求含 sessionId/recoveryId/requestId（各 1..128 字符）。首次必须有 throughEventId（1..512），续页必须有 cursor（1..2048），严格类型与 XOR。未知请求字段仍按既有 validator 规则透传；不从它们取权限、root 或路径。
- 失败回复为 `{type, sessionId, recoveryId, requestId, ok:false, reason:"busy"|"incomplete"}`。
  成功回复增加 `throughEventId/index/events`，并按 `complete:true` 无 next、`complete:false` 有 next 精确区分。
  index 是整体投影数组的起始 event offset。
- 实际链路已接通：RemoteHostManager WebSocket parse/鉴权/注入 socket 身份 → onClientEvent → Desktop orchestrator → handleClientEvent 的 await/early return → MobileOutputRecovery → viewer 定向回复 → useRemoteApp 的 MobileOutputClient。
  沿用既有选中会话 read grant 与 viewer-offline/revoke；没有新 worker RPC 或权限。
- 首页仍先尝试 1 MiB raw inline；超 raw 或投影 wire 预算时保留有效 journal 页并返回 `legacyBaseComplete:false`。小 inline 路径保留原行为。
  新客户端仅在该标记且已协商新位时请求基线页；旧 host 无位仍走原失败屏障，不发新请求；旧客户端可继续消费小 inline。

## Host 安全与预算

Core 只为 `readOutputJournalLegacyBase` 的完整成功结果附加可选
`identity:{endOffset,sha256}`，复用扫描器已计算的原始字节前缀证明。
参数签名、失败结构、普通 journal 分页、独立 cutover、身份校验和 Desktop/Hub 既有恢复路径不变。

每个 binding 用 `randomBytes(32)` 生成独立 cursorKey，revoke 清零并移除；不保存 transcript 或投影缓存。
每个基线页重新读取至多 32 MiB/262144 条原始基线，**整体调用 transcriptToStreamEvents 后切片**，保留其 knownTools 预扫、跨记录工具状态与去重语义。

cursor 是 `base64url(JSON).HMAC-SHA256`，payload 精确为
`{v:1,sessionId,recoveryId,throughEventId,endOffset,sha256,index,total}`。
解码检查总长度、编码规范、UTF-8、精确字段、摘要格式和安全整数；要求 `0 < index < total`，使用 timing-safe MAC 比较。
读前后复核 binding/socket/authority，每页核对当前真实 journal 的 through ID、Core 前缀 identity 与整体投影 total。
合法尾部追加不改变已冻结前缀；改写、截断、目录替换、跨 viewer/恢复/会话、重选或撤销均不能释放旧页。

- 与 journal 共用 viewer 单读与全局八读，并增加 `activeBaseReads <= 1`；无排队，容量不足立即 busy；释放在 try/finally。
- 每页 events JSON 预算为 `1 MiB - 32 KiB`，每个 event 按真实 UTF-8 单独计量一次，线性累加后切片；没有逐条 stringify 整数组的 O(n²) 行为。
- 单 event（连同数组括号）超预算或整个基线回复超过 1 MiB，显式 incomplete；不分裂、跳过或截掉 event。session_started 仅允许首条。

## Web 消费与失败边界

journal/base 复用同一个 10 秒 waiter，按事件类型、session/recovery/requestId 匹配。
busy 在验证失败 envelope 与 UTF-8 大小后才以 25 ms 退避，至多八次重试；cancel/fail 清 waiter、超时与退避 timer，迟到回复不能污染重选。

成功页逐页校验 through ID、index 连续、非空事件、投影字段与嵌套 schema、首次 session_started、后页不得重复 session_started、游标不重复及末页序列。
字段白名单阻止 `method/params` reducer 包装与 injected/authority 等非投影控制字段混入。
每页整个回复至多 `1 MiB + 4096` 字节；最多 40 页，累计至多 `32 MiB + 40*4096` 字节。
基线页占用同一个 2048 总页预算；验证后逐页 reduceStream 形成私有 candidate，再进入原 journal 循环与 frozen snapshot join，全部成功才 commit。

**保留限制：** 原始 32 MiB 可因投影膨胀、单事件过大、低填充率而超过单页、40 页或累计 wire 预算。
这类输入显式失败并保留原 transcript；没有放大 Mobile 包或静默漏数据。未来如需更大范围，须另审分片/预算协议。
原生手机、弱网、正式安装包刷新/冷重启仍未验；本轮 Hook/FakeWebSocket 与真实 Host、真实 loopback WS 测试是隔离源码证据。

## TDD 与复核记录

初轮在实现对应路径前保存失败日志；没有以缺 dist 的环境错误充作红灯。依赖安装后先 build，再跑消费者红灯。

| 阶段 | 实际结果 | 日志 |
| --- | --- | --- |
| Core 两文件首轮红灯（缺成功 identity） | 64 pass / 2 fail | `/tmp/mobile-base-pages-core-red.log` |
| Host/validator/auth/dispatch/恢复库首轮红灯 | 105 pass / 22 fail | `/tmp/mobile-base-pages-consumers-red.log` |
| 客户端与真实 hook 首轮红灯 | 65 pass / 7 fail | `/tmp/mobile-base-pages-web-red.log` |
| 首轮实现集成 | 198 pass / 1 fail | `/tmp/mobile-base-pages-target-green.log` |
| 字段/包装门禁首次补充红灯 | 23 pass / 2 fail | `/tmp/mobile-base-pages-schema-red.log` |
| 补强精确断言与 busy 门禁红灯 | 38 pass / 6 fail | `/tmp/mobile-base-pages-schema-busy-red.log` |
| 三文件补强绿灯 | 95 pass / 0 fail / 0 skipped | `/tmp/mobile-base-pages-target2-green.log` |

首轮实现集成唯一失败是 M6 夹具 raw/投影仍能塞入旧 1 MiB inline，测试误要求首页 incomplete；修正为 inline 成功、新分页端点因更小 event 预算 incomplete，未放宽实现预算。
复核另发现并修复：合法 bare event 可夹带 reducer envelope，以及 busy 在共享消费校验前跳过失败 schema/字节门禁。两者先以红灯复现再补实现。

M1–M13 对应覆盖：

- M1/M9：新旧 header 的约 3 MiB UTF-8 基线，每页整包 <=1 MiB；拼接等于整体投影，真实恢复最终 chat 等于整体投影再接原 journal。夹具包含工具结果先于后置工具定义、跨页工具参数/状态；另有 inline/paged 小基线最终结果全等。
- M2/M4：MAC、index、total 篡改，带有效签名的坏字段/范围，跨 viewer/session/recovery、撤销/重选/authority，old/sealed 前缀等长改写与截断、实际目录复制替换均失败且不更改损坏证据。
- M3：old/sealed 页间合法 transcript 追加不影响原前缀。
- M5：base 单大读、viewer 互斥、八 journal 拒绝 base、七 journal + 一 base 拒绝第九读；authority 前/后 throw/revoke 与 finally 释放。
- M6/M7：单 event 超分页预算失败；原 inline 显示过滤、raw 预算、隐藏输入/图片处理和小基线行为保留。
- M8：请求长度边界/XOR/types；公开声明编译合同覆盖首/续请求、失败、末页与续页的可判别类型。
- M10：oversize、index 回退/跳跃、重复 cursor、错误身份、缺/重复 session_started、空页/非法 event、complete/next 坏序列、>40 页与累计字节超限拒绝。
- M11/M12：无新位旧 host 不发新请求；中途 cancel、重选迟到 reply、busy timer 清理、10 秒超时合同和 type/requestId 误匹配隔离。
- M13：useRemoteApp 的真实 MobileOutputRecovery 3 MiB 端到端夹具成功；另由真实 RemoteHostManager loopback WebSocket 验证新事件经过 validator、socket 身份覆盖，再由真实 Main handler 测试保证等待且不落普通命令分发。

相对原 CC 方案仅做有依据的细化：DTO 真实位置在 Core protocol（领域实现仍留 Host）；采用 throughEventId 字段；能力采用现有对象新增独立显式 host 开关；增加精确投影字段门禁与 busy 前置校验。没有改变恢复框架、预算或权限边界。

## 最终验证

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| bun install --frozen-lockfile | exit 0，锁文件不变 | `/tmp/mobile-base-pages-install.log` |
| Core targeted 两文件 | 66 pass / 0 fail / 0 skipped | `/tmp/mobile-base-pages-core-green.log` |
| bun run build（最终源码） | exit 0 | `/tmp/mobile-base-pages-final-build.log` |
| 消费者/协议/类型十四文件 | 269 pass / 0 fail / 0 skipped | `/tmp/mobile-base-pages-consumers.log` |
| command/orchestrator/controller 相邻三文件 | 26 pass / 0 fail / 0 skipped | `/tmp/mobile-base-pages-dispatch-regression.log` |
| bun run typecheck（含串行完整 build） | exit 0，全部14 workspace | `/tmp/mobile-base-pages-typecheck.log` |
| bun run lint | exit 0，0 errors / 99 warnings | `/tmp/mobile-base-pages-lint.log` |
| 仅18个改动源文件 Prettier | exit 0 | `/tmp/mobile-base-pages-prettier.log` |
| git diff --check | exit 0 | `/tmp/mobile-base-pages-diff-check.log` |

最终三组 guarded 单测合计 **361 pass / 0 fail / 0 skipped**；过程中的重复回归不重复计入总数。
所有单测 timeout 保持 30000，没有放宽。构建保留现有 Vite chunk size 提示，lint 无新增 warning 总数。

最终命令（build/typecheck 的 dist 写入没有与消费者读取并发）：

```sh
BUN_INSTALL_CACHE_DIR=/tmp/mobile-base-pages-bun-cache bun install --frozen-lockfile
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/session/output-journal-legacy-base.test.ts ./packages/core/src/session/output-journal.test.ts
bun run build
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/mobile-remote/output-recovery.test.ts ./packages/server/src/mobile-remote/mobile-client-event-validator.test.ts ./packages/web/src/hooks/mobileOutputClient.test.ts ./packages/web/src/hooks/useRemoteApp.test.tsx ./packages/web/src/lib/mobileOutputRecovery.test.ts ./packages/web/src/lib/outputJournalRecovery.test.ts ./packages/web/src/lib/transcriptReplay.test.ts ./packages/desktop/src/main/session-transcript-ipc.test.ts ./packages/desktop/src/main/output-journal-recovery.test.ts ./packages/server/src/serve/headless-server.test.ts ./packages/web/app/chat.test.ts ./packages/server/src/mobile-remote/remote-host-manager.test.ts ./packages/desktop/src/main/mobile-remote/handle-client-event.test.ts ./packages/core/src/protocol/mobile-remote-types.test.ts
bun run typecheck
bun run lint
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/mobile-remote/external-runtime-commands.test.ts ./packages/desktop/src/main/mobile-remote-orchestrator.test.ts ./packages/desktop/src/main/mobile-remote-controller.test.ts
bunx --no-install prettier --check packages/core/src/protocol/mobile-remote-types.ts packages/core/src/protocol/mobile-remote-types.test.ts packages/core/src/session/output-journal.ts packages/core/src/session/output-journal-legacy-base.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/mobile-remote/handle-client-event.ts packages/desktop/src/main/mobile-remote/handle-client-event.test.ts packages/desktop/src/main/mobile-remote/output-recovery.ts packages/desktop/src/main/mobile-remote/output-recovery.test.ts packages/server/src/mobile-remote/mobile-client-event-validator.ts packages/server/src/mobile-remote/mobile-client-event-validator.test.ts packages/server/src/mobile-remote/remote-host-manager.ts packages/server/src/mobile-remote/remote-host-manager.test.ts packages/web/src/lib/mobileOutputRecovery.ts packages/web/src/lib/mobileOutputRecovery.test.ts packages/web/src/hooks/mobileOutputClient.ts packages/web/src/hooks/mobileOutputClient.test.ts packages/web/src/hooks/useRemoteApp.test.tsx
git diff --check
```

## 未提交候选与后续

本批候选共20个路径（18个源码/测试 + TODO/本记录），包括以下改动；没有暂存或提交。

| 归属 | 候选文件（相对仓库根） |
| --- | --- |
| Core（4） | `packages/core/src/session/output-journal.ts`、`output-journal-legacy-base.test.ts`；`packages/core/src/protocol/mobile-remote-types.ts`、新增 `mobile-remote-types.test.ts` |
| Desktop（5） | `packages/desktop/src/main/index.ts`；`packages/desktop/src/main/mobile-remote/{output-recovery,handle-client-event}.ts` 及对应两个 `.test.ts` |
| Server（4） | `packages/server/src/mobile-remote/{mobile-client-event-validator,remote-host-manager}.ts` 及对应两个 `.test.ts` |
| Web（5） | `packages/web/src/hooks/mobileOutputClient.ts`、其测试、`useRemoteApp.test.tsx`；`packages/web/src/lib/mobileOutputRecovery.ts`、新增同名 `.test.ts` |
| 记录（2） | `TODO.md`（只改原 Mobile 限制描述）、新增本交接记录 |

含新增未跟踪文件的统计：**20 files changed, 1806 insertions(+), 77 deletions(-)**。
上述统计与“未继续批次 3”属于来源阶段历史；本轮组合状态及提交以[2026-10-27 组合候选](audit-integration-20261027.md)为准。正式包、原生手机、弱网、冷重启的未验证项保持开放，本候选不表示前三节审计全部完成或已经发布。
