# Claude Code：一个 Agentic Coding Shell 的设计哲学

---

## 一、产品定位：不是聊天工具，而是编码操作系统

Claude Code 的第一个正确决策，是把自己定位成一个 **Agentic Coding Shell**，而不是一个"会写代码的聊天机器人"。

这两者的差异是根本性的。聊天机器人的核心抽象是"消息列表"——用户说一句、AI 回一句、偶尔调一下工具。编码操作系统的核心抽象是"工作现场"——有文件状态、有执行计划、有权限边界、有中断恢复能力，而对话只是驱动工作推进的手段之一。

这个定位决策贯穿了之后所有的架构设计。

### 五种运行模式共享一个核心

Claude Code 支持五种运行形态：交互式终端（TUI/REPL）、无头模式（Headless）、SDK 对接、远程桥接（Bridge）、以及 MCP Server 模式。但它们共享同一个核心执行循环——区别只在 I/O 形态（终端渲染 vs JSON 输出）、审批交互（弹窗 vs 自动决策）和传输协议。

这意味着在 Headless 模式跑通的任何场景，TUI 模式也一定能跑通。这是一个看似简单但极其重要的架构约束——它强制所有业务逻辑集中在核心层，而不是散落在各个模式的适配代码里。

---

## 二、Transcript：事件日志，不是聊天记录

这可能是 Claude Code 和所有普通 Agent 框架最大的架构差异。

### 为什么不能用消息数组

普通 Agent 框架把对话历史存成一个 `messages[]` 数组，直接发给 LLM。这在简单问答场景没问题，但在长时间自主编码场景会遇到一系列困难：

- **恢复能力**：程序崩溃后，你只能恢复到"聊了什么"，无法恢复到"工作做到哪了"
- **内容替换**：想把旧消息替换成摘要时，原始内容就丢了
- **分叉**：想从某个时间点创建一个分支会话，消息数组没有这个语义
- **审计**：无法区分"这条消息是用户说的"还是"这条消息是 compact 后合成的"

### Claude Code 的做法

Claude Code 的 Transcript 是一个 **append-only 的 JSONL 事件日志**。它记录的不是"消息"，而是"发生了什么事"。事件类型至少包括：

- **message** — 用户或模型的消息
- **tool_use / tool_result** — 工具调用与返回
- **summary** — 上下文压缩摘要
- **content_replace** — 内容替换操作
- **file_history** — 文件状态快照
- **plan_operation** — 计划的创建、更新、完成
- **turn_boundary** — 轮次分界标记
- **session_meta** — 会话元信息

LLM 从来不直接看到这个事件日志。它看到的 `messages[]` 是通过一个 `toMessages()` 方法**派生**出来的视图。这个看似多出来的间接层，带来了巨大的灵活性：

- **Resume**：重新加载事件日志，重建工作现场
- **Content replacement**：修改派生视图而不丢失原始事件
- **Fork**：新 session 共享原 session 的事件前缀，之后独立发展
- **Compact**：压缩后写入 summary 事件和 compact_boundary 事件，旧事件仍在日志里

### Compact Boundary 协议

当上下文被压缩时，Claude Code 不是简单地截断旧消息。它写入一个 `compact_boundary` 事件，其中包含一个 `preservedSegment` 结构——记录了被保留段的首条消息、锚点和尾条消息的标识符。这不是 UI 装饰，而是一个正式的 **Transcript 重连协议**，使得后续的 rewind 和 transcript 重链操作可以准确地把压缩后的片段拼回原来的位置。

---

## 三、Prompt 装配：双链结构与 Section 缓存

### 为什么 Prompt 不能是一个字符串

长时间编码 session 中，system prompt 的组成部分非常多：运行时信息（当前目录、操作系统、Shell）、用户指令（CLAUDE.md 文件内容）、工具定义（可能有几十甚至上百个）、MCP 服务器指令、技能列表、项目规则……如果每轮都把这些全部重新拼接成一个字符串，不仅浪费计算，而且在 200K context 的场景下，拼接本身的延迟也不可忽视。

### 双链架构

Claude Code 的 prompt 装配分成两条独立的链：

**System Chain**（进入 API 请求的 `system` 字段）：
- 运行时头部（模型标识、工作目录、平台信息）
- 产品身份标识
- 默认 system sections（10+ 个独立段落）
- 系统上下文（git 状态快照等）

**Messages Chain**（进入 API 请求的 `messages` 字段）：
- 用户上下文（CLAUDE.md 内容）作为前缀 user message 注入
- 历史 transcript 消息
- 当前轮的 attachments
- 当前轮的用户输入
- 归一化后合并相邻的 user messages

一个容易被忽略的关键设计：**CLAUDE.md 的内容不进 system prompt，而是作为 `<system-reminder>` 包裹的 user message 前插到消息链最前面**。这使得用户指令可以被后续的 compact 操作处理（user message 可以被压缩），而 system prompt 中的核心行为指令则始终保留。

### Per-Section 缓存

System prompt 的 10+ 个段落不是每轮都重算。Claude Code 维护一个 `Map<sectionName, cachedValue>` 级别的缓存，每个段落独立管理缓存策略：

- 大多数段落（运行时信息、语言检测、输出风格等）跨 turn 复用
- MCP 指令段被标记为 **cache-break**——因为 MCP server 可能在两轮之间变化，所以每轮强制重算
- 当 compact 成功后，指令扫描缓存会被失效，下次扫描时带上新的 `load_reason`

这种粒度的缓存管理，在 200K context 窗口、单次 session 可能跑几十轮的场景下，对延迟和成本都有实质影响。

### 指令发现链

Claude Code 的指令扫描（等同于读取 CLAUDE.md）不是简单地读一个文件。它是一条完整的发现链：

1. 扫描 managed 级别的指令文件和规则目录
2. 扫描 user 级别（用户主目录下）
3. 从当前工作目录沿祖先目录向上扫描，每一层检查项目级指令文件、`.claude/` 子目录、规则目录、local 指令文件
4. 扫描额外配置的附加目录
5. 附加自动记忆和团队记忆

每个发现的文件还支持 `@include` 递归引入。整条扫描链有深度限制、路径排除（可配置）和去重机制。

值得注意的是，其他工具的兼容文件（如 `.cursor/rules`、`.github/copilot-instructions.md` 等）**不会被自动注入到运行时 prompt 中**。它们只在执行 `/init` 命令时被读取，由模型决定是否把其中重要的部分写入到 CLAUDE.md 中。这是一个"一次性迁移"的设计，而不是"每轮都去兼容扫描"。

---

## 四、主循环：显式状态机，而非 while-true

### 普通 Agent 的循环

```
while (true) {
  response = callLLM(messages)
  if (response.hasToolCalls) {
    results = executeTools(response.toolCalls)
    messages.append(results)
  } else {
    return response.text
  }
}
```

### Claude Code 的状态机

Claude Code 的主循环外壳只做三件事：创建一个 queued command 容器、调用内核状态机、结束后清理。真正的多轮逻辑在内核状态机中。

这个状态机维护一个长生命周期的 **TurnState** 对象，它不是每轮重建的临时变量，而是在整个 session 运行期间跨 turn 搬运的唯一主状态。关键在于，这个对象**只在四种明确的场景下被整包重建**，每次重建都带有明确的 `transition.reason`：

1. **正常工具轮结束** — 把助手消息、工具结果合入消息链，进入下一轮
2. **上下文紧急压缩后重试** — 用压缩后的 transcript 替换消息链，重置压缩跟踪状态
3. **输出被截断后续写** — 追加一条"直接续写，不要道歉不要回顾"的元消息，最多重试 3 次
4. **Stop hook 产生阻塞错误** — 把错误信息塞回消息链，标记 stop hook 已激活，再补一轮

这种设计的好处是**每条路径的状态变化完全可预测**。你不会遇到"主状态被某个深层回调悄悄改了一个字段"的问题。

### Yield 面：混合事件流

主循环对外暴露的不只是 assistant 文本。它是一条混合事件流，包括：

- 每轮开始的请求信号
- 原始模型流事件
- 收口后的助手消息片段
- 各种附件（compact 产物、hook 结果、skill 发现、文件恢复等）
- 进度通知（hook、工具、MCP）
- 系统级通知和警告
- **Tombstone**——当 streaming 失败回退到 non-streaming 时，撤销已经发出的孤儿助手片段

Tombstone 机制值得特别关注：在流式场景下，模型可能已经吐出了一部分回复，然后流式传输失败了，系统回退到非流式请求重新获取完整回复。这时之前已经发出去的部分回复需要被作废。对 TUI 来说，收到 tombstone 就删除已显示的片段；对 SDK 来说，直接吞掉 tombstone 不对外发出。这种级别的流式故障恢复机制，在大多数 agent 框架中是不存在的。

---

## 五、工具系统：一等公民 + 延迟加载 + 结构化输出

### 工具不是附加物

在 Claude Code 中，工具不是"模型可以选择性使用的附加能力"，而是主循环的一等公民。每一轮的执行流程本质上是"模型决定做什么 → 工具执行 → 结果反馈 → 下一轮决定"。没有工具调用的轮次（即最终回复）反而是特殊情况。

### Deferred Tools：按需加载

当你接入多个 MCP server，每个暴露几十个工具时，所有工具的完整 schema 可能占几十 KB 的 context。Claude Code 的解决方案是 **Deferred Tool 机制**：

- MCP 工具默认为 deferred——模型初始只看到工具名字列表（通过一个专门的 attachment）
- 模型判断需要某个工具时，先调用一个特殊的"工具搜索"工具
- 搜索结果不是文本描述，而是一组**工具引用**——相当于告诉系统"我需要这些工具的完整信息"
- 下一轮的请求构建器从历史消息中提取已发现的工具引用，只把这些工具的完整 schema 放回请求的工具数组

这是一个类似操作系统 demand paging 的按需加载策略。模型不需要在每轮请求中携带所有工具的 schema，只需要"用到哪个加载哪个"。

### Tool Result 的双层形态

工具的返回不是简单的字符串。它分成两层：

**内部结构化输出**：工具本身返回结构化数据（如 Bash 工具返回 stdout、stderr、退出码、后台任务 ID 等）。

**Transcript 中的文本化结果**：结构化输出经过一个统一的映射函数转换成文本后才写入 transcript。不同工具的映射策略不同——Web 搜索结果会被降成带链接引用的文本，用户问答工具会把答案拼成自然语言句子。

这意味着模型看到的是人类可读的文本结果，但系统内部（包括 TUI 渲染器）可以基于结构化数据做更丰富的展示。

### 超长结果处理

编码场景中工具输出可能非常长（比如读取一个大文件、运行测试的完整日志）。Claude Code 对此有两层压缩：

1. **单次结果上限**：超过阈值的文本结果会被写入一个持久化文件，transcript 中只保留预览和文件路径
2. **消息预算**：更老的 tool_result 会在消息预算阶段被二次替换成简短的持久化引用

### Tool Result 配对修复

LLM API 要求每个 `tool_use` 必须有对应的 `tool_result`，且 ID 必须匹配。Claude Code 在 resume 和 transcript 重建时有专门的修复逻辑：

- 检测孤儿 tool_result（没有对应 tool_use）
- 检测重复 tool_result
- 检测缺失配对的 tool_use
- 缺失时补入合成的错误结果

这些不是"容错"，而是 transcript 持久化层的正式修复协议。

---

## 六、权限系统：两层状态机

### 为什么不能只有 allow/deny

在自主编码场景中，权限决策需要解决一系列矛盾：
- 读文件应该静默允许，但写文件需要确认
- `git status` 应该允许，但 `rm -rf /` 必须拒绝
- 用户可能希望"自动批准所有编辑操作"，也可能希望"每次都问我"
- 企业可能要求"不管用户怎么设置，这些危险操作必须禁止"
- 有时候应该让 AI 自己判断操作是否安全（auto 模式）

一个扁平的 allow/deny 列表无法表达这些语义。

### 两层架构

**第一层：分类器**（同步，快速）

分类器按顺序检查：
1. 静态 deny 规则
2. 静态 ask 规则
3. 工具自身声明的权限要求
4. bypass/rule allow 快捷路径
5. 回退到当前模式的默认行为

输出是三值决策：allow / deny / ask。

**第二层：审批后端**（异步，可能需要等待）

只有 ask 决策才进入第二层。第二层是一个统一的审批队列协议——不管最终的审批方是 TUI 弹窗、SDK 的 control_request、远端 bridge 回调，还是 MCP 审批工具，都是向同一种队列 item 写入 allow/deny 结果。

这个分离的关键好处是：**快路径（allow/deny）不等待任何 I/O**。在一个可能连续调用几十次工具的 session 中，这对延迟的影响是直接的。

### 六种权限模式

- **default** — 标准 ask/allow/deny 流程
- **acceptEdits** — 比 default 更宽松，但仍非全放行
- **dontAsk** — 不弹审批，未预授权的直接拒绝
- **bypassPermissions** — 全部允许（需要显式启用且可能被企业策略禁止）
- **auto** — ask 不一定弹审批，先过一个 AI 分类器自动判断
- **plan** — 与 auto 耦合的复合状态（plan 模式下可能启用隐藏的 auto-active）

模式切换不是简单改一个枚举值。进入 auto 模式时，系统会**主动剥离危险的宽泛 allow 规则**，防止分类器被预授权绕过。退出时再还原。进入 plan 模式时，会记录之前的模式，并根据条件决定是否在 plan 内启用隐藏的 auto-active 状态。

### 细粒度规则

权限规则不是简单的工具名匹配，而是"工具名 + 参数子集"级别的细粒度控制：

- 允许以 git 开头的 Bash 命令
- 允许编辑 docs 目录下的文件
- 允许 fetch 特定域名
- MCP 工具有独立的命名空间权限

### Auto 分类器的设计

Auto 模式的分类器不是一个简单的规则引擎，而是用 LLM 做分类。但它有大量的 fast-path 避免不必要的 LLM 调用：

- 工具自己声明的安全输入直接放行
- 在 acceptEdits 模式下会直接允许的操作直接放行
- 命中本地安全白名单的直接放行
- 需要用户交互的工具（如 AskUserQuestion）保留人工审批
- 特定危险工具（如 PowerShell）显式要求人工审批

只有"仍然不确定、且适合自动判定"的那一段 ask 才真正送入分类器。分类器失败时的策略也不是统一的 fail-open 或 fail-closed——解析失败偏 fail-closed，分类器不可用可能回退到人工审批，请求被中断记为不可用。

### Sandbox 与权限规则的合流

Sandbox 不是独立于权限系统的另一套机制。它直接消费权限规则的路径级结果：编辑文件的 allow 规则会并入 sandbox 的 allowWrite，读文件的 deny 规则会并入 sandbox 的 denyRead。当开启"sandbox 内自动允许 Bash"时，也不是简单的全放行——仍然先检查子命令规则，只有所有子命令都能被 sandbox 覆盖且没有 ask/deny 冲突时才 allow。

---

## 七、上下文压缩：三级策略 + 熔断器

### 为什么简单截断不够

长 session 中 context 会持续增长，最终超过模型上限。简单截断前面的消息会丢失重要上下文。即使用 LLM 做摘要，摘要本身也消耗 token，可能触发连锁的 context 超限。

### 三级渐进策略

**第一级：微压缩（每轮自动，零成本）**

每轮开始时自动执行，把超过保留阈值的旧 tool_result 内容清除，替换为占位文本。这是同步操作，不调用 LLM，不消耗额外 token。

**第二级：自动压缩（超阈值触发）**

当 token 数超过阈值时触发。有两种 producer：
- 先尝试 session-memory compact——只压缩旧的部分，保留近期消息
- 不成功再走全量 compact——用 LLM 生成整段摘要

所有 compact producer 必须满足同一个公共合同：产出边界标记、摘要消息、可选的保留消息段、附件和 hook 结果。主循环不理解 compact 内部细节，只要求产出的结果满足这个合同。

**第三级：紧急缩减（极端情况）**

如果压缩后仍然超限，用最激进的窗口策略：只保留第一条和最后几条消息。

### 熔断器

自动压缩有一个连续失败计数器。当连续失败达到 3 次时，熔断器打开，不再尝试 compact。这避免了"compact 消耗 token → 触发 context 超限 → 再次尝试 compact → 再失败"的死循环。

熔断器的计数只在正常工具轮结束时递增——不计入 recovery 分支、stop hook 分支或 reactive compact 分支。这意味着统计的是"compact 后真正完成过多少个正常工具轮"，而不是所有循环次数。

### Compact 后的 Transcript 重建

Compact 成功后，主循环会把产出的所有元素（边界标记、摘要、保留消息、附件、hook 结果）按固定顺序展开，直接作为下一轮的消息输入。同时写入 telemetry（压缩前后的 token 数、使用量等）。整个过程对调用方是透明的。

---

## 八、四层上下文模型

普通 Agent 框架通常只有一个 context 对象到处传递。Claude Code 把上下文分成四个层次，每层有不同的生命周期和职责：

### 全局应用状态

生命周期最长。存放当前工作目录、session ID、已调用的 skills、prompt section 缓存、权限上下文、UI 状态、MCP/Plugin 状态等。工具执行时通过一个桥接方法访问这一层。

### Request 级别的用户上下文

每次请求构建时生成。当前只包含 CLAUDE.md 扫描结果和日期信息。它不直接进 system prompt，而是被包装成 `<system-reminder>` 格式的 user message 前插到消息链。

### Request 级别的系统上下文

每次请求构建时生成。当前只包含 git 状态快照（当前分支、status 摘要、最近提交）。它通过一个泛型序列化器追加到 system prompt 末尾——这个序列化器对所有字段做 `key: value` 格式化，所以未来增加新字段不需要改代码。

### Turn/Run 级别的工具执行上下文

这是能力最丰富的一层。它不只是 prompt 片段，而是工具执行、hook、子 agent 和 compact 辅助路径真正传递的运行态上下文。它包含：

- **文件状态**：已读文件缓存（带容量上限的 LRU 缓存，最多 100 条、25MB）、内容替换状态、文件读取限制
- **触发器**：嵌套内存附件触发器、动态 skill 目录触发器、已发现的 skill 名称
- **执行控制**：中断控制器、流模式设置、SDK 状态设置
- **应用状态桥接**：获取/设置全局状态、本地拒绝追踪、归属状态更新
- **请求/Agent 元数据**：选项、消息、Agent ID、查询跟踪

当创建子 agent 或 fork 时，这个上下文不是简单复制。Claude Code 的克隆器会：
- **克隆**文件状态缓存
- **重置**所有触发器（新的空 Set）
- **降权** UI 相关能力（TUI 操作变成 no-op）
- **包装**全局状态访问（可能强制设置"避免权限弹窗"标记）
- **新建**查询跟踪（新链 ID，深度 +1）

这确保了子 agent 不会意外修改父链的触发器状态或 UI 状态。

### ContextModifier：工具改变运行态的协议

工具不只能返回文本结果，还可以返回一个 ContextModifier——本质上是一个"上下文 → 上下文"的变换函数。它可以修改运行时权限规则、切换主循环使用的模型、调整推理强度等。

执行器对 ContextModifier 的应用时机有明确的并发安全规则：
- 并发安全的工具（如读文件）整批执行完后统一应用
- 非并发安全的工具（如写文件）每个执行完立即应用

这避免了并发工具在共享上下文上产生不可预测的中间状态。

---

## 九、配置系统：五层合并与企业治理

### 五层来源

按优先级从低到高：

1. **Managed/Policy** — 组织级策略（只读，可能通过 MDM 分发）
2. **User** — 用户主目录下的配置
3. **Project** — 项目目录下的配置（入版本控制）
4. **Local** — 项目本地配置（不入版本控制）
5. **CLI Flags** — 命令行参数（最高优先级）

合并策略是深合并，数组替换（非拼接），`null` 值表示删除该键。

### 企业治理

这个配置系统不只是"多了几个配置源"。它有几个为企业场景设计的关键特性：

**Managed Policy 可以清空其他层的权限规则**。当开启这个开关时，user/project/local/CLI/session 这些来源的 allow/deny/ask 规则会被全部清空，只保留 managed policy 定义的规则。

但有一个刻意保留的例外：**命令级运行时授权不会被清空**。这是因为 slash command 和 skill 在执行时可能声明自己需要的工具权限，这种"当前命令上下文的临时授权"不应该被企业策略干掉。

**回写只对三层有效**。user/project/local 可以写回，flag 和 managed 是只读的。删除规则时，命令级授权和策略/flag 授权被视为只读来源。

**实时性**。配置文件有文件 watcher 监听变更，MDM/注册表有轮询机制。配置变更后权限状态会被重新评估——待审批队列中的 item 都带有 `recheckPermission()` 回调，权限变更后会被自动重算。

---

## 十、MCP 与 Plugin：不是"接入更多工具"那么简单

### MCP 是完整的 Server 生命周期管理

Claude Code 对 MCP 的支持不是简单的"支持 MCP 协议调用工具"。它是一套完整的 server 生命周期管理系统：

- **四种传输协议**：stdio（JSON-RPC over 标准输入输出）、SSE（下行 SSE + 上行 HTTP POST）、streamable-http（session-aware 双向 HTTP）、WebSocket
- **连接去重**：按连接签名去重（不是按名字），避免同一个 server 被重复连接
- **优雅关闭**：stdio server 的关闭顺序是 SIGINT → 等待 → SIGTERM → 等待 → SIGKILL
- **MCP 指令双重落地**：一方面进入 system prompt 的默认 section（每轮 cache-break），另一方面作为增量 attachment 更新
- **MCP 资源是一等类型**：`@server:uri` 触发读取，内容快照直接展开进 prompt（不是引用链接）

### Plugin 是多能力装配容器

Plugin 在 Claude Code 中不是"附带几条 skill 的目录"。一个 Plugin 可以同时注入：命令、技能、子 Agent、输出风格、生命周期钩子、MCP 服务器、LSP 服务器、配置覆盖、消息通道。

Plugin 有三层状态：
1. **Marketplace 声明层** — 从哪里发现 plugin
2. **安装记录层** — 哪些已物化到本地（带版本、带 scope）
3. **启停选择层** — 哪些当前应启用（来自 settings 的多个来源）

Plugin 还有完整的依赖解析（安装期做 closure 解析，运行期复检）、跨 marketplace 依赖控制、安全治理（黑名单、下架强制卸载）、以及 session scope overlay（`--plugin-dir` 的 inline plugin 可以覆盖同名已安装 plugin）。

---

## 十一、Session 还原：恢复"工作状态"

Resume 不是"加载之前的消息数组继续聊"。它恢复的是完整的工作现场：

1. **事件日志恢复** — 从 JSONL 文件重建完整的 Transcript
2. **Plan 状态恢复** — 恢复活跃的 plan 文件和 plan 模式状态
3. **文件历史恢复** — 恢复文件状态快照
4. **中断轮补偿** — 检测是否有被中断的 turn，如果有则补入续写信号
5. **已调用 Skill 恢复** — 从 compact 保留的 attachment 中恢复 invokedSkills 状态
6. **Tool Result 配对修复** — 修复 orphaned/duplicate tool_result

文件状态的恢复也不是简单的"记住读了哪些文件"。从 transcript 回放时，只回放两类 full-file 事件：完整读取（无 offset/limit）的成功读取工具结果，以及文件写入工具的输入内容。这确保缓存中的是完整文件状态，而不是部分读取的片段。

Fork 创建新 session，共享源 session 的事件前缀，之后独立发展。子 Agent 的 transcript 独立落盘到 `subagents/` 目录。Agent Team 模式下有 mailbox 协议实现 leader 和 teammate 之间的通信，以及 plan approval 的上卷。

---

## 十二、为什么这些设计很重要

回到最初的问题：Claude Code 的 harness 为什么做得好？

**不是因为它用了什么高深技术**。JSONL 事件日志、per-section 缓存、两层权限分类、按需加载工具——这些单独看都不复杂。

**而是因为每一层的设计决策都服从同一个原则：为"LLM 长时间自主执行编码任务"这个场景做正确的工程选择。**

- Transcript 用事件日志而不是消息数组，因为编码 session 需要可恢复的工作现场
- Prompt 用 section 缓存而不是全量重算，因为 200K context 窗口下重算成本不可忽视
- 权限用两层分离而不是扁平列表，因为快路径不能等 I/O
- 工具用延迟加载而不是全量发送，因为几百个工具的 schema 会撑爆 context
- Compact 用熔断器而不是无限重试，因为压缩本身消耗 token 可能加剧超限
- 上下文用四层模型而不是单一对象，因为子 agent 需要隔离又需要部分继承
- 配置用五层合并而不是单文件，因为企业场景需要策略覆盖

这些决策的共同特征是：**都不是显而易见的**。如果你只想做一个"能调工具的聊天 CLI"，每一层都有更简单的做法。但如果你的目标是让 AI 在真实代码仓库里连续自主工作十几分钟甚至几十分钟，这些"过度设计"就变成了必须的基础设施。

Claude Code 的 harness 本质上是一个为 LLM 自主编码设计的轻量级操作系统。它管理的不是进程和内存，而是上下文窗口和工具权限。但核心挑战是一样的：在有限资源下，让执行者能长时间可靠运行。
