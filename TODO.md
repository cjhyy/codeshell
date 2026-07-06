# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 最近一次清理：2026-07-06（逐条核实代码现状后重写）。

---

# 🔴 未修 bug（有实证）

- 🔴 **[压缩/token] 压缩用 `estimateTokensHybrid` 估算比真实 tokenizer 低 ~2.5×，压完仍远超真实上限且不再触发二次压缩** — 实测硬证据(session `s-mr908xtp-3a414dad`，同点无 confound)：`13:42:46 COMPACT before=239030 after=162940`(估)，`13:43:58` 压完首个真实请求 `msgs=190 promptTokens=409612`(真) → 压完估 162,940 vs 真实 409,612 = **2.5× 低估**；压缩前那侧估 ~239k vs 真实 ~694k ≈ 2.9× 低估。**现象**：压缩把 msgs 630→190、真实 ~694k→~409k(压缩本身有效)，但之后历史长回 190→234 条 / 真实 409k→**482k**，却再没触发第二次压缩 —— 因为估算以为只有 ~162k(41% of 400k，远低于 gate) = 用户看到的「压完还很满 / 一条就回弹」。
  - **机制(代码确认 `packages/core/src/context/manager.ts`)**：① 所有压缩 gate 与 before/after 一律用 `estimateTokensHybrid()`(:338/:350-352/:445-459)，**从不用**引擎每轮已拿到的真实 `promptTokens`(尽管 `recordActualUsage` 已接线在 `turn-loop.ts:741`)；② `estimateTokensHybrid`(:148-159)只在 `lastActualAtMessageCount < messages.length` 时才用真实锚点，**一次 summary 压缩把消息 630→190 后该条件变 false → 丢弃真实锚点回退纯启发式** = 2.5× 偏低的 162,940。
  - **修复方向**：(a) 压缩判定阈值与 before/after 优先采用引擎已有的真实 `promptTokens`；(b) `estimateTokensHybrid` 在压缩缩容(messages.length < lastActualAtMessageCount)后不应直接丢真实锚点回退纯启发式，应按缩容比例重估或立即用下一轮真实用量重锚；(c) 可选：给启发式针对代码/中文/JSON 更高系数，或直接接真实 tokenizer。
  - **已排除**：图片驻留(已修，实测 cacheRead 紧跟 prompt 无大图重发)、「磁盘大=上下文大」、压缩空转。关联记忆 `codeshell-compaction-underestimates-tokens-2p5x-evidence`、`codeshell-tui-context-window-uses-global-default-not-model-maxContextTokens`(窗口用 200k 全局默认而非模型真实窗口，同源需一并核)。

---

# 🟡 待改进 / 待优化

- 🟡 **[记忆/dream · 不对称] 会自动打扫的区(dream)小，不能自动打扫的区(user)反而堆最多** — 现状：平时会话记的东西几乎都直接进 **user 区**(要转正、跨会话可靠)，但 user 区 **dream 永远碰不到**(`dream-consolidation.ts:184-190` 硬拒非 dream scope 写入，因为后台 dream 无交互式权限后端)，只能靠交互会话里逐条批准删。结果**最该被自动清理的完成态 changelog 恰恰落在永不自动清理的区**。**根治方向(二选一或都做)**：① 让 dream 能对 user 区**提议**清理(列候选清单，用户一次性批准)；② 把 changelog/过程类记忆改成默认存 **dream 区**(可自动归档)，user 区只留耐用事实(架构/根因/偏好)。另 `shouldAutoDream()` 缺 Codex 的 rate-limit 阈值跳过(配额低时别烧 token 跑 dream)，可一并考虑。
- 🟡 **[编排] DriveAgent 前台超时静默丢任务**(`codeshell-driveagent-foreground-timeout-silent-drop`)：`background:false` 调用 120s 超时后返回通用错误字符串，任务未真移到后台也无 jobId，ListShells 查不到，完成通知永不来——与文档承诺不符，会误导编排 agent 谎报进度。
- 🟡 **[编排] 并发子代理同工作区碰撞风险**(`codeshell-multi-agent-collision-risk`)：并发 DriveAgent 在同一 cwd 无隔离，可能互相覆盖。关联 worktree 隔离。
- 🟡 **[worktree] CC/Codex session resume cwd 不匹配**(`codeshell-cc-codex-worktree-session-resume-cwd-mismatch`)：worktree 已删或 cwd 不符时 resume 出错。建议记 sessionId→cwd/worktree 映射，resume 强制原 cwd。
- 🟡 **[goal] complete_goal 无活跃 goal 仍被暴露/调用**(`complete-goal-no-active-goal-guard-root-cause`)：工具在 coding preset 无条件注册，turn-loop 处理时未检查 active goal 存在性。方向：运行时 gating + preset 层限制暴露。
- 🟡 **[会话] TodoWrite 列表 resume 后不恢复**(`codeshell-todo-session-resume-empty-list`)：resume 后模型看到空列表。
- 🟡 **[前端] panel state 保存写放大**(`codeshell-panel-refactor-save-all-buckets-write-amplification`)：保存副作用每次遍历全部 bucket，任意 bucket 变更即全量 savePanelState。
- 🟡 **[前端] 乐观输入气泡短暂丢失**(`codeshell-optimistic-input-bubble-overwritten-by-hydrate`)：hydrate 覆盖渐进式输入气泡。
- 🟡 **[CI] Windows CI 长期红**(`codeshell-windows-ci-gitbash-discovery-test-flake`)：shell-invocation 测试假设宿主无 Git Bash，但 Windows runner 预装 Git for Windows。

---

# 发布关键路径（beta1，必须用户亲自做）

- 🟡 **npm 包**（若本轮要发）：**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）；**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**：中/英切换走主流程，确认无未翻译泄漏 / 无 localStorage 报错。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**：`persist:login-*` 分区只清 cookie，localStorage/IndexedDB/SW 残留 → 改非持久分区或 `clearStorageData`；BrowserHost phase-2 webview 收编未预留类型/未抽共享 helper。
- ⚪️ **内部浏览器 Network 可视化/请求复用 UX**：内置浏览器面板看不到 Network。方向：给浏览器面板提供 Network 观察能力(请求列表/过滤/查看 payload/response/copy as fetch 或转工具调用)。注意隐私与凭证边界，默认只对当前 session/browser partition 可见。
- ⚪️ **JSON-Schema 导出未接线**：`schema-export.ts` 无 caller → 宿主启动写 `~/.code-shell/settings.schema.json` 或 release notes 注明不暴露。
- ⚪️ **i18n 收尾（增量）**：`"新对话"` 哨兵常量化；非 React helper 硬编码 localStorage key 应 import KEY；mobile(~149 处)单独接同套 i18n。

---

# 大路线图（beta1 不做，留存方向）

- **core 通用化 + 插件面板**（`docs/todo/core-harness-and-plugin-panels.md`）：① core=无 coding/git 预设的通用 harness——4 个内核 git 触点参数化 / harness-min preset + CI 纯度 smoke / coding pack 外移(git/lsp/review/worktree/cc-orchestrator/quota…)；② 插件={UI 面板+能力}——PanelRegistry / manifest `panels` / csplugin:// 沙箱 host / 按 permissions 过滤的 scoped bridge。**Phase A(工具元数据合一 + PanelRegistry)最小可先做**。与 `architecture-debt.md` P1-⑤⑥ 重叠处合并执行。
- **架构债 P1/P2**（`docs/todo/architecture-debt.md`，P0 已并 main）：P1=拆 index、arena builtin 可选、拆 engine.ts、拆 App.tsx、真启用 safeStorage；P2=arena 移包/state 单例/cron 测试/文档措辞。
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
