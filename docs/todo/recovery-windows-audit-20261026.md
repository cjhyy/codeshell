# 2026-10-26 审计前三节修复交付

状态：原 CC 第二轮验收 **PASS**；I1/I2 修复与 M1–M3 已接受，本轮源码已按授权集成本地 main；未远端合并或发行。任务分支
`codex/core/recovery-windows-audit-20261026`，基线 `2661eb04d`（当前 origin/main）。
发行审计基线为 v0.9.46 / `c7f108ee4`；不能把本轮修复算进已发行包。
本轮实施范围已获用户合并授权并完成本地代码集成；最终组合验证与远端边界见文末。本轮不发版、不改 workflow、不做生产操作；secondary 两仓只读。
未触碰真实 Keychain、secrets、旧 HOME、生产迁移或付费实验。

## 历史恢复实现与方案差异

根因已核实：`engine/run-stream.ts` 与 Desktop `external-runtime-state.ts`
从完整 transcript 取首个 journal 前的末 ID，旧恢复函数却只扫描 1 MiB/4096 条。
新实现保持两个写端签名，普通 journal 分页和 `outputJournalCutover` 上限不变。

- 旧基线使用独立 32 MiB、262144 事件预算，单记录内容仍至多 1 MiB；
  共享 64 KiB 分块 reader，跨块 UTF-8 使用 fatal 解码，首条必须为 session_meta，
  验证 id/type/data，坏数据失败关闭。
- 首次创建且有 base ID 时，锁外扫描并保留打开的普通非链接 transcript fd；
  锁内首次写 header 前重验目录、transcript 路径 dev/ino、size≥offset。
  捕获失败只省略新字段，保留 base ID，兼容旧 run 行为。既有 journal 不扫描。
  原有 incarnation、owner、pin、binding 和 watermark 机制保留。
- 新 header 的 `legacyBaseEndOffset` / `legacyBaseSha256` 必须成对且有 base ID。
  偏移为 1..32 MiB 的安全整数，摘要为 64 位小写十六进制。读端从真实 journal
  readHeader 取可信字段并核对请求 ID；有证明时精读前缀并核对末 ID/偏移/摘要，
  坏 offset 不降级。旧 header 在 min(size,maxBytes) 内流式寻找，返回前重验目录与路径。
- 相对 CC 的修正：摘要直接覆盖原始 Buffer 字节，保留 BOM、CRLF 和 LF，
  不以 text+LF 规范化。捕获复用同一扫描器；没有另造索引或持久迁移。
- 联查额外发现并修复 Desktop renderer 的分页校验：IPC 附带的大 legacyBaseItems
  先折叠，再从传给共享分页校验器的对象中剥离。共享 web 分页断言不放宽。
  Hub 原本已分开传 transcript/page，补了 HTTP/WS 和 chatFromOutputJournal 回归。
- Mobile 显式传 maxBytes=1 MiB，八并发不变，wire 仍≤1 MiB；客户端仍保留
  **1 MiB + 4096 字节**的 legacyBase 断言。4096 是字节余量，不能写成事件数。
  大旧基线的 mobile 分页协议仍未实现。

所有失败返回 complete:false/events:[]；回归验证原 transcript hash 不变、
同长度原地修改被摘要拒绝，基线后的巨大行不影响恢复。真实样本只复用其
1,963,815 字节规模构造合成夹具，未读取或改写用户旧会话。

## Windows 本地脚本与未关闭项

### A：NSIS 初始身份竞态未改代码

已证实 spawn 卸载后同步 pwsh 初次快照可能晚于目标退出。现有合同继续拒绝
用迟到 exit 0 补初始 PID/PPID/birth；本轮没有放松该 gate。
stdin holder 不是简单替换进程的窄修复：当前正常收据、crash evidence 和 collector
均把 operation.child 当执行根，目标句柄证明需要独立契约和 Windows 验证。
本轮按允许的停止条件保留 A，不宣称已修历史 Windows 故障。

后续最小可审查方案只托管卸载：固定 ps1 holder 先建立自身 birth custody，
收到带 nonce 的 START gate 后用 UseShellExecute=false/ArgumentList 启动目标，
保留 Process 句柄并报告 target PID/start/可信 PPID（source=holder-handle）。
不能在阻塞 WaitForExit() 期间声称可以处理 stdin；应以短片段 WaitForExit 加
一个未完成的 ReadLineAsync 协调 STOP/EOF。目标 stdout 与控制协议分离。
正常验收须同时证明 target exit 0、holder exit 0 和 watchdog cleaned；超时必须
先按持有句柄终止并等待目标，再清 holder。初始 holder 身份失败只关闭 gate/EOF，
不能据 PID 发信号或接受退出。需更新严格收据读者并覆盖快退、错 nonce、错身份、
提前 EOF、stdout 污染、holder 异常、timeout 与清理顺序后，才能在 Windows 验收。

### B：周期阻塞治理与诊断已实现，Windows 原生未验

默认周期快照改为异步 execFile，同步/异步复用固定命令、环境、超时、解析与
错误脱敏；仅周期 tick 使用异步。in-flight 防重入，state/generation 丢弃 stop/cleanup
后的成功或拒绝；清理不等待 pending promise。自定义同步 snapshot adapter 保留
原调用路径，避免拆散 NSIS/AppImage same-query sidecar；不能声称这些路径也改成异步。初始身份、逐信号即时复核、
confirmStopped、bindObservedDescendant 仍同步，不改变 owned 身份授权。

snapshotTiming getter 提供 count/totalMs/maxMs/recent（最多32）/maxTickGapMs 的副本。
源码 harness 将其注册到失败诊断 sidecar，在 error/settled 捕获；首轮遗漏的实际打包路径已在第二轮接入，见下文。getter 抛错不影响原错或清理。
settlement/completionEvidence 不加字段，严格收据读者无需 schema 迁移。
这解决已证实的周期同步阻塞性质，不证明它就是 CI40 20 秒首窗超时的根因。
本机 macOS，仅完成本地合同与真实本机进程夹具，Windows 真机验收未完成。

### C：保留原生证据与门禁

`0xC0000005` 无 dump 不定位。仍需准确 installer/app/ASAR 与源码摘要、OS/架构、
UTC 时序、目标 PID/PPID/birth、异常模块/地址及对应 dump 与符号证据，才能判断原因。
本轮不改 WER 注册表或 CI。Windows 签名证书、Apple 账号/Developer ID/公证、
0.9.44→0.9.46 升级回滚、CI40 后续 Windows 操作及 Linux services 独立重跑仍未关闭；
没有删除工件或触发远端。runtime-agent-task.test.ts 的已知偶发未找到根因，本轮未改 timeout。

## 发布、部署与待决策事实

- [v0.9.46](https://github.com/cjhyy/codeshell/releases/tag/v0.9.46) 于
  2026-10-22 09:51:40 UTC 正式发布，tag=`c7f108ee4`。
  [release run 39755931851](https://github.com/cjhyy/codeshell/actions/runs/39755931851)
  三平台打包/发布成功；[smoke job 119747953811](https://github.com/cjhyy/codeshell/actions/runs/39755931851/job/119747953811)
  明确报告 10 tarballs / 49 typed entries，47 runtime imports 通过；registry 只读确认
  十包 0.9.46 存在，未提供 gitHead。release.yml 的 nine tarballs 名称仅留待修。
  当前 origin/main `2661eb04d` 的[普通 CI](https://github.com/cjhyy/codeshell/actions/runs/39771531242)
  十二项成功；不能用这些事实关闭上面的原生失败。10-19/20 当时不建议发版的记录不重写。
- runtime PR #195、#211–#214 均已合入且是 v0.9.46 祖先。只保留 E05 真 reload、
  E08 真账号与既有能力边界；24h 调度、原生 MCP、扩权、逐请求成本没有新增实现。
- Panel 仓只读 HEAD=`090300c`（本地跟踪 origin/main=`7850d68`），manifest：
  Design 0.22.0、Job 5.1.0、Quant 0.47.0、Download 0.24.1、Video 0.8.0、Starter 0.1.1。
  前三无同版本本地 tag；后三当前包目录相对同版本 tag 各有 5/6/6 个文件差异。
  [Download 0.24.1](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/video-download-v0.24.1)
  与 [Video 0.8.0](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/video-studio-v0.8.0)
  已正式发行。未下载校验所有正式 ZIP，目录差异不冒充 ZIP 字节比对。
  旧五草稿仍存在，六 Panel 的版本及包摘要须用户重新冻结，本轮不选择或发布。
- Services 本地主线 `0245869` 含 `da73ce5`。Link 10-16 生产文档记录
  c892b91b→195e16a→da73ce5 / schema3，后次切换 health200/NRestarts0；
  详见[部署追认](../remote-link-host.md#2026-10-26-后续部署追认)。
  Account 已有部署及真实 GitHub 登录/consent/native callback 保存证据：
  [10-12 部署记录](https://github.com/cjhyy/codeshell-services/blob/0245869/docs/github-login-link-target-deployment-2026-10-12.md)、
  [10-13 Account 部署](https://github.com/cjhyy/codeshell-services/blob/0245869/docs/account-profile-target-deployment-2026-10-13.md)。
  严格单仓读取、OS Keychain 与旧 owner 显式迁移未关闭；未连接生产做新验证。
- P1.4 既有部署已执行，恢复演练目标仍待用户决定。未取得推送网关部署证据，
  不把 Account/Link 外推为整个薄云端已上线。其余八家 Link 的 10-09 暂停不解冻，
  不切换旧 owner；dream/portable memory 归属与审批、runtime 新能力、优化 lab 预算继续待拍板。

## 首轮本地测试证据（历史记录）

所有单测经 guarded runner 创建隔离 HOME 并清除继承凭据。日志在本机 `/tmp/recovery-*.log`，
不包含用户真实历史。没有触发远端测试或 CI。

| 检查                                                             | 结果                                                  | 日志                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| 初轮恢复 TDD 红灯（实现前，9 tests）                             | 2 pass / 7 fail                                       | `/tmp/recovery-legacy-red.log`         |
| HEAD 基线对照（只在临时目录重定位 imports，基线源取自 git show） | 4 pass / 12 fail；1,963,815 字节和 >4096 事件分别失败 | `/tmp/recovery-baseline-red.log`       |
| 当前新增恢复用例（16 tests）                                     | 16 pass / 0 fail                                      | `/tmp/recovery-legacy-final.log`       |
| 完整 core 定向 shard（含新用例及四组原守卫）                     | 90 pass / 0 fail                                      | `/tmp/recovery-core-reviewed.log`      |
| Desktop/Hub/Web/Mobile 九文件联查                                | 134 pass / 0 fail                                     | `/tmp/recovery-consumers-reviewed.log` |
| Windows B 初轮 TDD 红灯                                          | 44 pass / 4 fail                                      | `/tmp/recovery-windows-red.log`        |
| Node 脚本与严格收据消费者合同（15 文件）                         | 220 pass / 0 fail                                     | `/tmp/recovery-node-final.log`         |
| packaged-main-preload（Bun 测试）                                | 10 pass / 0 fail                                      | `/tmp/recovery-preload.log`            |
| bun run build                                                    | exit 0                                                | `/tmp/recovery-build.log`              |
| bun run typecheck（含重新 build）                                | exit 0，14 workspace 均通过                           | `/tmp/recovery-typecheck-final.log`    |
| bun run lint                                                     | exit 0，0 errors / 99 warnings                        | `/tmp/recovery-lint-final.log`         |

首轮四组测试共 454 pass / 0 fail / 0 skipped，原 CC 独立复跑确认；其首轮未重跑 build/typecheck。初轮 Desktop 大基线冷恢复测试
揭示 IPC envelope 进入分页大小校验的问题，修复后通过；新 Hub 折叠 fixture 初次
漏传 Session coverage 证明，补齐真实 SessionOutputCoverageStore 读取后通过，未放宽生产身份检查。
扩大 Node 检查时误纳入使用 bun:test 的 packaged-main-preload.test.mjs，出现 bun: URL
加载错误（220 pass / 1 loading failure）；确认 runner 类型后原测试用 guarded Bun 10/0 通过。
这些中途失败均保留在本机日志，不冒充既有产品缺陷。

实际最终测试命令：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/session/output-journal.test.ts ./packages/core/src/session/output-journal-identity-migration.test.ts ./packages/core/src/session/output-journal-persistent-identity.test.ts ./packages/core/src/session/output-journal-storage.test.ts ./packages/core/src/session/output-journal-legacy-base.test.ts

node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/session-transcript-ipc.test.ts ./packages/desktop/src/main/external-runtime-state.test.ts ./packages/desktop/src/main/mobile-remote/output-recovery.test.ts ./packages/desktop/src/main/output-journal-recovery.test.ts ./packages/desktop/src/renderer/app/useTranscriptBuckets.test.tsx ./packages/server/src/serve/headless-server.test.ts ./packages/web/src/lib/outputJournalRecovery.test.ts ./packages/web/src/hooks/mobileOutputClient.test.ts ./packages/web/app/chat.test.ts

node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/electron-test-process-snapshot.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/scripts/electron-harness.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/e2e-startup-operation-cycles.test.mjs packages/desktop/scripts/process-custody.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/panel-operation-diagnostics.test.mjs packages/desktop/scripts/macos-dmg-custody.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/composer-operation-diagnostics.test.mjs

node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/scripts/packaged-main-preload.test.mjs

bun run build
bun run typecheck
bun run lint
```

首轮曾对 22 个改动文件执行 Prettier 并通过 diff check；其历史 Markdown 纯排版改动已在第二轮撤回。本轮仅对改动源文件做 Prettier，不强制全 Markdown 格式。
package release clean-build 本轮未运行，没有与 dist 消费者并发。

## 文件清单

实现文件：

- `packages/core/src/session/output-journal.ts`
- `packages/desktop/src/main/mobile-remote/output-recovery.ts`
- `packages/desktop/src/renderer/app/outputJournalRecovery.ts`
- `packages/desktop/scripts/electron-test-process-snapshot.mjs`
- `packages/desktop/scripts/electron-test-watchdog.mjs`
- `packages/desktop/scripts/electron-harness.mjs`
- `packages/desktop/scripts/e2e-ui-packaged.mjs`
- `packages/desktop/scripts/packaged-pet-fixture.mjs`
- `packages/desktop/scripts/packaged-startup-observation.mjs`

测试文件：

- `packages/core/src/session/output-journal-legacy-base.test.ts`（本任务新增）
- `packages/desktop/src/main/external-runtime-state.test.ts`
- `packages/desktop/src/main/mobile-remote/output-recovery.test.ts`
- `packages/desktop/src/main/output-journal-recovery.test.ts`（经真实 session-transcript IPC）
- `packages/server/src/serve/headless-server.test.ts`
- `packages/web/app/chat.test.ts`
- `packages/desktop/scripts/electron-test-process-snapshot.test.mjs`
- `packages/desktop/scripts/electron-test-watchdog.test.mjs`
- `packages/desktop/scripts/windows-source-harness.test.mjs`
- `packages/desktop/scripts/packaged-startup-observation.test.mjs`
- `packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs`

文档：`TODO.md`、`docs/cloud-accounts.md`、`docs/remote-link-host.md`、
`docs/todo/external-runtime-parity-audit-20261021.md`、
`docs/todo/link-server-oauth-architecture.md`、
`docs/todo/release-real-operations-2026-10-16.md`、本文（本任务新增）。
原 CI/Release 历史记录仅增加追认，纯 Prettier 排版已撤回；不改当时通过/失败或批准结论。

## 首轮 CC BLOCKED 后的第二轮整改

CC 已独立复跑首轮 454/0，并核实发布文档事实；仍因 I1 追加竞态回退、I2 实际打包路径
缺 timing 而 BLOCKED。本轮只整改该范围及 M1–M3，不把本地转绿视为 CC 验收。

### I1：追加期间恢复与首次捕获

撤去两处以 size/mtimeNs/ctimeNs 全量 stamp 不变作为成功条件的检查。现在对打开 fd
复核 dev/ino，最后 size 必须 ≥ 冻结 base.endOffset，保留目录和 named regular file 复核。
元数据改变只触发一次已冻结前缀的原始 SHA-256 重读校验，不能单凭尾部追加判失败；
重读止于 base.endOffset，最多 32 MiB、64 KiB 缓冲，捕获仍在锁外。
这个有界二次校验是相对简单 size 检查的补充：同长度改写和改写后追加也不能冒充合法追加。
新 header 还须符合已存 prefix SHA；旧 header 保留 lines 截断检测、扫描摘要及身份检查。

新增正式用例覆盖新旧 header 读取期间追加（1024 字节/2.4 MB）、返回末 ID 仍为 base、
首次捕获期间追加后写出正确 offset/hash、截断到 offset 以下、同长度合法 JSON 改写、
改写后追加及捕获时三类损坏。已有路径/目录替换、静态摘要篡改等守卫保留。
首轮追加测试红灯为 23 pass / 6 fail；I1 首次定向转绿 29/0，补齐捕获损坏矩阵后 core
五文件为 105 pass / 0 fail（31 个新增恢复用例）。

### I2：CI40 实际 packaged 首窗路径

接线为 e2e-ui-packaged.recordFirstError → fixture.recordLaunchFailure →
createPackagedLaunchDiagnostics.failed；captureMain 创建同一 child 的原 watchdog 后绑定
sidecar.watchdog(child, monitor)，verifyUnchanged 在原 completed 结算之后调用 settled。
每 launch 的旁证字段为 snapshotTiming: { atFailure, settled }，分别保存首次错误冻结值与
结算累计值；两个值各为 null 或 count/totalMs/maxMs/recent/maxTickGapMs 的显式投影。
recent 最多 32，数字有限非负、count 为安全整数，数据字段 getter/非法元数据拒绝，
输入输出均复制；不展开任意对象或序列化异常。读取 watchdog 的公开 getter本身允许，
其抛错只令 recordingFailed=true/timing=null，不替换原错、不打断原清理。

全仓联查未发现 packagedLaunchDiagnostics 的独立严格字段白名单 reader；已有 crash
collector/NSIS acceptance 只消费其他身份字段，不把新旁证用于授权。不迁移 completion、
settlement、startupObservation 或进程身份 schema，不放松 pin。原 watchdog 的 in-flight /
generation 不变。AppImage/NSIS 自定义 snapshot 保持同步，真实 Windows 首窗根因仍未证实。

纯 Node 合同执行实际 driver 的 first-error 函数，首窗 timeout 冻结 timing，随后保留
同一原始错误并完成 cleanup；另覆盖 throwing getter、32 条边界、副本、非法数值/字段
getter、同 PID 不同 child 拒绝。I2 红灯 16 pass / 4 fail，初步两文件回归 40/0。

### M1–M3

- M1：保留 legacyBaseThroughEventId 非空字符串且 ≤512 的 header 校验。旧 base API
  本来就拒绝 >512 请求 ID，nanoid 正常历史不受影响；现在普通 journal reader 也会拒绝
  这种原本无法恢复的异常 header。没有改写或迁移异常原文件。
- M2：两份历史 Markdown 已从 HEAD 原文重建并仅插入新增追认：release 文档 +35 行、
  external-runtime audit +8 行，历史表格与空行重排全部撤回。没有全 Markdown 格式门禁。
- M3：TODO 已同步原 CC 第二轮 PASS，保留正式包/原生验收，不依赖临时
  worktree 位置，不编造 PR；本轮修复尚未发行。

### 第二轮完整复跑

按 core 五文件 → build → 消费者九文件 → Node 十五文件及新增 packaged 合同串行执行，
最后 typecheck、lint、仅源文件 Prettier、diff check。测试结果：

| 第二轮检查 | 结果 | 日志 |
| --- | --- | --- |
| I1 首轮红灯 | 23 pass / 6 fail，均为合法追加场景 | `/tmp/recovery-r2-i1-red.log` |
| I1 首次定向绿灯 | 29 pass / 0 fail | `/tmp/recovery-r2-i1-green.log` |
| I2 首轮红灯 | 16 pass / 4 fail，缺实际 packaged timing API | `/tmp/recovery-r2-i2-red.log` |
| I2 初步两文件绿灯 | 40 pass / 0 fail | `/tmp/recovery-r2-i2-green.log` |
| Core 五文件（最终，含31个新恢复测试） | 105 pass / 0 fail / 0 skipped | `/tmp/recovery-r2-core.log` |
| bun run build | exit 0 | `/tmp/recovery-r2-build.log` |
| 消费者九文件 | 134 pass / 0 fail / 0 skipped | `/tmp/recovery-r2-consumers.log` |
| 原 Node 十五文件 + packaged startup/signal/AppImage 三文件 | 252 pass / 0 fail / 0 skipped | `/tmp/recovery-r2-node.log` |
| packaged Bun 九文件（含原 preload 十例） | 63 pass / 0 fail / 0 skipped | `/tmp/recovery-r2-packaged-bun.log` |

四组最终单测合计 **554 pass / 0 fail / 0 skipped**。新增合同还直接执行真实 fixture 的
watchdog 绑定片段及等待 completed→settled 的片段，验证 pending 时不读取 timing，
结算后采集且原 settlement 对象不变。首窗 timeout 合同执行真实 driver first-error 函数。
完整 `bun run typecheck` 已重跑并 exit 0（含 build 与全部14个 workspace），日志
`/tmp/recovery-r2-typecheck.log`；随后 `bun run lint` exit 0，0 errors / 99 warnings，
日志 `/tmp/recovery-r2-lint.log`。仅20个改动源文件的 `bunx prettier --check` exit 0，
日志 `/tmp/recovery-r2-prettier.log`；`git diff --check` 通过。没有用历史 Markdown
全文件格式检查迫使重排。剥除新增追认后，两份历史 Markdown 与 HEAD 原文逐字相同。

未关闭清单仍按本文 Windows A/C、mobile 大旧基线、正式包冷重启与第三节待决策项保留。


Core、build、消费者使用上方相同命令重跑，日志改为本节 r2 路径。Node 的实际最终命令：

```sh
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/electron-test-process-snapshot.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/scripts/electron-harness.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/e2e-startup-operation-cycles.test.mjs packages/desktop/scripts/process-custody.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/panel-operation-diagnostics.test.mjs packages/desktop/scripts/macos-dmg-custody.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/composer-operation-diagnostics.test.mjs packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/packaged-signal-diagnostics.test.mjs packages/desktop/scripts/packaged-appimage-runtime.test.mjs

node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/scripts/packaged-pet-shutdown.test.mjs ./packages/desktop/scripts/packaged-main-preload.test.mjs ./packages/desktop/scripts/packaged-chromium-guard.test.mjs ./packages/desktop/scripts/packaged-app-layout.test.mjs ./packages/desktop/scripts/packaged-linux-environment.test.mjs ./packages/desktop/scripts/packaged-process-exits.test.mjs ./packages/desktop/scripts/packaged-pet-bootstrap.test.mjs ./packages/desktop/scripts/packaged-app-integrity.test.mjs ./packages/desktop/scripts/run-packaged-ui-acceptance.test.mjs
```


### 第二轮交付状态与 diff

原 CC 第二轮已 PASS（session `3e34f601-e67b-4de4-a43f-eba9cf0283f3`）：独立
Core105 + 消费者134 + Node252 + packagedBun63 = 554/0/0，另有追加/篡改独立4/0。
build/typecheck/lint 采纳本文上一轮日志，CC 未独立重跑。I1/I2 关闭，M1–M3 接受。
该结论仅覆盖本轮实施范围，不表示审计前三节全部清零；未改workflow、未连接生产或启动外部CLI写手。
本轮核心整改涉及 output-journal.ts/其新测试；实际打包整改涉及 e2e-ui-packaged、
packaged-pet-fixture、packaged-startup-observation 及两个 Node 合同文件。
M1 保留并说明，M2/M3 已在文档收尾。未关闭项目、原失败记录与本地范围限制不变。

第二轮提交前的历史 `git diff --stat`（当时25个已跟踪文件，两个新增文件不在该命令统计内；
任务提交 `50e93ac71` 实际包含全部27个路径）：

```text
 TODO.md                                            |  26 ++-
 docs/cloud-accounts.md                             |   6 +-
 docs/remote-link-host.md                           |  16 ++
 .../todo/external-runtime-parity-audit-20261021.md |   8 +
 docs/todo/link-server-oauth-architecture.md        |   6 +-
 docs/todo/release-real-operations-2026-10-16.md    |  35 ++++
 packages/core/src/session/output-journal.ts        | 201 ++++++++++++++++++---
 packages/desktop/scripts/e2e-ui-packaged.mjs       |   1 +
 packages/desktop/scripts/electron-harness.mjs      |  18 +-
 .../scripts/electron-test-process-snapshot.mjs     |  86 ++++++---
 .../electron-test-process-snapshot.test.mjs        |  58 ++++++
 .../desktop/scripts/electron-test-watchdog.mjs     | 100 ++++++++--
 .../scripts/electron-test-watchdog.test.mjs        | 104 +++++++++++
 packages/desktop/scripts/packaged-pet-fixture.mjs  |   6 +
 .../scripts/packaged-startup-observation.mjs       |  65 ++++++-
 .../scripts/packaged-startup-observation.test.mjs  | 179 ++++++++++++++++++
 .../windows-packaged-main-crash-evidence.test.mjs  |   1 +
 .../scripts/windows-source-harness.test.mjs        |  23 +++
 .../src/main/external-runtime-state.test.ts        |  27 ++-
 .../src/main/mobile-remote/output-recovery.test.ts |  16 ++
 .../src/main/mobile-remote/output-recovery.ts      |   7 +-
 .../src/main/output-journal-recovery.test.ts       |  10 +-
 .../src/renderer/app/outputJournalRecovery.ts      |   9 +-
 packages/server/src/serve/headless-server.test.ts  |  57 ++++++
 packages/web/app/chat.test.ts                      |  51 ++++++
 25 files changed, 1028 insertions(+), 88 deletions(-)
```


## 用户授权后的集成记录

用户授权合并通过验收的本轮实施范围，不发版；不将本次合并称为审计前三节全部清零。
原 CC 二轮 PASS session 为 `3e34f601-e67b-4de4-a43f-eba9cf0283f3`，独立554/0/0及
追加/篡改独立4/0保留其已审输入。以下为吸收本地主线后的最终组合验证。

- 任务提交：`50e93ac7171dc8af7727c3362b966d4ae5d16299`，只包含本任务27个路径。
- 正常 merge 节点：`0920af53d0c8ba8f6e15a83b1a8d5865b9fff444`，吸收本地主线
  `29a96c1de28fbdb754fca39e5254cd1c218edcd8`，没有冲突、没有改写任何已有提交。
  两个独立提交 `54afce1fe`（credentials）与 `29a96c1de`（cc-room）原样保留为祖先。
  两提交路径与任务27路径无交集；CC已审任务路径在组合树中逐文件不变。
- 主仓 main 在干净且仍为预期 `29a96c1de` 时执行 `git merge --ff-only`，已快进至
  上述代码集成节点。本文收尾只更新交付状态与证据，不改变已验证源码。
- 重新 fetch 两次，origin/main 均为 `2661eb04da4266c532464bc8bd9223aeba0d9caa`。
  GitHub main protected=false，普通CI仅在main push/PR等既定事件运行，原生验收另行触发。
  两个独立本地提交均不在 origin/main；正常推送组合头会把它们一起发布，因此按用户
  边界仅完成本地合并，**未推送任何分支、未创建PR、未远端合并**。未触发CI、发版或生产部署。

### 最终组合验证

对代码节点 `0920af53d` 串行完成依赖同步、原四组554项、两个独立提交相关回归、
build/typecheck/lint/源文件格式与diff检查；没有与其他dist读写检查并发。
`bun install --frozen-lockfile` exit 0，锁文件保持合入版本，没有额外依赖改动。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| Core 五文件 | 105 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-core.log` |
| bun run build | exit 0 | `/tmp/recovery-merge-build.log` |
| 消费者九文件 | 134 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-consumers.log` |
| Node 十八文件 | 252 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-node.log` |
| packaged Bun 九文件 | 63 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-packaged-bun.log` |
| Cookie 域/持久 jar/Server 三文件 | 26 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-cookie.log` |
| Desktop browser-host（独立 shard） | 7 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-browser-host.log` |
| Desktop credentials-login（独立 shard） | 25 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-credentials-login.log` |
| linked-session/worktree/RoomManager 五文件 | 86 pass / 0 fail / 0 skipped | `/tmp/recovery-merge-cc-room.log` |
| bun run typecheck（含完整build和14 workspace） | exit 0 | `/tmp/recovery-merge-typecheck.log` |
| bun run lint | exit 0，0 errors / 99 warnings | `/tmp/recovery-merge-lint.log` |
| 20个任务源文件 Prettier | exit 0 | `/tmp/recovery-merge-prettier.log` |
| git diff --check origin/main..HEAD | exit 0 | `/tmp/recovery-merge-diff-check.log` |

八个 guarded 单测命令合计 **698 pass / 0 fail / 0 skipped**：原四组554 + 新增144。
这些是源码及隔离夹具组合验证，不关闭 Windows 原生/正式包、mobile 大旧基线或业务决策。
最终命令（全部顺序执行；普通单测经隔离 HOME runner）：

```sh
bun install --frozen-lockfile
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/session/output-journal.test.ts ./packages/core/src/session/output-journal-identity-migration.test.ts ./packages/core/src/session/output-journal-persistent-identity.test.ts ./packages/core/src/session/output-journal-storage.test.ts ./packages/core/src/session/output-journal-legacy-base.test.ts
bun run build
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/session-transcript-ipc.test.ts ./packages/desktop/src/main/external-runtime-state.test.ts ./packages/desktop/src/main/mobile-remote/output-recovery.test.ts ./packages/desktop/src/main/output-journal-recovery.test.ts ./packages/desktop/src/renderer/app/useTranscriptBuckets.test.tsx ./packages/server/src/serve/headless-server.test.ts ./packages/web/src/lib/outputJournalRecovery.test.ts ./packages/web/src/hooks/mobileOutputClient.test.ts ./packages/web/app/chat.test.ts
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/electron-test-process-snapshot.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/scripts/electron-harness.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/e2e-startup-operation-cycles.test.mjs packages/desktop/scripts/process-custody.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/panel-operation-diagnostics.test.mjs packages/desktop/scripts/macos-dmg-custody.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/composer-operation-diagnostics.test.mjs packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/packaged-signal-diagnostics.test.mjs packages/desktop/scripts/packaged-appimage-runtime.test.mjs
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/scripts/packaged-pet-shutdown.test.mjs ./packages/desktop/scripts/packaged-main-preload.test.mjs ./packages/desktop/scripts/packaged-chromium-guard.test.mjs ./packages/desktop/scripts/packaged-app-layout.test.mjs ./packages/desktop/scripts/packaged-linux-environment.test.mjs ./packages/desktop/scripts/packaged-process-exits.test.mjs ./packages/desktop/scripts/packaged-pet-bootstrap.test.mjs ./packages/desktop/scripts/packaged-app-integrity.test.mjs ./packages/desktop/scripts/run-packaged-ui-acceptance.test.mjs
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/credentials/cookie-domain.test.ts ./packages/core/src/credentials/cookie-jar.test.ts ./packages/server/src/panels/task-cookies.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/browser-host/index.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/credentials-login/index.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/src/main/renderer-project-path.test.ts ./packages/desktop/src/main/cc-room/linked-session-resolver.test.ts ./packages/desktop/src/main/cc-room/linked-session-ipc.test.ts ./packages/desktop/src/main/cc-room/transcript-subscriptions.test.ts ./packages/server/src/mobile-remote/room-manager.test.ts
bun run typecheck
bun run lint
bunx prettier --check packages/core/src/session/output-journal.ts packages/core/src/session/output-journal-legacy-base.test.ts packages/desktop/scripts/e2e-ui-packaged.mjs packages/desktop/scripts/electron-harness.mjs packages/desktop/scripts/electron-test-process-snapshot.mjs packages/desktop/scripts/electron-test-process-snapshot.test.mjs packages/desktop/scripts/electron-test-watchdog.mjs packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/packaged-pet-fixture.mjs packages/desktop/scripts/packaged-startup-observation.mjs packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/src/main/external-runtime-state.test.ts packages/desktop/src/main/mobile-remote/output-recovery.test.ts packages/desktop/src/main/mobile-remote/output-recovery.ts packages/desktop/src/main/output-journal-recovery.test.ts packages/desktop/src/renderer/app/outputJournalRecovery.ts packages/server/src/serve/headless-server.test.ts packages/web/app/chat.test.ts
git diff --check origin/main..HEAD
```

### 保留与后续清理

主仓与任务 worktree 的源码/文档提交均保持 clean。工作目录有外部 resume 进程仍在使用，
因此暂留 `codeshell/.worktrees/recovery-windows-audit-20261026` 与
`codex/core/recovery-windows-audit-20261026`；由主代理确认无人使用后清理。
交付记录在主仓 `docs/todo/recovery-windows-audit-20261026.md`，不依赖临时 worktree。

NSIS A holder契约、`0xC0000005` dump定位、Windows真机、签名/公证/证书、跨版升级回滚、
Linux services重跑、mobile大旧基线与真包冷重启仍未关闭。六Panel重新冻结、恢复演练目标、
其他八家Link暂停、旧owner迁移、dream/portable memory归属审批、runtime新能力与lab预算
继续保持原待决策边界；本次未修改这些生产行为。

## 批次1来源交付历史：NSIS 卸载 holder（2026-10-26）

当前补记：来源已获原 CC 二轮 PASS 196/0，已转入[组合候选](audit-integration-20261027.md)，
待最终组合验收；以下未提交、BLOCKED 与待复验文字仅保存各来源阶段历史。

本节追加候选实施证据，不改写上轮已经合入及原 CC PASS 的历史事实。用户授权继续原审计
前三节剩余项，流程固定为 **CC 方案 → Codex 隔离 TDD → 原 CC 验收**；本次只做第一批
NSIS 卸载 holder，后续批次、mobile 与业务决策未推进。交付给原 CC session
`3e34f601-e67b-4de4-a43f-eba9cf0283f3`，**未提交，未验收通过**。

- 指定 worktree：`codeshell/.worktrees/nsis-uninstall-holder-20261026`。
- 分支：`codex/desktop/nsis-uninstall-holder-20261026`；HEAD/本地 main 基线均为
  `55dce40442926c83995d1c76c78e47f10d71c625`，包含上轮恢复、Windows async watchdog 与 timing。
  本地记录的 `origin/main` 为旧 `2661eb04da4266c532464bc8bd9223aeba0d9caa`；没有 fetch、回退或切换基线。
- 只编辑该 worktree 七个路径；未触碰主仓或其他活跃任务，未提交/push/合并、修改 workflow、
  触发 CI/生产、调用外部 CLI 写手或安装系统 pwsh。进程合同均用假进程、内存快照/日志与计时器；
  Node 测试经现有隔离 HOME runner，不运行真实卸载器。

### 实现与固定方案的关系

新增 `windows-nsis-uninstall-holder.ps1`，只接受 Nonce/Target/InstallDir，目标参数固定为
`/S /currentuser _?=dir`。ready JSON flush 后同步等待严格 START nonce；初始 EOF 输出
aborted/退出4，坏指令输出 protocol/退出2。目标以 `UseShellExecute=false`、ArgumentList、
CreateNoWindow 和三路重定向启动，立即关闭 stdin；两条输出经异步 CopyToAsync(Stream.Null)
丢弃，异常由固定 C# async helper 捕获观察，不使用线程池上的 PowerShell scriptblock。
控制通道只输出有限 JSON，错误只有固定枚举，不包含目标路径或原异常内容。

Start 成功后保留同一 Process/SafeHandle，检查 handle 有效，读取 Id 与 StartTime UTC 七位
`o`，ppid 为 holder `$PID`，再输出 target。运行期共用一个普通 StreamReader 和 ReadLineAsync，
配合 WaitForExit(200)；STOP/EOF 无条件尝试同一 Process 的 Kill(true)，最多 WaitForExit(5000)，
输出 stopped/退出3。读取异常与真正 EOF 区分；已启动后的异常先清目标，再输出枚举 error。
正常输出目标 exit code，holder 自身退出0；非0目标仍由 Node wrapper 判失败。Process/reader Dispose。

新增 `windows-nsis-uninstall-holder.mjs`：固定同 process-snapshot 的 PowerShell 7 路径，
verifyExecutable 使用同 crash-evidence 的 plain-file/realpath 检查方式。通过 spawn 包装添加
stdin pipe 和 stdout parser，通过 watch 包装在原 watchdog 成功证明 holder pid/ppid/birth 后
才 START。初始失败先锁定原错，只 EOF、无 START/信号；即使 EOF 同步抛出第二个错误，也保留原错。
原 watchdog API/初始快照失败行为与 `runNsisOwnedProcess` 函数体均未修改。

协议总 stdout 上限16 KiB、单行1 KiB、事件最多6；严格检查类型、唯一字面键、nonce、顺序和
pid/ppid/完整有效 birth。正常仅接受 ready→target→exit0。运行后协议错误先 STOP，最多等15秒
stopped，再交原 monitor 清理 holder；原始错误不会被清理失败覆盖。协议已失败后仅允许有界回收
匹配 nonce/顺序的 stopped 或 target exit 作为清理旁证，不能升绿。timeoutMs−20秒开始 STOP，
保留原 watchdog deadline；timeoutMs≤20秒、非整数或超 Node timer 上限在 IO/spawn 前拒绝。
holder 先死、start-failed 或其他缺少可信目标退出证明的路径标记 `unprovenProcess`。

`operation.holder` 保存 schemaVersion/script path+SHA256/nonce/有限 events/target（source 为
holder-handle）/targetExit/stopped。watchdog settlement 若观察过同 target PID，其 ppid 和七位
birth 按后述 C1 规则交叉核对：ppid 精确相同，WMI 第七位0，并与句柄时间的微秒桶相等。
新 `assertHolderUninstallTarget` 先执行未修改的 assertNormalNsisProcess，
再重放协议、复核零退出、无 stopped、固定脚本路径及当前字节 SHA 与 fixtureSHA256 的关联；
不能仅附加任意 holder 对象便通过。driver 的 fixtureSHA256 增加新 mjs/ps1，copied 卸载器仍保留
运行前后同一 SHA/size 校验。

**六个 controller roots 的 label 统计不变**，第六个仍叫 uninstall；其 operation.child 与
operation.command 现在分别指 holder 身份与固定 pwsh，不能再当作卸载器身份。真实卸载器在
holder.target 中由句柄证明，不新增第七个 controller root。checkpoint kind/label 均未增加。
全仓检索真正严格 reader/collector：通用严格 reader 为 assertNormalNsisProcess，UI reader
只消费 UI Main；crash collector 与调用点均限定 install，replace roles 也不消费 uninstall。
未发现另一个硬编码六 roots 的严格汇总 reader。workflow 已上传 receipt 与 uninstall.stdout.log，
测试追加在已有 workflow 清单的两个 test 文件内，无 workflow 改动。

逐字比较 HEAD 已确认：runNsisOwnedProcess、assertNormalNsisProcess、卸载 absent(installation)
的 try/catch、final-integrity 至文件末尾，以及 nsis-initial-identity-observation.test.mjs 全文
保持相同，包含原221/286提取合同的固定15自由名。

### .NET 快退语义证明与原生边界

已核实微软 [StartTime 文档](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.starttime?view=net-10.0)
及 [.NET 8 固定源码](https://github.com/dotnet/runtime/blob/v8.0.0/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs#L534-L717)：
Windows StartWithCreateProcess 成功返回前保存 CreateProcess 的原 hProcess 和 PID，StartTime 的
GetProcessTimes 使用该句柄且 throwIfExited=false；退出后持有句柄仍能读取创建时间。只读审查还
对照 .NET 6/9/10 的同一路径。实现没有按 PID reopen、WMI 补身份、迟到 exit0 补身份或身份重试。
这证明成功 Start 后0ms快退的 API 语义可成立，**不是本机已执行 Windows/PowerShell 的证据**。

两个必要实现细化：一是不能直接使用 Console.In.ReadLineAsync，微软
[SyncTextReader 源码](https://github.com/dotnet/runtime/blob/v8.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.cs#L82-L95)
显示其实际同步 ReadLine；因此首次 START 与后续 STOP 共用 OpenStandardInput 上的普通 reader。
二是 C# helper 只负责异步读取/丢弃并观察错误，不增加目标命令、args 或执行权限。

保守边界：.NET Start 内部在 native 创建后、Process 关联原句柄前还构造重定向流；Start 抛错
不能绝对证明 OS 从未创建目标。该窄窗口不能安全按 PID/WMI 补救；START 后没有可信 exit/stopped
时一律 unproven，绝不报告清理成功。Kill(true)+WaitForExit 只证明目标退出，不能代替原 watchdog
对已观察 descendants 的 settlement，也不证明所有 OS descendants 都被观察到。

### 红绿与最终检查

新增21个顶层测试，覆盖 H1–H10/H12、运行中各类坏消息的 STOP、真实 watchdog+假快退快照、
15秒 STOP 无确认上限、初始任意原错及 EOF 同步错误竞态；H11 原测试全文保留并复跑。
H2 是0ms假目标合同，H12 是静态 guard，均不能记为原生 Windows 已通过。

| 检查 | 确切结果 | 日志 |
| --- | --- | --- |
| 首次两文件尝试（依赖未装） | 12 pass / 5 fail；含 smoke import 缺 electron-builder，不作功能红灯 | `/tmp/nsis-holder-b1-red.log` |
| bun install --frozen-lockfile | exit 0，2099 packages，锁文件不变 | `/tmp/nsis-holder-b1-install.log` |
| 两文件基线红灯回放（当时新增16项） | 30 pass / 16 fail；HEAD源码+无holder模块，finally恢复候选实现 | `/tmp/nsis-holder-b1-baseline-red.log` |
| 首次两文件功能绿灯 | 46 pass / 0 fail | `/tmp/nsis-holder-b1-green-first.log` |
| EOF 同步错误竞态红灯 | 50 pass / 1 fail，第二个 protocol 错误覆盖初始身份错误 | `/tmp/nsis-holder-b1-eof-red.log` |
| 竞态修复后两文件 | 51 pass / 0 fail / 0 skipped | `/tmp/nsis-holder-b1-green-extended.log` |
| 指定十一文件最终隔离 Node | **191 pass / 0 fail / 0 skipped** | `/tmp/nsis-holder-b1-node.log` |
| check-workflow-test-paths | exit 0，97 literal paths 全存在 | `/tmp/nsis-holder-b1-workflow-paths.log` |
| bun run lint | exit 0，0 errors / 99 warnings | `/tmp/nsis-holder-b1-lint.log` |
| 五个改动 mjs 的 Prettier check | exit 0；无 PS1 parser，不将静态 PS1 记为格式/原生执行通过 | `/tmp/nsis-holder-b1-prettier.log` |
| git diff --check | exit 0 | `/tmp/nsis-holder-b1-diff-check.log` |

红绿两文件使用以下命令（基线回放临时恢复 HEAD 的 driver/acceptance 并移除两新模块，内存保留
实现且 try/finally 恢复，未重置工作树或改动其他任务；EOF 红灯直接运行当时实现）：

```sh
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs
```

最终实际命令（测试11个路径已核实存在）：

```sh
bun install --frozen-lockfile
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/windows-nsis-checkpoint-diagnostics.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/windows-nsis-desktop-observation.test.mjs packages/desktop/scripts/nsis-safe-per-user-install-mode.test.mjs packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/packaged-signal-diagnostics.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs
node scripts/check-workflow-test-paths.mjs
bun run lint
bunx prettier --check packages/desktop/scripts/smoke-windows-nsis-install.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/windows-nsis-uninstall-holder.mjs
git diff --check
```

### 原生 Windows 关闭条件

当前只是 macOS 上源码、纯 Node 与静态守卫候选。原 CC 必须验收本批后才可推进下一批；Windows
实际关闭仍需在原获准的 fresh exclusive github-hosted/windows-2022/x64 边界内验证固定 pwsh 版本、
真实0ms目标的 retained-handle PID/ppid/七位 birth 与零退出、正常 NSIS 卸载/剩余路径检查、
START 前 EOF/坏 nonce 不启动目标、运行后 STOP/EOF/坏指令清理、stdout/stderr 洪泛不阻塞、
超时 stopped/owned settlement、holder 先死或 Start 异常绝不伪造退出证明，并留 receipt/logs 与
对应 fixture SHA。需独立核对已观察 target 的 PID/PPID 和 WMI→句柄的定向微秒投影，保留完整
句柄100ns birth；跨微秒或 WMI 第七位非0须拒绝。原 watchdog 同源身份比较仍须完全一致。
本批没有触发上述原生执行；`0xC0000005` 定位、其他平台/后续批次及上文未关闭项仍保留。

### 第一批 CC BLOCKED 后的 C1 整改交接（待原 CC 复验）

原 CC 独立复跑第一批191/0，但复现 C1 并判 BLOCKED：holder 的 GetProcessTimes birth 有100ns
七位精度，WMI CreationDate 只有微秒且第七位0。旧 wrapper/acceptance 全等比较将合法的
handle `…7654321Z` 与 WMI `…7654320Z` 拒绝，旧 H9 还把这一截断误写成应失败的测试。
本节修正该候选规则，以上候选说明及原生关闭条件已同步；上轮已合入历史事实、CC191/0及
本批 BLOCKED 状态保留，当前依然是**未提交、未合入、待复验候选**。

本次只改五个已有候选路径，没有新增文件或依赖：

- `windows-nsis-uninstall-holder.mjs`：新增共享纯 helper `wmiRowMatchesNsisHolderTarget(row, target)`，
  替换卸载结算后的 observed-target 比较并移除一般 `same`。helper 参数方向固定为 WMI row→
  holder handle target：pid/ppid 必须是相同的正整数；WMI birth 末位必须0；两边通过现有
  windowsBirthToFileTime 验证合法完整 UTC 时间后，以 BigInt 比较
  `rowFiletime === handleFiletime / 10n * 10n`。只对句柄值计算微秒桶，不同时截断两边，
  不使用邻近 tick 容差、四舍五入或毫秒精度。
- `windows-nsis-acceptance.mjs`：同 target PID 的 settlement row 使用同一 helper。复用原有
  acceptance→holder→crash-parser 依赖链，没有增加循环依赖。
- `smoke-windows-nsis-install.test.mjs`：H9 改为正确截断通过；增加异微秒/非0末位/ppid拒绝、
  helper 方向及非法时间矩阵、真实 watchdog+假进程周期观察目标的完整成功合同。
- `windows-nsis-acceptance.test.mjs`：同样覆盖 handle 最后位0–9、前后微秒、非0 WMI 第七位
  （即使等于句柄）、拒绝 round-up/毫秒降精度、跨秒/跨日、pid/ppid类型和非法日历/形状。
  验证断言前后 receipt 完全不变。
- 本文：精确记录整改及红绿证据，不重排历史 Markdown。

handle 的七位 birth 仍是唯一 target 身份来源，协议/receipt 中的值没有被截断或替换。WMI row
保留原观察值，只在卸载结算交叉核对中使用此投影；没有据此增加任何信号授权。holder root
仍由同一 WMI 源严格比较。PS1、driver（含整个 runner、指定 catch 与 final-integrity）、
原 assertNormalNsisProcess、H11 initial-identity 测试、全局 watchdog/process-custody/snapshot
及 crash 精确事件关联均逐字未改。没有读取 CC 的临时 repro，正式测试自行复现等价场景。

周期合同使用真实 watchElectronTestProcess 和 parseWindowsProcessSnapshot，初始仅看到 holder，
START 后保持目标运行并调用原1秒轮询，实际采纳同 pid/ppid、birth末0的 target row。随后目标
exit0、holder close0，原 watchdog 正常结算，完整 wrapper 与 acceptance 均通过；settlement
仍保留 WMI `…7654320Z`，holder.target 仍保留 `…7654321Z`，没有信号、unproven 标记或残留计时器。
全部进程/快照/计时器及 runner 日志写入适配器为夹具，没有真实 spawn/pwsh/卸载器执行。

先修改测试，保持旧比较运行红灯，再实现 helper 与两处接线。相对第一批191基组新增5个顶层测试
（矩阵子场景在各顶层测试内循环），并修正 H9 与 acceptance 原错误期望；最终为196项。

| C1 检查 | 确切结果 | 日志 |
| --- | --- | --- |
| 两文件 TDD 红灯 | 49 pass / 7 fail / 0 skipped；合法截断被拒、伪 WMI 被接受及 helper 尚未实现 | `/tmp/nsis-holder-c1-red.log` |
| 两文件绿灯 | 56 pass / 0 fail / 0 skipped | `/tmp/nsis-holder-c1-green.log` |
| 原十一文件最终隔离回归 | **196 pass / 0 fail / 0 skipped** | `/tmp/nsis-holder-c1-node.log` |
| workflow test paths | exit 0，97 literal paths 全存在 | `/tmp/nsis-holder-c1-workflow-paths.log` |
| bun run lint | exit 0，0 errors / 99 warnings | `/tmp/nsis-holder-c1-lint.log` |
| 候选五个 mjs 的源 Prettier | exit 0 | `/tmp/nsis-holder-c1-prettier.log` |
| git diff --check | exit 0 | `/tmp/nsis-holder-c1-diff-check.log` |

两文件红绿命令及最终完整命令如下；依赖沿用第一批安装结果，本轮没有 install：

```sh
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/windows-nsis-checkpoint-diagnostics.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/windows-nsis-desktop-observation.test.mjs packages/desktop/scripts/nsis-safe-per-user-install-mode.test.mjs packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/packaged-signal-diagnostics.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs
node scripts/check-workflow-test-paths.mjs
bun run lint
bunx prettier --check packages/desktop/scripts/smoke-windows-nsis-install.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/windows-nsis-uninstall-holder.mjs
git diff --check
```

**仍无 pwsh/原生 Windows 执行证据**。M1（StartTime 本地时间转 UTC 的 DST 风险）仍待原生
针对场景核实，本次未改 PS1、未宣称关闭或推广结论；M2（Add-Type async helper 的原生运行）
也保持未验。C1 的 fake 周期只验证微秒投影与现有 watchdog 的组合合同，不替代 M1/M2、真实
0ms句柄、NSIS 卸载、STOP/EOF/洪泛或其他原生关闭条件。工作仍限定原指定 worktree/分支及
`55dce4044` 基线；未提交/push/合并/触发 CI，未推进 mobile 或其他批次，供原 CC session
`3e34f601-e67b-4de4-a43f-eba9cf0283f3` 复验。

## 2026-10-27 批 1 当前组合状态

上文批 1 BLOCKED、C1 整改及待复验文字保留来源历史。用户交接确认原 CC 二轮已 PASS：
**196 pass / 0 fail**。A 代码与两个新 holder 文件逐字节转入[2026-10-27 组合候选](audit-integration-20261027.md)，
原 runner、normal assertion、卸载 catch、final-integrity 和 H11 保持不变。
本轮去重组合回归与候选提交见该记录；待原 CC 最终组合验收，未合 main、未推送、
未发布。Windows 真原生、M1/M2、真实卸载及首窗/dump 的未完成边界保持开放。
