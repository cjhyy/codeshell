# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 最近一次清理：2026-07-07（按 HEAD 7e4b0470 复核 TODO/bug-status，删除已修压缩 blocker，并更新 core/desktop/renderer/TUI 状态）。

---

# 🟡 待改进 / 待优化

- 🟡 **[压缩/token] 无真实 usage anchor 时仍依赖启发式估算（blocker 已修）** — 原 2.5× 低估 blocker 已修：`recordActualUsage` 记录真实 anchor 估算值，缩容后按比例 rescale(`manager.ts:141-169`)，`turn-loop.ts` 已传入当前 messages(`turn-loop.ts:737-745`)，summary compact 后若仍超过 snip gate 会继续走 snip/window/emergency ladder(`manager.ts:482-528`)。剩余改进：没有真实 anchor 的初始估算仍落在启发式路径，`estimateTokens` 仍是 `estimateMessagesTokens()*4/3`(`compaction.ts:17-23`)。
- 🟡 **[前端/CC 面板] Claude Code / 外部 agent 面板缺「当前 session 触发」标识** — 一屏里有多个 CC/Codex（DriveAgent 驱动的）面板时，看不出哪个是当前这个 session 触发/关联的。当前面板只按 `sessionId` 拉当前列表(`BackgroundShellPanel.tsx:45-53`)，但 header/row 只展示数量、状态、描述、变更文件等(`BackgroundShellPanel.tsx:208-224`, `:283-321`)，条目数据也不带来源 session(`background-work.ts:110-146`)。修法：给面板卡片打 tag/徽标标注来源 session（如 session 短 id/名称、或「本会话」高亮）。
- 🟡 **[记忆/dream · 不对称] 会自动打扫的区(dream)小，不能自动打扫的区(user)反而堆最多** — 现状：平时会话记的东西几乎都直接进 **user 区**(要转正、跨会话可靠)，但 user 区 **dream 永远碰不到**：user memories 对 dream 只读(`memory.ts:10-16`)，dream consolidation 虽加载 user+dream 但写入循环硬拒非 dream scope(`dream-consolidation.ts:88-95`, `:180-190`)。结果**最该被自动清理的完成态 changelog 恰恰落在永不自动清理的区**。**根治方向(二选一或都做)**：① 让 dream 能对 user 区**提议**清理(列候选清单，用户一次性批准)；② 把 changelog/过程类记忆改成默认存 **dream 区**(可自动归档)，user 区只留耐用事实(架构/根因/偏好)。另 `shouldAutoDream()` 只看启用、session 数和时间窗口(`auto-dream.ts:58-72`)，缺 Codex rate-limit 阈值跳过。
- 🟢 **[会话] TodoWrite resume 恢复 — Codex 核实已修，仅缺测试**(`codeshell-todo-session-resume-empty-list`)：`readLastTodoSnapshot` 扫最新 TodoWrite，末次全 completed 则刻意清空(`task.ts:154-170`)；resume 时重放为 `task_update`(`engine.ts:1613-1618`)，模型也从 resumed transcript 看到旧 tool-use。剩：补 `task.test.ts`/`engine.todo-resume.test.ts`；当前 `rg` 未见专门覆盖 `readLastTodoSnapshot`/resume `task_update` 的测试。
- 🟢 **[前端] 乐观气泡 — Codex 核实基本已修，仅剩 announce 边缘**(`codeshell-optimistic-input-bubble-overwritten-by-hydrate`)：正常 composer send + queued/steer send 都受保护：reducer 按 `steerId`/`clientMessageId` 跨 hydrate 保留本地 intent(`transcriptsReducer.ts:56-88`)，send/queued steer 均写入或复用 `clientMessageId`(`App.tsx:1952-2026`, `:2168-2205`, `:2264-2280`)。**仅剩缺口**：automation/mobile announce 气泡无 key 派发(`App.tsx:1670-1672`, `:1737-1741`)，后续 hydrate 可覆盖。修法：给 announce 派发稳定 `clientMessageId`(如 `automation:${sid}:prompt`)。

---

# 发布关键路径（beta1，必须用户亲自做）

- 🟡 **npm 包**（若本轮要发）：**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）；**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**：中/英切换走主流程，确认无未翻译泄漏 / 无 localStorage 报错。

---

# beta1 延后（非 bug，记 release notes）

- 🔶 **browser-login 硬化（部分已落，剩账号切换/webview 收口）**(effort M)：已落：登录窗口改用非持久 `login-${uuid}` 分区(`credentials-login/index.ts:207`)，关闭后 `destroyPartitionStorage` 用 `clearStorageData()` 清全部站点存储(`browser-host/index.ts:146-154`)。剩：账号切换 `restoreCookiesToBrowser(..., mode:"clear")` 仍只清 cookies，注释也标明不动 localStorage(`credentials-service.ts:148-160`)；BrowserHost 仍只支持 `kind:"window"`(`browser-host/index.ts:17-23`, `:90-93`)，browser-panel webview 硬化逻辑仍散在 `main/index.ts:1078-1113`。
- ⚪️ **内部浏览器 Network 可视化/请求复用 UX** — 当前 BrowserPanel 仍是 webview + 地址栏 + tabs + localhost anchors(`BrowserPanel.tsx:94-104`)，未见 Network/request/response/header/payload/copy-as-fetch 面板实现。
- 🔶 **i18n 收尾（增量）**：✅ `"新对话"` 哨兵已常量化为 `DEFAULT_SESSION_TITLE`(`transcripts.ts:34-40`)；剩：非 React helper 仍硬编码 `codeshell.uiLanguage` key(`messages/time.ts:22-28`, `messages/streamGroups.ts:32-38`)；mobile 仍单独大量硬编码中文（如 `mobile/App.tsx:130-147`, `mobile/components/SessionList.tsx:58-80`, `mobile/components/Composer.tsx:80-93`）。

---

# 大路线图（beta1 不做，留存方向）

- **core 通用化 + 插件面板**（`docs/todo/core-harness-and-plugin-panels.md`）：① core=无 coding/git 预设的通用 harness——4 个内核 git 触点参数化 / harness-min preset + CI 纯度 smoke / coding pack 外移(git/lsp/review/worktree/cc-orchestrator/quota…)；② 插件={UI 面板+能力}——PanelRegistry / manifest `panels` / csplugin:// 沙箱 host / 按 permissions 过滤的 scoped bridge。**Phase A(工具元数据合一 + PanelRegistry)最小可先做**。与 `architecture-debt.md` P1-⑤⑥ 重叠处合并执行。
- **架构债 P1/P2**（`docs/todo/architecture-debt.md`，P0 已并 main）：P1=拆 index、arena builtin 可选、拆 engine.ts、拆 App.tsx、真启用 safeStorage；P2=arena 移包/state 单例/cron 测试/文档措辞。
  - ✅ **拆 engine.ts 的两个前置已完成**（2026-07-07 codex 核实）：`extractJSON` 已提取到 `utils/json.ts`(`utils/json.ts:1-11`)，arena utils re-export 保留旧面(`arena/strategies/utils.ts:43-49`)；`EngineConfig`/`EngineHookConfig`/`EngineResult` 已在 `engine/types.ts`(`engine/types.ts:1-11`, `:26-70`, `:163-175`)，类型级 `tool-system→engine` 循环已不存在，仅剩一条 test-only 的 `Engine` runtime import（`agent.send-input.llm.test.ts:5`，可移入 engine 测试区或 allowlist）。拆 engine.ts 本体仍待做。
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
