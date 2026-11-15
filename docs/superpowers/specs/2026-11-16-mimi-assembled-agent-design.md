# Mimi 组装化：模块提供能力，preset 显式选择

- 日期：2026-11-16
- 状态：方案，待主人审阅
- 基线：`main` @ `c0c6193eb`（0.11.0-rc.2 之后）
- 相关：`docs/todo/agent-module-resolved-composition-design.md`（AgentModule / ResolvedComposition，A–D 已实现）、`docs/architecture/05-core-runtime-settings-composition.md`、`2026-11-09-mimi-dispatch-notify-proactivity-design.md`

## 0. 一句话

Mimi 不再靠"pet 模块的工具注入到所有会话 + 每轮按来源决定哪些工具可见"来成形，而是一个由 preset `mimi` 显式组装出来的 Agent：模块只声明自己提供什么，preset 决定这个 Agent 用什么，Mimi 独有的助理能力以模块的形式插进来，行为差异走组装和 hooks，不在 core 里写 Mimi 特判。

## 1. 现状问题（代码核实）

组装体系（`packages/core/src/composition/`）已经能让模块声明工具、preset、提示词段、动态上下文、hooks、行为档（behavior profile）和服务，但 Mimi 并没有被"组装"：

1. **隐式注入**：pet 模块只贡献 21 个工具和一个行为档，不贡献 preset。`presetInjectedTools()`（`composition/resolve-preset.ts`）的规则是"不贡献 preset 的模块，其工具注入当前 preset"，所以这 21 个工具进了 worker 里**每一个**会话。普通工作会话能不能看到 Mimi 的工具，只靠每个工具自己的可见性判断。给 pet 模块加一个 preset，会反过来改变所有工作会话的工具——两份本该独立的配置被绑在了一起。
2. **工具注册表由 worker 的种子 preset 决定**：desktop worker 用默认 preset（`terminal-coding`）建一个种子 Engine，所有会话共享它的工具注册表（`cli/agent-server-stdio.ts`）。会话自己的 preset 只影响提示词段和权限规则，不影响有哪些工具。
3. **Mimi 拿到的是"编码助手 + 一层人设"**：Mimi 的运行请求不带 preset，所以她用的是 worker 默认的 `terminal-coding`：base / orchestration / coding / tone 提示词段，目录是 git 仓库时还有 git 状态，然后再叠上 `PET_SYSTEM_PROMPT`。她真正需要的能力集合从来没被显式写出来过。
4. **能力随每轮变化**：Mimi 的工具是否可见取决于 `profileMeta`（`petHostActionKinds`、`petGateway`、`petSessions`、`petOutboundTargets`……），而这些由 desktop 每轮按消息来源重新计算（桌面 / IM / 群聊 / 跟进唤醒 / 是否主人回合，`pet-dispatch-service.ts`、`pet-notice-turn-gate.ts`）。同一个会话，这一轮和下一轮能用的工具、提示词都可能不同。实测 Mimi 会话每一轮的 `systemPromptDigest` 与 `toolCatalogDigest` 都不一样，连相隔一分钟的两轮也是。
5. **hooks 选不了、也看不见是谁**：模块 hooks 在每个 Engine 上都注册（含子代理），preset 无法选择；hook 与动态上下文提供者拿不到会话种类、preset、行为档和这一轮的输入，所以 Mimi 的"每轮世界状态"只能由 desktop 拼成一个字符串（`profileParams.runtimeContext`）塞进去。

## 2. 目标与不做

目标：

- **G1 显式**：每个 Agent 的能力集合（工具、提示词段、hooks、动态上下文、行为档、服务）由它的 preset 一次选定；同一份选择结果决定所有这些东西。
- **G2 隔离**：新增一个没被选中的能力，现有会话的工具、提示词、hooks、行为完全不变。同一个 worker 同时跑 Mimi 和 coding，两者只拿到各自选中的能力。
- **G3 稳定**：同一个会话里，能力集合不随这一轮从哪来而变；每轮不同的事实只作为输入进入"每轮上下文"。
- **G4 Mimi 可插**：Mimi 独有的助理能力（派活、IM、提醒、跟进、记忆、手机遥控）都是模块，Mimi 的 preset 选它们；工作会话侧的"回报 Mimi"能力也是一个可选模块。
- **G5 依赖可查**：preset 选了某个能力而它依赖的模块、宿主服务缺失时，在组装阶段报错，并指出缺的是哪一项。

不做：

- 不另做缓存机制。G3 做到之后，系统提示词和工具清单本来就稳定。
- 不做通用的 `when` 条件语言、preset 继承图和子 preset。
- 不重构已安装插件 / MCP 的加载与授权；preset 只声明"是否使用这些来源"。
- 不要求 SDK 调用方改写：不传 preset 时的默认行为保持不变。
- 不碰上下文窗口提交（`NewContext` 请求与实际提交、segment 与窗口解耦、外部运行时自动 reset），那是独立的一项。

## 3. 模型

### 3.1 模块：只声明"我提供什么"

沿用现有 `AgentModule` / `AgentEngineContributions`，改两点：

- 工具贡献只剩一种：`{ tool, tags? }` 进入目录，**只有被 preset 选中才生效**。删除 `presetInjectedTools()` 与 `always` 旁路（目前没有生产模块用 `always`）。
- 新增可选的依赖声明 `requires?: { modules?: string[]; hostServices?: string[] }`，挂在模块或单个能力上，供 G5 校验。

hooks、动态上下文提供者、提示词段一律带名字进入目录，不再"注册即全局生效"。

### 3.2 Preset：决定"这个 Agent 用什么"

preset 从"工具名清单 + 提示词段名"扩为一个能力选择：

```ts
interface AgentPreset {
  name: string;
  tools: string[]; // 显式工具名，组装时校验存在
  promptSections: string[];
  hooks?: string[]; // 模块 hooks 按名字选择
  contextProviders?: string[]; // 每轮上下文提供者按名字选择
  profile?: string; // 绑定的行为档（如 "pet"）
  services?: string[]; // 模块私有服务
  sources?: { plugins?: boolean; mcp?: boolean; skills?: boolean; memory?: boolean };
  extends?: string; // 至多一层：在另一个 preset 基础上增删，避免复制粘贴
}
```

规则：

- 只用静态 TypeScript 声明，复用现有编译器（`composition/compiler.ts`）。
- 选中的名字不存在、或依赖缺失 → 组装失败，错误列出缺失项。
- `extends` 只允许一层，展开后再校验。
- 宿主可以用一个**有序清单**给已有 preset 追加能力（例如 desktop 在装了 pet 模块时给工作会话的 preset 追加 `mimi-link`），不另起一套宿主 preset 产品体系。清单本身也参与组装校验。

### 3.3 每个 Engine 拥有自己的有效能力集合

- 共享注册表只存**定义**（避免每个会话重复构建）。每个 Engine 创建时，按自己会话的 preset 从共享注册表 fork 出"有效工具集合"，不再由 worker 的种子 preset 决定。
- hooks、上下文提供者、服务同样按 preset 生效；子代理按父会话的 preset，再套用现有的子代理限制。
- 会话的 preset 在创建时确定并落盘；旧会话没有记录时按会话种类推出（`pet` → `mimi`，其余 → worker 默认），保证恢复后行为不变。

### 3.4 每轮输入与每轮上下文

把"这一轮从哪来、主人在不在、这轮允许哪些宿主动作、世界状态"等**每轮事实**和"能力"分开：

- 运行请求带一个不透明的 `runInput`（由宿主填，模块定义 schema 并校验），取代 Mimi 专用的 `profileParams.runtimeContext` 字符串和遗留的 `petRuntimeContext` 字段。
- hooks 与上下文提供者的上下文扩为 `{ sessionId, sessionKind, preset, profile, runInput, cwd, workspace }`。
- 新增一个 hook 输出 `turnContext`（文本块），写入现有的"动态上下文消息"——它已经排在用户消息之后、压缩前会被剥掉，正好用来放每轮事实。这是现在唯一缺的 hook 能力。
- **工具可见性只依赖会话级、慢变的事实**（preset、会话种类、宿主是否配置了某项服务）。每轮的权限（这轮能不能改规则、能不能发 IM、是不是主人回合）一律在**调用时**由运行期服务和宿主拒绝，工具始终在清单里。工具描述写得通用，不在描述里泄露具体渠道或会话。

### 3.5 用 hooks 改变行为

模块 hook 是改 Mimi 行为的主要手段，例如：

| hook                                 | Mimi 模块里用来做什么                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `user_prompt_submit` / `turnContext` | 注入每轮世界状态、来源、待补报提醒、最近的晨报                                         |
| `pre_tool_use`                       | 每轮权限：非主人回合拒绝改规则、改设置；按 `runInput.hostActions` 拒绝未授权的宿主动作 |
| `post_tool_use`                      | 宿主动作结果回写（现在由 `reportResult` 做）                                           |
| `on_turn_end` / `on_stop`            | 回合收尾；以后要把 desktop 侧的收尾逻辑迁进来时用                                      |

行为档（`PET_BEHAVIOR_PROFILE`）保留，只承担 Engine 级开关：`maxTurns`、`contextStrategy`、关计划模式、关 MCP、记忆范围等。人设与规则提示词改为 `mimi-core` 模块的提示词段，由 preset 选择。

## 4. Mimi 的模块拆分

| 模块                      | 提供                                                                                                       | 依赖                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `mimi-core`               | 人设与路由规则提示词段、`CurrentTime`、`pet` 行为档、每轮世界状态提供者                                    | 宿主服务 `petHost`                 |
| `mimi-dispatch`           | `DelegateWork`、`Sessions`、`ManageSessions`、`ControlLongTask`、`WatchSession`、`BindConversationSession` | `mimi-core`                        |
| `mimi-im`                 | `Gateway`、`GatewayReply`、`SendMessage`、`MobileRemote`                                                   | `mimi-core`、宿主服务 `imGateway`  |
| `mimi-memory`             | `Memory`（加上 core 的 `SaveContextNote`、`NewContext`、`SearchHistory`）                                  | `mimi-core`                        |
| `mimi-notices`            | `FollowUps`、`ManageFollowUp`、`Notices`、`Triggers`、`ManageTrigger`、`NotificationSettings`              | `mimi-core`、宿主服务 `petNotices` |
| `mimi-link`（工作会话侧） | `ReportToMimi`、`NotifyMe`、`RequestMimiDelivery`                                                          | 宿主服务 `petHost`                 |

preset：

- `mimi` = `mimi-core` + `mimi-dispatch` + `mimi-im` + `mimi-memory` + `mimi-notices`，绑定行为档 `pet`，`sources: { mcp: false, plugins: false }`，**不含** coding 提示词段和 git 上下文。
- 工作会话的 `terminal-coding` / `general` 不变；desktop 在宿主清单里给它们追加 `mimi-link`。`NotifyMe` 由此成为工作会话一开始就加载的工具（今天它是延迟加载，实测模型要先 `ToolSearch` 两次才找到它，第 7 分钟才建上规则）。
- 外部运行时（Codex / CC 上的 Mimi）的工具目录改为"preset `mimi` 的工具 ∩ 有外部声明的工具"，替代手写的 `PET_MANAGER_TOOL_CATALOG`。

## 5. Desktop 侧改动

- `PetDispatchService` 的每次运行带 `preset: "mimi"` 和 `runInput`（来源、是否主人回合、允许的宿主动作、世界状态），不再拼 `runtimeContext` 字符串，也不再计算每轮工具可见性所需的 `profileMeta`。
- 提醒工具的"主人回合"门禁（`pet-notice-turn-gate.ts`）改为 `pre_tool_use` 拒绝 + 宿主读写端的现有校验；群聊回合里工具仍在清单中，但调用被拒并给出原因。读取类工具在非主人回合同样拒绝，保持 #356 的隐私边界。
- 收尾轮、汇报轮、启动回执轮沿用同一个 preset，用 `runInput` 区分；启动回执轮现在的 `toolAllowlist: []` 改为 `runInput.hostActions = []` 加调用时拒绝，而不是清空工具。

## 6. 迁移与兼容

- **旧会话**：`kind: "pet"` 的会话恢复时推出 preset `mimi`；工作会话推出 worker 默认 preset。恢复后的能力与迁移前一致（Work→Mimi 回报、desktop coding 的差异、子代理限制都保留）。
- **SDK 与 CLI**：不传 preset 时行为不变；不再存在"装了某个模块，所有会话的工具都变了"。
- **组合 golden**：改为按 preset 各记一份（`harness-min`、`general`、`terminal-coding`、`mimi`），每份包含工具、提示词段名、hooks、提供者、行为档；有意重生成并逐项审阅，不整体覆盖。
- **core 里的 pet 残留**：`petRuntimeContext` / `petWorkspaces` 遗留字段、`EngineResult.petWorkDelegation`、`normalizedSessionKind` 对 `pet` 的特判，迁到 `mimi-*` 模块或通用字段后删除。

## 7. 分期

| 期                | 内容                                                                                                                                                              | 验收                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A 显式选择**    | 删 `presetInjectedTools()` 与 `always`；preset 显式选工具 / hooks / 提供者 / 行为档；每个 Engine 按自己的 preset fork 有效工具集合；依赖校验；按 preset 的 golden | G2 两条测试通过；现有会话行为不变（回放与契约测试全过）                                                                                                |
| **B 每轮输入**    | `runInput` 通道；hook / 提供者上下文扩展；`turnContext` 写入动态上下文消息                                                                                        | 一个测试模块能按会话种类注入每轮文本，不改系统提示词                                                                                                   |
| **C Mimi 模块化** | 拆出 `mimi-*` 模块、preset `mimi` 与 `mimi-link`；desktop 改发 preset 与 `runInput`；门禁改为调用时拒绝；外部运行时目录由 preset 推出                             | Mimi 不再带 coding 提示词与 git 上下文；不同来源的两轮，Mimi 的工具清单与系统提示词逐字节相同；群聊回合调用提醒工具被拒；`NotifyMe` 在工作会话首轮可用 |
| **D 清理**        | 删 core 里的 pet 残留与遗留字段；更新架构文档 05 / 06 / 14                                                                                                        | 全仓契约 / 预算测试通过                                                                                                                                |

A 是 core 改动，B 是 core 的一个小扩展，C、D 只动 pet 与 desktop。A、B 可以先合，C 合入前 Mimi 的现状不变。

## 8. 验收标准（总）

1. 新增一个未被任何 preset 选中的能力：所有现有会话的工具、提示词、hooks、行为完全不变。
2. 同一个 worker 同时运行 Mimi 与 coding 会话：两者只获得各自 preset 选中的能力。
3. 同一个 Mimi 会话，桌面一轮、IM 私聊一轮、群聊一轮：工具清单与系统提示词相同；差异只出现在每轮上下文里，权限差异表现为调用被拒。
4. preset 选了缺失的能力或依赖：组装失败并指出缺失项。
5. 旧 pet 会话、旧工作会话恢复后行为与迁移前一致。

## 9. 风险

- **组装改动面大**：涉及共享注册表、会话恢复和多个宿主（desktop worker、CLI、server、自动化的 `RunManager`）。A 期必须一次把所有入口迁完，不能留下仍走隐式注入的旁路。
- **golden 变动**：按 preset 拆开后基线整体变化，需要有意重生成并逐项比对。
- **工具始终可见带来的模型行为变化**：群聊回合里 Mimi 可能尝试调用随后被拒的工具。工具描述要写明"只有主人本人可以要求"，拒绝原因要能直接转述。
