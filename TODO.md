# CodeShell TODO

> 长期路线图。近期执行队列放在 `TODO-week.md`。
> 本文只保留**未完成 / 部分完成 / 待确认 / Roadmap**。已完成项一律归档到底部「✅ 已完成归档」一行一条，不再展开实现细节。
> 标注：🔧 部分完成 | ⬜ 未开始 | ❓ 待确认 | ~ 进行中

---

## 🎯 待办速览（当前真正未做 — 动手前先 grep 现状，见 [[project_todo_items_often_predone]]）

> 纯 code 活优先；需人盯/多天的另列。本表是「下一步该做啥」的唯一入口，详情见对应分区。

**本轮开工中（2026-06-09，五项，详见各分区）：**
- 🔧 **B1 路径授权后原工具继续运行**：批准路径后 Read/Glob/Grep 应重试续跑，避免被迫绕 Bash（核实：现真没做，工具批准后不重试）→ P0
- ⬜ **B2 审计路径授权**：记录批准来源/范围/过期/被拒原因（核实：现零审计）→ P0
- 🔧 **D1 `task` 加 `agentId` tag**：基础设施+desktop 隔离已做，缺 TodoWrite 传 agentId + TUI 隔离 → P5
- ⬜ **D2 Agent 角色 settings-level 默认**：默认 general-purpose 硬编码，加 `agent.defaultType` → P5
- 🔧 **A1 Shell Snapshot 错误高亮**：core 全做，只剩 renderer 把 STDERR 段染色 → P2

**其他纯 code / 收尾活：**
- 🔧 **真视频适配器**：替换 `FakeVideoProvider`，接入 seedance/kling（待各自私有 API 文档）→ P6
- ⬜ **GenerateImage 结果直接展示图片**：tool result 本地 PNG 在 desktop 渲染区预览 → P2
- 🔧 会话崩溃恢复产品闭环；工具超时/可取消性一致化；友好错误消息 → P1
- 🔧 配置系统：YAML 支持 / JSON Schema 生成 / 配置迁移机制（`/config show|set|get` 已实现）→ P4
- 🔧 长时段断网的会话级重连（瞬时错误已被 withRetry 覆盖）→ P1

**需人盯 / 多天 / Roadmap：**
- ⬜ 浏览器自动化能力（对标 WorkBuddy，见 P4）
- ⬜ Markdown 渲染体验优化（desktop/TUI 一致性）→ P2
- ⬜ 测试覆盖 / E2E / CI / 覆盖率 / 文档 → P7
- ⬜ 性能优化（启动懒加载、流式重渲染、大文件、MCP 连接池）→ P7
- ⬜ Roadmap：P4 Workspace 数据源绑定、P5 远程控制/跨代理编排、view_image TUI inline 渲染

---

## P0 — 安全、权限与隔离基石

### 🔧 权限系统增强

底座已成；剩余是路径授权的体验闭环与审计。

- [x] **B1 原工具可继续运行** —— 核实后认定**无需实现**（2026-06-10）：控制流本就正确。7 个工具(read/glob/grep/edit/write/notebook/apply-patch)统一 `const blocked = await enforcePathPolicyWithApproval(...); if (blocked) return blocked;`——审批在 enforce **内部** await 完成，批准则 return null，工具继续往下执行，从不提前 return。用户当时"点批准后报错"的真因是 ESM 裸 `require()` 抛 `require is not defined`(path-policy/permission.ts)→已修(7642c16)。原 review 误读控制流。
- [ ] **B2 审计路径授权（暂缓 → P3，企业/受监管场景再做）**：记录批准来源/范围/过期/被拒原因。核实(2026-06-10)：路径**授权机制本身是核心安全闸、会一直用**(越界/敏感才拦，工作区内直接放行)；但「审计日志」是低频、个人本地场景几乎用不上的合规功能，性价比低，故降级暂缓。设计已就绪(单独 JSONL `path-approval-audit.jsonl` + 滚动尾部 N 条 + 接 enforcePathPolicyWithApproval 四分支)，要做时直接落。`recordPathApproval` 现只写前缀到 settings.local.json，零审计信息
- [~] **路径策略 block 接入权限系统**：`enforcePathPolicyWithApproval` 已交互批准本次/拒绝（aa1bcd7）；本会话/特定路径范围待补（同路径级规则）。测试 path-policy-approval.test.ts

> 已完成部分见底部归档：路径级前缀规则、命令模式匹配、会话级缓存、`/permissions`、scope UI、Sandbox 全套。

---

## P1 — 核心运行可靠性

### 🔧 错误处理与恢复

- [~] 网络断开自动重连 —— 瞬时网络错误已被 `withRetry` 覆盖（5xx/ECONNRESET 重试）；**长时段断网的会话级重连待补**
- [ ] 会话崩溃恢复：RunManager 的 `recover` 已部分实现，需补齐产品闭环
- [ ] 工具执行超时处理与可取消性一致化
- [ ] 优雅的错误消息：用户友好、包含下一步建议

> 已完成归档：LLM 重试（指数退避/可配/429/4xx 不重试）、重试期 Cancel 可打断、ApplyPatch 原子性、LLM/Engine 五个待确认项、自动化 run 卡死复核。

---

## P2 — 交互体验与工作流效率

### ✅ 运行中输入缓存 / 强制发送下一轮 —— 已完成（2026-06-09 核实）

- [x] 运行中排队 + 空闲自动 flush —— desktop（queuedInput.ts + App.tsx useEffect）+ TUI（App.tsx useEffect）两端均有
- [x] 显式"强制发送/打断并进入下一轮" —— desktop `forceSend()`（enqueue + stop）/ TUI `/force` 命令（入队 + client.cancel）
- [x] UI 展示"已缓存 N 条/将于本轮后发送" —— desktop 传 queuedInputCount 给 ChatView / TUI "⌛ 已缓存 N 条…"提示行
- [x] desktop + TUI 行为一致 —— FIFO 逻辑 + 自动 flush 两端对齐

### ⬜ GenerateImage 工具结果直接展示图片

- [ ] 确认 tool result 的图片路径是否进入 transcript/content block
- [ ] 确认 desktop Markdown/tool-result renderer 是否支持本地 PNG 预览
- [ ] 设计 GenerateImage 返回结构：保留路径文本 + 可渲染 image block
- [ ] 补 desktop 渲染测试/手动 smoke

### ⬜ Markdown 内容结构与渲染体验优化

- [ ] 梳理 desktop/TUI Markdown 渲染差异：标题、列表、引用、代码块、图片、链接、表格
- [ ] 优化长回答结构：摘要优先、分节、步骤列表、结果块、注意事项分离
- [ ] 优化代码块：语言标签、复制按钮、长代码折叠/滚动
- [ ] 图片/链接混排一致性（本地路径、图床、Markdown image/link）
- [ ] 明确工具结果 Markdown 结构规范，避免正文/JSON/日志混杂
- [ ] 补渲染 smoke/demo

### 🔧 Shell Snapshot —— core 全做，只剩 renderer 高亮（2026-06-09 核实）

- [x] 捕获 stdout/stderr 完整输出 —— bash.ts:118-120，STDERR: 段分隔
- [x] 智能截断：保留头尾 + 中间摘要 —— runtime/truncate-output.ts（含行边界对齐 + 巨行硬切回退），有测试
- [x] 退出码语义化：非零→`Exit code: N (command failed)` / 信号杀→`Killed by signal: X`，截断后 prepend 永不丢 —— bash.ts:134-142
- [ ] **错误输出高亮标注（唯一剩余）**：core 已加 `STDERR:` 前缀，缺 renderer 富样式 —— desktop ToolResultView + TUI 把 STDERR 段染错误色，不改文本、保留复制

> 已完成归档：Undo/撤销系统（/undo、/undo all、diff 预览、ApplyPatch 备份）。剩 git 集成 + desktop 端入口（留后）。

---

## P3 — 上下文、记忆与指令系统

### ✅ 跨会话记忆系统（Memories）—— 配置全接（2026-06-09 核实，原标"待接"误导）

- [x] `memories.maxCount` 已接（覆盖默认 2）
- [x] `memories.maxAge` 已接 —— readMemoriesConfig → PromptComposer → MemoryManager.buildMemoryContext → `filterByAge` 按 mtime 过滤旧记忆；测试 memory.maxage.test.ts
- [x] `memories.extractionModel` 已接 —— engine.resolveExtractionClient：设了且在 modelPool 则优先用它提取记忆，否则回退 aux client

### 🔧 智能上下文管理

3 级 compaction（含 LLM 摘要 Tier 2 + 锚定滚动摘要）已实现。

- [~] **压缩阈值可配**：把 compaction 的 `compactAtRatio`(0.85)/`summarizeAtRatio`(0.92)/`microcompactFloorRatio`(0.7) 抽到 settings，用户按模型窗口自调。进行中。

> **不做（两项同因）**：
> - ~~每轮主动「请求压缩」(enable_request_compression)~~ — 摘要能力已在 Tier 2，触发走压力门控即可；每轮压会逐字节改写请求前缀→击穿 Anthropic prompt cache（前缀匹配）。
> - ~~token 预算动态调档位~~ — 同因：按剩余 token 实时下调档位/keepRecent 会变成"温而频"地改写历史前缀→缓存命中下降、成本反升。最优是"压得狠而稀"（压一次到更低水位、之后多轮前缀稳定）。现有固定 ratio 门控正是这个策略，刻意保留。

> 已完成归档：文件读取去重、tool result 压缩（多 Tier）、记忆合并/注入/`/memory` 全子命令、AGENTS.md 层级指令系统。

---

## P4 — 插件、MCP 与扩展能力

### ⬜ 浏览器自动化能力（Roadmap，对标腾讯 WorkBuddy / OpenClaw）

让 agent 驱动真实浏览器替用户完成网页操作（登录态复用、抓取信息、填表点击），作为继文件/数据源之后的又一类工具。目前**完全未支持**。

- [ ] 选型：headless Chromium via Playwright/Puppeteer，跑在本地（对齐 sandbox，数据不外发）
- [ ] 登录态/cookie 持久化：保存浏览器 storage state（cookie + localStorage）到本地跨任务复用；2FA/验证码把控制权交还用户
- [ ] agent 循环：观察（优先 DOM/无障碍树，截图兜底）→ 决策（click/type/scroll/navigate）→ 执行 → 回灌
- [ ] **token 成本控制（关键，别走截图优先的回头路）**：① 状态优先用精简后的可交互元素列表，非整页 DOM/截图；② prompt 缓存固定系统提示+工具定义；③ 微决策走小模型/小上下文；④ 上下文裁剪只留摘要+最近几步；⑤ 能用确定性脚本（登录态复用）就别进模型。截图仅在 DOM 抓不到时兜底
- [ ] 安全边界：复用 sandbox 文件/网络策略；不自动外发凭据、敏感操作需审批
- [ ] 暴露为工具 + desktop 浏览器面板接线（仓库已有浏览器面板，见 [[project_desktop_four_panels]]）
- 背景：2026-06-09 对话（用户问 WorkBuddy 怎么记 cookie / 是否无头浏览器代操作；澄清 token 大头在多步 agent 循环+每步塞网页状态，不在记 cookie）

### ⬜ Workspace 数据源绑定与作用域分配（Roadmap）

每个项目都是一个 workspace。用户可把不同外部数据源 link 到 CodeShell，再按 workspace 分配可访问范围。

- [ ] 定义 workspace 级资源模型：project path、linked data sources、allowed scopes、默认读取策略
- [ ] 支持 link 外部数据源：Figma、文档库、issue/PR、云盘、知识库、数据库等
- [ ] 按 workspace 分配数据源范围
- [ ] Agent 读取上下文时自动发现已授权数据源与范围
- [ ] 工具调用检查 workspace scope，避免跨项目读取
- [ ] 管理 UI/命令 + 授权审计（来源/更新时间/失效撤销）

### 🔧 配置系统完善

- [ ] 支持 YAML 配置（目前是 JSON；现有 yaml 解析仅用于 skill/agent frontmatter，非配置系统）
- [ ] 配置 JSON Schema 生成（IDE 自动补全）
- [ ] 配置迁移机制：版本升级时自动迁移旧配置
- 注：`/config show|set|get` 已实现（core-commands.ts），原 TODO 标「未做」属漂移；交互式 TUI 表单编辑仍可后续增强

> 已完成归档：插件 MCP 加载/禁用链路、MCP 管理页插件 owner 标注、Feature Flags 系统底座 + `/features`。

---

## P5 — Agent / 多代理能力

### ⬜ 远程控制入口 / 跨代理编排（Roadmap）

CodeShell 作为统一控制台，通过安全授权连接远程设备/环境，编排 Codex、Claude Code 等外部 coding agent。

- [ ] SSH 连接远程机器/开发环境
- [ ] 手机扫码 / 临时配对码完成设备授权与会话绑定
- [ ] 定义远程控制会话：下发任务、跟踪状态、收集日志与产物
- [ ] 编排 Codex CLI / Claude Code 等外部 agent
- [ ] 统一管理外部 agent 的 cwd/权限/审批/日志/产物/失败恢复
- [ ] 安全边界：不自动外发密钥、不绕过外部 agent 审批、不允许未授权远控

### 🔧 其他多代理增强

- [ ] **D2** Agent 角色 settings-level 默认配置：定义已从用户/插件/项目三源加载，但默认类型 `general-purpose` 硬编码在 agent.ts:51；加 `settings.agent.defaultType`，优先级 参数→项目默认→用户默认→general-purpose
- [~] **D1** `task` 加 `agentId` tag 防混入主视图：基础设施已做（task_update event 有 agentId 字段、子 agent 事件已打标、desktop 已隔离+测试）；缺 TodoWrite(task.ts) 发事件时带 agentId（ToolContext 需加字段）+ TUI 隔离（App.tsx task_update case）

> 已完成归档：后台 agent 完成通知、subagent_type enum、子 agent skill 隔离、max_depth/max_threads 限制、Agent 结果汇总视图、删除 SendMessage 死代码。

---

## P6 — 模型与工具能力扩展

### 🔧 多 provider 图片 / 视频生成工具

框架全做，剩真视频适配器（见 [[project_image_video_gen]]）。

- [ ] **接入即梦(seedance)/可灵(kling)真视频适配器**：替换 `video-providers.ts` 的 `FakeVideoProvider`（仍占位，待各自私有 API 文档）

### ⬜ view_image 后续增量

- [ ] TUI 端图片渲染：终端 inline image（iTerm/kitty graphics protocol）
- [ ] 策略 B：看过一轮后把历史图降级成文字摘要，进一步省 token

> 已完成归档：Model Provider 增强（authCommand/httpHeaders/reasoningSummary/serviceTier/fallback）、图片生成（OpenAI+Gemini）、视频生成框架、Code Review `/review` 命令。

---

## P7 — 工程质量、性能与文档

### 🔧 测试覆盖

- [ ] 工具集成测试：每个 builtin tool
- [ ] E2E 测试：完整对话流程
- [ ] CI 流水线：GitHub Actions
- [ ] 测试覆盖率 > 60%
- [ ] 清理已知不稳定 / 待修测试

### ⬜ 性能优化

- [ ] 启动时间优化：懒加载非核心模块
- [ ] 流式渲染优化：减少不必要的重渲染
- [ ] 大文件处理优化：分块读取、增量搜索
- [ ] MCP 连接池复用

### 🔧 文档

- [ ] 用户指南：Getting Started、Configuration、Tools Reference
- [ ] 开发者文档：Contributing Guide
- [ ] API 文档：公开 API 的 TypeDoc
- [ ] 中文文档

---

## ✅ 已完成归档

> 一行一条，不展开实现细节。需要细节查 git log 或对应记忆。

**P0 安全/权限**：Sandbox 全套（seatbelt/bwrap/policy/测试）· 路径级前缀规则(beea3d9) · 命令模式匹配 · 会话级权限缓存(按操作 keying，修「批准 git 放行 rm」) · `/permissions` · 审批 scope UI(f5f57ac)

**P1 可靠性**：LLM 重试(指数退避/可配/429/4xx 不重试) · 重试期 Cancel 可打断 · ApplyPatch 原子性 · LLM/Engine 五项(截断归一/resume 竞态/sandbox 缓存/SessionStart 注入/run 卡死复核) · RPC 30s 超时假死修复 · main 同步 fs 假死修复

**P2 交互**：运行中输入缓存(desktop) · Undo 系统(/undo · /undo all · diff 预览 · ApplyPatch 备份，cc25b03/cafe9e4)

**P3 上下文/记忆**：文件读取去重 · tool result 多 Tier 压缩 · 记忆合并(Dream)/注入/`/memory` 全子命令 · AGENTS.md 层级指令系统

**P4 插件/MCP/配置**：插件 MCP 加载/禁用链路(ea9dc50) · MCP 管理页插件 owner 标注 · Feature Flags 底座 + `/features` · `/config show|set|get`

**P5 多代理**：后台 agent 完成通知 + auto-background + outputFile · subagent_type enum+name · 子 agent skill 隔离 · max_depth/max_threads 限制 · Agent 结果汇总视图(c46e155) · 删 SendMessage/agentCoordinator 死代码

**P6 模型/工具**：Provider 增强(authCommand/httpHeaders/reasoningSummary/serviceTier/fallbackModelKeys，877639d) · 图片生成(OpenAI+Gemini) · 视频生成框架(三段式+后台轮询) · `/review` 命令(52daeb3)
