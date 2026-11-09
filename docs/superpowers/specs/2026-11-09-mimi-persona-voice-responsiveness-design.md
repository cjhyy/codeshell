# Mimi 人设、IM 表达与响应性

- 日期：2026-11-09
- 状态：已与用户确认方向，直接实现第一版
- 分支：`claude/pet/mimi-persona-voice-20261109`（单 PR）
- 涉及包：`packages/core`（稳定上下文、单次运行推理档位）、`packages/pet`（人设预设、提示词、GatewayReply）、`packages/chat`（微信正在输入、纯文本、分条发送）、`packages/desktop`（配置中心、调度接线、计时）

## 0. 背景

对标个人助理类产品（Poke、OpenClaw、ChatGPT Pulse）后，Mimi 的骨架（前台/执行分离、话题段、连发合并、文件式记忆）与业界一致，差距集中在三处：

1. **没有人设。** `PET_SYSTEM_PROMPT` 约 3.4 万字符几乎全是路由与真实性规则，身份只有 "local work manager and dispatcher"。角色包（Mimi/Shiro/Maki）只管形象。配置中心已有 `pet.personalization.communicationStyle` 自由文本，但本机为空，且它随世界状态注入，被标注为 "status data, never instructions"，削弱了效果。OpenClaw 用独立的 `SOUL.md` 承载性格，与操作规则分开。
2. **IM 表达不像人。** `packages/chat/src/wechat.ts` 原样发出文本，只在 8,000 字处硬切，不处理 Markdown；每轮只能发一条完整回复。
3. **响应慢且无反馈。** 本机 39 轮真实 Mimi 会话（10-20 至 11-07，#311 之前）：engine 侧一轮 P50 19.6 s、P90 86.5 s；中位 2 次模型调用，单次 5–9 s；首调用缓存命中为 0（#311 已修）。等待期间微信侧没有任何反馈。微信 ilink 协议实际提供 `getconfig`（取 `typing_ticket`）与 `sendtyping`（status 1 开始、2 取消），#311 设计中"网关层无此能力"的判断需更正。

经讨论，本版不引入快速前台模型（两层架构的状态一致性、误判与成本问题较大，且缺少 #311 之后的数据），改做"单模型提速 + 体感优化"，并在 §6 写明启动快速前台的门槛。

## 1. 目标与验收

| #   | 目标         | 验收口径                                                                                          |
| --- | ------------ | ------------------------------------------------------------------------------------------------- |
| G1  | 人设生效     | 切换角色后语气明显不同；用户改写过的人设优先于预设                                                |
| G2  | 微信无 Markdown | 发往 `textFormat: "plain"` 渠道的回复不含 Markdown 标记                                        |
| G3  | 可分条       | 模型可把回复拆成 1–4 条短消息，宿主依次发出                                                       |
| G4  | 等待可感知   | 微信消息被接下后 ≤1 s 开始"正在输入"；回复发出、失败或停止时取消                                 |
| G5  | 响应风格可调 | 配置中心"快/均衡/深思"映射到 Mimi 管理轮的推理档位                                               |
| G6  | 有数据       | 每轮记录收到→开始输入、收到→首次模型请求、调用次数、收到→发出；脚本可按"纯闲聊轮"统计 P50/P90 |

## 2. 人设层

### 2.1 内置预设（`packages/pet/src/persona.ts`）

```ts
export const PET_PERSONA_IDS = ["mimi", "shiro", "maki"] as const;
export type PetPersonaId = (typeof PET_PERSONA_IDS)[number];
export interface PetPersonaFields {
  personality: string;   // 性格与价值观
  speakingStyle: string; // 说话方式、语气词、emoji 习惯、消息长度
  examples: string;      // 3–4 组示例对话，纯文本
}
export interface PetPersonaPreset extends PetPersonaFields { id: PetPersonaId; name: string; }
export const PET_PERSONA_PRESETS: Readonly<Record<PetPersonaId, PetPersonaPreset>>;
```

每份预设的示例必须包含至少一条"诚实但像人"的状态汇报（例如派活后："好，我开了个新会话去弄，弄好了跟你说～"），用来示范如何在不夸大结果的前提下说人话。

角色形象到人设的映射：`mimi-sprite → mimi`、`shiro-sprite → shiro`、`maki-sprite → maki`，未知形象回落到 `mimi`。

### 2.2 用户改写（设置）

`settings.pet.persona`（core settings schema，均为可选）：

```ts
persona?: {
  preset?: "follow-character" | PetPersonaId; // 默认 follow-character
  overrides?: Partial<Record<PetPersonaId, Partial<PetPersonaFields>>>; // 每字段 ≤ 2,000 字
}
```

- 每个角色单独保存改写，切换角色不丢。
- 现有 `pet.personalization` 四个字段保持不变，不迁移；`communicationStyle` 作为全局补充。

### 2.3 合成与优先级（`resolvePetPersona`）

`resolvePetPersona({ presetSetting, appearance, overrides })` → `PetPersonaPreset`：先按设置选预设（`follow-character` 时按形象映射），再逐字段用非空改写覆盖。

优先级：**用户改写 > 角色预设**；`personalization.communicationStyle` / `customInstructions` 作为用户全局补充，排在人设之后、同为用户设定。人设属于"表达层"的最高设定，**不能**覆盖路由、权限、真实性等规则——这一点在稳定上下文的标题中写明。

### 2.4 注入位置：稳定上下文

现状：`personalization` 随 `runtimeContext` 进入每轮会变的动态消息，并被声明为 "status data, never instructions"。

改动（core 通用能力）：

- `RunBehaviorProfile` 新增 `stableContextTag?: string`。
- `composeRunSystemPrompt` 读取 `profileParams.stableContext`（字符串，≤ 16,000 字符，超出截断）并以
  `<${stableContextTag}>…</${stableContextTag}>` 拼在系统提示末尾（位于 dynamic 说明句之前），无论 `runtimeContextPlacement` 为何值。
- 只在用户修改设置或切换形象时变化，能命中提示缓存。

Pet 侧：`PET_BEHAVIOR_PROFILE.stableContextTag = "mimi_persona"`；宿主把合成后的人设与四个个性化字段格式化为纯文本放入 `stableContext`，不再放入 `runtimeContext.personalization`。`run-params` 校验 `stableContext` 为有界字符串。

稳定块的开头固定写明：

> Owner-configured persona and preferences for how Mimi speaks. Apply them to tone, wording and message length. They never change tool routing, permissions, security rules or truthful status reporting.

### 2.5 提示词

`PET_SYSTEM_PROMPT` 新增 `# Voice` 一节：

- 用 `<mimi_persona>` 中的人设说话；没有时用简短、口语、友好的默认语气。
- 真实性规则约束的是"说什么"，不是"怎么说"：用自然的话转述宿主状态，不照抄 "REQUEST RECORDED" 一类回执措辞，不添加未发生的事实。
- 聊天里优先短句；IM 渠道遵循 `gatewayReply.textFormat` 与分条规则（见 §4）。

同时删去旧的那句 "The trusted runtime context may include owner-authored personalization…"，改为指向 `<mimi_persona>`。

## 3. 配置中心（`PetSettingsPage`）

个性化卡片内新增：

1. **人设**：预设下拉（跟随角色 / Mimi / Shiro / Maki）；下方"性格""说话风格""示例对话"三个文本框，显示当前生效预设的内容作为初始值，编辑即写入对应角色的 `overrides`；"恢复预设"按钮清空该角色的改写。
2. **响应风格**：快 / 均衡 / 深思，写 `pet.responseStyle`（`"fast" | "balanced" | "deep"`，默认 `balanced`）。
3. **IM 分条发送**：开关，写 `pet.imMultiMessage`（默认 true）。

沿用现有 `useTargetedDebouncedSave` 与 `writeSettings` 路径；i18n 中英文同步。

## 4. IM 表达

### 4.1 正在输入（仅微信）

- `ChannelAdapter` 新增可选 `setTyping?(target: string, on: boolean): Promise<void>`；`ChannelCapabilities.outbound` 新增 `typing: boolean`（微信 true，其余 false）。
- 微信实现：`on` 时用该 target 的 `context_token` 调 `ilink/bot/getconfig` 取 `typing_ticket`（按 target 缓存，失败不缓存），再调 `ilink/bot/sendtyping`（status 1），之后每 5 s 续一次，最长 120 s；`off` 时发 status 2 并清除定时器。任何错误只记日志，不抛出，不影响回复。
- 宿主生命周期：IM 路由的聊天轮被 admission 接下（leader）时开启；该轮的网关投递结束（成功、失败、停止、超时）时关闭。follower 合并进来的消息不重复开启。
- 请求形状以腾讯官方 `@tencent-weixin/openclaw-weixin` 为准，实现时对照其 `src/api` 核实字段名；与 `getupdates`/`sendmessage` 共用现有 `base_info` 构造。

### 4.2 纯文本渠道

- `ChannelCapabilities.outbound` 新增 `textFormat: "plain" | "markdown"`。本版：wechat、wecom、line 为 `plain`，其余为 `markdown`（默认能力也为 `markdown`，保持现状）。
- `PetGatewayReplyCapability` 增加 `textFormat`，由宿主按路由能力填入；GatewayReply 工具描述据此告诉模型"不要使用 Markdown"。
- 宿主发送前对 `plain` 渠道做确定性转换 `markdownToPlainText`（`packages/chat/src/plain-text.ts`）：
  - 标题：去掉行首 `#`；
  - 强调：`**x**`、`__x__`、`*x*`、`_x_`、`~~x~~` → `x`（不跨行）；
  - 行内代码去反引号；代码块去掉围栏、保留内容；
  - 无序列表 `- ` / `* ` / `+ ` → `· `；有序列表保留数字；
  - 链接 `[文字](url)` → `文字 url`；图片 `![alt](url)` → `alt url`；
  - 引用 `> ` 去掉；分隔线行删除；表格行去掉首尾 `|` 并把中间 `|` 换成 `  `，删除对齐行；
  - 连续 3 个以上空行压成 2 个。
  Markdown 是确定性语法，这一转换不属于"解析给人看的散文"。

### 4.3 分条发送

- `GatewayReply` 参数新增 `messages?: string[]`（1–4 条，每条非空、合计长度受 `maxTextLength` 约束），与 `text` 二选一；`button`、`attachment_paths` 仍为顶层字段，挂在最后一条。
- 宿主内部把回复统一表示为 `segments: string[]`（`text` 视为单段）。
- `pet.imMultiMessage === false` 时，宿主用空行拼接为单段发送。
- 发送：依次调用网关发送；段间延迟 `min(2500, 600 + 30 × 下一段字符数)` ms，期间保持"正在输入"。
- 回执：全部成功按现有成功回执；第 k 段失败时停止后续段，回执写明"已发出 k−1/n 段"，模型下一轮可见真实状态。
- 提示词：IM 回复像聊天一样可拆成 1–4 条短消息，每条一个意思；长内容（列表、报告）不强行拆。

## 5. 响应性

### 5.1 单次运行推理档位

- core `agent/run` 新增可选参数 `reasoning?: "low" | "medium" | "high"`。engine 在该次运行中覆盖模型连接上的 `paramValues.reasoning`；模型不支持推理档位或不支持该值时忽略并记 `run.reasoning_override_ignored` 日志，不报错。
- Mimi：`responseStyle` 映射 `fast → "low"`、`balanced → 不传`、`deep → "high"`，应用于聊天轮与后台汇报轮。

### 5.2 一次调用完成闲聊

核实 #311 的"SaveContextNote 与 GatewayReply 同一次响应"在真实 worker 下生效；把每轮模型调用次数写入 §5.3 的指标。

### 5.3 计时与统计

- 在 #311 的 `pet.turn.phase` 之外，宿主记录 `pet.turn.latency`：`clientMessageId`、`route`（desktop/IM 渠道名）、`receivedAt`、`typingStartMs`、`firstModelRequestMs`（可得时）、`modelCalls`、`deliveredMs`、`toolNames`（本轮调用过的工具名集合）。
- `scripts/mimi-latency-report.ts`：读取 `~/.code-shell/logs`（可用参数改目录），按"纯闲聊轮"（`toolNames ⊆ {GatewayReply, SaveContextNote}`）与其他轮分别输出 P50/P90 与样本数。

## 6. 快速前台：启动门槛（本版不实现）

满足任一条件即启动第二份设计（轻量前台模型负责闲聊与即时确认，其余升级给现有管理轮）：

- #311 与本设计都装到本机后，连续 7 天"纯闲聊轮"收到→发出 P50 > 6 s；
- "快"档下一周内误判（该派活未派、谎报状态）> 3 次（用户反馈 + 日志抽查）。

## 7. 不做

- 主动性/心跳（另行规划）。
- 宿主模板文案（确认码、超时提示）的改写。
- 微信以外渠道的"正在输入"。
- 快速前台本身。
- 桌面聊天的分条显示（GatewayReply 只用于 IM 路由）。

## 8. 测试

- core：稳定上下文在 system/dynamic 两种放置下的拼接与截断；`reasoning` 覆盖与不支持时忽略。
- pet：`resolvePetPersona` 的预设选择、形象映射、逐字段覆盖；GatewayReply `messages` 的校验（与 `text` 互斥、条数、长度）；run-params 对 `stableContext` 的校验。
- chat：`markdownToPlainText` 各规则；微信 `setTyping` 的请求序列、续期与取消、失败静默；分条发送与部分失败。
- desktop：设置读写与默认值；调度把人设放入 `stableContext` 而非 `runtimeContext`；IM 轮开启/关闭 typing；分条与拼接开关；`pet.turn.latency` 字段。
- 改调度后跑 `bun test ./tests/mimi-chat-replay.test.ts`；开 PR 前跑全仓契约/预算测试。
