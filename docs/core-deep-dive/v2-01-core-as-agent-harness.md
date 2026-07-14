# 从 LLM Call 到 Agent Harness：通用编排内核的设计原理

> 模型提供推理能力，Harness 提供运行能力。前者决定“下一步想做什么”，后者决定“这一步能否执行、如何执行，以及执行后怎样继续”。

本文以 CodeShell Core 为实现样本，讨论一个更普遍的问题：**怎样把一次模型调用扩展成可控制、可观察、可恢复的 Agent 运行时**。重点不是介绍某个产品，而是沿着一次真实任务，看多轮循环、工具执行、上下文治理、安全边界、状态持久化和宿主协议为什么会自然出现。

这是 v2 深度长文系列的第 1 篇。后续文章会继续展开：

- 第 02 篇：Engine 与 TurnLoop
- 第 03 篇：工具系统与安全
- 第 04 篇：模型、上下文与记忆
- 第 05 篇：协议、宿主与长任务编排

---

## 1. Agent 解决的不是“调用模型”，而是“组织一次运行”

一次普通的 LLM Call 很简单：应用提交消息，模型返回文本。当任务所需信息已经全部放进 prompt，例如总结、翻译、分类和改写，这个接口就足够了。

但只要任务需要接触外部环境，问题就变了：

- 模型要求读取文件或执行命令时，谁负责真正操作？
- 工具参数是否合法，目标路径是否越界，危险动作是否需要审批？
- 工具执行完以后，结果如何进入下一轮推理？
- 任务被取消、进程退出或上下文超限时，系统如何收尾与恢复？

即使模型原生支持 tool use，它输出的也只是结构化意图：

```text
模型：我想调用 Bash，参数是 { command: "bun test" }
```

这不等于命令已经执行，更不等于它应该被执行。意图到副作用之间必须有一层受信任的控制面，负责校验、授权、执行、记录和反馈。这层控制面就是 Agent Harness。

可以用一个简化公式概括：

```text
Agent = Model + Control Loop + Tools + State + Policy Boundaries + Host Interface
```

模型只是其中的决策组件。Agent 则是一个由模型驱动、由运行时约束的持续过程。

---

## 2. 最小循环，以及它为什么还不够

![从 LLM Call 到 Agent Harness 的演进](assets/v2/v2-01-llm-call-to-harness.png)

最小 Agent Loop 通常只有几行：

```ts
while (!finished) {
  const input = context.build(transcript);
  const response = await model.generate(input, tools);
  transcript.append(response);

  for (const call of response.toolCalls) {
    const result = await executor.execute(call);
    transcript.append(result);
  }

  finished = stopPolicy.evaluate(response, transcript);
}
```

它已经表达了 Agent 的基本节奏：**模型决定下一步，运行时执行下一步，执行结果再影响模型。** 搜索型研究系统、数据分析 Agent 或编码 Agent，本质上都可以从这个循环出发。

真正的复杂度不在 `while`，而在每个名词背后：

- `context` 既要让模型看到足够信息，又不能超过 token 窗口。
- `executor` 既要执行工具，又要阻止模型越权。
- `transcript` 既要记录事实，又不能被原样塞回每一轮上下文。
- `stopPolicy` 既要识别正常完成，也要处理取消、错误和最大轮次。
- 宿主既要实时展示过程，又不能直接依赖 TurnLoop 的内部实现。

专项 Agent 往往把这些规则写进自己的循环；通用 Harness 则把它们抽成稳定的运行机制，把领域差异留给配置与扩展模块。

> **LLM Call 是一次推理，Agent Harness 是一次受控运行。**

---

## 3. 一次“修复失败测试”的请求如何跑完

先不列模块，直接看一条任务如何穿过运行时：

> 用户：运行测试，定位失败原因并修复。

下面假设请求来自 TUI 或桌面宿主，并启用了编程能力。

### 3.1 建立本轮运行边界

宿主提交用户消息、会话 ID、工作目录和本轮选项。Engine 解析或创建 session，并确定这次 run 使用的模型、preset、capability、工具集合和权限模式。

这里有一个重要细节：**运行中的权限语义不能随界面设置瞬间漂移。** 当前轮次开始后，它应使用同一份有效配置；用户在运行中修改的设置，通常从下一轮边界生效。否则同一批工具调用可能在前后半段受到不同规则约束。

会话确定后，宿主先收到 `session_started` 一类事件，因此 UI 在最终回答出现前就知道这次运行属于哪个 session。

### 3.2 构造模型真正看到的输入

Context 并不等于“把整个聊天记录拼起来”。运行时会组合：

- preset 选择的系统提示段；
- capability 提供的领域提示与动态上下文，例如当前 Git 状态；
- transcript 中与本轮相关的消息和工具结果；
- 当前可用的工具定义；
- token 预算要求下的裁剪、外置结果或压缩摘要。

模型收到的是为本轮构造的视图，而不是会话事实的唯一副本。

### 3.3 模型先调查，工具系统负责执行

模型可能先调用 `Read`、`Grep` 或 `Bash` 读取测试和错误信息。每个工具调用都会先经过 ToolExecutor，而不是直接触达文件系统或 Shell。

Executor 会检查工具是否属于本轮允许集合、参数是否符合 schema、目标路径是否可访问、权限结论是 `allow`、`ask` 还是 `deny`。通过门禁后，工具实现才会运行；结果随后同时进入两条路径：

```text
工具结果 ──→ Transcript：成为可恢复的会话事实
        └──→ StreamEvent：让宿主实时更新界面
```

TurnLoop 再把这个结果放进下一轮输入，让模型基于真实输出继续判断，而不是假设工具已经成功。

### 3.4 修改代码时，控制权可能回到用户

定位问题后，模型可能请求 `ApplyPatch`。这个工具并不属于通用循环本身，而是由编程 capability 贡献。

如果当前规则给出 `ask`，运行时会进入 `waiting-permission` 阶段，并通过 protocol 向宿主发送审批请求。此时模型没有获得文件写入权，Engine 也没有忙等；它在等待宿主把用户决定路由回来。

批准后，工具继续执行并记录修改结果；拒绝后，executor 返回一个明确的拒绝结果，模型可以改用其他方案或向用户解释为什么无法继续。**审批不是循环之外的弹窗，而是循环中的一种可等待状态。**

### 3.5 验证失败不会自动等于整个任务失败

修改完成后，模型调用 `Bash` 运行 `bun test`。如果测试仍然失败，这个失败首先是工具结果，而不一定是 run 的终点。TurnLoop 会把错误输出交还模型，模型可以继续读取相关文件、再次修改并重新验证。

只有当模型给出最终回答，或运行触发取消、模型错误、上下文无法继续压缩、最大轮次等终止条件时，这次 run 才结束。

一条典型的可观察状态线大致如下：

```text
starting → model → tool → waiting-permission? → tool → model
         → compacting? → model → finalizing → turn_complete
```

其中 `waiting-permission` 和 `compacting` 是条件分支，不是每次运行都会经过。最终的 `turn_complete` 还会携带 `completed`、`model_error`、`aborted_tools`、`max_turns` 等终止原因，让宿主知道“结束”究竟意味着什么。

这条运行故事解释了为什么一个 Agent 不能只有模型和工具：只要任务需要审批、重试、流式展示、上下文治理或恢复，运行时就必须拥有明确的状态和边界。

---

## 4. 从一次运行中抽出的四条不变量

![通用 Agent Harness 的分层结构](assets/v2/v2-01-core-runtime-layers.png)

上面的流程可以抽象成四条比模块名称更重要的不变量。

### 4.1 模型拥有决策权，但不拥有执行权

模型可以提出 `tool_use`，真正的副作用必须经过统一 executor。这样才能保证新增工具不会绕过可见性、参数校验、路径策略、权限、Hook 和审计。

如果每个工具各自处理安全，系统就无法证明“所有副作用都经过同样的门禁”。统一执行入口不是代码复用技巧，而是安全模型成立的前提。

### 4.2 Transcript 是事实，Context 是视图，Memory 是提炼

三者解决的是不同问题：

```text
Transcript：发生过什么
Context：这一轮需要看什么
Memory：以后值得记住什么
```

长对话中，Context 可以裁剪、摘要或外置大块工具结果，但 Transcript 仍承担恢复与审计职责。Memory 则保存从多次经历中提炼出的长期信息，而不是无限复制聊天原文。

把三者分开，才能同时满足“模型输入足够短”“历史事实不丢失”和“长期知识不过度膨胀”。

### 4.3 Engine 管运行，Host 管交互

宿主需要的是稳定语义：开始运行、接收流式事件、展示审批、转向、取消和查询状态。它不应了解 TurnLoop 内部如何调度工具或压缩上下文。

协议层把这些语义固定下来后，终端、桌面、远程界面和自动化服务可以共享同一套运行机制，同时保留各自的交互方式。

### 4.4 Core 定义生命周期，Capability 定义领域能力

Engine 只需要知道一种能力如何被安装、选择和调用，不需要知道“编程”“研究”或“运维”分别意味着什么。具体工具、领域提示、动态上下文和工作区行为应通过 capability 进入系统。

这四条边界共同完成一件事：**让每一种复杂性拥有唯一、可测试、可替换的归属。**

---

## 5. 机制与策略如何在仓库中分开

通用内核最重要的设计约束是：

> **Core carries mechanism, not policy.**

机制回答“系统如何运行”，策略回答“这次运行应该表现成什么样”。当前仓库把它们分在三个层次：

| 层次       | 负责什么                     | 例子                                                               |
| ---------- | ---------------------------- | ------------------------------------------------------------------ |
| Core       | 稳定的生命周期与约束契约     | Engine、TurnLoop、ToolExecutor、Session、Protocol、Capability 接口 |
| Capability | 某个领域需要的实现与默认行为 | 编程提示、ApplyPatch、LSP、Git 上下文、worktree                    |
| Host       | 产品入口、进程组织与交互方式 | TUI 组合根、桌面 worker、renderer 审批界面                         |

![Core、Capability 与 Host 的组合关系](assets/v2/v2-01-presets-not-hardcoding.png)

### 5.1 Preset 是选择，Capability 是贡献

Preset 只从已有能力中选择提示段、工具集合和默认权限。Core 内置的 `harness-min` 与 `general` 都是领域中性的，它们不会让 Engine 自动获得编程能力。

编程包则通过 `CapabilityModule` 贡献新的实现。去掉细节后，当前结构接近：

```ts
const CODING_CAPABILITY = {
  id: "coding",
  defaultPreset: "terminal-coding",
  tools: CODING_TOOLS,
  presets: [CODING_GENERAL_PRESET, TERMINAL_CODING_PRESET],
  promptSections: { coding },
  dynamicContextProviders: [gitDynamicContextProvider],
  // instruction boundary、artifact、workspace、tool service 等
};
```

两者的区别可以概括为：

- **Preset 是选择**：本次运行从已有能力中暴露哪些提示、工具和默认权限。
- **Capability 是贡献**：向运行时加入哪些新工具、领域上下文和服务。

### 5.2 Host 在组合根决定产品形态

TUI 是一个产品组合根。它显式安装编程能力：

```ts
registerCapability(CODING_CAPABILITY);
```

SDK 使用者则可以按 Engine 隔离注入：

```ts
const engine = new Engine({
  llm,
  capabilities: [CODING_CAPABILITY],
});
```

因此，通用运行时不需要出现 `if (coding)`。需要编程能力的宿主安装它；客服、研究或媒体 Agent 可以只使用 core，或者安装另一组 capability。

这不是为了追求“插件化”形式，而是为了避免领域策略反向侵蚀通用循环。新增 LSP、Git worktree 或外部编码 Agent 适配器时，Engine 和 TurnLoop 不需要跟着理解这些概念。

---

## 6. 安全是执行路径，不是旁边的一层

Harness 与“接了工具的聊天机器人”最关键的差别，不是工具数量，而是如何看待模型输出：**它是待审查的请求，不是天然可信的命令。**

一条典型的工具执行链路如下：

```text
运行配置 / 工具可见性
        ↓
会话级可用性再次检查
        ↓
参数 schema 校验
        ↓
pre-tool hook（若改写参数，必须重新校验）
        ↓
路径策略与其他领域门禁
        ↓
权限分类：allow / ask / deny
        ↓
人工审批（仅 ask）
        ↓
工具执行与 OS sandbox
        ↓
结果记录、post-tool hook、返回模型
```

这条链路里有几处容易被忽略的细节。

### 6.1 隐藏工具不等于禁止执行

模型可能记住上一轮出现过的工具，也可能直接生成一个当前不可见的工具名。因此，工具集合既要在模型侧过滤，也要在 executor 侧再次校验。**可见性改善模型选择，执行门禁才建立安全边界。**

### 6.2 参数改写后必须重新验证

Hook 可以清洗或规范化参数，但任何改写都会让原校验结论失效。正确顺序是“校验 → 改写 → 再校验”，然后才进入路径和权限判断。

### 6.3 扩展只能收紧权限

多个判断合并时应遵循 `deny > ask > allow`。Hook 可以把 `allow` 收紧为 `ask` 或 `deny`，但不能把已有的 `deny` 放宽为 `allow`。否则，一个低层扩展就可能绕过宿主或用户设定的规则。

### 6.4 权限、路径与 Sandbox 不能互相替代

Shell 管道、重定向、命令替换和链式命令说明，只看字符串前缀不足以判断副作用。软链接和 `..` 也说明，只比较原始路径字符串不足以防止越界。

权限决定“是否允许”，路径策略决定“可以触达哪里”，OS sandbox 再限制“进程最终能做什么”。三者服务于不同威胁模型，缺少任何一层都会留下空档。

外部工具同样不能走旁路。MCP server、网页和第三方进程返回的内容都可能包含错误数据或提示注入，应接受同样的会话隔离、权限和结果处理。

### 6.5 失败本身也是运行状态

Production Harness 不能把所有异常都压成一句“执行失败”。不同失败需要不同语义：

| 场景                     | 运行时行为                                | 为什么                              |
| ------------------------ | ----------------------------------------- | ----------------------------------- |
| 权限为 `deny` 或用户拒绝 | 不执行 handler，把拒绝作为工具结果返回    | 模型可以停止、换方案或解释原因      |
| 可恢复的工具错误         | 记录错误结果并继续 TurnLoop               | 一次命令失败不等于整个任务失败      |
| 用户取消 model stream    | 传播 abort，并以 `aborted_streaming` 收尾 | 宿主需要区分取消与模型故障          |
| 用户取消工具阶段         | 停止后续执行，并以 `aborted_tools` 收尾   | 防止取消后继续产生副作用            |
| 上下文接近上限           | 进入 `compacting`，从事实账本重建更短视图 | 保留可继续推理的空间                |
| 模型错误或轮次耗尽       | 返回明确 terminal reason                  | 让 UI、自动化和恢复逻辑采取不同动作 |

安全不是某个 `permission.ts` 文件的职责，而是从“模型能看到什么”一直延伸到“操作系统最终允许什么”，再延伸到“失败后系统怎样停止”的完整链条。

---

## 7. 宿主复用与恢复边界

当运行机制与界面解耦后，同一个内核可以有多种接入方式：

- TUI 可以在同一进程内通过 protocol client/server 交互。
- 桌面聊天由主进程管理 worker，Engine 在 worker 中运行，renderer 只消费事件和提交控制指令。
- SDK 和专用 runner 可以直接构造 Engine，不必强制经过 protocol。
- 自动化与 cron 可以复用运行机制，但采用更适合无头环境的权限与恢复策略。

因此，“主路径经协议”不等于“所有调用都必须经协议”。Protocol 的作用是建立宿主契约，而不是禁止 Engine 作为嵌入式 API 使用。

### 7.1 可观察不等于暴露内部实现

宿主不需要知道 TurnLoop 的每个局部变量，只需要消费稳定事件：session 建立、文本增量、工具开始、工具结果、审批请求和 `turn_complete`。进度层还可以把运行概括为 `starting`、`model`、`tool`、`waiting-permission`、`compacting`、`finalizing` 等阶段。

这样，TUI 和桌面可以有不同界面，却对“运行到哪一步”保持同一套理解。

### 7.2 可恢复不等于把进程冻结起来

一个任务能否跨进程继续，取决于它是否保存了足够的语义状态：

| 状态类型 | 典型内容                            | 恢复方式                 |
| -------- | ----------------------------------- | ------------------------ |
| 事实状态 | Transcript、工具结果、session 状态  | 必须持久化               |
| 目标状态 | Run、Goal、Cron 定义及生命周期      | 持久化后由状态机继续推进 |
| 派生状态 | 当前 Context、工具可见列表、UI 投影 | 从事实与配置重新构建     |
| 瞬时状态 | model stream、外部子进程、内存回调  | 中断后重新执行或显式失败 |

因此，恢复 session 不等于续接原来的网络流或子进程。可靠的长任务设计需要明确哪些状态是事实、哪些可以重建、哪些在中断后必须承认已经丢失。

这也是为什么长任务最终会演化成状态机，而不是一个无限延长的函数调用。

---

## 8. 在仓库中如何实践

增加一种 Agent 能力时，可以按下面的顺序判断落点。

### 第一步：判断是机制还是策略

如果换一个领域仍然成立，例如取消、审批、上下文压缩和会话恢复，才考虑进入 `packages/core/`。只服务某个领域的工具、提示和工作区逻辑，应放进独立 capability。判断标准可以直接参考 `packages/core/CONTRIBUTING.md`。

### 第二步：选择扩展层

- 只需要重新组合现有提示段、工具和权限：新增 preset。
- 需要加入工具实现、动态上下文或领域服务：实现 `CapabilityModule`。
- 只影响界面交互或进程组织：留在 `packages/tui/` 或 `packages/desktop/`，通过 protocol 与运行时通信。

### 第三步：在组合根安装能力

SDK 场景优先通过 `new Engine({ capabilities: [...] })` 显式注入，避免污染进程全局。产品入口可以参考 `packages/tui/src/cli/main.ts`，使用 `registerCapability(...)` 安装进程级能力。`packages/coding/src/index.ts` 是目前最完整的 capability 参考实现。

### 第四步：按边界验证

测试重点不应该只有“模型最后回答对不对”，还应覆盖：

- 工具是否只在目标 preset 下可见；
- executor 是否再次阻止禁用或越界调用；
- 默认权限与审批路由是否正确；
- 提示段是否随相关工具启停；
- 工具失败、用户取消和上下文压缩是否产生正确状态；
- 宿主能否收到完整且顺序正确的流式事件。

这套实践的核心不是“把新功能接进来”，而是让它只接触自己应该负责的那一层。代价是排查问题时需要同时理解 preset、capability、host 和运行配置；收益是新增一个领域能力时，Engine、TurnLoop、安全链路和会话机制仍然可以原样复用。

如果只带走一句话，可以是：

> **Agent 不是会调用工具的 LLM，而是被 Harness 组织和约束的一次持续运行。**
