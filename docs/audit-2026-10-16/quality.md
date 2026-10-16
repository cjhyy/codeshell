# 独立质量复核

基线：`66ee7737a7d6203319834e601c84afe6757f801e`。范围为 [root.md](root.md) A01–A12、[desktop.md](desktop.md) D01–D03、[server-web-chat.md](server-web-chat.md) SWC-01–06，以及追加的 [core.md](core.md) C04。复核读取当前源码、已保存的最小复现和日志；本复核新增执行 **0**，没有运行测试、产品、原生工具、网络、权限或认证实验，没有读取用户数据，没有更改产品或 Git 状态。唯一写入为本文件。

结论：修订后的根因均可保留，现有 P2/P3 分级与限定影响基本相称。A11 只有静态可达证据；SWC-06 是旧条件候选的动态补证，不应计作全新根因。其余条目仍须按各自替身、局部 service 或 decoder 层级交付，不能汇总为平台端到端验证或仓库全面通过。

## 已发现并修订的证据问题

1. **A05 初稿使用不存在的终态 `error`。** `TerminalReason` 的实际枚举是 `model_error`，见 `packages/core/src/types.ts:604–620`。初稿测试经 `any` 注入非法值，原收据只能证明命令没有检查 reason，不能证明真实错误终态的样例。协调者已改成 `model_error` 和 `prior-round output`，重新保存 [当前复现](evidence/root-git.test.ts) 与 [当前日志](evidence/root-git.log)：4 pass / 13 expect / Completed。只读核对确认当前源码和收据一致。初稿保留为 `root-git-initial.*`，不得重复计数。
2. **A05 “半截输出”需要收窄。** `turn-loop.ts:1381–1383` 保存已完成模型轮次的 `finalText`；`:1194,1993` 可携该值返回 `model_error`；`server.ts:1851–1862`、`client.ts:166–172` 正常传回。该链支持“错误运行仍带此前轮次非空文本”，不能保证失败流本轮的半截 delta 出现在 `result.text`。当前报告已区分动态 command 替身与上述静态链。
3. **A12 初稿使用不存在的终态 `aborted`。** 协调者已换成 `aborted_streaming`，当前 [复现](evidence/root-json-output.test.ts) 与 [日志](evidence/root-json-output.log) 为 1 pass / 3 expect / Completed。初稿 `root-json-output-initial.*` 只作诊断保留。报告应使用合法枚举，仍保留“未运行真实子代理或完整 CLI”的边界。
4. **A10 Engine 输入不等于 CLI 的完整实际传参。** 当前测试直接传入 flag apiKey，但 `run.ts:118–122` 的 resolved 分支仅覆盖 provider/model/baseUrl，没有覆盖 options.apiKey。已修订测试注释和报告：model/baseUrl 被 seed 覆盖有动态证据；CLI apiKey 被忽略是独立的静态接线事实；provider 分支也未动态测试。没有真实请求或费用证据。
5. **SWC 三份收据属于会话转录摘录。** 初次核对时缺少同名 `.log`；分审后续只把原有 exec_command stdout 逐字保存为三个文件，没有重新执行。当前文件头明确标注 `TRANSCRIPT EXCERPT, NOT A RUNNER RAW FILE`，并保留 tool chunk、exit code、原命令和 Completed 输出；报告也已同步说明。它们支持对原会话观察的追溯，但不构成独立原始磁盘日志或 JUnit 审计链。
6. **SWC-03 有意 fallback 与耐久性保证须区分。** `delivery-queue.ts:385–390` 明确把 spooling 设计为 availability improvement；`packages/chat/README.md:333–336` 仍描述惰性媒体的内存队列。另一方面，`DeliveryQueueConfig` 的 spool 注释及现有 `delivery-queue.test.ts:210–220` 明确旨在修复已接受附件重启丢失，`:401–416` 只为超限保留 memory fallback。因此小附件 I/O 故障无告警降级、重启不能从本地队列恢复的事实成立；不能把所有 memory fallback 都认定违反已发布契约。报告宜承认当前策略，聚焦未向调用者暴露降级，reject 或可靠后备是修复建议。

## 逐项判断

| 条目 | 复核判断 | 证据与必须保留的边界 |
| --- | --- | --- |
| A01 / P2 | 保留 | 真实临时文件与生产 applier；成功 move 的新文件丢执行位，普通 update 对照保留。限定 POSIX 执行权限，未测试实际脚本启动。 |
| A02 / P2 | 保留 | 真实失败写入触发 rollback，Buffer → UTF-8 string → Buffer 导致字节变化；删除后重建也丢 mode。all-or-nothing 注释支持原子恢复预期；不应推断外部备份是否存在。 |
| A03 / P3 | 保留 | `.trim()` 与 `slice(3)` 的组合和临时 Git 收据一致；首行未暂存路径截首字符。影响是上下文路径，未证明命令按错路径写入。 |
| A04 / P3 | 保留 | 合法 subject 含 `|` 与裸分隔解析冲突；作者/日期错位均有断言。展示/提示准确性问题。 |
| A05 / P2 | 修订后保留 | 合法 `model_error` 替身 + 真实 slash command/Git；终态传输和非空旧正文由源码核对。未执行真实模型失败。 |
| A06 / P2 | 保留 | prompt 只读未暂存 diff，真实 commit 包含既有暂存修改；内容 sentinel 与 HEAD 断言对应。不能扩写为任何暂存边界都应由命令保留。 |
| A07 / P2 | 保留 | 实际 command/client/transport/server/manager，Engine 为配置记录替身；TUI 的 ChatSessionManager 接线已核对。证明错误引擎被修改，未证明真实工具越权执行。 |
| A08 / P2 | 保留 | config 响应确实省略 sessionStorageDir，command 默认路径与自定义真实 history 不一致；配置 getter 为替身。默认同 ID 旧历史的误恢复只属静态风险。 |
| A09 / P2 | 保留 | all 分支与 restoreAllToEarliest 都只用 snapshots；created-only 的真实 history 在单轮 undo 对照中可删除。生产 hook 的 prepareCreated/commitCreated 与 marker 机制相容。 |
| A10 / P2 | 修订后保留 | 真实 Engine 构造证据 + CLI 接线静态核验；不能把 provider/apiKey 的全部 CLI 路径都算成动态通过。 |
| A11 / P2 | 静态保留 | 当前分支提交后固定 push 本地 main，再在当前 HEAD 打 tag；前置条件没有集成关系验证，tag workflow 也没有 main ancestry gate。以本地 main 可成功推送、目标 tag 不存在为可达前提；未发布或推送。 |
| A12 / P3 | 修订后保留 | 生产 renderer 接收 child delta 后，空正文终态的 JSON fallback 采用 child 文本；TextRenderer 对照排除。run.ts:236,242 的调用链与 subagent-spawner.ts:98 的 agentId 标记静态对应。 |
| D01 / P2 | 保留 | 生产搜索 service + 真实 Git/自有磁盘；Unicode 与换行名称变为 Git 转义字面量，ASCII/非 Git 对照正常。未运行 Electron。 |
| D02 / P2 | 保留 | 生产服务全局 top30 后，复现按 Popover 相同 rootId 条件筛空；源码接线准确。不是真实渲染器执行收据。 |
| D03 / P2 | 保留 | 生产 JsonLineDecoder 的逐字节分片复现与 UTF-8 整行/ASCII/长度帧对照一致。只证明 decoder 数据完整性；没有 Chrome、socket、认证或 shutdown 动态实验。 |
| SWC-01 / P2 | 保留 | 实际 gateway/queue，自有持久目录及无网络 adapter；同渠道 ordinal 在重排后绑定错账号。首次 maxConcurrent=0 是保留 pending 的调度控制，未验证真实平台投递。 |
| SWC-02 / P2 | 保留 | dedupe/completed key 没有 adapterId，两个 handler 成功但只保存一条的 fixture 与源码一致。completed 分支由源码推导，不是另一个动态样例。 |
| SWC-03 / P2 | 保留 | 1 byte 合法附件的 spool I/O 错误被吞为 memory-only，重建 queue 无记录；真实 gateway resolve 的 ACK 影响属静态接线。精确影响应为“本地队列无法恢复”，未验证服务商 ACK/重投。 |
| SWC-04 / P2 | 保留 | 真实 MatrixAdapter，严格 fixture origin 的内存 fetch 模拟 sync echo，正确 botUserId 有正常对照。缺少 self ID 过滤的根因成立；没有真实平台/模型循环。 |
| SWC-05 / P2 | 保留 | JSON parse 之后非对象字段读取不在 try 内，null/42 可让整个调用 reject；相邻 reader 和 malformed JSON 对照支持隔离缺陷。未证明 Core writer 会生成该损坏。 |
| SWC-06 / P3 | 条件保留 | sort 的 localeCompare 与 cursor 的 `>` 次序不一致；fixture 用 utimes 强制相等目录 mtime。自然生产相等 mtime 未验证，不能消除条件标记或计为全新根因。 |
| C04 / P2 | 保留 | 真实 ToolExecutor/Write/history hook/FileHistory，自有 Host 与 workspace 两个 cwd；备份错指 Host 文件，FileHistory undo 成功后 workspace 仍是修改后正文。Edit 为同一 hook 与 ctx.cwd 定位的静态核验；未执行 TUI `/undo` 命令或额外制造无关文件覆盖。 |

根目录当前最终专项收据合计 6 文件 / 12 tests / 45 expect，Desktop 指定范围为 2 文件 / 6 tests / 54 expect；均在已读日志内为 0 fail、0 skipped、Completed。这些是既有缺陷复现收据，不是本复核新增执行，也不代表修复通过。SWC 三份会话转录摘录为 4/2/3 pass、9/19/10 expect，合计 9 tests / 38 expect，均含 Completed；本复核核对了摘录与 fixture 的项目/数量对应，但不能替代未留存的原始 raw/JUnit。C04 的 [round3 日志](evidence/core-providers-policy-round3.log) 包含该测试的 5 个断言及零网络 attempt 清理行，整份为 6 pass / 25 expect / 0 fail/skip / Completed；前五项不属于此次质量复核范围，不能把它们当作本复核已完成的独立质量结论。

## 位置精度

以下为当前源码更直接的定位，建议主报告更新；这是报告定位修订，不改变根因：

| 条目 | 建议源码行 |
| --- | --- |
| A01 | `applier.ts:143–163,297–306` |
| A02 | `applier.ts:112–122,278–289`；初稿 `124–129` 未包含 UTF-8 读取 |
| A05 | `git-commands.ts:84–91`；标题可同步明确 `model_error` |
| A06 | `git-commands.ts:70–90`；`git/utils.ts:85–98,118–122` |
| A07 | `protocol/server.ts:3540–3557`，包括实际 setter |
| A08 | `utility-commands.ts:58–64`；协议 `server.ts:3178–3207` |
| A09 | `utility-commands.ts:73–101`；`file-history.ts:363–367` |
| A10 | `run.ts:118–122,158–171,193–203`；`engine.ts:934–948` |
| SWC-05 | `sessions-service.ts:337–345` |
| SWC-06 | `sessions-service.ts:304,312–316` |
| C04 | `file-history-hook.ts:25–30`；`file-history.ts:138–147,241–245`；`write.ts:40–41`、`edit.ts:61–62`。原报告 `file-history.ts:148` 是 hash 计算，路径 resolve 在 `:140`。 |

旧审查材料仅做有限查重交叉核对；本复核没有重新对全部历史条目做完整去重。报告中明确列出的平台中止限制继续有效，本复核没有继续、改道或重试被中止的工作。全仓 build/typecheck、真实平台、付费模型、原生 UI 和完整生产调用验证均不在此次质量复核范围。
