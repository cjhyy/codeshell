# 本周 TODO — 2026-06-03 → 2026-06-09

> 这周要做的事。**只放本周**；长线路线图见 `TODO.md`。**只保留未完成/进行中/待确认项。**

## 近期新增 / 本周候选

| 状态 | # | 任务 | 备注 / 关键落点 |
| ---- | - | ---- | --------------- |
| ⬜ 未开始 | 7 | **运行中输入缓存 / 强制发送下一轮** | 竞品（Codex/Claude Code）都有的关键交互：当前轮运行中用户仍可在输入框继续输入；默认先缓存为 queued input，等当前 assistant/tool 完成后自动读取并进入下一轮；同时提供显式“强制发送/打断并进入下一轮”能力。关键点：区分普通缓存 vs interrupt/force；UI 展示“已缓存 N 条/将于本轮后发送”；发送顺序稳定；避免与 approval prompt、AskUserQuestion、后台 agent 通知、automation/headless run 混淆；desktop + TUI 行为一致。 |
| ⬜ 未开始 | 8 | **GenerateImage 工具结果直接展示图片** | 当前只返回 `.code-shell/generated_images/*.png` 路径，聊天结果区没有 PNG 预览。需确认 tool result 图片路径是否进入 transcript/content block；desktop renderer 是否支持 tool result 本地 PNG 预览；设计返回结构：保留路径文本 + 可渲染 image block/Markdown image；补 desktop smoke。 |
| ⬜ 未开始 | 9 | **插件 MCP 在 MCP 管理页可见** | `chrome-devtools` 插件实际启动并连接了 `chrome-devtools-mcp`，但 MCP 管理页看不见。插件 MCP 不应由普通 MCP 配置页编辑 command/args/env，但应显示状态、工具数、工具列表、错误信息，并标注 `source=plugin` / `owner=<plugin>` / `editable=false`。 |
| ⬜ 未开始 | 10 | **Markdown 内容结构与渲染体验优化** | 梳理 desktop/TUI Markdown 渲染差异；优化长回答结构、代码块展示、图片/链接混排、工具结果 Markdown 结构规范；补 smoke/demo。 |
| ⬜ 未开始 | 11 | **路径策略 block 时缺少权限申请/继续运行能力** | 当前访问 workspace 外路径（如 Desktop、`~/.code-shell`）会被 path policy 直接 block，工具层没有正常弹权限/申请临时授权/继续执行的能力；用户即使口头授权也可能无法解除，导致只能绕到 Bash 或放弃。需要把 path policy deny 接入权限系统：展示可理解原因、允许用户批准本次/本会话/特定路径、批准后原工具可继续运行；避免 Bash 绕过造成策略不一致。 |
| ⬜ 未开始 | 12 | **移除项目后不应被 session 磁盘恢复自动复活** | 采用“移除=隐藏项目、保留本地会话”的方案 A：移除 repo 时按 path 写入 tombstone/removedProjectPaths；启动 backfill、disk rebuild、automation import、live session placement 的 `createRepoForCwd` 都要跳过已移除 cwd，不能因历史 session/run 自动重建侧栏项目；用户手动重新添加同一路径时清除 tombstone，并恢复该目录历史 session。同步更新确认弹窗/测试，保证“重新添加同一目录可恢复”语义成立。 |

## 遗留 / 待确认

- [ ] **插件 MCP 加载/禁用链路收尾** —— 现象：安装 `chrome-devtools-codex-plugin` 后，`mcp-servers.json` 已生成，`mergePluginMcpServers({}, [])` 能读到 `chrome-devtools:chrome-devtools`，但新 session 的 `ToolSearch` 里没有暴露 Chrome DevTools MCP 工具；关闭插件后也可能复用同一进程内已注册 MCP tools。后续期望：安装插件后新 session 自动加载插件 MCP；禁用插件后不再合并 MCP server、已连接 server 被 disconnect、`ToolRegistry` 对应 MCP tools 被 unregister；重新启用可重新 connect/register。
- [ ] **自动化 run 卡在 `turn.start` 后、首个 `llm.request` 前** —— 收集卡住 run 的 events/checkpoints/lock/heartbeat；定位 EngineRunner / RunManager / LLM request 前置路径；确认 lock release 与失败恢复。
- [ ] **view_image 收尾（剩 2 个计划明确排除的低优先增量）**：
  - TUI 端图片渲染（计划明确排除，低优先）：终端 inline image（iTerm/kitty graphics protocol）。core 已能产出 image 块，desktop 已能渲染（`InlineImageLink`），仅 TUI 缺。
  - 策略 B「看过一轮后把历史图降级成文字摘要」（计划排除，后续增量）：当前靠三道闸门 + tool_result.content 递归剥离控制污染，够用；主动降级是更激进的省 token 手段，留待需要时做。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研：`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计：`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计：`docs/superpowers/specs/2026-05-29-capability-control-design.md`（对应 #2）
- 泛化推理强度配置：`docs/superpowers/specs/2026-06-02-reasoning-config-design.md` + plan `docs/superpowers/plans/2026-06-02-reasoning-config.md`
- Goal 模式重设计：`docs/goal-mode-redesign-2026-06-02.md` + plan `docs/superpowers/plans/2026-06-02-goal-mode-p0.md`
- 工具可见性守卫 plan：`docs/superpowers/plans/2026-06-02-tool-visibility-guard.md`
- [自动化方案](./docs/automation-plan-2026-05-31.md) — headless/无人值守，Goal P0 是其 Phase 5 依赖
