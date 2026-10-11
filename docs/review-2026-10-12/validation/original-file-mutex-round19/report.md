# 第十九轮：真实 Node Host 文件锁权限错误恢复复核

结论：确认 1 个新候选，建议 **P2，存储权限故障下 Host 被非争用错误同步阻塞约 30 秒**，独立执行0质量审计已支持，正式编号由主代理管理。本轮 1 次最终成功的 standalone 原生验证、38 个 Node assert；不新增 Bun test/expect。4 次较早的 harness 失败独立保留且不计成功。没有产品、主报告、构建产物或 goal 改动。

## 基线与证据边界

- 实际运行：冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`；真实 Node v25.8.1 / macOS arm64 / 非 root uid501。只读 `git diff 84740d56..HEAD` 确认本报告的 Core mutex/lockfile、Hub auth、title store/session-management/HubSessions 相关文件两产品基线无差异；本代理仅在latest原生运行；其后主代理独立在两冻结基线分别原生重跑成功，另列在末尾，不把源码相同冒充动态复现。
- 使用已构建生产 dist：真实 `startHeadlessServer`、HubAuthStore、认证 Cookie/HTTP、SessionManager 磁盘目录和正常 title store；没有 fake auth predicate，也没有绕开认证提前锁来强行到 title 锁。
- maintained `scripts/run-isolated-node-smoke.mjs` 在导入前建立全新私有 HOME/state，fixture 的所有 realm 在 Core/Host 导入前安装 maintained exact-origin network guard；Host/holder 还禁止 net.connect/createConnection/tls.connect。只监听一个 owned 127.0.0.1 临时 origin；parent 不导入 Core/Host。没有账号、外网、真实 worker、engine、CLI 或模型。SessionManager 只创建 owned 元数据，bridge 始终 hasChild=false / generation0。
- 最终 HTTP caller 每个请求使用 `Connection: close`，不把最终 response 200/500 推广至所有浏览器 keepalive 连接。真实 Hub UI 接线只读；没有真实浏览器或 Electron UI 操作。正常另一个进程的锁 holder 是此脚本 fork 的 owned helper，调用同一生产 acquireLockOnPath，350ms 后释放；没有操作其他进程。

## 新候选 FM19-1：EACCES 被当作可重试争用，阻塞整个 Host 事件循环

**精确修复点：** `packages/core/src/utils/file-mutex.ts:95–112`。第101行以 `retries:0` 调 proper-lockfile.lockSync，第102–104行无错误分类地 catch 后仅检查总 deadline，第112行通过第63行 Atomics.wait 同步休眠；默认预算在第50行为30,000ms。proper-lockfile 已在依赖 `lib/lockfile.js:46–48` 将非EEXIST错误立即返回；这里把真实 EACCES 重新包成整轮30秒等待。

**正式入口与真实前置门禁：** Hub Sessions 行的“重命名”按钮 `packages/web/app/HubSessions.tsx:417–429` 打开编辑器，表单第303–306行调用 mutate，mutate第173–177行发 PATCH `/api/v1/sessions/:id`。本次原生验证使用实际 setup 得到的 Cookie 和该合法 endpoint。Headless 的所有 `/api/` 请求先在 `packages/server/src/serve/headless-server.ts:727–728` 执行 HubAuth.authenticate；`packages/server/src/hub/auth-store.ts:85` 的真实 auth 文件是 `<dataDir>/hub/auth.json`，第161–174行 authenticate 每次经过第254–264行 mutate，先在第256行 acquireFileLock。Core第73–76行锁定文件所在 hub 目录，proper-lockfile 创建 sibling `<dataDir>/hub.lock`。

这条认证锁比 title store 的锁更早。认证已初始化即可存在该门禁，不要求先保存标题；fixture首次标题保存只用于正常与文件字节对照。权限故障设为已初始化、当前登录有效的 owned `<dataDir>` 从0700变0500；内部 hub 目录仍存在、可读、可遍历且当前进程可chmod700，HubAuth ensureDirectory第267–273行只修复 hub 自身权限，不修复其 parent。于是真实原生 mkdir(`<dataDir>/hub.lock`) 抛EACCES。本轮观察到的发生点是 **认证锁**，不是 `session-titles-store.ts:167`。原先仅观察 title anchor 的夹具会漏掉这一门禁，已明确纠正。

**实际影响：** 单个合法请求约30秒后才500；同进程不需要认证的健康检查也约30秒不能响应，Host自身20ms定时器不能调度。不是只有这一标题操作等待。保留有意义的跨进程锁和拒绝错误写入是正确保护；非争用权限错误拖住全Host整个争用预算是候选问题。

## 最终原生结果与恢复

| 控制/复现 | 实际结果 |
|---|---|
| setup→正常首次标题保存 | 200；真实 title anchor 已建立；title lock释放；`/health` 基线少于1秒；无worker |
| dataDir0500后同一合法重命名 PATCH | 在 `<dataDir>/hub.lock` 记录803次真实EACCES；500 `server request failed`；30,015.75ms |
| 第一条EACCES收据后，由独立caller进程发 `/health` | 200；30,009.79ms；callee正常健康路由本身不读存储 |
| 同一期间 timer | parent100ms timer继续295次；Host20ms interval最大间隔30,021.95ms |
| 失败保护 | 自定义标题文件原字节不变，自动生成标题不变，没有生成title锁；bridge无child、generation0 |
| owned dataDir修回0700 | 实际 `/api/v1/environment` 200，6.80ms；相同标题、相同expectedTitle重试200，17.42ms；reload/detail读取新customTitle，generated title仍保留 |
| 正常跨进程争用 | 另一个owned helper真实持hub锁350ms，11次真实EEXIST后377.39ms返回200，title/auth锁均释放，新标题落盘，holder正常exit0 |
| 退出与清理 | host52519和holder52617均exit0、无signal；await host.close；maintained wrapper exit0；post-run确认owned根和isolator根已不存在，限定ps无此脚本host/holder残留 |

最终日志：`Completed native file mutex round19; 38 assertions; real HubAuth/HTTP/Node + normal title store controls; no worker/model/CLI`。本轮最终成功38仅属于这一次原生脚本，不与Bun收集器混计，也不累加历史失败中已执行的setup断言。

修权限后同稿 API 重试动态成功；正式Hub editor对500保留稿并释放busy的 `HubSessions.tsx:187–204` 仅本轮源码确认，既有第十八轮实际组件正常控制也已验证失败保稿/同稿重试。本轮未额外执行浏览器点击恢复。没有永久故障、聊天数据丢失或shell执行错误的证据。

## 级别、反证与修复边界

建议窄P2：触发需要既有且auth已初始化的Host，dataDir（hub的parent）对当前非root进程失去写权限，而hub子目录仍可读/遍历/可chmod700；属于明确限定的存储故障恢复情境；健康权限下及短正常争用均正常。虽然最终可恢复，单个请求却让同进程健康路由和timer停约30秒，使故障扩大至整个Host。不是无条件常态、不可恢复死锁、安全攻击或OOM结论；Linux/Windows、Node22/Electron和其他errno未动态验证，不能泛化；整盘EROFS或hub自身chmod失败可能在锁前立即拒绝，未测试且不归入本复现。故障期间只测合法titlePATCH和fresh /health；其他API的共享认证锁只有源码支持，权限修复后的environment200则是动态恢复控制。

正常争用的重试策略有明确用途，CODESHELL也要求同步锁内不能await。此次锁 holder在另一个进程，能正常计时释放；生产 title临界区本身也没有await，不能把本候选描述成同进程async-holder死锁。建议只对真正可重试争用/明确暂态错误执行退避，EACCES一类非争用错误立即带上下文失败；保留跨进程锁、stale策略、CAS、symlink检查和失败不写盘保护，不以“忽略锁错误后继续写”或删除认证检查修复。是否再把某些 Host锁等待改为异步应单独设计，不需要扩大此结论。

既有标题fresh目录EACCES控制在未建anchor时会更早拒绝；本轮真实Host还多出auth前置锁。这些早失败并不能反证上述已记录的认证锁阻塞，也不应将其误报为已实际走完title handler。正式授权/owner/title格式验证均保留；本次合法请求先停在auth锁。

去重：第十八轮Hub标题EACCES原始diagnostic是线索而未列正式finding，本轮补上真实Node与事件循环证据。与R71项目重命名拒写后乐观UI、R70自动保存pending丢失、R60删除tombstone、R65拒读空树不同：本项修复点是共享mutex非争用错误分类，影响是服务事件循环可用性；没有把这些UI恢复问题重复列入。与30秒RPC/摘要超时也独立，这里是原生同步锁预算，而非worker/configure人工gate。

## 证据、复跑与诊断保留

已冻结，允许主代理复制standalone验证，所有脚本以process.cwd()定位repo：

- `/tmp/codeshell-review-20261012-file-mutex-round19/file-mutex-host.mjs`
- `/tmp/codeshell-review-20261012-file-mutex-round19/native-host.log`
- `/tmp/codeshell-review-20261012-file-mutex-round19/native-observations.json`
- `/tmp/codeshell-review-20261012-file-mutex-round19/post-run-cleanup.json`（运行后仅检查owned路径，不增加38断言）

在有已构建dist的冻结repo cwd运行：

```sh
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-review-20261012-file-mutex-round19/file-mutex-host.mjs
```

该原生运行真实等待产品30秒，不能塞进默认30秒Bun collector后称通过。父进程owned hard deadline60秒；工具yield均不超过10秒。文件系统观察器只观察精确graceful-fs依赖实例的真实mkdirSync，委托真实实现并原样rethrow，不合成错误、不改retry/timeout/返回值。private root先realpath规范化以匹配proper-lockfile的canonical路径。

原始失败全部保留，不是成功复现：

1. `native-host.first-harness-failed.log`：未及时挂catch的请求在finally abort后产生unhandled AbortError，掩盖观察点超时。没有结果JSON；scoped ps事后确认无owned残留。已改夹具的即时catch/finally await settled和child disconnect清理。
2. `second-harness-failed.native-host.log` / `second-harness-failed.native-observations.json`：只观察title锁且路径不canonical，6秒等待收据超时；8个setup断言，Host最终exit0。
3. `third-harness-failed.native-host.log` / `third-harness-failed.native-observations.json`：canonical修正后仍只观察title锁，实际auth锁先失败，6秒等待收据超时；8个setup断言，Host最终exit0。
4. `fourth-harness-failed.native-host.log` / `fourth-harness-failed.native-observations.json`：已真实记录auth锁EACCES，但约30秒点fetch返回ECONNRESET；10个setup/边界断言，Host最终exit0。成因未独立定位，不将它写成第二个产品问题或据此声称通用HTTP状态。最终夹具每请求Connection: close后完整通过。

上游原始Bun诊断仍在 `/tmp/codeshell-review-20261012-hub-session-operations-round18/diagnostic-parent-EACCES-lock-timeout.log`，未覆盖/删除，也不累加为本轮执行数。

Completed — 原生最终1次成功 / 38 assertions；原生历史4次harness失败单列；本轮Bun测试0；不运行真实worker/模型/CLI；只写/tmp。

## 主代理后续双基线独立原生复跑（与作者单次分开）

主代理使用同一冻结便携脚本，在两个工作区各运行一次 maintained Node isolator；本代理只读核对两份最终JSON，没有再执行。两份都是38 assertions、failure=null、closedNormally=true，host/holder分别正常exit0、signal=null、无worker。独立审计 `/tmp/codeshell-review-20261012-file-mutex-round19/quality-audit.md` 新增执行0，支持单项窄P2。

| 主代理执行基线 | title PATCH500 | fresh /health200 | Host20ms timer gap | EACCES次数 | 修权限ENV / 同稿title | 正常争用 |
|---|---|---|---|---|---|---|
| 84740d56 | 30,026.84ms | 30,021.92ms | 30,034.15ms | 838 | 3.27 / 9.51ms、均200 | 403.81ms200，EEXIST13次 |
| a66f4ef2 | 30,035.69ms | 30,028.49ms | 30,044.58ms | 856 | 3.91 / 9.87ms、均200 | 389.61ms200，EEXIST12次 |

证据位于两个工作区各自 `docs/review-2026-10-12/validation/file-mutex-round19/` 的 `file-mutex-host.mjs` 与 `native-observations.json`，主代理管理各自日志。主代理每基线1次standalone/38 Node assertions独立列账，本作者latest1次/38也独立列账；不把这些数加进common Bun文件/测试/expect。主代理反馈common仍79 files / 236 tests，此附录不改该口径。

Completed — 作者最终成功1次/38 Node assertions；主代理后续两基线各1次/38另列；质量审计新增执行0；四份早期失败诊断保留。
