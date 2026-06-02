# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的**——已完成的移到底部「已完成」区。

## 待办

| 状态 | #   | 任务 | 备注 / 关键落点 |
| ---- | --- | ---- | --------------- |
| 🔴 | 1 | 修 13 个预存测试 fail(让 CI 绿) | **低成本、最该先做**(#3 调研期发现,#5 调研确认与隔离无关=纯测试基础设施债)。① fake engine stub 缺 `isHeadless()`(6 fail):`tests/protocol/in-process-client-drift.test.ts:36/70/97/124`、`multi-session.test.ts:27/52/93` —— Engine 真身有 `isHeadless()`(`engine.ts:638`),给 stub/fake 补上即可;② `AgentMessageView.test.tsx:50` 期望「· 3 tools」实际「3 tools」—— 对齐断言或实现(`AgentMessageView.tsx:26-29`);③ 余下 plugin-hook timeout / fixture 环境问题逐个看。**目标:`bun test` 从 13 fail → 0。** |
| 🟡 | 2 | 跨 MCP/builtin/skill/plugin 统一能力 UI | **【已基本完成,剩纯产品决策】** 后端 100%(`capability-control/` + list/setEnabled/setOverride + 三个 IPC + preload 桥)+ UI ~80%(`CapabilitiesOverviewSection.tsx`:用户/项目 scope、五分类、两态/三态开关、统计、实时保存,已挂进 SettingsPage)。与分散 tab(MCP/扩展/子代理/钩子)=分工非重复(总览管开关、各 tab 管细节)。**剩**:① 产品方向——A 维持现状(推荐)/B 大一统内嵌(~5-7d)/C 总览+详情弹窗(~2-3d);② 无需决策即可做的小项:点能力行跳转对应 tab、builtin 项目级覆盖(spec §4.2 首期未纳入)、项目级 agent 写路径(AgentsSection 现只写 user)。**建议别为完成 TODO 强行重构。** spec:`docs/superpowers/specs/2026-05-29-capability-control-design.md` |
| 🟡 | 3 | 多 session 隔离根治 + 慢 修复 | **【隔离架构已成体系,剩缓解→根治】** per-session 独立 Engine/AbortController/队列 + 配置切片 + model 切换 per-session(pendingModel defer,`server.ts:499-508`)都齐。**剩架构隐患**:① `activeKey` 仍全局可变(`engine.ts:1799`),并发切模型竞态→per-session 化;② maxTokens 跨模型残留(DeepSeek 384k 漏到 gpt-5.5 128k),per-run 重算缓解但复用 client 仍可能残留→per-run 重建 client 或 client 去模型化。详见 `docs/research/session-isolation-state.md` §6。**慢**:RPC 30s 超时已修;**memory extraction 耗时波动未深挖**(`services/memory-orchestrator.ts`、`engine.ts:1306`);resolveSandboxBackend 每 turn 重 resolve(`engine.ts:719`,P3)。**建议**:P1 activeKey per-session + maxTokens 防残留(对标 Codex);P2 memory extraction 根因。**改 core 必 rebuild** |
| 🔴 | 4 | 配置热重载「第二层」:push 给运行中的 session | **【调研完毕,可开 brainstorm+spec】** 第一层已落地(`cli/agent-server-stdio.ts:147-153` `freshSettings`,新 session 重读盘)。第二层=让 running session 也热生效(对标 Codex 写事件触发→遍历 live thread `refresh_runtime_config`)。**攒好的料**:① EngineConfigSlice per-session 字段(`chat-session-manager.ts:6-16`:permissionMode/preset/customSystemPrompt/appendSystemPrompt/goal/maxTurns/maxContextTokens/cwd)→写 spec 拆 RequestOverride vs DiskDefaults,push 只更新后者;② 派生状态重建清单:可热重载=PromptComposer/HookRegistry/MCPManager/disabledLists/agentDefsCache,无法=ToolRegistry(plugin 工具注册算死,需重启),已无损=modelPool;③ live session 遍历=`ChatSessionManager.sessions` 私有 Map(`:31`,需加公有遍历)+ main→worker 走 `handleConfigure`(`server.ts:478-546`,需加 `handleSettingsReload`+`Engine.refreshRuntimeConfig`);④ 搁置方案A=本任务受限子集,「下条消息生效」语义可复用。**写 spec 前 5 个开放问题**:in-flight turn 是否中断(Codex=否)/子 agent appendSystemPrompt 传播边界/MCP 热切换是否断 in-flight tool/plugin 工具动态重载 vs 明确需重启/snapshot 是否要版本戳防乱序。Codex 参照:`config_processor.rs`、`session/mod.rs refresh_runtime_config`。**改 core 必 rebuild** |
| 🟡 | 6 | 侧边栏 session 状态指示器(在跑/需输入/完成) | **【idea,待 brainstorm;2026-06-03 记】** 诉求:侧边栏每个 session 项按状态显示提醒——**在跑→转圈 spinner**、**有 ask_user/审批等我点→蓝点**、**完成(后台跑完且我没在看那条)→未读蓝点**。**已查清的料(数据基本现成,缺的是映射到侧边栏行)**:① **running 已有** `App.tsx:164 busyKeys: Set<bucketKey>`,`bucketKey=repoId::sessionId`(`:89`)——每个 bucket 是否在跑已知;② **ask/审批已有** `ask_user` + approval pending 队列(`App.tsx:101/109/121`,approvalsBadge 已在用 `:209`);③ **完成/未读** 需新增:对比「有新 turn_complete」vs「当前正看的 session」(activeSessionId `:207`)算未读;④ 侧边栏行 = `Sidebar.tsx` SessionRow(`:488` `s: SessionSummary`),现有 Badge 组件(`:314`)+ status-running/ok 色 token 可复用;⑤ SessionSummary(`transcripts.ts:31`)目前无 status 字段,指示器状态应在 App 层按 busyKeys/ask队列/未读集 算好再传给 Sidebar,**不塞进持久化的 SessionSummary**。**待定**(brainstorm 拍):未读的判定与清除时机(切到该 session 即清?)、三态优先级(ask>running>done?)、转圈用 CSS spinner 还是复用刚做的 shimmer。相关:实时活动行 commit `83b9373`、[[project_draft_session_autojump_bug]](activeSessionId 语义) |
| ⚪ 不做 | 5 | 内置默认配置随 Electron 发布(agents/skills) | **【不做 — 2026-06-03 用户决定搁置;调研料留档备查】** 诉求:用户开箱即有默认子代理/技能,且走 **Electron 发布默认**(不是 core 包)。**已查清现状**:① **presets 已是 core 内置常量**(`preset/index.ts:118 BUILTIN_AGENT_PRESETS`,general/terminal-coding…)→ 本来就有,不用动;② **models 默认也是 core 常量**(`onboarding.ts` 各 provider 默认 model 列表)→ 不用动;③ **agents 缺分发**——4 个 `.md`(explorer/general-purpose/planner/researcher)仅在本仓库 `.code-shell/agents/`、**git 未跟踪**、无任何内置/seed;core 有软默认 `DEFAULT_AGENT_TYPE="general-purpose"`(`tool-system/builtin/agent.ts:48`)但**不保证存在**,打包后用户 registry 空→退临时 agent,偏好失效;④ **skills 缺内置默认**(`skills/scanner.ts` 只扫 plugin installPath/skills + 用户级,无 bundled)。**Electron 打包现状**:`packages/desktop/package.json build.files` 只带 `out/**`+icon,**无 extraResources、无 seed 机制**。**现成参考模式**:core `prompt/sections/*.md`——build 拷 dist + `package.json files` 列出 + 运行时 `readFileSync(new URL("./sections/x.md", import.meta.url))` 包内读。**待定方向**(brainstorm 时拍):A=Electron extraResources 带默认 + 首次启动 seed 到 `~/.code-shell/{agents,skills}`(用户可改可删,推荐);B=包内只读加载不 seed(用户不能删、升级跟新)。AgentsSection 现 `listAgents(cwd)` 用 `activeRepoPath ?? ""`,没选项目→只列用户级→空(用户报「子代理没东西」根因)。相关记忆 [[project_agent_capability_overview]] [[project_subagent_require_configured]] |

## 遗留 / 待确认

- [ ] **本地 main 领先 origin/main 未 push**(2026-06-03 实测 ~101 commit,含本轮 goal/tools/reasoning 17 个)。此前选择本地合并不 push —— 决定何时 push。
- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查(归入 #3 P2)。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交(本轮 commit 列表里夹了一条 `059cc07 fix(desktop): no-repo 沙箱` 非本 session 改动);在 main 上干活前先确认。
- [ ] **根 `tsup.config.ts` 是死配置**(指向不存在的 `src/run`/`src/product`,真实构建走 workspaces `--filter`),可顺手删/更新(低优先)。
- [ ] **InvestigationGuard 与显式只读深度分析冲突** —— 用户明确要求「只读分析/不要修改任何文件」时,连续 Glob/Grep/Read 会持续注入「change strategy now」。建议为 read-only review / researcher subagent 增加 guard policy override 或只保留去重提醒。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计:`docs/superpowers/specs/2026-05-29-capability-control-design.md`(对应 #2)
- 泛化推理强度配置:`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` + plan `docs/superpowers/plans/2026-06-02-reasoning-config.md`(已完成,见下)
- Goal 模式重设计:`docs/goal-mode-redesign-2026-06-02.md` + plan `docs/superpowers/plans/2026-06-02-goal-mode-p0.md`(P0 已完成,P1 见下)
- 工具可见性守卫 plan:`docs/superpowers/plans/2026-06-02-tool-visibility-guard.md`(已完成)
- [自动化方案](./docs/automation-plan-2026-05-31.md)— headless/无人值守,Goal P0 是其 Phase 5 依赖(已就绪)

---

## ✅ 已完成(本周移除自待办)

**2026-06-02 → 06-03(/goal 一轮,17 commit `08552fc`→`a00246a`,在 main 未 push):**

- **Goal 模式 P0**(`08552fc`→`42fe1e8`):`config.goal` 升 `GoalConfig{objective,tokenBudget?,timeBudgetMs?}` + run 级预算护栏(超预算强制停 `goal_budget_exhausted`)+ `complete_goal` 内建工具(模型自报完成→turn-loop 短路,绕过裁判)+ 裁判 hook 降兜底、解析/抛错失败不再静默放行。24 测试绿。**剩 P1(可选)**:goal 进上下文(`<goal_context>`)、状态机、headless 主动 continuation(设计 §3 P1)。
- **内建工具凭证可见性守卫**(`67feabb`):没配凭证的 WebSearch/GenerateImage 不再暴露——`BUILTIN_TOOL_GUARDS` + `engine.ts` toolDefs 组装处 `.filter()`,每条消息重算,配好下条消息生效。执行层兜底保留。
- **泛化推理强度配置 P0+P1+P2**(`249fddd`→`729ca5b`):富结构 `ReasoningSetting`(off/on/effort/budget)+ `reasoningControlFor` 描述符 + 全链路 thinking→reasoning 改名、去 medium 硬编码;**修了 Anthropic thinking 完全没实现的真 bug**;ModelSection 按 kind 渲染控件。**剩 P3(可选,已 defer)**:OpenRouter max_tokens/enabled 透传(Mistral magistral effort 选项细化已在 code-review 修复中解决,见下)。
- **#1/#2/#6 调研**(`a00246a`):无代码,结论已并入上方各待办行。
- **code-review 修复 6 项**(`12969cb`+`6b55d88`,high-effort review 验证后的全部 finding):① **magistral 不再被误判 gpt-5.5**——加 `openai-effort.supportedEfforts` 一等字段(gpt-5.5→[low,med,high,xhigh]、magistral→[high]),不再从 disabledEffort 反推(根治,顺带解决上面 P3 的 magistral 项);② TUI `friendlyReason` 补 `goal_budget_exhausted`;③ 工具守卫 `isWebSearch/GenerateImageAvailable` 加 1s TTL per-cwd 缓存(原每条消息 2 次读盘);④ goal-stop-hook 文件头 docstring 对齐反转后的行为;⑤ ModelSection reasoning fetch 串行→Promise.all 并行;⑥ `complete_goal` 工具名提 `COMPLETE_GOAL_TOOL_NAME` 常量(两处共用防改名漏)。build+typecheck 绿。

**此前(2026-05-30 ~ 05-31)**:远程插件安装(git 来源)、全量逐文件 review(121 条)、Extensions/自动化界面 UI、插件安装卡死修复。详见 git log。
