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
- TUI `/cost`、footer 使用真实 Session/Runtime 摘要，取消 primary-model 猜测的每轮费用；退出费用说明写 stderr，保证 JSON stdout 可解析，只有未知请求也可显示覆盖说明。
- stdio/TCP、TUI Host 显式配置持久 storage；独立 SDK 默认内存，只有明确 sessionStorageDir/ledger 配置才持久化。
- 独立 Web 当前没有现成运行/用量页面，本次提供协议能力，未新增 Web GUI。

## 验证

- 核心受影响回归：1392 pass / 0 fail，235 个文件，5201 assertions。覆盖 ledger、所有 LLM、Engine、protocol、Session、CostTracker 与 Goal stop hooks。
- 账本/真实 Engine/Host 冷读定向：22 pass / 0 fail。包括复制同 SID state 到另一 storage、restart/fork/replay、生产 SubAgentSpawner、晚到 title、external 重发、SDK 真正 fetch retry、流式失败后 fallback、缺 usage/零 usage/未知价格、账本故障不额外付费、两个 Bun 进程并发发布。
- 本地隔离 guard 自测：非白名单本地服务收到 0 次请求；允许服务收到 7 次。fetch 固定 exact HTTP 127.0.0.1:port 并 `redirect:error`；http/https request/get（含 ESM named import）同样校验；移除代理环境；stdio child/grandchild 都验证独立 HOME、preload guard 和父子 PID 收据。HOME hash 不匹配在加载 Core 前拒绝。
- 最终发布包、工作区类型、Desktop/TUI UI 回归与已编译 Node SDK/stdio/TUI 消费 smoke 的结果在 PR 验证记录中补充。

消费 smoke 使用合成任务和本地 HTTP fixture；在 Core 加载前安装网络 guard，向 worker 发送 agent/run 前校验实际 PID 的 origin/HOME 启动收据。失败时保留私有 fixture 以便诊断，成功才清理。尚未执行完整 Electron GUI 人工操作；React 运行记录页交互、TUI 实际 terminal render、Main 冷读和真实 stdio worker 是独立的自动验证证据。

## 明确限制

- 金额是价格表估算，不是 provider 发票；unknown 不会被计为免费。
- 单次查询最多读取 10000 receipt，目录扫描最多 50000 entries；分页 cursor 和 partial 标记公开可用。Desktop 当前显示这一有界结果并明确覆盖不足，没有无界全盘扫描或跨页总额保证。
- 账本当前用每请求文件存储，内存活跃记录随 Runtime 生命周期增长；未实现压缩/长期保留策略。
- `pending` 的异步 title 在 CLI 立即退出时可能缺 usage，保留 unknown；不为获得费用而追加请求。
- 外部仅提供 aggregate 的旧 recordBilledUsage 无法证明物理请求 identity，只继续预算兼容。第三方 provider 未使用包装 fetch 时，失败/内部重试覆盖仍有限。
- storage scope pin 随明确存储目录绑定；搬移目录不会自动合并历史归属。无 pin 的旧引用保持覆盖不足，不能静默跨目录恢复。
