# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的**——已完成的移到底部「已完成」区。

## 待办

| 状态 | #   | 任务 | 备注 / 关键落点 |
| ---- | --- | ---- | --------------- |
| 🟡 | 2 | 统一能力 UI — **剩纯产品决策** | **【小项已全做完(`562fc83`),仅剩一个产品方向待你拍】** 三个无需决策的小项已落地:① 点能力行跳转对应 tab;② builtin 项目级覆盖(schema `CapabilityOverrides.builtin` + overlay `bucketForKind`/`effectiveBuiltinLists` + Engine 构造期消费,真生效非只可写);③ 项目级 agent 写路径(AgentsSection 按 activeRepoPath 走 project scope)。**只剩**:产品方向——A 维持现状(推荐)/B 大一统内嵌(~5-7d)/C 总览+详情弹窗(~2-3d)。**建议 A,别为完成 TODO 强行重构。** |
| 🟡 | 3 | 多 session 隔离 — **剩 P2/P3(均低优先)** | **【P1 根治已完成(`9ce09a5`):** activeKey 改 per-session(Engine 自持 activeModelKey,aux-client 决策不再读共享池)+ maxTokens 不再臆造 8192(undefined→端点默认/Anthropic 4096 兜底,clamp 仍挡 384k→128k)。**剩(低优先,非阻塞)**:① **P2 memory extraction 耗时波动未深挖**(`services/memory-orchestrator.ts`、`engine.ts` extraction 路径;`elapsedMs` 3083→5939→8689 又掉回);② **P3 resolveSandboxBackend 每 turn 重 resolve**(`engine.ts`)。详见 `docs/research/session-isolation-state.md` §6。**改 core 必 rebuild** |
| ⚪ 不做 | 5 | 内置默认配置随 Electron 发布(agents/skills) | **【不做 — 2026-06-03 用户决定搁置;调研料留档备查】** 诉求:用户开箱即有默认子代理/技能,且走 **Electron 发布默认**(不是 core 包)。**已查清现状**:① **presets 已是 core 内置常量**(`preset/index.ts:118 BUILTIN_AGENT_PRESETS`,general/terminal-coding…)→ 本来就有,不用动;② **models 默认也是 core 常量**(`onboarding.ts` 各 provider 默认 model 列表)→ 不用动;③ **agents 缺分发**——4 个 `.md`(explorer/general-purpose/planner/researcher)仅在本仓库 `.code-shell/agents/`、**git 未跟踪**、无任何内置/seed;core 有软默认 `DEFAULT_AGENT_TYPE="general-purpose"`(`tool-system/builtin/agent.ts:48`)但**不保证存在**,打包后用户 registry 空→退临时 agent,偏好失效;④ **skills 缺内置默认**(`skills/scanner.ts` 只扫 plugin installPath/skills + 用户级,无 bundled)。**Electron 打包现状**:`packages/desktop/package.json build.files` 只带 `out/**`+icon,**无 extraResources、无 seed 机制**。**现成参考模式**:core `prompt/sections/*.md`——build 拷 dist + `package.json files` 列出 + 运行时 `readFileSync(new URL("./sections/x.md", import.meta.url))` 包内读。**待定方向**(brainstorm 时拍):A=Electron extraResources 带默认 + 首次启动 seed 到 `~/.code-shell/{agents,skills}`(用户可改可删,推荐);B=包内只读加载不 seed(用户不能删、升级跟新)。AgentsSection 现 `listAgents(cwd)` 用 `activeRepoPath ?? ""`,没选项目→只列用户级→空(用户报「子代理没东西」根因)。相关记忆 [[project_agent_capability_overview]] [[project_subagent_require_configured]] |

## 📋 #7 修复清单(本轮 code-review,按严重度;全 CONFIRMED/PLAUSIBLE)

> 评审范围 `68ab0a6..HEAD` 的本轮功能改动(#2/#3/#4/#6 + 个性化宿主接线 + 顺带 a657e44)。

**P0 — altitude(我今晚引入,该修深):**
- [x] **①  `activeModelKey` worker 路径恒 undefined**(`engine.ts` ctor `if (!config.runtime) populateModelPoolFromSettings()` L546-549 → 带 runtime 的 worker session 跳过唯一设 activeModelKey 的路径;`resolveAuxClient` L1744 `auxKey === this.activeModelKey` 恒不匹配)。**修**:删 `activeModelKey` 字段,L1744 改 `this.modelPool.get(auxKey)?.model === this.config.llm.model`(per-engine 已隔离的单一真相源)。回归测试改为断言 worker 场景(带 runtime、未 switchModel、auxKey==active)能去重。
- [x] **② `preset` 热重载静默无效**(per-turn composer 读 `this.preset` L1285,ctor 一次性 `resolveAgentPreset` L505;toolRegistry 也 ctor 冻结;但 `DiskDefaultPatch`/`diskDefaultsFrom` 把 preset 列为热重载)。**修(二选一,推荐 A)**:A=`refreshRuntimeConfig` 检测到 preset 变化时重跑 `resolveAgentPreset` 更新 `this.preset`(toolRegistry 的 builtin 集无法热重建→日志提示需重启或仅系统提示热生效);B=把 preset 移出 `DiskDefaultPatch`,只声明真能 reload 的字段并文档化。

**P0 — 测试卫生(已咬到用户):**
- [x] **③ 测试污染真实 `~/.code-shell/settings.json`**(`persistActiveModel`→写真盘;#3 测试用真 Engine.switchModel 把 `A-key`/`model-a`/localhost 漏进用户配置;已手动清理 activeKey→deepseek-v4-flash + 删假 model 块 + 存 `.bak`)。**修**:所有会触发 `persistActiveModel`/写盘的测试必须 `HOME`/`os.homedir` 指向 tmp(或 mock persist);审计 `switchModel`/`populateModelPoolFromSettings` 相关测试。**这是 review 没抓到的第 11 项**。

**P1 — #4 部分热重载族:**
- [x] **④ 非 stdio 宿主 reloadSettings 静默 no-op**(只 `agent-server-stdio` 传 settingsReader;tcp/repl/run 没传;`server.ts` L528/L574 `&& this.settingsReader` 跳过却仍回 `ok:true`)。**修**:无 reader 时回明确「不支持」或这些宿主也注入 reader。
- [x] **⑤ MCP connectAll 惊群**(`engine.ts` L2007;mcpManager=共享 `runtime.mcpPool` L1303;`mcp-manager.ts` connect 在 L254 才 `connections.set`、L192 才 has→K 个 session 同 tick 并发重复连同一 server)。**修**:广播层算一次 added、对共享池只 connectAll 一次;或 connect 用 pending-promise map 合并同名 in-flight。
- [x] **⑥ reloadHooks 每次保存无谓 churn**(`refreshRuntimeConfig` L1997 无条件 reloadHooks;无内容短路;version 单调永不等;个性化 600ms 防抖自动保存→K session×重读盘+拆装全 hook,即便只改 responseLanguage)。**修**:server 端对 `diskDefaultsFrom` 哈希,patch 与上次相同跳过广播;或 refreshRuntimeConfig 对比 this.config 再决定是否 reloadHooks/只在 hooks 实际变时重注册。
- [x] **⑦ builtin 覆盖 ctor 急切、不即时**(`engine.ts` L511 `effectiveBuiltinLists(...readBuiltinOverride(cwd))` 烘进冻结 toolRegistry;skills/plugins/agents 每 turn 懒读 L1281;refreshRuntimeConfig 不重折叠 builtin;新 UI 三态开关让用户期望即时)。**修**:builtin 工具集加每 turn 重算钩子(对齐其他类),或 UI/文档明确 builtin 覆盖为 session 级需新建会话。
- [x] **⑧ `diskDefaultsFrom` 覆盖 per-request slice preset/prompt**(`disk-defaults.ts` L36-39 无条件用 `agent.*`;refreshRuntimeConfig spread 覆盖;新建 session 走 `resolveSessionAgentConfig(slice, settings)` 让 slice 优先)。**潜伏**:当前 desktop slice 只带 permissionMode+cwd 且仅 stdio 接 reader→不可达。**修**:diskDefaultsFrom 不该无条件压 per-request 可覆盖字段;或文档化 reload 只推纯 disk 字段(与 ⑧ 设计澄清一起)。

**P2 — #6 性能/重复:**
- [x] **⑨ `sessionStatusMap` memo 审批循环 O(approvals×总session)**(`App.tsx` L289;`resolveBucket` miss 回退全量反扫;冷启/HMR 后 engineToBucketRef 空全 miss)。**修**:每次 memo 先建一次 engineSessionId→bucket 索引,approval O(1) 查。
- [x] **⑩ `rowBucketKey` 第三份拷贝**(`Sidebar.tsx` L32;App.bucketKey L91、streamRouting.bucketKey 已有;仅 JSDoc 维持字节一致;漂移→侧边栏状态标静默全不显示、测试还绿)。**修**:把 bucketKey 导出(或挪到 transcripts.ts 挨着 NO_REPO_KEY),三处 import 同一实现。
- [x] **⑪ AutomationView `needsImport` O(n²)+ 忽略 link 自带字段**(`AutomationView.tsx` L740 行内 `props.sessions.find()` 逐行;link 对象已有 needsImport)。**注:`a657e44` 非本轮改动,顺修**。**修**:直接用 link 上的 needsImport,别按 run.sessionId 重算。

## 遗留 / 待确认

- [ ] **本地 main 领先 origin/main 未 push**(2026-06-03 实测 ~101 commit,含本轮 goal/tools/reasoning 17 个)。此前选择本地合并不 push —— 决定何时 push。
- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查(归入 #3 P2)。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交(本轮 commit 列表里夹了一条 `059cc07 fix(desktop): no-repo 沙箱` 非本 session 改动);在 main 上干活前先确认。
- [x] **根 `tsup.config.ts` 死配置** —— 已不存在(早前某轮删除);`tsup` 仅 devDependency,build 走 workspace `--filter`,无引用。核实关闭。
- [ ] **InvestigationGuard 与显式只读深度分析冲突** —— 用户明确要求「只读分析/不要修改任何文件」时,连续 Glob/Grep/Read 会持续注入「change strategy now」。建议为 read-only review / researcher subagent 增加 guard policy override 或只保留去重提醒。
- [x] **切换模型闪「保存中…」** —— **已修(`78fe9c2` 本轮)**:`ModelSection` 共享 `saving` → 动作级 `savingId`(active:<key> / aux / reasoning:<key> / new),删底部无条件块,各控件只 disable 自己,新增表单保留按钮内联「保存中…」;active 行切换中 no-op(aria-busy)、aux Select 自己 save 时 disable。仿 `CapabilitiesOverviewSection`。typecheck+build+235 renderer 测试绿。详见记忆 `project_model_switch_saving_flash`。
- [x] **自动化「立即运行」后无状态指示**(更关键的②已修) —— **已修(本轮)**:`onAutomationSession` 绑定 route 后 `setBusyForKey(bucket, true)`,侧边栏立即转圈;announce 先于本 run 的 `session_started` 事件到达(automation-host 同一有序通道先 onSession 后 emit),既有 turn_complete handler 自然清 busy + 离屏置 unread → 与聊天同 asking>running>unread。**剩①滞后**:session 仅在 headless Engine 发 `session_started`(sessionId 在 main 铸造)后才现身,属固有,未动(用户标②为更关键)。详见记忆 `project_automation_runnow_session_lag`。
- [x] **消息加时间节点** —— **已修(本轮)**:`UserMessage.createdAt?` + `AssistantMessage.createdAt?/doneAt?`(stream_request_start 记 createdAt、assistant_message/turn_complete done 点记 doneAt 不覆盖);耗时=doneAt−createdAt 经 formatDuration 渲染在复制按钮左、回答时刻并列,提问时刻在用户气泡下(均 hover 显);新 `messages/time.ts` formatClockTime。replay/automation(foldTranscript)不带 createdAt(FoldItem 无原始时间戳),历史 transcript 不显误导性 replay 时间;live reducer 态随 localStorage 持久。3 新测试。详见记忆 `project_message_timestamps`。

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

**2026-06-03(/goal「过夜全做完」一轮,3 个 UX 遗留,commit `2edbe39`→`17d91ee`,在 main 未 push):**

- **消息加时间节点**(`2edbe39`):`UserMessage` 加可选 `createdAt`、`AssistantMessage` 加 `createdAt`(stream_request_start 记)+`doneAt`(assistant_message / turn_complete done 点记,绝不覆盖更早值)。耗时=doneAt−createdAt 经既有 `formatDuration` 渲在复制按钮左、回答钟点并列;提问钟点在用户气泡下;均 hover 显。新 `messages/time.ts` `formatClockTime`。replay/automation 路径(foldTranscript)不带 createdAt(`FoldItem` 无原始时间戳)→历史 transcript 不显误导性 replay 时间;live reducer 态随 localStorage 持久保真。3 新 reducer 测试。
- **切模型闪「保存中…」**(`78fe9c2`):`ModelSection` 共享 `saving` 布尔 → 动作级 `savingId`(active:<key> / aux / reasoning:<key> / new)。删底部无条件「保存中…」块,各控件只 disable 自己;新增表单保留按钮内联「保存中…」;active 行切换中 no-op + aria-busy;aux Select 自己 save 时 disable。仿 `CapabilitiesOverviewSection` 的 savingId。typecheck+build+全 235 renderer 测试绿。
- **自动化「立即运行」无状态指示**(`17d91ee`,用户标②为「更关键」):`onAutomationSession` 绑 route 后 `setBusyForKey(bucket, true)` → 侧边栏立即转圈。announce 先于本 run 的 `session_started` 流事件到达(automation-host 同一有序通道先 onSession 后 emit),既有 turn_complete handler 自然清 busy 并离屏置 unread → 与聊天同 asking>running>unread 生命周期。**剩①滞后**未动(session 须等 headless Engine 发 `session_started`,sessionId 在 main 铸造,属固有)。**全仓库 `bun test` 2075 pass/0 fail。**

**2026-06-03(code-review 11 项修复,commit `8a53508`,在 main 未 push):**

- **#7 high-effort code-review 11 项全修**(`8a53508`,清单见上「📋 #7」全打勾):7 finder×verify 全 CONFIRMED。**P0**:① 删 `Engine.activeModelKey`(worker 带 runtime 构造恒 undefined→aux 去重失效),改从 `this.config.llm` 派生且比**完整 LLM 身份**(model+baseUrl+provider+kind+maxTokens+reasoning,非仅 model 名);② `preset` 热重载真生效(refreshRuntimeConfig 重 resolve `this.preset`,系统提示下一 turn 生效;builtin 工具集仍需重启→日志提示);③ 测试污染真盘根治——`persistActiveModel`+session dir 改用 `userHome()`(HOME-aware,从 manager 导出),HOME 隔离的测试再也写不到真 `~/.code-shell`(顺手清了已泄漏的 `A-key`/`model-a`)。**P1**:④ MCPManager.connect 按名合并 in-flight(灭广播惊群,settle 后清可重试);⑤ reloadSettings patch 与上次字节相同则跳过广播(灭 reloadHooks churn);⑥ builtin 项目覆盖改每 turn 应用——既从 LLM 工具列表隐藏**又在 executor 强制**(`ToolContext.disabledBuiltins`,仿 plan-mode 拒绝,真门禁非只隐藏);⑦ diskDefaultsFrom 文档化只推纯 disk 字段。**P2**:⑧ `sessionStatusMap` 每次建一次 engineSessionId→bucket 反查索引(灭 O(approvals×session));⑨ 单一 `bucketKey`/`repoKeyOf` 入 transcripts.ts、App/Sidebar/streamRouting 共享(灭第三份拷贝+注释式不变量);⑩ AutomationView `needsImport` 用 link 自带 flag(灭 O(n²))。① ⑥ 两处边角经二次 verify 后加固(完整身份比较 + executor 强制)。`bun test` 2072 pass/0 fail。**注**:工作区另有并行 session 的 automation cron-abort 改动(runner/scheduler/agent-bridge/automation-*/liveSession/preload/CapabilitiesOverviewSection collapse),**未纳入本 commit**(只提我 #7 的 19 个文件)。

**2026-06-03(/goal「全做完 TODO」一轮,6 commit `562fc83`→`9ce09a5`,在 main 未 push):**

- **#2 统一能力 UI 三小项**(`562fc83`):① 点能力行→跳对应 detail tab(role=button+键盘,builtin 不跳);② **builtin 项目级覆盖**——`CapabilityOverrides.builtin` bucket + `bucketForKind("builtin")` + `effectiveBuiltinLists()`,**关键**:Engine 构造期 `readBuiltinOverride(cwd)` 折进 toolRegistry,project `builtin:off` 真把工具从 live registry 删掉(非只可写,有 e2e 测试证),因 builtin 是构造期解析(不同于 skill/plugin 的 lazy);③ 项目级 agent 写——AgentsSection 按 activeRepoPath 走 project scope(IPC/preload/service 早就收 opts)。剩纯产品决策(留待办)。
- **#6 侧边栏 session 状态指示器**(`e603a70`):每行一个状态标,优先级 asking>running>unread——审批待点→脉冲蓝点、在跑→spinner、非活动 session 跑完→未读蓝点。状态在 App 算(`sessionStatusMap` memo,approvalQueue 经 `resolveBucket` 映射到 bucket + 新 `unreadBuckets`),传 Sidebar 不入持久化 SessionSummary。unread 在 turn_complete 处对 `activeBucketRef`(非 stale closure)判定、选中即清。App.bucketKey 与 Sidebar.rowBucketKey 共享 NO_REPO_KEY 格式须同步。
- **#4 配置热重载第二层**(`f983e59` spec + `141ec5d`):设置改动推给**已运行 session**(下一 turn 生效,不打断 in-flight)。复用既有 settingsBus→`configure({reloadSettings})` 通道(平行 reloadModels)。关键发现:多数派生态本就热(composer 每 turn 重建、disabledLists 每 turn 重读),真正要补的窄=把 disk-default 字段并进 running session 的 `this.config` + reloadHooks。`ChatSessionManager.forEachSession`、`Engine.refreshRuntimeConfig(patch,version)`(version 防乱序、MCP 只增不断)、`reloadHooks`(按 handle 精确反注册,不碰 plugin/goal hook,无重复累积)、`diskDefaultsFrom`(只挑 disk-default,不含 request-override,与 engineFactory 同读盘 freshSettings 不分叉)。5 个开放问题全按 Codex「不打断 in-flight」拍。spec:`docs/superpowers/specs/2026-06-03-config-hot-reload-layer2-design.md`。
- **#3 隔离 P1 根治**(`9ce09a5`,plan `docs/superpowers/plans/2026-06-03-session-isolation-p1.md`):调研发现两处**都已被既有基础设施大幅缓解**,只收尾边角——① `resolveAuxClient` 原读共享池 `getActiveKey()`(别 session 切了会串)→ Engine 自持 `activeModelKey`,回归测试证「共享池切到 B、本 Engine 仍 A」aux 决策仍用 A(修前 fail);② `model-pool.toLLMConfig` 不再 `?? 8192` 臆造(undefined→OpenAI 省字段/Anthropic 4096 兜底,clamp 仍挡 384k→128k)。剩 P2(memory extraction)/P3(sandbox resolve)低优先留待办。

**2026-06-03(/goal 上一轮,过夜验收,5 commit `2dfd522`→`d9ef196`,在 main 未 push):**

- **#1 修预存测试 fail(CI 绿)**(`f1976d2`):实测 15 fail(非 13),全是测试基础设施债,实现侧无 bug。① 8 个 fake/stub Engine 缺 `isHeadless()`(`tests/protocol/multi-session`、`in-process-client-drift`、`background-agent-protocol`×5、`protocol-client-query`)补 `isHeadless: () => false`;② `agent-type-e2e` 的 ephemeral 用例陈旧——现行设计是「省略 agent_type + 非空 registry → 回退 general-purpose/首个」,改用空 registry 才测真 ephemeral;③ `AgentMessageView` 折叠头去掉「· 」前缀,断言对齐;④ `capabilities` gpt-5.5/magistral 补 `supportedEfforts`(实现新增的一等字段)。**`bun test` 15 fail → 0(2019 pass)**。Explore 子代理逐条根因 + spec/quality 双审。
- **个性化设置 完整落地**(`2dfd522`+`d9ef196`,plan `docs/superpowers/plans/2026-06-02-personalization.md`):设置页「个性化」真生效 + 新增回复语言/称呼画像两字段 + 指令文件兼容开关(CLAUDE.md/AGENTS.md 勾选,主名写死 CODESHELL.md)。Task 1–8 验收发现**计划编写后已被一轮实现完成**(schema/EngineConfig/composer section/`compatFileNamesFrom`/engineFactory/UI 两 section 全在),本轮补齐唯一缺口:**三字段原只在 desktop stdio 宿主接线,TUI(repl/run/cron)+TCP 漏接→功能在那些宿主里是死的**;抽 core 共享 helper `personalizationFrom(agent)` 全宿主 spread,杜绝再漂移。子代理自动继承三字段。Task 9 手动验收(起 desktop 填值)留用户。
- **automation 会话 disk 重建标 ⚙**(`2dfd522`):`planDiskRebuild` 读 `DiskSessionMeta.origin`,automation 会话标 `source:automation`,desktop 留空——补齐 session-origin 工作的 desktop 侧。

**2026-06-02 → 06-03(/goal 一轮,17 commit `08552fc`→`a00246a`,在 main 未 push):**

- **Goal 模式 P0**(`08552fc`→`42fe1e8`):`config.goal` 升 `GoalConfig{objective,tokenBudget?,timeBudgetMs?}` + run 级预算护栏(超预算强制停 `goal_budget_exhausted`)+ `complete_goal` 内建工具(模型自报完成→turn-loop 短路,绕过裁判)+ 裁判 hook 降兜底、解析/抛错失败不再静默放行。24 测试绿。**剩 P1(可选)**:goal 进上下文(`<goal_context>`)、状态机、headless 主动 continuation(设计 §3 P1)。
- **内建工具凭证可见性守卫**(`67feabb`):没配凭证的 WebSearch/GenerateImage 不再暴露——`BUILTIN_TOOL_GUARDS` + `engine.ts` toolDefs 组装处 `.filter()`,每条消息重算,配好下条消息生效。执行层兜底保留。
- **泛化推理强度配置 P0+P1+P2**(`249fddd`→`729ca5b`):富结构 `ReasoningSetting`(off/on/effort/budget)+ `reasoningControlFor` 描述符 + 全链路 thinking→reasoning 改名、去 medium 硬编码;**修了 Anthropic thinking 完全没实现的真 bug**;ModelSection 按 kind 渲染控件。**剩 P3(可选,已 defer)**:OpenRouter max_tokens/enabled 透传(Mistral magistral effort 选项细化已在 code-review 修复中解决,见下)。
- **#1/#2/#6 调研**(`a00246a`):无代码,结论已并入上方各待办行。
- **code-review 修复 6 项**(`12969cb`+`6b55d88`,high-effort review 验证后的全部 finding):① **magistral 不再被误判 gpt-5.5**——加 `openai-effort.supportedEfforts` 一等字段(gpt-5.5→[low,med,high,xhigh]、magistral→[high]),不再从 disabledEffort 反推(根治,顺带解决上面 P3 的 magistral 项);② TUI `friendlyReason` 补 `goal_budget_exhausted`;③ 工具守卫 `isWebSearch/GenerateImageAvailable` 加 1s TTL per-cwd 缓存(原每条消息 2 次读盘);④ goal-stop-hook 文件头 docstring 对齐反转后的行为;⑤ ModelSection reasoning fetch 串行→Promise.all 并行;⑥ `complete_goal` 工具名提 `COMPLETE_GOAL_TOOL_NAME` 常量(两处共用防改名漏)。build+typecheck 绿。

**此前(2026-05-30 ~ 05-31)**:远程插件安装(git 来源)、全量逐文件 review(121 条)、Extensions/自动化界面 UI、插件安装卡死修复。详见 git log。
