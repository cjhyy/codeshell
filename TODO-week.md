# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**；长线路线图见 `TODO.md`。**只保留未完成/进行中/待确认项。**

## 近期新增 / 本周候选

| 状态 | # | 任务 | 备注 / 关键落点 |
| ---- | - | ---- | --------------- |
| ⬜ 未开始 | 14 | **Goal 模式最大轮次优化调研** | 先调研当前 Goal 模式最大轮次/停止条件/预算控制如何实现，确认是否存在轮次过少、过多、无法动态调整或 UI 不透明的问题；再比较可选优化方案：按 goal 类型配置默认 max turns、运行中可续轮/加预算、接近上限时提示、失败恢复与总结输出等。产出建议方案后再决定是否实现。 |
| 🟡 设计完成/待实现 | 15 | **Session 内后台命令支持** | 调研结论：当前不支持（Bash 同步 120s 超时杀；PTY 仅 UI 终端面板、agent 用不了；后台 agent 只能跑 LLM 不能跑进程）。已产出完整设计：`docs/superpowers/specs/2026-06-05-background-shell-design.md`（CC 式后台 shell 范式：Bash 加 `run_in_background` + BashOutput/KillShell/ListShells；core 层 `BackgroundShellManager`；session 级生命周期；五难点=进程组杀净/不被 Engine 等待循环卡死/端口探测/ANSI 清理/孤儿 pidfile；退出一行通知，运行中靠主动拉不灌 context；automation 禁用）。决策已敲定（关 tab 不杀仅 app 退出/删 session 才杀；抽 `core/runtime/spawn-common.ts` 共用沙箱+env+杀进程；落盘满 8MB 环绕覆盖）。待用户 review spec → writing-plans 拆实现计划。desktop UI 面板列为二期。 |

## 已完成 / 本周记录

- [x] **#8 GenerateImage 工具结果直接展示图片** —— desktop Markdown 放行内部 `codeshell-path:` scheme，raw `.code-shell/generated_images/*.png` 路径可走现有 inline image loader；保留文件名/路径入口；TUI 不变。
- [x] **#12 移除项目后不应被 session 磁盘恢复自动复活** —— 增加 removed repo path tombstone；移除项目时记录 path，手动重新添加时清除；automation backfill、disk rebuild、live session placement 自动建 repo 前跳过已移除 cwd。
- [x] **#13 设置页隐藏未实现的浏览器/电脑操控入口** —— 设置页暂不展示“浏览器 / 电脑操控”入口，后续真实能力实现后再恢复。
- [x] **#9 插件 MCP 在 MCP 管理页可见** —— MCP 页加载 user settings 与插件安装目录 MCP 的合并视图；插件 MCP 标记 `source=plugin` / `editable=false`，可测试连接、查看工具/错误详情，但不能在普通 MCP 配置页编辑、删除或启停。
- [x] **#10 Markdown 内容结构与渲染体验优化** —— 收敛为低风险渲染收尾：内部 `codeshell-path:` 链接保留，外部 URL 正常渲染；raw generated PNG 路径进入 inline image loader，保留文件名入口。
- [x] **#11 路径策略 block 时缺少权限申请/继续运行能力** —— `PathPolicy` 的 `ask` 决策接入交互式 approval：文件工具访问工作区外路径时弹“路径权限”确认，用户批准则本次工具继续，拒绝/headless 无 UI 则阻止；敏感写仍 hard deny。
- [x] **插件 MCP 加载/禁用链路收尾** —— 插件 MCP 进入 engine/runtime merged config；`refreshRuntimeConfig` 调用 `MCPManager.reconcile()`，安装/启用后可 connect/register，禁用/移除后 disconnect 并 unregister 对应 MCP tools，无需 Electron 重启。
- [x] **自动化 run 卡在 `turn.start` 后、首个 `llm.request` 前** —— 根因定位为 automation one-shot Engine 可能在首个 LLM 前等待 MCP startup；automation 现显式禁用 MCP tools 并传空 `mcpServers`，避免无人值守 run 被外部 MCP 启动阻塞。
- [x] **#7 运行中输入缓存 / 强制发送下一轮** —— desktop busy 时输入框保持可用，Enter 缓存当前可见 session 的 queued input 并显示“已缓存 N 条”，当前轮结束后 FIFO 自动发送；“打断发送”会先缓存再 cancel 当前轮。TUI busy 时普通输入进入 FIFO 队列，空闲后自动提交，`/force <text>` 缓存后取消当前轮。跨 session 后台自动 drain 留作后续增强。

## 遗留 / 待确认

view_image 的两个计划明确排除项（TUI inline 图片渲染、历史图降级成文字摘要）不作为本周执行项，保留到长期 backlog。

### code-review 遗留（2026-06-05 max-effort 审查，低优先级，已随特性提交但未修）

> 关键项（深层导入崩溃、normalizeRepoPath 大小写/根路径）已在 `ea9dc50`/`2e24b47` 修复。以下为审查保留的次要项，按落点分组待后续处理。

| 状态 | 任务 | 关键落点 |
| ---- | ---- | -------- |
| ⬜ 未开始 | **路径审批弹窗匹配过宽 + 标题误导** | `path-policy.ts:341` 批准判定用 `answer.trim().startsWith("允许本次")`，桌面端 AskUser 发原始自由文本（无 TUI 的 `Other:` 前缀），以「允许本次」开头的自由文本会误批准敏感读取——应改成与确切选项标签相等比较；另 `path-policy.ts:332` 标题硬编码「工作区外路径」，对工作区内敏感读取（committed `.env` 等）误标，应据 `c.reason` 区分。 |
| ⬜ 未开始 | **path-policy 跨工具不一致** | `notebook-edit.ts:74`/`apply-patch/index.ts:95`/`glob.ts:48`/`grep.ts:76` 仍用旧同步 `enforcePathPolicy`（ask→自动拒绝），与已接入弹窗审批的 Read/Write/Edit 不一致；NotebookEdit 作为写类工具尤为明显，唯一绕过是进程级关闭 `CODESHELL_PATH_POLICY`。考虑统一接 `enforcePathPolicyWithApproval`。 |
| ⬜ 未开始 | **reconcile 切断进行中调用 + 吞 rejection** | `mcp-manager.ts:217` 移除/禁用服务器时会断开其进行中的 MCP 调用（抛错被上报，非挂死；旧逻辑延迟到下次会话重建）；`engine.ts:2138` `void this.mcpManager.reconcile(...)` 无 `.catch`，rejection 被静默吞掉，应加日志兜底。（跨会话切断已验证不会发生——mcpServers 对所有会话全局一致。） |
| ⬜ 未开始 | **renderer 清理项** | App.tsx 有 4× 几乎相同的 `createRepoForCwd` 闭包（removed 守卫散落各处），可抽 `makeCreateRepoForCwd` 工厂收拢；`McpSection.tsx:124` `stripNameFromServer` 未剥 `source`/`editable`，toggle/save 会把这两个合并专用字段写进 settings.json（运行时无害，schema 会丢弃，但污染配置文件）；`repos.ts` 的 `loadRemovedRepoPaths` 在磁盘重建热循环里被逐会话重复 JSON.parse，可每轮 hoist 一次。 |

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研：`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计：`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计：`docs/superpowers/specs/2026-05-29-capability-control-design.md`（对应 #2）
- 泛化推理强度配置：`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` + plan `docs/superpowers/plans/2026-06-02-reasoning-config.md`
- Goal 模式重设计：`docs/goal-mode-redesign-2026-06-02.md` + plan `docs/superpowers/plans/2026-06-02-goal-mode-p0.md`
- 工具可见性守卫 plan：`docs/superpowers/plans/2026-06-02-tool-visibility-guard.md`
- [自动化方案](./docs/automation-plan-2026-05-31.md) — headless/无人值守，Goal P0 是其 Phase 5 依赖
