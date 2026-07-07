# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 最近一次清理：2026-07-06（三路 Codex 并行核实代码现状后重写，附 file:line 证据）。

---

# 🆕 2026-07-07 三路 Codex 只读审查发现（待复核）

> 三路并行 codex 审查产出，明细见 `docs/todo/review-core.md`(17)、`docs/todo/review-ui.md`(17)、`docs/todo/review-docs.md`(20)。**已经历「审查→修复→独立复核(`review-verification.md`)→补修」全流程**：core 安全 P1 5 项 + core P2 6 项 + UI 安全 P1 2 项 + UI/CDP P2 + docs 20 项全部落地并有回归测试；复核发现的 1 个 BROKEN(Config 原型污染) + 2 个关键 WEAK(审批乱序、Markdown className) 已补修并加负向测试；VERSION 常量对齐 rc.12。全部未提交，待分组 commit（安全修复 / P2 / docs 三组）。

**core — 安全/正确性 P1（最高危，优先复核）**
- 🔴 **[安全] 插件安装路径穿越**：`installFromSource.ts:37` 远程插件 `#subdir` 未拒 `..`；`pluginInstaller.ts:118/157` marketplace 源允许绝对/`../` 路径且无 containment 检查 → 可安装/复制任意本地目录。修：realpath 校验 subdir/path 严格落在 clone/marketplace 根下。
- 🔴 **[安全] 原型污染**：`settings/manager.ts:325` 点号写入遍历继承对象，`config_set("__proto__.polluted",v)` 可达 `Object.prototype`（protocol 仅 `server.ts:1456` 挡受保护根）。修：所有点号读写删拒 `__proto__`/`prototype`/`constructor`/空段，只下降 own plain object。
- 🔴 **[正确性] 路径策略与执行不一致**：`executor.ts:595` 按 `ctx.cwd` 解析批准，但 read/write/edit/notebook-edit/lsp 用原始 arg（`process.cwd()` 相对）→ 批准一个文件却读写另一个。修：执行前归一化 path arg 或让每个 builtin 都过 `ctx.cwd`；`generate-video.ts:328`+`image-uploader.ts:41` 同源。
- 🔴 **[安全] runId 未校验**：`FileRunStore.ts:45` runId 直接拼进 runs 目录（delete/lock/heartbeat 复用），无 `assertSafeRunId`（session 有）→ 路径穿越。修：加单段 guard。
- 🔴 **[并发] run 审批竞态**：`RunApprovalBackend.ts:76` 只存一个 pending，并发 ask-gated 工具第二个覆盖第一个 promise → 首个永挂；`RunManager.ts:204` resume 对 null/非 pending 记录也 resolve；`:270` cancel 未走 `resolvingRuns` guard 与 resume 竞态。修：队列化审批 + 校验 approvalId 归属/pending + cancel 同 guard。

**UI — 安全 P1**
- 🔴 **[安全] Markdown span style 注入**：`renderer/Markdown.tsx:51` sanitize 后仍允许 span 任意 `style` → 助手供给的 HTML 可视觉欺骗/隐藏内容。修：移除 style 或窄允许列表。
- 🔴 **[安全] console 消息伪造强开 tab**：`browser/useBrowserTabs.ts:137` guest 页 console 打印 `__CS_OPEN_TAB__` 即可强制宿主开 tab/搜索。修：`startsWith`+解析+要求 http(s)+限流，或换不可伪造通道。
- 🟡 其余 UI：ChatView 录音无卸载清理、ProviderModelFlow fetch 无 try/finally（`review-ui.md` P1）；13 个 P2（listener/timer/pty cwd/CDP 等泄漏与硬化）。

---

# 🔴 未修 bug（有实证）

- 🔴 **[压缩/token] 压缩用 `estimateTokensHybrid` 估算比真实 tokenizer 低 ~2.5×，压完仍远超真实上限且不再触发二次压缩** — 实测硬证据(session `s-mr908xtp-3a414dad`，同点无 confound)：`13:42:46 COMPACT before=239030 after=162940`(估)，`13:43:58` 压完首个真实请求 `msgs=190 promptTokens=409612`(真) → 压完估 162,940 vs 真实 409,612 = **2.5× 低估**；压缩前那侧估 ~239k vs 真实 ~694k ≈ 2.9× 低估。**现象**：压缩把 msgs 630→190、真实 ~694k→~409k(压缩本身有效)，但之后历史长回 190→234 条 / 真实 409k→**482k**，却再没触发第二次压缩 —— 因为估算以为只有 ~162k(41% of 400k，远低于 gate) = 用户看到的「压完还很满 / 一条就回弹」。
  - **机制(代码确认 `packages/core/src/context/manager.ts`)**：① 所有压缩 gate 与 before/after 一律用 `estimateTokensHybrid()`(:338/:350-352/:445-459)，**从不用**引擎每轮已拿到的真实 `promptTokens`(尽管 `recordActualUsage` 已接线在 `turn-loop.ts:741`)；② `estimateTokensHybrid`(:148-159)只在 `lastActualAtMessageCount < messages.length` 时才用真实锚点，**一次 summary 压缩把消息 630→190 后该条件变 false → 丢弃真实锚点回退纯启发式** = 2.5× 偏低的 162,940。
  - **修复方向(Codex 核实,effort M)**：(a) `manager.ts:139-158` `recordActualUsage`/`estimateTokensHybrid` 在缩容时按比例 rescale 真实锚点而非丢弃；(b) `turn-loop.ts:741` 调用改为把当前 `messages`(或其 `estimateTokens`)连同 `promptTokens` 一起传；(c) summary 压缩 after 值(`manager.ts:202-208`)也用修正后的 hybrid，别用纯 `estimateTokens(compacted)`。测试补 `manager-micro-escalation.test.ts` 或新建 `manager-hybrid.test.ts`，方法签名变了同步改 `turn-loop-usage-cache.test.ts`。**不加**每轮动态预算重请求(与 prompt cache 冲突,刻意不做)。
  - **已排除**：图片驻留(已修，实测 cacheRead 紧跟 prompt 无大图重发)、「磁盘大=上下文大」、压缩空转。关联记忆 `codeshell-compaction-underestimates-tokens-2p5x-evidence`、`codeshell-tui-context-window-uses-global-default-not-model-maxContextTokens`(窗口用 200k 全局默认而非模型真实窗口，同源需一并核)。

---

# 🟡 待改进 / 待优化

- 🟡 **[记忆/dream · 不对称] 会自动打扫的区(dream)小，不能自动打扫的区(user)反而堆最多** — 现状：平时会话记的东西几乎都直接进 **user 区**(要转正、跨会话可靠)，但 user 区 **dream 永远碰不到**(`dream-consolidation.ts:184-190` 硬拒非 dream scope 写入，因为后台 dream 无交互式权限后端)，只能靠交互会话里逐条批准删。结果**最该被自动清理的完成态 changelog 恰恰落在永不自动清理的区**。**根治方向(二选一或都做)**：① 让 dream 能对 user 区**提议**清理(列候选清单，用户一次性批准)；② 把 changelog/过程类记忆改成默认存 **dream 区**(可自动归档)，user 区只留耐用事实(架构/根因/偏好)。另 `shouldAutoDream()` 缺 Codex 的 rate-limit 阈值跳过(配额低时别烧 token 跑 dream)，可一并考虑。
- 🟡 **[编排] DriveAgent 前台超时静默丢任务**(`codeshell-driveagent-foreground-timeout-silent-drop`,effort M)：`background:false` 只 `await runner`(`drive-claude-code.ts:140-142`)，无 jobId/无 backgroundJobRegistry/无完成通知(那些只在后台分支 `:93-138`)；registry 默认 120s 超时(`registry.ts:11-16`)返回通用错误(`registry.ts:175-183`)；且 `defaultRunner` 不传 `ctx.signal`(`:60-62`)→ 超时后 CLI 可能继续跑但结果被丢。修法：前台阈值到点自动 handoff 到后台(复用后台完成处理器 + 发 jobId)，并把 `ctx.signal` 传进 `runAgentOnce`。测试 `drive-claude-code.test.ts`。
- 🟡 **[编排] 并发子代理同工作区碰撞风险**(`codeshell-multi-agent-collision-risk`,effort M)：cwd 由 caller 传、无 per-invocation 隔离(`drive-claude-code.ts:70` → `external-agent-driver.ts:43-45` 直接 spawn)；同轮 unsafe 调用串行(`streaming-tool-queue.ts:37-46`,DriveAgent `isConcurrencySafe:false`)，但**后台任务启动即返回，多个后台 DriveAgent 仍可在同 cwd 重叠写文件**。修法：BackgroundJobEntry 记 cwd，同 cwd 已有 writable 任务时拒绝/警告；或加 `isolateWithWorktree` 选项。
- 🟡 **[worktree] CC/Codex session resume 无 cwd 绑定**(`codeshell-cc-codex-worktree-session-resume-cwd-mismatch`,effort M)：resume 只透传字符串(`drive-claude-code.ts:74`)，cwd 独立取自 args(`:70`)，无 `sessionId→cwd/worktree` 权威映射。CC/Codex 的 transcript 查找是 cwd-keyed(`session-history.ts:38-45`/`codex-session-history.ts:25-33`)→ 跨 cwd resume 不纠正、原 cwd 是被删的 worktree 则失败。修法：新增持久化 external-agent session 存储(keyed by {cli,sessionId}→{cwd,worktreePath?,worktreeBranch?})，resume 时强制原 cwd，worktree 丢失则阻止或重建。
- 🟡 **[goal] complete_goal/cancel_goal 无 goal 时 schema 仍暴露**(`complete-goal-no-active-goal-guard-root-cause`,effort S)：⚠️**运行时 guard 已存在**——`executor.ts:153-163` 无 `hasGoal` 时拒绝执行，turn-loop 短路需 goalTracker(无 goal 为 null,`:527-534`)，engine 从 explicit/persisted/config goal 算 `hasGoal`(`:1724-1731`)。**仅剩缺口**：`BUILTIN_TOOL_GUARDS` 没 gate 这俩(`builtin/index.ts:774-786`)，无 goal 时工具 schema 仍暴露给模型(执行会被拒但白占位)。修法：给 `BUILTIN_TOOL_GUARDS` 加 `[completeGoalToolDef.name, ctx=>ctx.hasGoal]` + cancel 同理，改 `tool-guards.test.ts` 断言。
- 🟢 **[会话] TodoWrite resume 恢复 — Codex 核实已修，仅缺测试**(`codeshell-todo-session-resume-empty-list`)：`readLastTodoSnapshot`(`task.ts:154-168`) + `engine.ts:1608-1613` resume 时重放最新 TodoWrite 为 `task_update`，模型也从 resumed transcript 看到旧 tool-use。除非无 TodoWrite 或末次全 completed(刻意清空)。剩：补 `task.test.ts`/`engine.todo-resume.test.ts`；`engine.ts:1605` 注释说容忍 legacy TaskCreate/Update 但 `readLastTodoSnapshot` 只认 TodoWrite(注释误导)。
- 🟢 **[前端] panel 写放大 — Codex 核实已修**(`codeshell-panel-refactor-save-all-buckets-write-amplification`)：effect 仍 O(n) 遍历但缓存快照跳过未变 bucket(`App.tsx:2613-2622` 有 `continue`)，只写变更的(`transcripts.ts:297-307` 单 key 写)。写放大已消除。可选优化：`updatePanelBucket` 记 dirty bucket 免 O(n) 扫描。
- 🟢 **[前端] 乐观气泡 — Codex 核实基本已修，仅剩 announce 边缘**(`codeshell-optimistic-input-bubble-overwritten-by-hydrate`)：正常 composer send + queued/steer send 都受保护(reducer 按 `steerId`/`clientMessageId` 跨 hydrate 保留本地 intent,`transcriptsReducer.ts:56-88` + 回归测试)。**仅剩缺口**：automation/mobile announce 气泡无 key 派发(`App.tsx:1670/1739`)，后续 hydrate 可覆盖。修法：给 announce 派发稳定 `clientMessageId`(如 `automation:${sid}:prompt`)。
---

# 发布关键路径（beta1，必须用户亲自做）

- 🟡 **npm 包**（若本轮要发）：**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）；**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**：中/英切换走主流程，确认无未翻译泄漏 / 无 localStorage 报错。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**(effort M)：登录用持久分区 `persist:login-${uuid}`(`credentials-login/index.ts:207`)，登出 `destroyPartitionCookies` 只清 cookie(`browser-host/index.ts:146-153`)，账号切换 clear 模式也只清 cookie 且注释明说不碰 localStorage(`credentials-service.ts:84-95`)→ localStorage/IndexedDB/CacheStorage/SW 残留。修法：登录分区改非持久 `login-${uuid}`；`destroyPartitionCookies`→`clearStorageData()` 清全部站点存储。另 BrowserHost 仍只 `kind:"window"`(`:17-23`,拒 webview `:90-93`)，webview 硬化逻辑散在 `main/index.ts:1076-1102` 未抽共享 helper。
- ⚪️ **内部浏览器 Network 可视化/请求复用 UX**：内置浏览器面板看不到 Network。方向：给浏览器面板提供 Network 观察能力(请求列表/过滤/查看 payload/response/copy as fetch 或转工具调用)。注意隐私与凭证边界，默认只对当前 session/browser partition 可见。
- ⚪️ **JSON-Schema 导出未接线**(effort S)：`schema-export.ts:8-12` 注释明说 `manager.load()` 故意不写文件；`settingsJsonSchema()`/`writeSettingsSchemaFile()` 存在但只被 `index.ts:436-437` re-export，无生产 caller。修法：TUI+desktop 启动调 `writeSettingsSchemaFile(join(userHome(),".code-shell"))`，或 release notes 注明 SDK-only。
- ⚪️ **i18n 收尾（增量）**：`"新对话"` 哨兵常量化；非 React helper 硬编码 localStorage key 应 import KEY；mobile(~149 处)单独接同套 i18n。

---

# 大路线图（beta1 不做，留存方向）

- **core 通用化 + 插件面板**（`docs/todo/core-harness-and-plugin-panels.md`）：① core=无 coding/git 预设的通用 harness——4 个内核 git 触点参数化 / harness-min preset + CI 纯度 smoke / coding pack 外移(git/lsp/review/worktree/cc-orchestrator/quota…)；② 插件={UI 面板+能力}——PanelRegistry / manifest `panels` / csplugin:// 沙箱 host / 按 permissions 过滤的 scoped bridge。**Phase A(工具元数据合一 + PanelRegistry)最小可先做**。与 `architecture-debt.md` P1-⑤⑥ 重叠处合并执行。
- **架构债 P1/P2**（`docs/todo/architecture-debt.md`，P0 已并 main）：P1=拆 index、arena builtin 可选、拆 engine.ts、拆 App.tsx、真启用 safeStorage；P2=arena 移包/state 单例/cron 测试/文档措辞。
  - ✅ **拆 engine.ts 的两个前置已完成**（2026-07-07 codex 核实）：`extractJSON` 已提取到 `utils/json.ts`（arena 三步第①步，arena/utils.ts re-export 保留旧面）；`EngineConfig`/`EngineHookConfig`/`EngineResult` 已在 `engine/types.ts`，类型级 `tool-system→engine` 循环已不存在，仅剩一条 test-only 的 `Engine` runtime import（`agent.send-input.llm.test.ts`，可移入 engine 测试区或 allowlist）。拆 engine.ts 本体仍待做。
- **Workspace / Profile / 数字人**（`docs/todo/workspace-profile-讨论稿.md` v0.5）：base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。P3。
- **Workspace 数据源绑定**（P4）：资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配。大子系统。
- **聊天软件接入（channel，参考 OpenClaw）**（`docs/todo/im-gateway-remote-orchestration.md`）：微信/Telegram 做成可插拔 channel 前端。core 保持 channel-agnostic，平台接入做外部插件；接入做成一类凭证进 CredentialStore；扫码微信号绑死为收发身份 + 必配 allowlist。未立项。
- **工程质量 P7**：builtin tools 集成测试 / E2E / CI 覆盖率 >60% / 性能 / 文档。
  - **Electron e2e 设施**（playwright 现是孤儿依赖）：用 `_electron` API 驱动真机 app，沉淀 `verifier-electron` 基座。`launchApp()` 按 title/URL 抓主窗（**别用 `firstWindow()`，会抓 DevTools 窗**）；难点：webview 嵌套需 `frameLocator` / node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。
- **Markdown 渲染一致性**（desktop/TUI）。
- **view_image TUI inline**（iTerm/kitty graphics protocol）+ 历史图降级文字摘要省 token。
- **设置/命名清理**：settings/repo/workspace 命名收口；ModelSection 1065 行深度重排。
- **其他未落地设计稿**（见 `docs/todo/`）：`roadmap.md`(Phase 0–6)、`prompt-cache-optimization.md`、`session-cumulative-cache-usage-plan.md`、`mcp-http-auth-oauth-link-tech-design.md`、`smoke-automation-mock-provider.md`、`worktree-session-isolation-research.md`。

---

# 明确不做（已决策，留因）

- **每轮主动请求压缩 / token 预算动态调档**：与 Anthropic prompt cache 冲突，固定 ratio 门控刻意保留。
