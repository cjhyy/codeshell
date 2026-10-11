# 第十九轮 file-mutex 独立只读质量审计

本审计新增测试、原生进程和网络实验执行均为 **0**。已读冻结 latest a66f4ef291f304ee4df9da8095a90671d9a8f140 的 CODESHELL、源码、已有 dist、作者原生脚本及主报告 R01–R76。只写本文，未改产品、构建、fixture、主报告或 goal，未创建代理。

**冻结结论：支持保留单项 FM19-1/P2 Host availability 候选。生产首因是正式标题 PATCH → HubAuth.authenticate → acquireFileLock(data/hub/auth.json) → data/hub.lock 的真实 EACCES → file-mutex 无差别同步重试；没有抵达 SessionTitlesStore 的锁。** 已只读核对最终[作者报告](file-mutex-round19.md)、[source](validation/file-mutex-round19/file-mutex-host.mjs)、[native log](validation/original-file-mutex-round19/native-host.log)、[observations](validation/original-file-mutex-round19/native-observations.json) 和 [cleanup receipt](validation/original-file-mutex-round19/post-run-cleanup.json)：作者原生 Node 1 个成功 fixture / 38 assertions / Completed / exit0；本审计执行0，root后续双基线另计。四份未完成诊断不算通过或新增缺陷。不扩大成 P1、安全攻击、无限挂死、标题/历史损坏或所有文件权限失败。

## 正式入口和首个生产门禁

实际 HubSessions 标题 form [304–306](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:304) 调 mutate；[165–178](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:165) 同步防重后发 PATCH。Headless [188–192](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:188) 用 opts.dataDir 创建真实 HubAuth；[723–751](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:723) 先在 728 authenticate，再做 Origin 等检查，751 才转发 sessionManagement.handle。作者没有跳过认证以强行抵达 title store。回答/审批/模型不参与本轮。

实际 callback [auth-http.ts:107–108](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-http.ts:107) 调 store.authenticate。HubAuthStore [85](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:85) filePath 为 dataDir/hub/auth.json；[161–174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:161) 对格式有效 token 调 mutate。即使一分钟内无需持久化 lastSeenAt，也先取得锁：mutate [254–263](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:254) ensureDirectory → acquireFileLock → read/validate → 按 changed 写入 → finally release。lastSeenAt 写节流不能排除 acquisition。

Core acquireFileLock [73–76](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/utils/file-mutex.ts:73) 锁 dirname(file)，所以 sibling 为 dataDir/hub.lock。Auth ensureDirectory [267–273](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:267) 仅确保/chmod hub 子目录 0700，不修 dataDir parent。启动和 setup 已建立 hub 后，当前非 root Host 可读/遍历 dataDir 却不可新建 entry（自有 parent chmod 0500），正常带 Cookie 的请求便可在 auth lock mkdir EACCES。

AUTH 先于标题 handler，因此动态响应应为 Headless 外层 [778–779](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:778) 的 HTTP 500 “server request failed”，不能引用 title handler 的中文 500。标题 anchor 是否预建不是该 native auth 故障的必要前提；先成功保存标题只是正常控制/持久基线。不能把 auth 锁收据写成 title acquisition 收据，亦不另计标题锁发现。未绕过 Cookie/Origin/ownership；不据 token 格式校验次序推导匿名安全攻击。

## 根因、同进程范围和超时反证

file-mutex 默认 [50](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/utils/file-mutex.ts:50) 30,000ms；[62–64](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/utils/file-mutex.ts:62) sleepSync 直接 Atomics.wait；[95–112](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/utils/file-mutex.ts:95) 捕获全部 lockSync 错误，不筛 ELOCKED，EACCES 也同步重试直到 deadline。Promise/async 不会把此代码移入 worker。

lazy wrapper [65–77](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/utils/lockfile.ts:65) 调 proper-lockfile 4.1.2。依赖 [lib/lockfile.js:46–49](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js:46) 对非 EEXIST 原错立即回传；live lock [67–69](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js:67) 才转 ELOCKED。adapter [5–20/43–57](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js:5) 用真实 sync fs 并原样抛错。无谓权限重试由仓库外层引入；正常控制的 native mkdir EEXIST 与外层捕获 ELOCKED 应明确区分。

Headless [715–780](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:715) 同一 Node createServer callback 处理 /health（719）、environment（742）和 session API（751）；WS upgrade [1216–1217](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:1216) 也在该 server。无需 AUTH 的 /health 仍等同一个 JS 事件循环，定时器和 JS 消息处理也无法进展。这不等于 OS 网络停止或独立 agent worker 计算停止，不能冒称实际所有任务超时。

最终脚本故障期间只追加 /health，避免并发第二个需 AUTH 的 ENV 再产生第二次锁等待；ENV 在权限修复后控制。动态范围只能是一份 auth acquisition 故障、一份独立健康请求和 Host timer gap，不是测遍全 API。故障持续时后续认证可再进相同 retry 是源码关系，不是无限挂死实验。

session readBody [424–434](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:424) 的 10 秒 timer 尚未在首 AUTH 之前创建，亦只保护 body 收取，不能终止本次 acquisition。file-mutex/Auth mutation 无 signal 参数；UI AbortController 取消客户端等待不会让同步等待中的服务端取消回调提前运行。该取消边界是源码结论，脚本没有动态点击 UI Cancel。

## 正常保护、恢复和 P 级

Auth setup/login [127–129/146–153](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:127) 在锁前 await scrypt，mutate 锁内仅同步 read/validate/write/finally release。这不是该 writer 的同进程 async-holder deadlock，不能借 CODESHELL 警告另造一个发现。

正常跨进程争用仍须允许：作者自有 Node holder 对 data/hub 实际 acquireLockOnPath，短暂持有后 finally release；另一进程 timer 能继续，Host 随后成功。不能用同进程 await-delay 冒充另一进程释放，也不能删锁、失败后无锁写入或任意缩短正常竞争预算。

deadline 后错误经 Headless catch 返回，事件循环恢复；权限修复后原 Cookie 的 ENV 和同一 title/expectedTitle 请求应及时成功。native fixture 不渲染 HubSessions，只能动态证明 HTTP 同稿重试；实际 UI 的错误/保稿/解除 busy 是 [HubSessions:187–205](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:187) 静态接线，第十八轮已有该 UI 500 保稿正常控制，不能称本轮 browser UI E2E。

建议 **P2**：正常轻量请求在窄存储故障下使局部 acquisition 错误放大为整个 Headless Host 约 30 秒停顿，超出局部保存反馈 P3。保留非 root、真实 parent 拒写、单次有界及恢复条件；没有历史/消息丢失、模型费用、crash 或权限绕过，不升 P1。失败请求未抵达 title mutation，最终确断言原 title bytes 不变；同稿成功不能扩大成磁盘完全故障的一般恢复保证。

## 观测、隔离、失败诊断及最终计数

维护 run-isolated-node-smoke 提供 private HOME，fixture 拒绝 root；各 mode 在 Core/Host import 前装 exact owned loopback guard，Host/holder 再 deny direct net/tls，parent 只对 owned origin HTTP。actual HubAuth/setup、Headless Node HTTP、Core lock util 和普通标题存储被执行；Host/holder 是自有 Node child，“无 agent worker”不等于“无子进程”。已核 bridge.hasChild/generation、child exit/close、closedNormally 收据；未用模型/provider/CLI/真实用户账号。Node22、Electron、Linux/Windows、其他 errno/整盘只读不在本次动态覆盖，锁前 mkdir/chmod 即失败的故障不能套入这份 30 秒结论。

observer 经 createRequire(Core lockfile.js) → resolve(proper-lockfile) → 其 require(graceful-fs) 取得真实依赖实例，只包装 mkdirSync。它委托原方法，返回原结果或重新 throw 同一个 error，仅记录自有 title/auth lockPath；首 EACCES receipt 写到 denied data 之外的 owned 根。parent 对新建 owned 根 realpathSync，使过滤与 proper-lockfile canonical target 一致，未改产品 realpath。无 Date.now/sleep/预算/lockSync 结果/权限模拟；少量观测 I/O不能解释 30 秒，精确开销不在范围。

parent 与 Host 不同进程，parent interval 可继续；首次真实 auth EACCES 后才发 /health，Host 20ms timer gap 独立佐证 JS 阻塞，避免仅凭客户端排队推断。finally 接 catch、abort/allSettled outstanding requests，修权限，关闭并 await children，删 owned目录，isolator 最后删 HOME；仍须最终清理收据。

前四份诊断全部保留且不计成功：前三轮先后调整 node:fs observer 到实际 graceful-fs 实例、规范化 owned 路径，最初只盯 title lock 的过滤又漏掉生产首因 AUTH；second/third 的 8 个断言仅为 setup/正常保存控制。第四份实际客户端 ECONNRESET 诊断也保留，尚未取得完整候选收据，不另列产品发现或把其具体网络成因当作已证明。最终客户端每个 fetch 增加 Connection: close，固定新连接以排除旧连接池干扰；仅改变客户端请求 header，没有改 Host timeout、认证、锁或30秒产品等待。正常 exit0 cleanup 与失败记录 closedNormally=false 不矛盾，不能将 AbortError 写成产品 native crash。

最终收据为 Node v25.8.1 / macOS arm64 / UID501。真实 auth sibling mkdir EACCES 803次；标题请求 500，30,015.75ms；首 EACCES 后另发的 /health 200，30,009.79ms；Host 20ms timer gap 30,021.95ms，parent timer 295 ticks。修权限后 ENV 200/6.80ms、同稿标题200/17.42ms。正常另进程持有 auth 锁350ms 后释放，标题请求200/377.39ms，native EEXIST11次；generated title保持。Host/holder均close exit0、signal null，failure=null、closedNormally=true，multiple bridge snapshots无worker/generation0。38项是 fixture 的 check/equal 对 Node assert 调用逐项计数，非 Bun test/expect；不增加 Bun文件/测试/断言汇总。cleanup receipt另证 owned root和isolated root均已删除、精确fixture进程检索无残留；这些post-run检查不混入38。

## 基线、去重和建议

84740 与 a66f 的 file-mutex、lockfile wrapper、HubAuthStore/auth-http、SessionTitlesStore/session-management 产品源码无差异；latest 既有 dist 的真实入口、默认30秒和 retry 与 src 对应。本审计未 build，两基线动态适用以作者/root 收据为准，不用源码一致冒充双基线执行。精确行号按 latest。

与 R43 Token 拒写缺反馈、R71 项目重命名乐观 UI、R65 目录 EACCES 冒充空树独立：UI feedback 修复不去掉明确非争用错误的同步重试；本项缺 Host 可用性。第十八轮非文件 title registry 500 是取得锁后 strict read 拒绝，其 Bun EACCES 诊断只是调查线索，不能当成已证明 native title锁的重复发现。第十七轮 fresh title parent EACCES 在 mkdir(anchor) 前置失败，不冲突。

最小修复是只为真正可重试的 ELOCKED 保留争用重试，明确权限/存储 acquisition 错误立即回传；若 Host 还要在正常争用时保持响应，应使用有界非阻塞 acquisition 或隔离同步锁工作。保留认证、跨进程 read-modify-write、真实 parent/anchor 检查、标题 CAS、严格 registry、finally release、同稿重试，不能故障时无锁写入或跳过认证。
