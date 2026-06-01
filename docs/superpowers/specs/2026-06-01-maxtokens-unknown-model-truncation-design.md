# 未知模型 maxTokens 兜底 & 输出截断报错 — 设计

> 状态：设计中。两个独立 bugfix，同一根因家族（`?? 8192` 默认在不同场景咬人）。
> 关联：`docs/research/session-isolation-state.md` §8.4 方向 C；memory `project_llm_retry_maxtokens_bugs`。

## 背景与根因（已实锤）

写一份长文档时，`gpt-5.5` 会话把输出顶满 8192 token（`stopReason:length`，`duration_ms:226926`），Write 工具的参数 JSON 被腰斩 → 报误导性的 `Missing required parameter: file_path`，文档没写成。

根因链（已逐行核实）：
1. `resolveMaxOutput("gpt-5.5")`（`onboarding.ts:467`）返回 `undefined`：表里无 `gpt-5.5`（只有 gpt-5/mini/nano），且因无 `vendor/` 前缀连 OpenRouter 兜底分支都进不去。
2. → `maxOutputTokens` 为 undefined → 一路到 `client-base.ts:47` 的 `this.maxTokens = config.maxTokens ?? 8192`，被吞成 8192。
3. → gpt-5.5 本可远超 8192，被腰斩，工具参数截断。

底层其实已具备「不发 max_tokens」的能力：`clampMaxTokens(requested, cap)`（`clamp-max-tokens.ts:15`）`requested === undefined → return undefined`。问题是 `?? 8192` 让 undefined 永远传不下来。

## 修复 1（治本·通用）：查不到上限 → 不猜值

**原则**：解析不到模型真实输出上限时，**不发明一个值**（不抬高常量、不针对单模型补表）。交端点用自己的默认上限；仅 Anthropic（`max_tokens` 必填）保留保守默认。对齐 Codex 与 session-isolation §8.4 方向 C。

**改动点**：

1. `client-base.ts:47` —— 去掉 `?? 8192` 的「吞 undefined」行为。`maxTokens` 字段类型改为 `number | undefined`，未知时保持 `undefined` 一路向下，让 provider 决定。
   - 注意：这是 `readonly maxTokens: number`（client-base.ts:13），要放宽为 `number | undefined`，并核对所有读它的地方。

2. **OpenAI provider**（`openai.ts:217,224-226`）：`clampMaxTokens(options.maxTokens ?? this.maxTokens, cap.maxOutputTokens)` 现在可能得到 `undefined`（当两者皆无且 cap 未知）。当结果为 `undefined` 时，**整个 `tokenLimit` 字段对象置空 `{}`**——即请求体里既不发 `max_tokens` 也不发 `max_completion_tokens`，由端点用自身上限。现有 clamp 逻辑（防 384000 串扰）保持不变：有 cap 就 `min`，有 requested 无 cap 就原样发。

3. **Anthropic provider**（`anthropic.ts:81,123`）：`max_tokens` 必填，不能省。`options.maxTokens ?? this.maxTokens ?? <保守默认>`——保留一个 Anthropic 专用保守默认（如 4096，或按 `resolveMaxOutput` 对 Anthropic 模型本就有值的事实，多数情况 this.maxTokens 会有值）。仅当真的全无时才用保守默认兜底。

**与现有 clamp 的兼容**：不动 `clamp-max-tokens.ts`，它已正确处理 undefined。只改「上游别把 undefined 变成 8192」+「OpenAI 侧 undefined 时省略字段」。

## 修复 2（止血）：截断 → 清晰报错

**原则**：当一次请求以 `stopReason === "length"`（OpenAI 的 `finish_reason:"length"` / Anthropic 的 `stop_reason:"max_tokens"`，已在 provider 归一化为 `stopReason`）结束、**且该 turn 包含未闭合/校验失败的工具调用**时，报一个明确的「输出超出 max output tokens 上限被截断」错误，而不是让残缺 JSON 走到 `validation.ts:30` 报误导性的 `Missing required parameter: file_path`。

**范围**：本期**只加清晰报错，不做 CC 式的升档重试**（升档另立后续）。修复 1 把上限放开后，写文档这类场景基本不会再触顶；修复 2 是兜底，保证万一触顶时错误信息不误导。

**改动点**（待实现时定最终落点，候选）：
- 在工具参数校验失败的路径上，若本次 LLM 响应的 `stopReason` 是 length/max_tokens，则把错误信息替换/包装为「输出被 max output tokens 截断，工具参数不完整。考虑提高该模型的 maxOutputTokens 或分段写入」。
- 需要把「本次响应的 stopReason」传到校验报错处，或在 turn 收尾时检测 `stopReason===length && 有 tool_call` 的组合并提示。具体接线点在实现阶段确认（engine turn-loop 收尾 vs executor 校验处）。

## 测试计划

先写红测试锁住行为，再实现（TDD）。

**修复 1**：
- `clampMaxTokens` 单测已可能存在，补：`requested=undefined, cap=undefined → undefined`（应已通过，确认契约）。
- OpenAI provider：构造请求体时，`maxTokens` 与 `cap.maxOutputTokens` 皆未知 → 断言请求体里**既无 `max_tokens` 也无 `max_completion_tokens`**。
- OpenAI provider：`maxTokens` 已知或 cap 已知 → 断言照常发、且不超过 cap（守住 384000 不回归）。
- Anthropic provider：全无值 → 断言仍发一个保守 `max_tokens`（不能省）。
- 回归：`resolveMaxOutput("gpt-5.5")` 仍返回 undefined（不强行塞值），但链路末端不再 fallback 到 8192。

**修复 2**：
- 模拟一次 `stopReason:"length"` + 工具参数 JSON 不完整 → 断言报出的错误信息是「截断/超出 max output tokens」语义，**不是** `Missing required parameter: file_path`。
- 对照：`stopReason:"stop"` + 真的缺参数 → 仍报原来的 `Missing required parameter`（不误伤正常校验）。

## 不做 / 边界

- **不做**：CC 式的 `stop_reason:max_tokens → 升档到 64000 重试`（`tengu_max_tokens_escalate`）。留作后续，本期修复 1 放开上限后已大幅降低触顶概率。
- **不做**：针对 `gpt-5.5` 单独补 `KNOWN_MAX_OUTPUT` 表项（治标不治本，用户明确否决）。
- **不做**：抬高 `?? 8192` 这个常量本身（用户否决「只是换个更大的猜测值」）。
- **不动**：`clamp-max-tokens.ts` 与现有的 384000 串扰防护逻辑，仅与之兼容。
- **不碰**：session 隔离 / model per-session 化（那是独立的大改动，见 session-isolation-state.md 方向 2）。
- **关注回归点**：`client-base.ts` 的 `maxTokens` 从 `number` 放宽为 `number | undefined` 后，所有读取处都要核对（grep `this.maxTokens` / `.maxTokens`）。这是本次最容易引入回归的改动。
