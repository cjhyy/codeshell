# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**；长线路线图见 `TODO.md`。**只保留未完成/进行中/待确认项。**

## 近期新增 / 本周候选

| 状态 | # | 任务 | 备注 / 关键落点 |
| ---- | - | ---- | --------------- |
| ⬜ 未开始 | 14 | **Goal 模式最大轮次优化调研** | 先调研当前 Goal 模式最大轮次/停止条件/预算控制如何实现，确认是否存在轮次过少、过多、无法动态调整或 UI 不透明的问题；再比较可选优化方案：按 goal 类型配置默认 max turns、运行中可续轮/加预算、接近上限时提示、失败恢复与总结输出等。产出建议方案后再决定是否实现。 |
| ⬜ 未开始 | 15 | **Session 内后台命令支持与 UI 展示调研** | 调研当前 session 是否支持启动长期后台命令（例如 `npm run dev`）并保持进程、流式日志、停止/重启；若不支持，梳理可行技术方案（进程管理、生命周期绑定、权限/approval、日志截断、跨 desktop/TUI/headless 行为）；若已支持，重点设计 UI：后台命令列表/状态、端口提示、日志展开、停止按钮、失败通知，以及与普通 Bash tool 输出的区别。 |

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

当前本周遗留已清空。view_image 的两个计划明确排除项（TUI inline 图片渲染、历史图降级成文字摘要）不作为本周执行项，保留到长期 backlog。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研：`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计：`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计：`docs/superpowers/specs/2026-05-29-capability-control-design.md`（对应 #2）
- 泛化推理强度配置：`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` + plan `docs/superpowers/plans/2026-06-02-reasoning-config.md`
- Goal 模式重设计：`docs/goal-mode-redesign-2026-06-02.md` + plan `docs/superpowers/plans/2026-06-02-goal-mode-p0.md`
- 工具可见性守卫 plan：`docs/superpowers/plans/2026-06-02-tool-visibility-guard.md`
- [自动化方案](./docs/automation-plan-2026-05-31.md) — headless/无人值守，Goal P0 是其 Phase 5 依赖
