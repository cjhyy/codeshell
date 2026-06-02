# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的**——已完成的请移除。

## 待办

| 状态 | #   | 任务                          | 备注 / 关键落点 |
| ---- | --- | ----------------------------- | --------------- |
| 🟡 | 1   | 跨 MCP/builtin/skill/plugin 统一能力注册表 | **后端已全部完成**:core `capability-control/`(`types`/`project`/`service` + TDD 测试)、desktop `capabilities-service.ts` 薄转发、`index.ts` 两个 `ipcMain.handle`(`capabilities:list` / `capabilities:setEnabled`)。spec:`docs/superpowers/specs/2026-05-29-capability-control-design.md`。**剩**:② 一个**用它的统一「能力」UI**(替代/并列现有分散的 插件/技能/MCP tab)—— 产品决策,需定方向后再做。**注**:① preload 桥已提交(`preload/index.ts`/`types.d.ts` 含 `listCapabilities`/`setCapabilityEnabled`,在 `b98760e` 前已落盘);能力页另有改进(`ab1e9a0`)。⚠️ **2026-06-02 工作区有并行 session 正在改 `capability-control/`+`engine.ts`+`CapabilitiesOverviewSection.tsx`(未提交)**——动这块前先确认对方进度,改 core 必 rebuild |
| 🟡 | 2   | 多 session 上下文/串台 + 慢 修复 | 辅助任务模型已落地。**剩**:见「遗留 / 待确认」 |
| 🔴 | 3   | Goal 模式重设计(无人值守前置) | 现状 goal = 一个 string + 想停时调「裁判 LLM」猜 met,**无预算护栏、goal 不进上下文、解析失败即静默放行**——对无人值守长程任务(automation D6 写型任务)几乎不可用。**P0**(安全底线,优先):① 加 token/时间预算护栏(超预算强制停,`TerminalReason` 加 `goal_budget_exhausted`);② 完成判定改「模型自报 `complete_goal` 优先,裁判兜底」,失败不再静默放行成 completed。**P1**:goal 进上下文(`<goal_context>` user 角色伪装)、状态机(Active/Blocked/Complete/BudgetLimited)、headless 下主动 continuation。落点:`hooks/goal-stop-hook.ts:73-133`、`engine/turn-loop.ts:450-514`、`types.ts:227`。设计:`docs/goal-mode-redesign-2026-06-02.md`。**P0 是 automation Phase 5(写型任务)的依赖** |
| 🔴 | 4   | 内建工具「凭证/能力可见性守卫」 | **问题**:`WebSearch`(没配 search provider key)、`GenerateImage`(没配 `kind:"openai"` provider)现在都**无条件暴露**进工具表,只在执行时返回错误字符串——「没成功之前不算 builtin 工具」未做到。**已敲定设计(2026-06-02 brainstorm,尚无独立 spec,可写)**:做**通用守卫**而非新工具种类。① `BuiltinTool` 接口加可选 `isAvailable?: (cwd)=>boolean`,**没声明=永远可见**(其余工具零影响);② 各工具复用已有解析函数导出布尔判定——web-search.ts `isWebSearchAvailable = resolveSearchConfig(cwd).source!=="none"`、generate-image.ts 把 `resolveOpenAIProvider` 包成 `isGenerateImageAvailable`;③ builtin/index.ts 给这两条挂 `isAvailable` + 导出派生 `BUILTIN_TOOL_GUARDS: Map<name,(cwd)=>bool>`。**关键过滤落点 = `engine.ts:1203-1216` 的 `toolDefs` 组装处**(每条消息重算,**非** registry 注册层——后者启动算死、需重启进程)。prompt「# Available Tools」(composer.ts:157-167)与 LLM native tools 都源自这同一 `toolDefs`,sections/*.md 没硬编码工具名,**过滤一处全跟随一致**;permission rule 惰性、不在表里不会被调,**无需动**。**约束**:仅「已配 key」即可用(不持久化 verified,不动 SearchConnectionsPanel);配好后**下一条消息**生效、重建 session 可接受、**不重启 Electron**(共享 toolRegistry 是 seedEngine 启动建一次、所有 session 复用,所以必须在 run() 过滤而非注册层)。执行层 `source:"none"`/`no provider` 兜底保留。参照同区域 #1 手动能力开关 + memory `project_agent_capability_overview`(kind:"agent" 投射能力总览)。**改 core 必 rebuild** |
| 🔴 | 6   | 配置热重载「第二层」:push 给运行中的 session | **背景**:settings 改动现在只能「下个新 session 生效」——**第一层已落地**(2026-06-02):`agent-server-stdio.ts` engineFactory 每次 fire 调 `freshSettings()`=`settingsManager.load()` 重读磁盘(含兜底回退启动快照),个性化/append/preset/mcpServers/instructions 全走 `live`,新 session 无需重启 worker。**剩第二层**:让**正在运行的** session 也热生效。**对标 Codex**(源码核实):写事件触发,非文件监听——客户端 `config/batchWrite{reloadUserConfig:true}` → 写盘 → host 重读一次新快照 → 遍历所有 live thread 逐个 `refresh_runtime_config(snapshot)`;session 侧**只换 user 层**(`with_user_layer_from`,保留 per-session/request override)+ 重建派生(清 skills/plugins 缓存、重建 hooks、重算 tool_suggest、emit on_config_changed)+ `Arc::ptr_eq` 守卫防 in-flight 竞态;**不打断当前 turn,下个 turn 生效**。**我们要做的对应件**:① EngineConfig 引入「用户层 vs session 覆盖」区分(否则 push 会冲掉子 agent appendSystemPrompt 拼接/per-session permissionMode);② 一个 `Engine.refreshRuntimeConfig(snapshot)` 入口 + PromptComposer 缓存失效/工具列表/MCP 重算;③ desktop settings 写完发 IPC 通知 worker reload(`ChatSessionManager` 持有 live sessions,遍历推送)。**价值=通用基础设施**:个性化 + MCP 增删 + skills/plugins 开关 + 模型切换 + hooks 全可复用同一 push 入口(参见已搁置记忆 `project_config_hot_reload` 方案A、`project_settings_hooks_memory_dream`)。**需独立 brainstorm+spec**(回答:分层模型、派生状态重建清单、in-flight 语义、IPC 协议)。Codex 参照:`codex-rs/app-server/src/request_processors/config_processor.rs`、`core/src/session/mod.rs` `refresh_runtime_config`。**改 core 必 rebuild** |
| 🔴 | 5   | 泛化推理强度(reasoning/thinking)配置 | **现状**:底层 `rules.ts` 已识别 6 种推理形态、已分别翻译 OpenAI 平铺 `reasoning_effort` vs OpenRouter 嵌套 `{reasoning:{effort}}`,但卡 4 处:① settings 只存 `enum(enabled/disabled)`,存不下档位/budget(`schema.ts:118,149`);② 运行时硬编码 `enabled→"medium"`(`openai.ts:264`),gpt-5.5 的 xhigh 永远用不到;③ **Anthropic client 完全没实现 thinking,配了无效(bug)**;④ `ModelSection.tsx` 无任何思考 UI。**设计(复用 capability-control 范式)**:core 出 `reasoningControlFor(kind,model)` 纯函数→告诉 UI 渲染 `toggle`(DS/智谱)/`effort`下拉(GPT/Gemini/Grok/Mistral/Groq/OR)/`budget`数字框(Claude4.0~4.5)/`adaptive`灰条(Claude4.6+)/`none`;settings `thinking`→富结构 `ReasoningSetting` 联合;去掉 medium 硬编码读真实档位;**Anthropic 一并补实现**。用户需求场景:切 ds-pro 出开关、切 gpt 出档位下拉、OR 上的 gpt 也是下拉(底层字段 core 自翻 UI 无感)。**向后兼容**:未发布,直接改旧值不留迁移。**分阶段**:P0 core(schema+描述符+去硬编码,TDD)/P1 Anthropic 补实现/P2 ModelSection UI/P3 OR 的 max_tokens·enabled 透传。spec:`docs/superpowers/specs/2026-06-02-reasoning-config-design.md`(含全 12 行各家能力表 + 原生 vs OR 差异表)。**改 core 必 rebuild**;保留 gpt-5.5+tools 自愈测试 `openai-reasoning-effort-drop.test.ts` |

## 遗留 / 待确认

- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **本地 main 领先 origin/main 未 push**(2026-06-02 实测 49 commit;此前选择本地合并不 push)。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交;在 main 上干活前先确认。
- [ ] **根 `tsup.config.ts` 是死配置**(指向不存在的 `src/run`/`src/product`,真实构建走 workspaces `--filter`),可顺手删/更新(低优先)。
- [ ] **InvestigationGuard 与显式只读深度分析冲突** —— 2026-06-02 复现:用户明确要求“只读分析/不要修改任何文件/尽量多读多搜”时,连续 Glob/Grep/Read 会持续注入“change strategy now — make a code change, run a command with side effects, or ask the user”。这会诱导违反只读约束。建议为 read-only review / researcher subagent / explicit no-write tasks 增加 guard policy override 或只保留去重提醒,不要要求 side effect。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计:`docs/superpowers/specs/2026-05-29-capability-control-design.md`
- 泛化推理强度配置设计:`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` — #5 设计文档
- 扩展 UI:`docs/superpowers/specs/2026-05-29-extensions-ui-*.md`(已实现)
- [Goal 模式重设计(对标 Codex goal)](./docs/goal-mode-redesign-2026-06-02.md)— #3 设计文档
- [自动化方案](./docs/automation-plan-2026-05-31.md)— headless/无人值守,#3 P0 是其 Phase 5 依赖

---

> **已完成并从本表移除**(2026-05-30 ~ 05-31):#11 远程插件安装(git 来源)、#12 全量逐文件 review(121 条已验证项全处理)、Extensions/自动化界面 UI、插件安装卡死修复(git 非交互)。详见 git log。
