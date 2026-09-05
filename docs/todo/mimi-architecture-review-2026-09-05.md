# Mimi 架构复核与演进设计

状态：设计提案，尚未实施。基线：`f4a32b9b`，2026-09-05。本文仅新增设计材料，不修改运行配置、源码、会话或历史日志。

配套：[交互架构图](mimi-architecture-2026-09-05/mimi.architecture.html) · [结构源](mimi-architecture-2026-09-05/mimi.architecture.json) · [日志统计](mimi-architecture-2026-09-05/log-evidence.json)。图描述建议形态，节点内标出沿用与增强；已绑定会话直达 Work Session 的现有旁路用说明保留，避免图中跨线遮挡。

## 1. 修复是否成功

**回复终止修复有运行证据，也通过当前回归；上下文成本治理仍不完整。不能用旧的 956 万 tokens 判定该修复失败。**

需要分清三个口径：

- `s-mtg157x2-1acd78a5` 是执行任务的 Work Session，曾用于生成 Archify 架构图，随后用于调查 Mimi。它不是 Mimi 管理会话。
- `pet-fd77a637-c033-4fc3-a6eb-b968b1cd9ef3` 才是 Mimi 管理会话。
- `engine.done.tokens` 是该次运行累计用量；每轮输入会重复计入已有历史。它既不是同时占用的上下文，也不能直接当作未命中缓存的收费 tokens。计费需进一步区分输入、输出、缓存读写及辅助请求。

### 证据时间线（UTC+8）

| 时间与来源 | 观察 | 能证明什么 |
| --- | --- | --- |
| 9/2 15:18:51，Mimi transcript 第 1601 行 | `DelegateWork.objective` 写“新建独立工作线程”，同时传入已有 `session_id` | 自然语言目标与结构化路由发生冲突；宿主实际接收的是复用决策 |
| 9/2 15:19:59，Work transcript 第 581 行 | Mimi 排障被追加到此前 Archify 会话 | 新目标进入旧历史；隔离 git worktree 没有隔离模型上下文 |
| 9/2 15:20:18，engine 日志第 3632 行 | Work 第一次请求输入已经 181,338 tokens | 尚未深入调查，输入就已很大 |
| 9/2 15:36:12，engine 日志第 4675 行 | Work 41 轮，累计 9,557,449 tokens，`aborted_streaming` | 这是被取消的一次旧运行，不能用于评价后来修复的效果 |
| 9/2，Mimi engine 日志汇总 | 124 个流式请求，输入 90,616–107,841；重复 GatewayReply 被拒 75 次 | Mimi 自身当时也有长历史和错误重试问题 |
| 9/3，Mimi 日志汇总 | Session / Workspace 不匹配 22 次 | 回复终止补丁没有覆盖所有工具失败循环 |
| 9/4 17:08:51，engine 日志第 10091–10094 行 | GatewayReply 成功后出现 `turn.reply_committed_stop`；1 轮结束，输入 18,109 | 有明确的运行时成功证据 |
| 9/4 17:18:31–42，第 10123、10135–10136 行 | Sessions 参数失败一次，之后 GatewayReply 正常终止；2 轮结束，输入约 27k | 终止机制有效，工具参数契约仍值得改进 |
| 9/5 当前保留 engine 日志 | 未发现该 Mimi 会话流式请求 | 不能声称已验证 9/5 新流量或全部安装进程 |

9/4 后段输入从此前 110k 以上降到 18k–27k，是改善信号。但模型、工具集合、历史消息数同时变化，不能把降幅全部归功于某个压缩补丁，也不能据此推算固定节省比例。

合并提交 `659bf81d`、补充重复回复终止 `31c0de66` 和 Workspace 不匹配提示修复 `69558358` 都在当前代码历史中。本次复跑四个测试文件：**47 pass / 0 fail / 208 assertions**，覆盖真实 Pet+Engine 回复终止、steer 替换、同批重复回复、拒绝语义、Workspace 不匹配和分段控制。测试证明这些契约，不等于整条微信收发链路已做线上验收。

## 2. 当前设计中应保留的部分

1. **管理与执行已经分开。** `packages/pet` 只拥有管理 profile、结构化工具和领域状态机；Work Session 执行文件、浏览器和代码操作；Core 通过通用扩展接口工作。不能把 Pet 分支重新塞入 Core。
2. **已经存在持久任务账本和回执。** `PetLongTaskCoordinator`、host action claim/complete、report receipts、work memory、follow-up service 不应被另一套任务系统替代。
3. **消息接纳与完成已部分分离。** `PetWorkDelegationHost` 等待启动受理，不等待整个任务结束；已绑定 IM 会话有 `SessionConversationBridge` 可直接 run/steer/排队，无需每条消息让 Mimi 再做路由。
4. **上下文已有基础治理。** Pet runtime world 上限 32,768 字符，任务清单有条目上限，MCP 关闭、不可调用的技能目录不注入；存在带消息锚点的分段归档、手动 `/clear`。
5. **回复已由宿主掌握真实状态。** GatewayReply 登记草稿并触发终止边界，宿主做最终执行；steer 可替换尚未发送的草稿。登记成功不等于已发送。

## 3. 仍存在的架构缺口

### A. “同一目标”是提示词规则，尚不是可审计的路由契约

`profile.ts` 已要求不同目标新开 Session；但 `DelegateWork` 只有 `objective` 和可选 `session_id`。宿主能检查候选是否存在、Workspace 是否一致，不能核实新目标为什么要继承某个旧任务。候选摘要主要是标题、状态与更新时间，也缺少可靠的任务身份。

日志中“新建独立工作线程 + 旧 session_id”说明仅强化文案不足。选择另一个 git worktree 不会清除 Session transcript，二者必须独立建模。

### B. 上下文“放得下”与“值得发送”混为一谈

`PetSegmentController.beginTurn` 主要由手动清理或 12 小时空闲触发；持续使用就可能不触发新分段。委派结束目前记录工作记忆，未提供可靠 `turnRange` 时不会归档，该行为正确地避免误裁剪，但不能主动减小上下文。

Core 通用策略默认在窗口约 70% 才 microcompact、85% 才进入其他压缩、92% summary。大窗口模型可以合法携带很长历史，管理任务却不需要这么多。32,768 字符 world 上限只限制动态快照，不限制 system、工具定义、完整历史、检索结果和图片的总输入。

### C. 缓存稳定性与新鲜状态的摆放尚可优化

`composeRunSystemPrompt` 把易变 runtime world 拼到 system 尾部，world 中有 observedAt、generation 和动态清单。任何变化都可能改变 system hash，使此前历史的前缀复用受到影响，实际程度需按 provider 请求形态验证。

这不意味着所有低缓存命中都是这一个原因：切模型、工具集合变化、宿主切换也会改变缓存条件。改造时保留新鲜状态，调整其位置与生命周期；不能为了命中缓存而冻结旧权限或旧任务状态。

### D. 工具错误仍可变成反复推理

Sessions 将 list/search/describe 放在一个参数对象中；运行时要求 action 对应的字段互斥。日志实际出现 `list + session_id + query`。FollowUps 和 DelegateWork 也出现重复参数失败。

当前 Workspace mismatch 修复改进了错误提示，但不是“无论模型怎样生成都停止重复”的硬保证。`DelegateWork` 接受后主要返回字符串，未像 GatewayReply 一样请求明确的结束边界。不能直接给它加一个无条件 stop：任务完成续办路径可能同回合既委托又要求 GatewayReply，必须整体提交这一组决定。

### E. 全局记忆与当前对话需要更清晰的范围

当前桌面和多个 IM 回合可复用同一个 Mimi sessionId。投递路由已有来源约束，但模型历史仍是同一条长会话。应区分用户共享偏好、跨项目工作摘要与当前来源的近期对话；这既减少上下文，也减少从另一段对话误判“继续”的机会。

### F. 一次结果处理仍可能包含额外模型调用

已存在懒加载 follow-up 摘要及持久缓存，值得保留。9/4 17:08:52 的记录显示，一个 1 轮回复后仍有辅助模型记忆提取，`extracted=0`，以及其他辅助请求。建议让不同用途有独立 usage attribution，再判断哪些应按新增内容增量执行；不能把所有辅助调用都认定为重复或全部关闭。

## 4. 建议形态：短管理回合 + 明确任务身份 + 有界上下文 + 可恢复交付

### 4.1 接纳与路由

沿用现有消息队列、sender/route 校验和已绑定会话旁路。确定性命令（如查看已绑定会话、退出）继续无需模型。每条请求保留 `conversationKey、clientMessageId、origin`，不要在重试时生成新的任务身份。

新增来源隔离的上下文视图，可先在统一 transcript 上按元数据构造，不必立即迁移成多物理 Session。legacy 消息不能可靠归属时，以明确标记的迁移摘要承接，禁止猜成某个群聊历史。用户共享的偏好、项目状态仍可通过现有授权读模型获取。

### 4.2 结构化任务身份与路由决定

以下是**拟新增字段**，不是当前 API：

- `routing.mode = new | continue`；`continue` 必须带精确 `taskId/sessionSelector`。
- `continuityEvidence` 引用用户明确续办的消息 ID、有效 bound route，或先前登记的任务 ID；自然语言理由只作为审计说明，不能自行授予权限。
- `new` 必须得到新 Session；需要旧材料时只附 `contextRefs` / 有界交接摘要。
- 明确指定“新任务”与“继续某任务”的用户动作由宿主结构化保留；不依靠对任意自然语言做脆弱的关键词拦截。
- 语义不明确时，Mimi 可做一次有界候选查询。候选没有可靠连续性证据时默认新建；已明确要求续办时不能擅自新建。

“新建”和“续办”均继续验证权限、Workspace 所属、会话状态及运行并发。引入新的 domain schema version，老版本缺少新字段时走兼容路径并记 telemetry；显式现有 session_id 不应静默被改成另一个目标。

对于已发生串目标的 Work Session，不删除旧历史、不悄悄 `/clear`。在用户下一次明确新任务边界建立新 Session；若是续办，则生成带原文引用的检查点，保留原会话、工件和未完成操作。

### 4.3 独立的管理上下文预算

在 Core 增加通用 `RunBehaviorProfile` 预算能力，Pet 只提供数值和策略；普通 Work 不受 Mimi 阈值影响。

**首版建议参数，需离线回放校准，并非已实现或模型规格：**

| 项目 | 初始建议 | 到界行为 |
| --- | --- | --- |
| Mimi 单次完整输入 | 目标 ≤24k tokens，软界 32k，硬界 48k | 软界生成检查点并重组；硬界不继续发送超额输入 |
| 输入分配 | 固定规则/工具 8k、近期对话 8k、相关状态 4k、检索 4k | 图片计入同一总预算；未使用额度可以调剂 |
| 管理回合 | 通常 1–3 个模型轮次，最多 6 轮起步 | 达界返回明确状态或已批准的委派决定，不能声称任务完成 |
| 无进展重复 | 同一失败工具 + 规范化参数 + 状态版本出现 2 次 | 禁止第三次完全相同调用，返回结构化恢复结果 |
| 辅助处理 | 独立计量与输入上限 | 只处理新增事件；按内容 hash 与提示版本复用摘要 |

硬界包含 system、工具 schema、消息、runtime world、检索与图片估计，并保留模型输出余量。不能只按字符截断。裁剪顺序：无关候选 → 已完成事件详情 → 老工具输出 → 已被检查点覆盖的历史。当前用户消息、授权范围、路由、未答复问题、正在等待的工具/审批和活跃任务身份必须保留。

若摘要失败，不应在管理硬界下悄悄回退到全部历史。使用有来源标记的确定性短视图与原文引用；若关键输入本身超界，明确返回需要进一步处理的状态。禁止丢失当前输入后继续声称理解任务。

分段新增 token 压力与明确新目标两个触发器，保留现有 12 小时规则作为补充。所有压缩必须在当前消息持久化后、模型调用前的安全点执行，并使用现有归档锚点及重放机制。分段闭合、当前任务完成和全局会话终止是不同事件。

### 4.4 固定规则与动态数据分开组装

Mimi 的固定系统规则、静态工具定义置于稳定前缀；当前世界状态作为框架拥有的非持久动态消息靠近当前输入。动态块保留“仅状态数据”语义、来源标记和新鲜度，不给外部任务摘要系统指令权限。

需要为 profile 提供注入位置选项，旧 profile 默认行为保持不变。每回合替换动态块，不把上轮 world 再持久化注入。按真实 provider 的序列化请求做字节/哈希对照；同时验证权限变更会立即更新可见工具并在执行端重新校验。

Pet profile 可以利用已经存在的 `disableInstructions/disableCapabilityContext/disableSourcesContext/disableWorkspaceProfile/disableHooks/disableSessionTitle`，建立真正精简的管理配置。逐项审查后启用；保留用户通过 Mimi personalization 设置的偏好，避免误删用户授权规则或有效记忆。只关闭死上下文，不能靠裁切通用安全规则节省 tokens。

### 4.5 管理决定统一提交，但保持现有回复语义

建议建立领域层的 `ManagerDecision`：可以同时包含一个委派意图和一份回复意图，宿主检查后原子登记。登记完成后触发 Core 的通用工具边界，决定执行应结束、被 steer 修订，还是因已启动后台工作而停泊。

- 直接回答：提交回复草稿，结束管理推理，宿主验证并发送。
- 委托工作：提交明确路由，由宿主提供真实启动回执；避免为了编写“已开始”多跑一轮模型。
- 完成后必要续办：允许同一提交包含委托和当前结果说明，不因第一次工具返回就丢掉第二项。
- 输入错误：可读工具允许一次有界修正；有副作用工具不擅自修改目标、不自动执行替代任务。
- steer：在实际发送前按输入修订号替换草稿；发送之后的新输入属于下一个回复周期。

继续保留已经通过回归的 `reply_committed`、后台停泊优先、同批危险工具阻止和 steer 重驱语义。新旧工具并存迁移，不能将“宿主接受”改成“外部已送达”。

### 4.6 交付恢复与任务继续分开

在现有 claim/complete、report receipts 和 gateway inbox 上补足需要的交付阶段，不另造第二套消息数据库。建议状态：`pending → sending → sent`，以及 `failed/unknown`。只有平台提供真实送达回执时再使用 `delivered`。

- RPC 请求被接纳只表示排队或启动，不意味着任务完成。
- 发送失败只重试已存储的交付内容，不能重新调用 Mimi 或重新执行 Work。
- 支持渠道 idempotency key 时复用同一键；没有幂等能力且发送结果未知时保留 unknown，查询/人工处理，不能承诺端到端 exactly-once。
- 已存在“claim 后崩溃不得盲目重做”语义要保留。
- 完成通知优先用真实终态和结果引用生成简短通知；需要解释或决定续办才进入受预算约束的 Mimi 回合。

### 4.7 可观测性

每次请求记录：`role=manager|work|aux`、runId、conversationKey 的不可逆标识、taskId、路由模式及证据种类、输入各分区 token 估计/实测置信度、缓存读写、模型轮次、错误指纹、压缩前后体积及保留引用。

Worker 启动与 run 日志增加源码/构建版本和 profile schema version，便于区分“源码已修复”与“某旧 worker 仍运行”。缓存失效至少区分 system、tools、model、权限、动态数据和未知原因。

辅助调用加 purpose（记忆提取、分段摘要、完成解释等）与 parentRunId，避免双重计入。成本报表分开显示当前输入大小、累计输入、累计输出、缓存及实际可用账单数据。

## 5. 分阶段实施

| 顺序 | 改动 | 主要落点 | 验收 |
| --- | --- | --- | --- |
| P0-1 | 记录构建身份、角色与输入分区；重放当前故障样本 | logging、run-context、Pet dispatcher | Work 与 Mimi 用量不混淆；能定位旧 worker |
| P0-2 | 新建/续办结构化决定与宿主核验 | pet/delegation、delegate-work、dispatch、work-delegation-host | “画架构图 → 新建 Mimi 排障”不会重用旧 Session；明确续办仍保留状态 |
| P0-3 | 重复失败熔断与管理轮次限制；提交终态契约 | Core 通用执行预算；Pet 决定收集器 | 两次同参数失败后不再循环；委派 + 回复不会丢一项 |
| P1-1 | 按来源构造有界上下文、token 触发分段 | Pet segment controller、run-context、通用 profile | 连续使用超过 12 小时也不线性增长；来源不串话 |
| P1-2 | 动态 world 后置、manager profile 精简 | run-context、prompt composer、pet/profile | 相同历史前缀稳定；权限与状态仍实时有效 |
| P1-3 | 交付阶段核查与恢复 | 现有 gateway/receipt/long-task 服务 | 重启/超时不重复执行；未知交付状态如实报告 |
| P2 | 摘要增量处理、候选相关性排序 | summary、segment closure、disclosure | 辅助开销可归因并有质量回放 |

先以日志模式观察预算，离线回放通过后逐步启用；保留 per-profile 开关与旧注入方式回退。历史 transcript 不破坏性改写，归档 marker 与新持久状态均需版本化。不要把 Goal 模式强加给每次委派；代码现已是 opt-in，但 Pet README 的“每次委派都使用 Goal”描述需要同步。

附带小修：dispatcher 构建 `petReusableSessions` 时把候选 `updatedAt` 只写进描述，没有映射为结构化 `lastActiveAt`；run-params 的过期筛选对无时间字段条目会保留。补齐字段映射有价值，但 180 天陈旧阈值本身不能解决目标串用。

## 6. 下一轮必须验证的场景

- 新目标复用冲突、明确续办、绑定会话直达与退出、两个相同标题不同目标。
- 来自两个渠道/群聊的并发消息、同来源 steer、旧 route 失效与权限变化。
- 100–200 条持续管理消息，夹杂多个任务完成事件；按完整输入测量 P50/P95 与硬界，而不是只测 world 字符数。
- 摘要超时或失败、超长单条用户输入、图片估计偏差、重启后归档重放。
- 刻意生成无限重复参数失败的假模型、同批 DelegateWork + GatewayReply、提交前后到达的新消息。
- 发送前崩溃、发送后回执落盘前崩溃、重复终态事件、已有 claim 的 unknown 结果。
- 输入减少后的路由准确率、事实保留、授权约束与完成状态判断必须不退化。减少 tokens 不是唯一验收指标。

本次不宣称上述新架构已实现，也不以 47 个现有测试替代这些新增验收。优先实施路由契约和预算层，比继续加长提示词或一律增加超时更有针对性。

## 源码证据索引

- `packages/pet/src/profile.ts:48`：复用决策提示；`:116`：当前 Pet profile；`:155`：单轮委托登记。
- `packages/pet/src/delegate-work.ts`：复用字段和执行返回；`packages/pet/src/host-actions.ts:403`：已接受回复的终止屏障。
- `packages/desktop/src/main/pet/pet-dispatch-service.ts:314`：world 字符上限；`:1590`：候选构造；`:1739`：完整 runtime 组装；`:1800`：宿主复用核验。
- `packages/desktop/src/main/pet/pet-work-delegation-host.ts:75`：新建/复用 Session；`:99`：Goal opt-in。
- `packages/pet/src/topic-segment.ts`：12 小时默认阈值；`packages/desktop/src/main/pet/pet-segment-controller.ts:109`：任务结束无 turnRange 时不归档。
- `packages/core/src/engine/run-context.ts:92`：动态 world 拼接 system；`packages/core/src/context/manager.ts:67`：通用窗口比例阈值。
- `packages/core/src/engine/engine.ts:1435`：带锚点的运行前归档；`packages/core/src/engine/run-types.ts:25`：可扩展通用 profile。
- `packages/desktop/src/main/pet/session-conversation-bridge.ts`：已绑定会话旁路；`packages/desktop/src/main/pet/pet-host-action-receipts.ts`：claim/complete 与不确定结果。
