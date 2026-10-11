# 资源与进程发现的独立范围复核

结论：保留 R09、R17、R20、R30、R31、R36；没有推翻现有发现，没有新增条目。建议收紧 R17 的“新登录可恢复”和 R36 的 Desktop 扩展影响。此次只读审查真实代码、原始 fixture 与最新 a66f4ef2 成功日志，没有重复执行已通过的 fixture，没有构建或更改产品。

固定源码 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`。报告及原始最新验证日志读取自 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。已核对 `git diff 84740d56..HEAD`：hub/uploads、attachment-service、useHubController、tool-jobs、process-service、worker-bridge-core、spawn-common、serve/cli 八个根因文件均未改变；Panel runtime / headless 文件仅需更新行号。

## R09 — 保留 P2，重复启动前清理确实破坏活实例附件

可达性：serve CLI 默认 auth=hub、runtime=local、port=8790；[cli.ts:135](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/cli.ts:135) 不提供 --data-dir 时使用同一 `<CodeShell home>/serve`。重复运行同一命令无需任何非正常输入。

根因 [uploads.ts:61](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/uploads.ts:61) ready 无条件删除符合命名的现存 spool；[headless-server.ts:205](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:205) 在 listen（1290–1295 行）之前执行 ready。第一个 server 的内存 upload 记录不因此消失，健康检查也继续成功，但真实 bytes 已被第二实例删除；后续 prepare 201–207 行打开原路径遇 ENOENT。

保护/范围：故障是共享 dataDir 的两个实例交叠，不是普通干净重启对孤儿草稿 spool 的预期回收；不同 dataDir 不受影响。第一服务其他 API 无需全部失效，核心影响限定于待发送上传 bytes / Send 失败。原 fixture 真实认证 PUT 201、同端口第二启动失败、第一 /health 200、spool 从 1 到 0；最新日志 1 test / 6 assertions / pass。无需引入安全攻击解释。

## R17 — 保留 P2；配额有上界，且“新登录”只能条件绕过

可达性：真实 [useHubController.tsx:632](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/useHubController.tsx:632) 对选择文件顺序 upload；[useHubController.tsx:734](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/useHubController.tsx:734) removeFile 仅操作 SessionDrafts，服务端没有对应 discard endpoint。原 fixture 直接使用同一 SessionDrafts 类，不是任意伪造一个清空后的 UI；与生产 removeFile 两行一致。

资源界限 [uploads.ts:87](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/uploads.ts:87)：每 owner 16、全局 32、并行 receiving 4；99–102 行全局 bytes 128MiB。删除 16 个成功上传的草稿附件后显示零附件但 owner slots 仍满，第 17 个 PUT 429，成立。

已有保护：未完成/失败 PUT 的 catch 161–168 行删 map、关句柄、删 spool；成功执行后 receipt.commit 删除 spool（228–235 行，headless-server.ts:462–466 收到 worker 成功响应时触发）；prepare 失败/release 恢复 ready，便于重新发送；ready upload 的 15min TTL 在 250–255 行 sweep，close 259–264 行回收。不是无限磁盘泄漏，正常已成功发送和传输中断已有回收。

**建议改报告恢复句**：新登录产生新 owner，可条件绕过当前 owner 的 16 槽，但旧 spool 仍占全局 32 槽 / 128MiB，logout/revoke 不会直接释放已完成 spool，因此新登录不是普遍可靠恢复。等 TTL/sweep 或服务重启才保证此批 discarded spool 被回收。需显式 discard 的根因与 P2 判断不变。

## R20 — 保留 P3，精确区间为 (10MiB, 20MiB]

服务端 [uploads.ts:94](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/uploads.ts:94) admission 仅 `size > 20MiB` 拒绝；[attachment-service.ts:124](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/attachment-service.ts:124) 图片 staging 上限 10MiB，[attachment-service.ts:243](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/attachment-service.ts:243) 超出才拒绝。10MiB 本身并非尺寸失败，20MiB 本身可 PUT。普通 files 上限 20MiB 一致；SVG 会被当普通 file（uploads.ts:220），不属于这一图片尺寸路径。

原 fixture 的 `Buffer.alloc(11MiB)` 并非有效 PNG，但 size 检查发生在 sanitizeImageBytes（246 行）之前，故它准确证明 admission/staging 大小不一致；结论不依赖字节有效性。任意合法 PNG/JPEG 落在同区间也会命中相同尺寸判断。不能据此声称“所有上传后的图片内容处理都正确”。

已有保护/影响：Hub staging 在 worker run 之前，失败通过 JSON-RPC -32602 回到浏览器（headless-server.ts:1001–1019），不会向真实模型递交超限图片；未编辑过的新 draft 会恢复，用户移除/缩小再传可继续。该问题是 late admission UX，不是发送超限到模型、无提示成功或永久丢稿。原日志 11MiB PUT 201 后 prepare size rejection；同文件 2 tests / 21 assertions / pass（与 R17 共享）。P3 合理。

## R30 — 保留 P2；结果字段丢失与虚假活动状态成立，但可恢复

[tool-jobs.ts:806](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/tool-jobs.ts:806) executor 完成后以 clone 构造 terminal outcome；commit 430–434 行必须 write 成功才更新 map。最终 write 拒绝后 [tool-jobs.ts:768](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/tool-jobs.ts:768) finally 清 active executor、resolve done，随后 catch 吞掉错误。result 局部变量退出，job map/disk/subscriber 都只到 running。

activeCount 322–333 行计入所有非 terminal job，并非仅 active executor；最新 [runtime.ts:1888](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/runtime.ts:1888) 将 count 传到 Host；[headless-server.ts:542](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:542) configuration mutation 门禁据此 409。这条影响不是仅测试 private map 的推断，真实 gate 有连接。

原 fixture 用真实 mode 0500 导致 EACCES，包装 storage.write 只记录原错误并重抛，不是注入异常；最新 log 明确 EACCES、activeExecutors=0、activeCount=1、仅 queued/running 事件、无 result/error。权限修复不会自动补写。已有保护：修复存储后 cancel 提交 cancelled、activeCount=0，再 retry 成功；新 Host 将 stale running checkpoint 标 interrupted/HOST_INTERRUPTED，不自动执行。

范围建议：把“结果丢失”理解为返回的 job result/outcome 字段未保留，不能扩展为执行器已写出的所有 output 文件也丢失。不能写“永远不能恢复”或“取消无效”；主报告现有可恢复说明准确。最新 fixture 2 tests / 18 assertions / pass。

## R31 — 保留 P2，只承诺已验证的 POSIX local Hub CLI 生命周期

[process-service.ts:1065](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/process-service.ts:1065) close:void 仅 revokeGuest；[process-service.ts:1082](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/process-service.ts:1082) 保存 killProcessGroup 的 Promise 却不 await。最新 [runtime.ts:1947](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/panels/runtime.ts:1947) async close 在 finally 同步 processes.close 后直接等待其他资源，不 join termination。Headless await panels.close 1341 行因此不代表普通 native process 已停止。

[cli.ts:228](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/cli.ts:228) 在 server.close resolve 后立刻 process.exit(0)。[spawn-common.ts:349](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/runtime/spawn-common.ts:349) 的 3s SIGKILL escalation 依赖 Host 后续 timer，强制退出丢失这一步。原真实 Node + 认证 Hub Panel API fixture 让自有子进程延迟/忽略 SIGTERM，退出后 3.3s 仍活，最终自有 group cleanup 证明已清理；最新 log 1 test / 8 assertions / pass。

已有保护/范围：普通 cancel 的 child close handler 会 await running.termination（process-service.ts:817–837）；若 API Host 在 close 后还继续运行且 event loop 保留 timer，grace SIGKILL 可能正常完成。能响应 SIGTERM 的进程可能已经退出。不推广到 Windows、Docker 控制器、所有 Desktop 退出，或所有调用 server.close 的嵌入式 Host。当前主报告已限定本地 CLI/POSIX，成立。

## R36 — 保留 P2，建议正式影响只承诺 Node Hub/serve Host

[worker-bridge-core.ts:197](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:197) 至 265 行监听 ChildProcess 的 error/exit，并监听 stdout/stderr data，但没有 child.stdin error listener。sendLine 336–340 行写后立即 true、无 callback；outbox 262–265 同边界。Socket 的异步 EPIPE 不由 ChildProcess 的 error handler 或调用处同步 try/catch 接住。

原 fixture 真实 Node v25.8.1、真实编译 WorkerBridgeCore、自有无模型 worker，在 256KiB JSON-RPC 写入时 worker 退出，显示 sent:true 后 Socket Unhandled error EPIPE、Host exit 1，无 survived marker。256KiB 低于生产最新 [headless-server.ts:827](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:827) 的 1MiB WS 上限，属正常 worker 退出/请求交叉，不需要攻击。最新 log 1 test / 3 assertions / pass。

已有保护：spawn error/worker exit 已结算 pending 请求、清队列并支持后续 fresh worker；stdin.destroyed 检查可覆盖已经完全关闭的旧 stream，但覆盖不了检查后/写入中的异步错误。

**建议收紧原 runtime-round3 影响段的“Hub/desktop Host”**：当前平台闭环只证明原生 Node Host 会退出。Desktop AgentBridge 虽共享 Core，Electron 主进程的全局错误/退出语义没有在此 fixture 中验证；不要承诺 Electron 同样退出，也不要把 Node v25 实测扩成所有 OS/Node 版本实测。正式标题“Node Host”准确，保留 P2。

## 证据复核清单

已读原始 fixtures：

- `reproductions/server/double-start.test.ts`
- `reproductions/server/uploads.test.ts`
- `reproductions/runtime-round3/tool-job-final-write.test.ts` 及 write-crash child
- `reproductions/runtime-round3/panel-process-close.test.ts` 及 real Hub native child
- `reproductions/runtime-round3/worker-pipe-close.test.ts`

已读全部对应 `validation/latest-a66f4ef2/repro__*.log`：共 7 tests / 56 Bun assertions，最新回归全 pass。本次不把已有日志当新运行记录，也不额外增加测试计数。没有新增发现编号。
