# 提示缓存：工具前缀冻结与追加式工具发现

- 日期：2026-11-11
- 基线：`main` @ `2d1c0b638`（行号以此为准，动手前先 `git diff` 核对）
- 状态：步骤 1–3 已实现，离线验收与 CI 集成中；步骤 4 保持可选未开工
- 实测证据与探针：`docs/todo/prompt-cache-probes-20261111/`

## 1. 问题

所有厂商的提示缓存都按前缀匹配。CodeShell 现在有四处会在会话中途改写请求前缀，每发生一次，其后的历史缓存全部失效：

| # | 改写源 | 位置 |
|---|---|---|
| A | `ToolSearch` 的 `select:` 只返回回执，schema 在下一步追加进顶部 `tools` | `tool-system/builtin/tool-search.ts:101`、`tool-system/run-tool-surface.ts:96` |
| B | 每个模型步骤重新组装目录，失去资格的工具从 `tools` 中间消失、获得资格的出现。触发源：Goal 工具按 `hasGoal` 显隐、计划模式过滤、MCP 连接变化 | `engine/run-tooling.ts:99-103`、`engine/turn-loop.ts:1153`、`tool-system/builtin/index.ts:1044,1060`、`tool-system/tool-policy-snapshot.ts:43` |
| C | 每个新 run 按任务文本路由初始工具，后续用户消息命中关键词就往顶部追加 | `engine/run-tooling.ts:76-81` |
| D | 系统提示里列出当前可用工具名，随 B 一起变化 | `prompt/composer.ts:323-331` |

（以上路径均在 `packages/core/src/` 下，下同。）

另有一处独立的小缺口：

| # | 缺口 | 位置 |
|---|---|---|
| E | 经 OpenRouter 的 Claude 没有工具断点，系统提示一变工具段也重写 | `llm/prompt-cache.ts:94-101`、`llm/providers/openai.ts:1349` |

## 2. 实测结论（2026-11-11）

方法：每条线路三次请求——冷启动、追加一轮（对照）、第三次做变更。数字是第三次请求的"缓存命中 / 输入总量"。

### 2.1 改顶部工具 vs 历史追加

| 线路 | 顶部加一个工具 | 历史里追加发现结果 | 追加后模型的调用 |
|---|---|---|---|
| OpenRouter → Claude Sonnet 5 | 0 / 8570 | 8451 / 8647 | `CallTool` 正确 |
| OpenRouter → GPT-5.6 Luna | 0 / 5051 | 5051 / 5184 | 正确 |
| OpenRouter → DeepSeek V4 Flash | 0 / 5841 | 5632 / 5990 | 正确 |
| OpenRouter → Kimi K2.7 | 96 / 5382 | 5312 / 5469 | 正确 |
| OpenRouter → GLM 5.2 | 161 / 5290 | 5217 / 5354 | 正确 |
| OpenRouter → Grok 4.6 | 128 / 5138 | 4992 / 5192 | 正确 |
| DeepSeek 直连 | 256 / 5796 | 未测成（探针未回传思考内容） | — |
| OpenRouter → Gemini 3.8 Flash | 无结论 | 无结论 | 正确 |

结论：**改写顶部工具在所有测到的线路上都让历史缓存归零；追加式发现都保住了缓存。** 因此引擎层修复不需要按厂商区分。

### 2.2 OpenRouter 上 Claude 的工具断点

工具段约 5250 token。第二次请求只改系统提示。

| 断点位置 | 改系统提示后命中 |
|---|---|
| 不打工具断点（现状） | 0 / 8395 |
| 工具条目顶层（与 `type`、`function` 同级） | 5250 / 8394 |
| `function` 对象内部 | 0 / 8382（被忽略） |
| Anthropic 格式端点 `/api/v1/messages`，最后一个工具上 | 5250 |

### 2.3 其他观察

- Claude 原生引用（`defer_loading` + `tool_reference`）经 OpenRouter 的 `/api/v1/messages` 被接受，缓存保住，模型直接用真实工具名调用。延迟工具是否真的没进初始上下文，未验证。
- Gemini 隐式缓存多数请求命中为 0；加显式断点后每次请求都重新写一份缓存且计费翻倍。
- OpenRouter 默认就有承载方粘性，不需要额外发 `session_id`。带了 `session_id` 仍观察到两次中途切换，属不可控噪音。

### 2.4 局限

每格 1–2 次；工具 schema 很简单，复杂参数下 `CallTool` 准确率未测；没有直连 Anthropic 和直连 OpenAI 的凭据，这两条线路未测。

## 3. 设计

### 3.1 一条不分厂商的规则

> 一个**缓存周期**内，发给模型的 `tools` 数组和系统提示逐字节不变；所有变化只往消息末尾追加。

缓存周期在以下时刻结束并开始新周期（此时缓存本来就是冷的，可以重排顶部）：

1. 摘要压缩完成（`context/manager.ts:308-332` 的 `applySummaryCompaction` 路径）。
2. 会话的模型或线路发生变化。

其余情况（跨 run、会话恢复、Goal/计划模式切换、MCP 重连）都不结束周期。

### 3.2 状态模型

扩展 `SessionToolSelection`（`types.ts:314`），升到 `version: 2`：

```ts
export interface SessionToolSelection {
  version: 2;
  /** 冻结的顶部工具，有序。本周期内只读。 */
  names: string[];
  /** 本周期内通过 ToolSearch 发现的工具，可经 CallTool 调用，不进顶部。 */
  discovered: string[];
}
```

- `normalizeSessionToolSelection`（`tool-system/run-tool-surface.ts:4`）接受 v1，按 `{ names, discovered: [] }` 升级。读不懂时返回 `undefined`，**不要抛错，也不要清空已有状态**。
- 周期结束时：`names = names ∪ discovered`（保持 `names` 原顺序，新增的排在后面），`discovered = []`。
- `discovered` 与历史可能分叉（回滚、分支、截断）。这是无害的：执行器始终按真实 schema 校验参数；`ToolSearch` 的 `select:` 幂等，每次都返回完整 schema，不做"已加载"短路。

### 3.3 `RunToolSurface` 改动

文件：`tool-system/run-tool-surface.ts`

| 方法 | 现在 | 改为 |
|---|---|---|
| `select(names)` | 加入 `selectedNames`，下一步进顶部 | 加入 `discovered`；顶部不变 |
| `snapshot()` | `selectedNames ∩ 当前目录` | 返回冻结的 `names`；定义取**冻结时的副本**，不随目录变化 |
| `updateCatalog(defs)` | 更新目录并把初始工具并入选择 | 只更新资格目录；首次调用且无持久化状态时才确定 `names` |
| 新增 `isCallable(name)` | — | `name ∈ names ∪ discovered` 且当前有资格 |
| 新增 `rebase()` | — | 周期结束时调用：合并 `discovered` 进 `names`，并用当前目录的定义刷新冻结副本 |

冻结副本需要跨 run 保持逐字节一致。顶部工具的定义按"名字 → 当前目录定义"在每个 run 开始时重建即可，前提是定义本身是确定的；**如果某个工具的描述或 schema 在两次 run 之间会变，那是单独的改写源，要在 4.2 的断言里暴露出来再处理**，不要在本方案里静默吸收。

失去资格的顶部工具**保留在 `tools` 里**，由执行器拒绝（`tool-system/executor.ts:383` 已有资格闸门，`:303` 已有计划模式闸门）。

### 3.4 `CallTool`

新文件：`tool-system/builtin/call-tool.ts`

```ts
export const callToolDef: ToolDefinition = {
  name: "CallTool",
  description:
    "Call a tool whose schema was returned by ToolSearch. " +
    "Pass the exact tool name and an args object that matches that schema.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from ToolSearch." },
      args: { type: "object", description: "Arguments matching the tool's schema." },
    },
    required: ["name", "args"],
  },
};
```

约束：

- 定义是静态的。**不得**往 `name` 上加动态枚举，那会改写顶部。
- 只在目录里有 `ToolSearch` 时注册进顶部；与 `ToolSearch` 同进同出。

解包：新增一个纯函数（放在 `tool-system/` 下的新文件，**不要**加进 `turn-loop.ts`，它已经 2520 行）：

```ts
/** CallTool → 真实工具调用；其余调用原样返回。 */
export function resolveModelToolCall(
  call: ToolCall,
  surface: RunToolSurface,
): { call: ToolCall } | { error: string };
```

- 调用点：`engine/turn-loop.ts:1729`，在 `response.toolCalls` 截断之后、进入队列和执行器之前。之后的权限、hook、计划模式、并发分类（`executor.ts:152`）、审批、超时、追踪看到的都是真实工具名。
- 解包后的 `ToolCall` 保留原 `id`，新增可选字段 `wireToolName?: "CallTool"`，供落盘和界面区分。
- 历史里的 assistant 消息**保持线上原样**（仍是 `CallTool` 调用），不改写。
- 错误分支，均返回工具错误结果、不执行：
  - `name` 不是字符串，或指向 `CallTool` 自身 → 说明用法。
  - `name` 无资格 → 沿用 `executor.ts:386` 的文案。
  - `name` 有资格但不在 `names ∪ discovered` → 提示先 `ToolSearch select:<name>`。
  - `args` 是字符串 → 尝试一次 `JSON.parse`，得到对象则继续；否则报错。
  - `args` 不是对象 → 报错，并在错误里附上该工具的 schema。
- 宽松处理：模型直接用真实名字调用一个 `discovered` 里的工具（没走 `CallTool`）时，照常执行。把 `executor.ts:395-406` 的闸门从"本步已发给模型"改成 `surface.isCallable(name)`。

### 3.5 `ToolSearch` 改动

文件：`tool-system/builtin/tool-search.ts`

- `select:` 分支（`:101-114`）改为返回完整定义：每个选中工具输出名字、描述、`inputSchema` 的 JSON，再加一行用法："用 `CallTool` 调用，`name` 为工具名，`args` 按 schema 填写"。
- 格式确定、紧凑；相同输入必须产生逐字节相同的输出（会进缓存前缀）。键顺序沿用定义自身的顺序，不要重排。
- 输出预算：`MAX_OUTPUT_LENGTH = 8192`（`:15`）装不下 20 个 schema。`select:` 分支单独用更大的预算（建议 24_000 字符）。超出时按顺序装到装不下为止，剩余的明确列出名字并说明"未加载，请单独 select"。这些未加载的名字**不得**进入 `discovered`。
- 工具描述（`:23-28`）与系统提示里的说明（`prompt/composer.ts:330`）同步改成新语义。

发现结果不能被上下文管理改写，否则既丢 schema 又破坏前缀：

- 微压缩：`ToolSearch` 不在 `COMPACTABLE_TOOL_NAMES`（`context/compaction.ts:401`），无需改；加一条测试锁住。
- 大结果落盘换预览（`context/manager.ts:780` `persistLargeToolResults`）、`applyToolResultBudget`（`compaction.ts:763`）、`maskOldObservations`（`:722`）、`truncateToolResult`（`:838`，30k 上限）：逐个确认对 `ToolSearch` 结果的行为，需要的地方加豁免。24k 的预算是为了留在 30k 截断线以内。

### 3.6 三个改写源的处理

**B. 资格变化**

- Goal 工具（`builtin/index.ts:1044,1060`）：去掉 `hasGoal` 的可见性条件，始终在目录里；没有 Goal 时在工具处理函数或执行器里返回错误。
- 计划模式：`tool-policy-snapshot.ts:43` 的过滤不再作用于冻结的顶部（顶部已冻结，过滤只影响资格目录）；拒绝靠 `executor.ts:303`。
- MCP 晚连上的工具：进入资格目录，通过 `ToolSearch` 可发现，不进顶部。
- 顶部工具对应的 MCP 服务断开：schema 留在顶部，调用时由执行器报不可用。

**C. 每轮路由**

`initializeRunToolSurface`（`engine/run-tooling.ts:55`）：只有会话没有持久化 `toolSelection` 时才调用 `routeInitialTools`。已有状态时直接用持久化的 `names`。

**D. 系统提示里的工具名**

`prompt/composer.ts:323-331` 的 `tool_definitions` 段改为只列冻结的顶部 `names`，并去掉对资格目录的依赖。周期内不变。可发现的工具不在系统提示里枚举，靠 `ToolSearch` 关键词搜索。

如果实现时发现 Goal 状态还通过别的途径改写系统提示（入口 `engine/engine.ts:2337` `composeRunSystemPrompt`），记录下来单独处理，不在本方案范围内。

### 3.7 厂商差异的唯一位置

差异全部由 `resolvePromptCachePolicy`（`llm/prompt-cache.ts:78`）返回的 `PromptCachePolicy` 表达。引擎不读其中任何厂商信息；provider 客户端不自行判断厂商，只照策略翻译。

本方案对它的改动：

1. **删除 OpenRouter 的 Claude 分支。** `:86-102` 两个分支合并为一个，统一返回 `ANTHROPIC_BREAKPOINTS`（四个）和 `layoutVersion: "system-tools-stable-rolling-v2"`。删掉 `OPENROUTER_ANTHROPIC_BREAKPOINTS`。
2. **客户端翻译工具断点。** `llm/providers/openai.ts:1349` `convertTools` 增加 `policy` 参数：策略为 `anthropic-explicit` 且断点含 `"tools"` 时，在**最后一个工具条目的顶层**加 `cache_control: { type: "ephemeral" }`。必须是顶层，放进 `function` 里无效（见 2.2）。`anthropic.ts:557-573` 已有等价逻辑，不用改。
3. **新增字段，为后续留口，本期只有一个取值：**

```ts
export interface PromptCachePolicy {
  // ...已有字段
  /** 发现结果在请求里的呈现方式。 */
  toolDiscovery: "call-tool";   // 后续可加 "tool-reference"
}
```

不新增会话亲和字段，维持现状（只给 OpenAI 模型发 `prompt_cache_key`）。

## 4. 落地步骤

每步一个 PR，可独立合并。

### 步骤 1：OpenRouter 的 Claude 补工具断点（独立，先做）

- 改 `llm/prompt-cache.ts`、`llm/providers/openai.ts`（3.7 的第 1、2 点）。
- 更新 `llm/providers/openai-openrouter-anthropic-cache.test.ts`：它现在应断言三个断点，改为四个，并断言标记在工具条目顶层。
- `openai.ts` 已 1554 行，注意行数上限；超了就把缓存标记相关逻辑拆到新文件，**不要调高上限**。
- 验收：`tool_marker_probe.py` 的 `chat/top` 场景行为由真实客户端复现——改系统提示后工具段仍命中。

### 步骤 2：冻结顶部 + `CallTool` + 追加式发现

- 3.2–3.5 的全部内容。
- 压缩完成处调用 `surface.rebase()`。
- 验收见 5.1、5.2。

### 步骤 3：修掉 B、C、D

- 3.6 的全部内容。
- 验收见 5.3。

### 步骤 4（可选，另开方案）：Anthropic 原生引用

前置问题，未解决前不要开工：

1. 延迟工具是否真的不进初始上下文（用工具段大小对比输入 token 验证）。
2. 经 OpenRouter 的 Claude 现在走 chat completions；原生引用需要 Anthropic 格式。要么让这条线路改走 `anthropic.ts` + OpenRouter 的 `/api/v1/messages`，要么验证 chat completions 格式是否透传这两个字段（未测）。
3. `defer_loading` 的工具不能带 `cache_control`，断点要改挂到最后一个非延迟工具。
4. 中途换模型时，历史里的 `tool_reference` 要能降级渲染成 schema 文本。

### 不做

- Gemini 显式断点：实测每次请求重写缓存且计费翻倍，保持不加。
- OpenAI Responses API 的原生工具搜索：需要新写一个 provider 客户端，收益已被 `CallTool` 覆盖。
- OpenRouter `session_id`。

## 5. 验收

### 5.1 前缀逐字节断言（不联网，步骤 2 的硬性门槛）

新增测试：用假模型跑一个会话，记录每次发给 provider 的 `{ tools, systemPrompt, messages }`。

1. 预热若干轮。
2. 连续三批 `ToolSearch select:`，每批后跟一次 `CallTool`。
3. 断言：每次请求的 `tools` 和 `systemPrompt` 序列化后与第一次**逐字节相同**；每次请求的 `messages` 以前一次的 `messages` 为严格前缀。

### 5.2 `CallTool` 行为

- 解包后权限规则、hook、计划模式、并发分类按真实工具名生效（各一条测试）。
- 3.4 列出的每个错误分支各一条测试。
- 落盘再恢复：历史里的 `CallTool` 调用原样回放，`discovered` 恢复后工具仍可调用。
- v1 的 `toolSelection` 能升级；损坏的状态不抛错、不清空。
- 压缩后：`discovered` 并入 `names`，下一次请求的顶部包含它们，模型可直接用真实名字调用。

### 5.3 改写源

在 5.1 的会话里依次插入：设置 Goal、完成 Goal、进入计划模式、退出计划模式、MCP 服务晚连上、带路由关键词的第二条用户消息。每个事件之后断言 `tools` 和 `systemPrompt` 仍逐字节不变，且被禁止的工具调用被执行器拒绝。

### 5.4 真实端点

用 `docs/todo/prompt-cache-probes-20261111/cache_probe.py` 的方法，通过真实 CodeShell 会话复现"长历史预热 → 三批工具发现"，按线路各跑一遍，记录每步的缓存命中 token、延迟、调用是否成功。对照基线是 2.1 的"顶部加工具"一列。看响应里的承载方名字，排除中途切换造成的假失败。

### 5.5 调用准确率

2.1 只测了一个两参数的简单工具。上线前挑 10 个真实的复杂工具（嵌套对象、枚举、可选参数多的 MCP 工具），对比"直接进顶部调用"与"经 `CallTool` 调用"的首次调用成功率，至少覆盖 Claude、GPT、DeepSeek、GLM、Kimi 各一个模型。成功率明显下降的模型，把它的常用工具放进初始顶部来缓解。

## 6. 仓库约束（实现时遵守）

- 测试命令用 `bun test packages tests`，不要裸跑 `bun test`。
- 新的 TS 测试登记到 `tests/suites.mjs`。
- 行数有上限（默认 1500，老文件取整上限只降）。`turn-loop.ts`、`engine.ts`、`openai.ts` 都贴近或超过上限，新逻辑放新模块，超了就拆，不要调数字。
- 不要跑 `bun run format`，只对改过的文件跑 prettier。
- 组合相关的 golden fixture 禁止重新生成。
- 开 PR 前跑全仓契约与预算测试（`index.exports`、`ipc-contract`、`architecture-budgets`）。
- 改了 core 后跑下游包测试前先重建 core 的 dist。
- 若给 `Engine` 新增必填 setter，会打破十几个手写的假 Engine 测试桩；尽量用可选项。

## 7. 探针说明

`docs/todo/prompt-cache-probes-20261111/`：

- `cache_probe.py`：2.1 的实验。用法 `python3 cache_probe.py <场景,场景> [线路关键词…]`，场景有 `top`、`append`、`hist-top`、`hist-append`；线路关键词含 `native` 时加跑原生引用。
- `tool_marker_probe.py`：2.2 的实验，无参数。
- `results-long-history.txt`：长历史一轮的原始输出。其中 Claude 的几行用的是随机词填充，模型以 `refusal` 结束、没有发起调用，但缓存数字有效。2.1 表里 Claude 的数字和 2.2 的全部数字来自换成正常文本后的重跑，原始输出没有存档，重跑脚本即可复现。

两个脚本从 `~/.code-shell/settings.json` 读取本机已配置的 OpenRouter 和 DeepSeek 凭据，只发合成内容，不打印密钥。一次完整运行消耗约几十万输入 token（都是便宜模型）。

已知探针缺陷：DeepSeek 直连的 `append` 场景会因未回传 `reasoning_content` 报 400，这是探针问题，不是结论。


## 8. 实现记录（2026-11-11）

已实现步骤 1–3。原始探针保留，不把旧探针结果当成本次实现的实测结果。

### 与原方案相比补齐的边界

- v2 状态额外保存可选 `frozenDefinitions`。仅保存名字不能在进程重启、MCP 已断开的情况下还原旧 schema；冻结副本保留 JSON 键序，执行资格和参数验证仍以当前目录／注册表为准。
- 已保存的冻结副本（包括空列表）是本周期完整快照。冷启动时缺席的 MCP 工具随后恢复，不会填进顶部；需重新发现后调用，下一次压缩再提升。
- v2 同时保存 `cacheIdentity`，对 provider、协议、端点、模型和连接 key 做哈希，避免端点中的私密字段落入该状态。模型或线路变化会合并发现列表并刷新定义。
- 摘要之外，手动归档、notes rollover、实际丢弃历史的 snip/window/emergency、超长请求恢复同样会移走发现结果，因而也启动新周期。无效果的压缩不重建前缀。压缩后同时重建系统提示中的工具列表，避免下一轮 run 再次改写。
- 开始新主题前的笔记切换、撤销指令导致的历史清空也会启动新周期。压缩依据实际历史替换判断，而非仅看 token 是否减少；缓存摘要替换历史后 token 不降的情况同样受保护。
- `CallTool` 仅由原生模型请求的工具表与 `ToolSearch` 配对装配，不注册到产品 capability 目录，也不修改既有组合 golden。外部工具 Host 的既定 allowlist 不会因此被扩大。真正执行前仍经过当前资格、权限、hook、计划模式、参数验证和超时等原有闸门。
- 流式工具事件等包装器参数完整后只发布一次真实工具名；普通流式、重试回退和长输出续写保持相同规则，原始模型历史仍保留 `CallTool`。
- 失败的 `complete_goal`／`cancel_goal` 结果不再触发 Goal 终结；成功的真实工具结果才可更新持久状态。
- 最新主线的 Goal 状态说明已在尾部动态上下文，未发现需另外移走的 Goal 系统提示内容。工具门控的行为提示和工具名索引均使用冻结顶部集合。
- ToolSearch 完整 schema 豁免落盘预览、字符与 token 截断、整批结果预算；已有微压缩与浏览器 observation masking 不改写它们，测试锁定此行为。

### 验收边界

- 无网络假 provider 的真实 Engine 测试覆盖预热、三批发现／CallTool、逐字节 tools/systemPrompt、逐条消息严格前缀、JSON 落盘恢复、复杂参数和直接真实名调用。严格 messages 前缀断言覆盖同一 run 的连续步骤；跨 run 比较冻结 tools/systemPrompt。已有非持久动态上下文会在 run 边界重新组装，本改动不声称整个 messages 数组跨 run 也逐字节相同。
- 生命周期测试覆盖 Goal、计划模式、晚到工具、后续关键词、压缩、模型／线路切换；执行器测试覆盖解析错误、权限、审批、hook、当前 schema 和并发。
- 真实付费端点缓存计数（5.4）及五类模型 × 十种复杂工具的准确率矩阵（5.5）尚未重新执行，属于上线前验收，不能用离线测试代替。直连 Anthropic／OpenAI 也没有新增实测结论。
- 现有执行器参数验证器仍保持既定契约：使用当前注册 schema 检查顶层必填项和基本类型；本改动没有声称新增完整的递归 JSON Schema 验证。
- 实现基于最新主线，已没有 `tests/suites.mjs`；新测试由 CI 路径自动收录。验证使用 `scripts/run-bun-test-shard.mjs`／`bun run test --shard` 的隔离 HOME runner，不使用设计稿中的旧测试命令。
