# 第 7 章 · 支撑子系统

> 覆盖(概览级,非逐行):`hooks/*` `skills/*` `capability-control/*` `run/*`(2542)`arena/*`(9057)`plugins/*`(2824)
> 这些是挂在主循环旁边的能力扩展层。本章给每个子系统定位 + 接线点 + 逻辑理顺问题,不展开每个文件。

---

## 1. 各子系统职责与接线

### 1.1 Hooks(`hooks/`,765 行)
- `HookRegistry`:按 priority 降序的责任链。`emit` 聚合:data 合并、messages 累加、decision/updatedInput/updatedPrompt **last-write-wins**、additionalContext 追加、continueSession 任一为真即真、`stop` 中断链。
- **事件全集**(events.ts):on_session_start/end、on_agent_start/end、user_prompt_submit、on_turn_start/end、on_stop、pre/post_tool_use、on_tool_start/end、file_changed、on_permission_check、post_compact、notification。
- 接线:Engine 注册(plugin 80 → shell 50 → SDK 0),emit 点散在 engine.ts + turn-loop.ts + executor.ts(前 6 章都见过)。
- hook 错误 `console.error` 吞掉,不崩主循环(registry 86)。

### 1.2 Skills(`skills/`,351 行)
- 只有 `scanSkills` + `invalidateSkillCache`。扫 `.code-shell/skills` 等目录,过 disabledSkills/disabledPlugins。
- 渲染(prompt listing)在 `tool-system/builtin/skill-prompt.ts`(buildSkillListing,被 PromptComposer ch05 调)。
- 真正"调用 skill"是 `builtin/skill.ts`(skillTool),dispatch 时再查 disabled(ch04 ToolContext.disabledSkills)。

### 1.3 Capability-control(`capability-control/`,628 行)
- 统一控制面:把 4 种能力(builtin tools / MCP / skills / plugins)投影成同构 `CapabilityDescriptor[]`,desktop/CLI 的"开关能力"UI 后端。
- `CapabilityService.list()`:4 个 `projectXxx` 合并。`setEnabled(id, on)`:读 descriptor 内联的 `control`,路由到对应 settings key —— **不按 kind 分支**(注释强调)。
- 依赖全注入(registry/settings/scanSkills/readInstalledPlugins/resolveBuiltinToolNames),可无磁盘单测。

### 1.4 Run(`run/`,2542 行)— 受管代理生命周期
- `RunManager`:submit/start/resume/cancel/get/list/getEvents/attach/recover/shutdown。比 ChatSession 更重的"任务"抽象(有 RunStore 持久化 / RunQueue / Checkpoint / Artifact / Heartbeat / RunLock / Evaluator)。
- `EngineRunner` 包 Engine 执行一个 run;`FileRunStore` 落盘;`VALID_TRANSITIONS` 状态机。
- 与 ChatSession 并存:ChatSession = 交互式 UI tab(ch06),Run = 受管/可恢复/可评估的后台任务。

### 1.5 Arena(`arena/`,9057 行)— 多模型协作
- `Arena`:证据驱动流水线(planner → evidence → strategy/lens → tool-select → 参与者独立研究 → claim 注册 → 交叉评审 → 辩论 → 裁决 → 共识)。
- `IterativeArena`:多模型创作循环(tournament → critique-revise)。
- 经 `builtin/arena.ts`(arenaTool,30min 超时)进主循环;也可独立用。最大的单一子系统。

### 1.6 Plugins(`plugins/`,2824 行)
- 安装器(CC + Codex 双格式 detectFormat)、marketplace 管理、installedPlugins.json(V2)。
- 插件可贡献:hooks(loadPluginHooks)、agents(loadPluginAgents)、MCP(loadPluginMcp/mergePluginMcpServers)、commands(pluginCommandsLoader)、skills。
- 接线:Engine 构造期 loadPluginHooks + getAgentDefinitions 含 pluginAgentDirs(ch01);disabledPlugins 全链路过滤。

### 1.7 子代理注册(`builtin/agent.ts` + `agent-registry.ts`)
- Agent 工具:同步 spawn(返回文本)或 `run_in_background`(asyncAgentRegistry,MAX_BACKGROUND_AGENTS 上限,完成时发 notification hook)。
- **双保险禁套娃**:engine.ts spawn 剥工具 + agent.ts 运行时查 `ctx.isSubAgent`(ch01/ch04 已记)。

## 2. 逻辑理顺问题

- ⚠️ **`HookRegistry.emit` 的 decision 聚合是 last-write-wins**(registry 58)。priority 降序遍历,**后执行的(低 priority)覆盖先执行的(高 priority)decision**。注释说"priority order 决定谁 own override",但既然高 priority 先跑、低 priority 后跑且覆盖,**实际是低 priority 赢** —— 与"高 priority 优先"的直觉相反。plugin hook(80)的 decision 会被 SDK hook(0)覆盖。❓ 确认这是否预期(可能想让用户 SDK hook 压倒 plugin?但那应文档化为"低 priority = 最终决定权",当前注释含糊)。

- ⚠️ **ch04 的 clampHookDecision 防提权,但 emit 的 last-write-wins 让多 hook 链的最终 decision 不可预测**。executor 拿到的是 aggregated.decision(最后一个设它的 hook)。若一个 hook 设 deny、另一个设 ask,最终取后跑的。安全性上 clamp 只比对 classifier,不管链内覆盖顺序 —— **多 hook + 权限 decision 的交互需要更明确的合并语义**(取最严?当前取最后)。标记为权限链语义疑点。

- ❓ **Run 与 ChatSession 两套 Engine 包装并存**(run/ vs protocol/chat-session)。都管"跑 Engine + 取消 + 流",但 Run 有 Store/Queue/Checkpoint/Lock/Heartbeat/Evaluator,ChatSession 只有 FIFO 队列。**职责边界**:何时用 Run、何时用 ChatSession?二者能否复用底层 turn 执行?目前看是平行实现,潜在重复。需确认调用方(TUI/desktop 用哪个)。

- ❓ **Arena 9057 行、47 文件,是 core 第二大子系统但相对独立**。它复用 LLM 层(modelPool 选参与者)但有自己的一整套 phases/strategies/ledger/claim 状态机。**与主 TurnLoop 几乎无共享** —— arena 自己驱动多模型调用。这意味着 arena 内若有 max_tokens / 模型切换问题(ch03 §session-isolation 主题),需**单独核对** arena 的 LLM 调用路径是否也踩同样的 per-model 残留坑。标记为跨子系统核对项。

- ❓ **capability-control `setEnabled` 调 `this.list()` 再 find**(service 79)。每次开关一个能力都重新投影全部 4 类(扫 skills 磁盘 / 读 installedPlugins / listToolsDetailed)。批量开关 N 个 = N 次全量扫描。低效,记录。

- ❓ **skills 的 disabled 在三处过滤**:PromptComposer(listing,ch05)、skillTool dispatch(ch04)、capability-control list。三处都读 `settings.disabledSkills` 但 ch01 记过 **sub-agent 的 readDisabledLists 返回空**(子代理不过滤 skills)。即子代理 prompt 里仍列出用户禁用的 skill。是 ch01 已记的"子代理减面"取舍,这里确认其在 skills 链的体现。

- ❓ **plugin hooks 优先级 80 + emit last-write-wins**(§2 第一条)→ plugin 的 decision 总被更低优先级覆盖,但 plugin 的 messages 是**累加**的(不被覆盖)。即 plugin 注入的提醒会保留,但 plugin 的 permission decision 易被用户 hook 推翻。混合语义(messages 累加 vs decision 覆盖)对 plugin 作者不直观。记录。

- ❓ **后台子代理 `asyncAgentRegistry` 是 module 级**(agent-registry.ts)。多 session 并发跑后台子代理共享一个 registry + MAX_BACKGROUND_AGENTS 上限 —— **跨 session 的后台代理共池**,一个 session 跑满会饿死另一个 session。与 §session-isolation 的"全局单例串台"同类。需确认上限是否 per-session(看起来是 worker 全局)。

- ❓ **Run 的 recover()**(RunManager 307)从 RunStore 恢复中断的 run。崩溃恢复路径与 ch06 SessionManager.resume + ch02 dropOldestRounds 恢复是**不同层的恢复机制**。Run 恢复任务级状态,Session resume 恢复对话,turn-loop 恢复 context。三层恢复的交互(一个崩溃的后台 Run 内含一个 resume 的 session)未在单文件内体现,标记为待整体核对的恢复语义。

---

## 全系列收尾:跨章节重复实现清单(供后续重构参考)

通读 7 章后,反复出现的"同一意图、多套实现"模式(每条都已在对应章节标注):

1. **token 估算** ×3+:engine ctx-seed 手算 char/4(ch01)、turn-loop estimateTokens(ch02)、compaction estimateTokens char/4×4/3(ch05)、hybrid 校准(ch05)。
2. **orphan tool_use 修复** ×3:turn-loop.patchOrphanedToolUses(ch02)、patch-orphaned-tools.ts(ch01 resume)、Transcript.repairToolResultPairs(ch06)。
3. **并发工具调度** ×3:StreamingToolQueue(ch02 实际用)、executeToolsOverlapped(ch02 死代码)、executor.executeAll(ch04 疑似死代码)。
4. **Bash 只读判定** ×2:executor.isReadOnlyBashCommand(plan 模式,ch04)、permission.classifyBashCommand(权限,ch04)—— 白名单不一致。
5. **plan-mode 工具白名单** ×2:engine.planModeAllowed(ch01)、executor.allowedInPlan(ch04)—— 内容 drift。
6. **tool-call 循环** ×2:TurnLoop(ch02)、engine.runDreamLoop 手搓(ch01)。
7. **Engine 包装/生命周期** ×2:ChatSession(ch06)、run/EngineRunner+RunManager(ch07)。
8. **maxContextTokens=200_000 / maxTokens 8192 默认值**散落多处硬编码(ch01/ch03/ch05)。

最高优先核对(影响正确性,非仅整洁):
- **ch03 OpenAI 流式 stopReason 恒为 "stop"** → max_tokens 续写在流式下不触发(可能真 bug)。
- **ch05 tool defs 双发**(system prompt 散文 + tools 字段)→ 大量 token 冗余。
- **ch06 handleConfigure 缺 per-session model** → §session-isolation 串台根因(已有专篇)。
- **ch02/ch05 reactive compaction `% 2000` 条件基本永不触发** → 机制实质失效。
- **§2 hook decision last-write-wins** → 权限链合并语义不明确。
