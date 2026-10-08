# Runtime 跨 Session 成本账本交付

状态：已实施，2026-10-09；AgentModule 生命周期 Phase C 独立交付，Phase D 请求边界证据另行实施。设计见 [runtime-cross-session-cost-ledger-design.md](runtime-cross-session-cost-ledger-design.md)。当前版本号保持不变。

## 行为

Core 新增 UsageLedger，EngineRuntime/独立 Engine 通过异步 owner 绑定 Session、run、用途和子任务祖先的 accounting identity。相同 SID 的不同 Runtime、同一 Runtime 的不同会话存储目录分别归属；恢复会话必须匹配 namespace、SID、随机 accountingSessionId 与不可逆 storage scope pin。复制到另一存储目录、fork、无 pin 的旧引用均不能导入原账目。父会话可读取子任务叶子 receipt，每条实际请求只累计一次；现有 child aggregate 继续服务 Goal/token 预算。

内置 OpenAI/Anthropic 的 SDK 每次调用配置的 underlying fetch 建立独立 receipt，包括透明 SDK retry；任意自定义 fetch 内部的网络重试不可观测。流式 usage 在消费者异常前记录，已报告 usage 不因解析失败丢失；fallback 独立记账。只调用 recordUsage 的兼容 provider 可以保留已报告费用，但不能证明所有失败尝试均被覆盖。billingEnabled:false 不继承父请求记账上下文。

main、aux summary、tool summary、goal judge、title、context package、manual compact、subagent 各自保留用途。晚到 title 和源会话的 compact/context package 不随前台会话切换改归属。新 external billed callback 要求稳定 source/requestId，重复提交幂等且只更新一次预算；owner/模型/usage 冲突拒绝，两个进程并发首次发布也不会互相覆盖。

持久 receipt 使用单文件原子发布/更新，文件名为哈希，权限为 0600，目录为 0700；内容不含凭据、原始 endpoint、prompt 或响应正文。账本写失败保留当前内存记录并标记覆盖不足，不能触发额外付费重试。Session 只存 reference/摘要；恢复/replay 不重新灌入累计费用，显式 SDK legacy costStore 仍可通过兼容子字段恢复。

价格按完整 provider/model identity 与当时价格快照估算。缺 usage、未知 provider/模型、pending 或中断请求保持 unknown，可信零 usage 才能显示已知零估算。缓存价格中的启发式部分标为 estimated。历史旧 counters 不自动转成已知账单，覆盖不足标志随会话引用恢复。

## 消费者与权限

- `Engine.getUsageSummary` 和公开 `UsageLedger.summary` 提供有界 runtime/session/store 查询，并验证 scope、SID、includeChildren、日期、cursor 和 limit。
- `agent/query type:usage` 默认只允许 owned Session，聚合需要 Host 显式 `allowUsageAggregation:true`，带多租户 identity resolver 的协议 Host 无法开启该聚合捷径。
- Desktop 在现有运行记录页显示跨会话估算与选中 Session（含 children）覆盖；Main 冷读持久账本，preload 仅返回安全摘要。没有增加侧栏或导航。
- TUI `/cost`、footer 使用真实 Session/Runtime 摘要，取消 primary-model 猜测的每轮费用；恢复时按 SID 查询，切换立即隐藏旧摘要，generation fence 阻止晚到查询覆盖新会话/较新结果。旧 Host/错误响应清空费用，不保留另一会话金额。退出费用说明写 stderr，保证 JSON stdout 可解析，只有未知请求也可显示覆盖说明。
- stdio/TCP、TUI Host 显式配置持久 storage；独立 SDK 默认内存，只有明确 sessionStorageDir/ledger 配置才持久化。
- 独立 Web 当前没有现成运行/用量页面，本次提供协议能力，未新增 Web GUI。

## 验证

- 核心受影响回归：1392 pass / 0 fail，235 个文件，5201 assertions。覆盖 ledger、所有 LLM、Engine、protocol、Session、CostTracker 与 Goal stop hooks。
- 账本/真实 Engine/Host 冷读定向：22 pass / 0 fail。包括复制同 SID state 到另一 storage、restart/fork/replay、生产 SubAgentSpawner、晚到 title、external 重发、SDK 真正 fetch retry、流式失败后 fallback、缺 usage/零 usage/未知价格、账本故障不额外付费、两个 Bun 进程并发发布。
- 本地隔离 guard 自测：非白名单本地服务收到 0 次请求；允许服务收到 7 次。fetch 固定 exact HTTP 127.0.0.1:port 并 `redirect:error`；http/https request/get（含 ESM named import）同样校验；移除代理环境；stdio child/grandchild 都验证独立 HOME、preload guard 和父子 PID 收据。HOME hash 不匹配在加载 Core 前拒绝。
- 发布包检查：9 tarballs、47 typed entries、45 runtime imports，packed Node owner HTTP 生命周期通过。
- `bun run typecheck`：完整构建、12 workspaces 类型与 Web SPA 通过；Desktop main/preload/renderer/mobile/Chrome extension 构建通过。
- Desktop Main 冷读、运行记录交互、TUI terminal render/命令/JSON renderer：34 pass / 0 fail，195 assertions。组合后的核心定向 32 pass / 0 fail。
- Lint：0 errors、105 个既有 warnings；engine-bypass 与 workflow test paths guard 通过。
- 已编译纯 Node SDK、真实 stdio worker run→关闭→restart 冷读→replay（无新请求且 runId 相同）、TUI CLI 持久账本全部通过。实际 worker/TUI PID 的独立 HOME hash/origin/父 PID guard 收据均核验；本地服务收到 4 次请求，worker 2 receipt，TUI 2 receipt（含退出时尚未到服务的 pending title，费用 unknown）。
- TUI Session 水合与已有外部 turn/TodoWrite/terminal footer：9 pass / 0 fail，55 assertions，覆盖跨 SID 晚到、同 SID 新旧查询竞争和失败后清空。
- CI typecheck job 增加 guard 自检和三种已编译消费者 smoke，确保最终合入 head 持续验证。
- 真实 macOS Electron 33.4.11 GUI：`bun run --cwd packages/desktop test:e2e:runtime-cost-history` 从现有设置 → 活动记录 → 运行记录进入，使用已编译公开 `UsageLedger` / `SessionManager` receipt 与 transcript writer 写入私有两 Session、六条请求。生产 Main IPC 冷读及页面同时显示 `$0.011100` 已知估价、三个未知成本、两次缺失 usage 和五个 provider/model 分组；选中 Session 的归属、Completed / Failed / Cancelled、刷新与 renderer reload 后不重复均通过。重复 external identity 在热账本与冷启动后都不新增 receipt，落盘仍为六条。
- GUI 隔离证据：父进程和实际 Electron Main 在首次加载 Core 前安装 exact-origin HTTP guard，再拒绝包括该哨兵 origin 在内的全部 fetch / http / https request / get；每个实际进程执行七个否定探针，核验 PID、PPID 与 HOME / USERPROFILE / CODE_SHELL_HOME / CODE_SHELL_TEST_HOME 的不可逆 hash。此次自然未创建 worker，证据明确记录 `no worker created`；既有 bootstrap 仍为将来实际创建的 worker 注入 guard 并在收据核验前阻止其 stdin。环境移除 provider 凭据与代理，保留真实 OS keyring 配置，未使用 mock keychain / basic password store、真实模型、provider 或账号。截图及 JSON 收据保存在本次私有 fixture 的 `home/evidence` 下，并实际检查已知/未知、失败与取消页面截图。
- 本次 GUI 专项另行复核：package release gate 九个 tarballs / 47 typed entries、workspace / Desktop 构建、Desktop main / renderer / mobile 类型检查通过；Main usage-history 与运行记录交互的受隔离单元测试 9 pass / 0 fail、78 assertions；三个变更脚本 lint / format 通过，隔离 guard 自检、engine-bypass 和 workflow test paths guard 通过。

SDK / stdio / TUI 消费 smoke 使用合成任务和本地 HTTP fixture；在 Core 加载前安装网络 guard，向 worker 发送 agent/run 前校验实际 PID 的 origin/HOME 启动收据。GUI fixture 不启动 HTTP 服务或模型 run，只通过公开 Core writer 合成请求证据，再走真实 Main IPC 与现有 UI；成功保留私有截图和收据供检查，仅清理自己的 Electron user-data/cache，失败保留私有 fixture 诊断。自动 Electron 操作与截图检查不代表真实 provider 账单验收，也不代表 macOS Phase D 签名 / OS 级请求隔离验收。

## 明确限制

- 金额是价格表估算，不是 provider 发票；unknown 不会被计为免费。
- GUI 中取消 run 使用真实 transcript 的 `aborted_streaming` 状态，相关无 usage 请求按现有 receipt 契约记为 failed / unknown，不新增虚构的 cancelled receipt outcome。Session 的历史缺口使该 Session 标记 partial；store 只汇总实际读到的持久 receipt，因此同一次查询的 store 仍可以完整。两种覆盖语义分别验收。
- 单次查询最多读取 10000 receipt，目录扫描最多 50000 entries；分页 cursor 和 partial 标记公开可用。Desktop 当前显示这一有界结果并明确覆盖不足，没有无界全盘扫描或跨页总额保证。
- 账本当前用每请求文件存储，内存活跃记录随 Runtime 生命周期增长；未实现压缩/长期保留策略。
- `pending` 的异步 title 在 CLI 立即退出时可能缺 usage，保留 unknown；不为获得费用而追加请求。
- 外部仅提供 aggregate 的旧 recordBilledUsage 无法证明物理请求 identity，只继续预算兼容。第三方 provider 未使用包装 fetch 时，失败/内部重试覆盖仍有限。
- storage scope pin 随明确存储目录绑定；搬移目录不会自动合并历史归属。无 pin 的旧引用保持覆盖不足，不能静默跨目录恢复。
