# 第 5 章 · Context & Prompt

> 覆盖:`context/manager.ts`(532)`compaction.ts`(617)`tool-result-storage.ts`(367)`prompt/composer.ts`(210)+ `instruction-scanner.ts` `section-cache.ts`(概览)
> 上下文管理(防爆窗口)+ system prompt 装配。每 turn 的 `pre_check` 调 `manageAsync`(ch02 §3.1)。

---

## 1. 职责

- **ContextManager**:多层压缩编排,把 messages 控制在 `maxTokens` 内。
- **compaction.ts**:具体压缩算法(microcompact / snip / window / summary / dropOldestRounds)+ tool_use/result 配对保护。
- **tool-result-storage.ts**:大 tool_result 落盘 + 占位替换,"冻结决策"保 prompt cache 前缀稳定。
- **PromptComposer**:双链装配 —— system chain(runtime header + tools + behavior + skills)+ messages chain(CLAUDE.md/memory 作 userContext 前置)。

## 2. 关键类型 / 入口

- `ContextManager.manage`(同步)/`manageAsync`(异步,带 LLM 摘要)。`recordActualUsage` / `shouldReactiveCompact` / `checkLimits`。
- 默认配置:`maxTokens=200k`、`compactAtRatio=0.85`、`summarizeAtRatio=0.92`、`maxToolResultChars=30k`、`microcompactFloorRatio=0.7`。
- 压缩 tier:`micro | summary | window | snip | emergency`(`CompactStrategy`)。
- `adjustIndexToPreserveAPIInvariants`(compaction 35):**所有切片的护栏** —— 向前扩 start 使每个保留的 tool_result 的 tool_use 也在范围内。
- `DEFAULT_PERSIST_THRESHOLD=50k`、`PER_MESSAGE_AGGREGATE_CAP=200k`、`PREVIEW_SIZE=2k`。
- `PromptComposer.buildSystemPrompt / buildUserContextMessage / buildSystemContext`。

## 3. 逻辑主线

### 3.1 严重度阶梯(manage / manageAsync)

```
Tier 0a persistLargeToolResults  — 大 result 落盘 + 占位(给真路径,模型可 Read 回)
Tier 0b truncateToolResults      — 单个 >30k 的 head/tail 截断兜底
Tier 0c applyToolResultBudget    — 单消息聚合 >100k:最大的先截
Tier 1  microcompact (>floor 0.7) — 清旧的可压缩 tool_result 内容为指纹
── 估 token,按 gate 升级 ──
Tier 2  summary (≥0.85) / snip   — manageAsync:有 summarizeFn → LLM 滚动摘要;否则 snip
                                    manage(同步):有 lastSummary 回放;否则 snip
Tier 2b window (≥0.90)           — snip 不够 → 保头 + 尾 N(40%)
Tier 3  emergency (≥0.92)        — windowCompact(keep 6) 最后兜底
```

- **microcompactFloorRatio=0.7 的意义**:70% 以下不动 tool_result(否则模型被迫重读刚看过的文件);注释详述这是修过的"130k 每 turn churn"bug。
- **hybrid token 估算**(estimateTokensHybrid):有上次 API 真实 promptTokens 作基 + 之后新增消息的估算,避免纯 char/4 误差。

### 3.2 compaction 算法

- `microcompact`(238):构 id→name / id→input 映射;反向走,只数**可压缩 round**(COMPACTABLE = Read/Glob/Grep/Bash/PowerShell/NotebookEdit/WebFetch/WebSearch/REPL,排除编排类);超过 keepRecentN 的清成指纹 `[Old tool result cleared — Read file_path=...]`(带 args,免盲重读)。
- `snipCompact`(86):保头 N + 尾 M,中间换 marker。`windowCompact`(119):保 messages[0] + 尾 N。
- `applySummaryCompaction`(492):摘要包 `<anchored-summary>` 标记(滚动摘要 + resume 可恢复)+ 列被引用文件路径 + 给 transcript 路径。
- `dropOldestRounds`(567):按 API round 分组丢最旧(渐进 prompt-too-long 恢复,ch02 §3.1 catch 路径用);丢后首条是 assistant 则补 user 占位。

### 3.3 tool-result 落盘"冻结决策"(tool-result-storage)

- 一个 tool_use_id 一个文件(`<transcriptDir>/tool-results/<id>.txt`),`wx` flag 幂等(同 id 同内容不重写)。
- **冻结**:`seenIds` 一旦评估,命运固定;`replacements` 存**确切**替换串,重应用是 Map 查找不重读文件 → 保证 byte-identical → prompt cache 不失效。
- resume 时 `reconstructContentReplacementState` 从消息里认 `<persisted-output>` 标记重建状态。
- Pass1 决定持久化(per-result >50k 或 per-message 聚合 >200k 选最大的);Pass2 重写。**与 microcompact 协调**:已被 micro 清成 `[Old tool result cleared` 的不回滚(337,防两者每 turn 互相覆写)。

### 3.4 PromptComposer 双链

- **system chain**(getSections):runtime_header → custom_system(可选)→ tool_definitions(把每个工具 name+desc+schema 拼进 prompt!)→ behavior(preset section 文件)→ skills(scanSkills 过 disabled)→ append_system。经 SectionCache 缓存。
- **messages chain**:`buildUserContextMessage` 把 CLAUDE.md(scanInstructions/combineInstructions)+ memory(MemoryManager.buildMemoryContext)包成 `<system-reminder>` 当首条 user 消息(ch01 step16 unshift)。
- `buildSystemContext`:preset.injectGitStatus 时跑 3 个 execSync(branch/status/log,各 5s 超时)。

## 4. 逻辑理顺问题

- ⚠️ **tool defs 同时进 system prompt 文本 AND 各 provider 的 `tools` 字段**。`getSections` 的 `tool_definitions`(composer 149)把每个工具的 name+desc+完整 JSON schema 拼进 systemPrompt 文本;而 OpenAI/Anthropic client 又通过 `convertTools` 把同样的工具传 `tools` 字段(ch03)。**工具定义被发送两遍**(一遍当散文、一遍当结构化 tools)。这是巨大的 token 浪费(几十个工具的 schema ×2),且模型可能困惑。**需确认是否有意**(也许 behavior prompt 引用工具名需要散文版?但完整 schema 重复没必要)。**疑似重大 token 冗余。**

- ⚠️ **`buildUserContextMessage` 每次 run 重算 `Today's date`**(composer 64,`new Date()`)。这条 `<system-reminder>` 当首条 user 消息,**内容每天变** → Anthropic prompt cache(ch03 只 cache system prompt,不 cache messages)不受影响,但若将来 cache messages 前缀,日期变动会击穿。当前无害,记录。另:与 ch01 ctx-seed 一样依赖 wall-clock,resume 当天/跨天行为不同。

- ❓ **manage(同步) vs manageAsync 的 Tier 2 不对称**:manageAsync 有 LLM 摘要(滚动 + anchored),manage 同步版只能"回放 lastSummary"或 snip。TurnLoop 的 pre_check 用 manageAsync(ch02 281),而 ch01 `forceCompact` 调的是 `manage`(同步,1814)。**用户手动 /compact 拿不到 LLM 摘要,只有 snip/window** —— 手动压缩质量低于自动压缩。需确认是否预期(也许手动 compact 想要快)。

- ❓ **gate 重叠**:`compactAtRatio=0.85`、`windowGate=0.90`、`emergencyGate=summarizeAtRatio=0.92`。三个 gate 在 4 行内(0.85/0.90/0.92),一次 manage 可连跳 snip→window→emergency。但 manageAsync 的 LLM 摘要成功会**直接 return**(365),不进后面阶梯;失败才落阶梯。即:摘要成功 = 只摘要;摘要失败/无 = snip→window→emergency 全套。逻辑 OK,但 emergency `windowCompact(6)` 只保 6 条尾,可能砍掉刚摘要保留的 anchored summary(若摘要那条在前 6 条外)。❓ 摘要 + emergency 同 turn 不会发生(摘要 return 了),但**下一 turn** anchored summary 可能被 emergency 砍掉 → 滚动摘要链断裂。需验证 anchored summary 位置是否总在 emergency keep-tail 内。

- ❓ **`shouldReactiveCompact` 在 ch02 §3.1 被 `% 2000 === 0` 条件包住基本不触发**(已记 ch02)。这里确认 `shouldReactiveCompact` 本身实现正确(emergency gate),问题在调用侧。即使触发也只 warn 不压缩。**整个 reactive compaction 机制实质未生效。**

- ❓ **`deduplicateToolCalls` / `recordToolResult` / `toolCallHashes`**(manager 491-531)定义了工具调用去重(同 args 调 ≥2 次返缓存),但**没有调用方** —— TurnLoop / executor 都没调 `deduplicateToolCalls`。去重靠的是 InvestigationGuard(ch04),这套 hash 去重疑似**死代码**。需确认。

- ❓ **`truncateToolResults` 的 `modified` 标志是闭包共享 + map 内修改**(manager 437-453):一旦某 block 被截,`modified=true`,**后续所有消息**都返回 `{...msg, content: newContent}`(即使该消息没改),因为三元判断的是全局 `modified`。功能上无害(newContent 是同样的 map 结果),但**会不必要地复制所有后续消息对象**(破坏引用相等,可能影响下游 memo)。轻微低效 + 引用语义 bug。

- ❓ **`applyToolResultBudget` 默认 100k,但 manageAsync Tier0c 不传参**(manager 198/301)→ 用 100k。而 `PER_MESSAGE_AGGREGATE_CAP=200k`(tool-result-storage 持久化用)。两个"单消息聚合上限"(100k 截断 vs 200k 持久化)语义重叠且阈值不一致:持久化在 200k 才触发落盘,但 budget 在 100k 就截断 —— **持久化还没来得及救(50k-200k 区间),budget 已先截掉超 100k 的**。顺序是 0a 持久化先跑、0c budget 后跑,所以 50k+ 的单块已落盘换成 ~2k 占位,聚合很难再到 100k。逻辑上 OK 但阈值关系绕,记录。

- ❓ **`estimateTokens` 用 char/4 × 4/3 overhead**(compaction 21),与 ch02 ctx-bar 的 `estimateTokens`、ch01 ctx-seed 的手算 char/4 是**三套估算**。hybrid 用真实值校准缓解,但冷启动/估算路径仍是粗估。记录多套估算并存。
