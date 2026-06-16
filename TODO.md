# CodeShell TODO

> 长期路线图。近期执行队列放在 `TODO-week.md`。
> 本文只保留**未完成 / 部分完成 / 待确认 / Roadmap**。已完成项一律归档到底部「✅ 已完成归档」一行一条，不再展开实现细节。
> 标注：🔧 部分完成 | ⬜ 未开始 | ❓ 待确认 | ~ 进行中

---

## 🎯 待办速览（当前真正未做 — 动手前先 grep 现状，见 [[project_todo_items_often_predone]]）

> 纯 code 活优先；需人盯/多天的另列。本表是「下一步该做啥」的唯一入口，详情见对应分区。

**本轮开工中（2026-06-09，五项，详见各分区）：**
- ✅ **B1 路径授权后原工具继续运行**：核实后认定无需实现——控制流本就正确,「批准后报错」真因是 ESM 裸 require(已修 7642c16),见 P0 正文。
- ⏸️ **B2 审计路径授权**（暂缓 → P3，企业/受监管场景再做）：个人本地场景性价比低,设计已就绪要做时直接落,见 P0 正文。
- ✅ **D1 `task` 加 `agentId` tag**（2026-06-10 fbe6f68）：核实 TodoWrite 无需改——engine.ts:1152 childStream 已给每个子代理事件 spread agentId(含 task_update);ToolContext 无需加字段。真缺口仅 TUI App.tsx task_update case 缺隔离闸,已补 `if (taskEvent.agentId) break;` 与 desktop 对齐
- ❌ **D2 Agent 角色 settings-level 默认**（2026-06-10 用户决策不做）：硬编码 general-purpose 兜底已够用,可配默认子代理角色对个人场景无实用价值;企业/多角色场景如真需要再议 → 取消
- ✅ **A1 Shell Snapshot 错误高亮**（2026-06-10）：core 抽 classifyBashLines 纯分类器(STDERR: 粘性区 + Exit code/Killed by signal 状态行,文本逐字不改保复制),双端各染色:TUI ToolCall errorLines→ansi:red,desktop BashToolCard→text-status-err;两套各带测试(8+6)

**其他纯 code / 收尾活：**
- 🔧 **真视频适配器**：替换 `FakeVideoProvider`，接入 seedance/kling（待各自私有 API 文档）→ P6
- ✅ **GenerateImage 结果直接展示图片**（核实 2026-06-16 已实现）：`GenericToolCard` 已调 `detectAttachments` 从结果文本提取 .png → `AttachmentCard`/`ImageThumb` 渲缩略图(readImageDataUrl)。本次补回归测试 attachments.test.ts。
- ✅ **GenerateImage 改并发**（核实 2026-06-16 已实现）：文件名已是 `${Date.now()}-${randomBytes(3)}.png` 去冲突 + `builtin/index.ts` 标 `isConcurrencySafe:true`,6 张图已并发。
- ✅ **plugin/skill 更新后「重载生效」闭环**（2026-06-16 b86e7fb1）：核实 skills/commands 本就被 PromptComposer + Skill 工具按 cwd 实时 `scanSkills`(下一轮即生效),hooks/MCP 由 running session 监听 `codeshell:settings-changed`→`configure({reloadSettings})` 重 reconcile([[project_config_hotreload_layer2]])。故更新成功只需 `signalHotReload()` 复用该事件,无新 core 接线;toast 改「已生效」。
- ✅ **plugin/skill「全部更新」批量入口**（2026-06-16 b86e7fb1）：updatable>1 时显示「全部更新 (N)」按钮,`runBatchUpdate` 串行跑+单项失败不中断+`summarizeBatch` 汇总 toast;Plugins/Skills 两 tab 共用 `applyUpdates.ts`(纯函数,6 例单测)。
- 🔧 会话崩溃恢复产品闭环；工具超时/可取消性一致化；友好错误消息 → P1
- 🔧 配置系统：YAML 支持 / JSON Schema 生成 / 配置迁移机制（`/config show|set|get` 已实现）→ P4
- 🔧 长时段断网的会话级重连（瞬时错误已被 withRetry 覆盖）→ P1

**需人盯 / 多天 / Roadmap：**
- 🔧 浏览器自动化能力（对标 WorkBuddy）：MVP 已实现(2026-06-17,8 工具+独立 browser-driver 模块+观察遮蔽+安全)；留后=交互审批弹窗/无人值守隐藏窗口/视觉兜底/真机 smoke → P4
- ⬜ Markdown 渲染体验优化（desktop/TUI 一致性）→ P2
- ⬜ 测试覆盖 / E2E / CI / 覆盖率 / 文档 → P7
- ⬜ 性能优化（启动懒加载、流式重渲染、大文件、MCP 连接池）→ P7
- ⬜ Roadmap：P4 Workspace 数据源绑定、P5 远程控制/跨代理编排、view_image TUI inline 渲染

---

## P0 — 安全、权限与隔离基石

### 🔧 权限系统增强

底座已成；剩余是路径授权的体验闭环与审计。（B1「原工具可继续运行」核实后认定无需实现——控制流本就正确，当年「批准后报错」真因是 ESM 裸 require，已修 7642c16，见底部归档。）

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

> 已完成归档：Undo/撤销系统（/undo、/undo all、diff 预览、ApplyPatch 备份）。剩 git 集成 + desktop 端入口（留后）。Shell Snapshot 全套（stdout/stderr 捕获、头尾智能截断、退出码语义化、错误输出双端高亮）。运行中输入缓存 / 强制发送下一轮（desktop + TUI 两端，FIFO + 自动 flush + `/force`）。

---

## P3 — 上下文、记忆与指令系统

### 🔧 智能上下文管理

3 级 compaction（含 LLM 摘要 Tier 2 + 锚定滚动摘要）已实现。

- [~] **压缩阈值可配**：把 compaction 的 `compactAtRatio`(0.85)/`summarizeAtRatio`(0.92)/`microcompactFloorRatio`(0.7) 抽到 settings，用户按模型窗口自调。进行中。

> **不做（两项同因）**：
> - ~~每轮主动「请求压缩」(enable_request_compression)~~ — 摘要能力已在 Tier 2，触发走压力门控即可；每轮压会逐字节改写请求前缀→击穿 Anthropic prompt cache（前缀匹配）。
> - ~~token 预算动态调档位~~ — 同因：按剩余 token 实时下调档位/keepRecent 会变成"温而频"地改写历史前缀→缓存命中下降、成本反升。最优是"压得狠而稀"（压一次到更低水位、之后多轮前缀稳定）。现有固定 ratio 门控正是这个策略，刻意保留。

> 已完成归档：文件读取去重、tool result 压缩（多 Tier）、记忆合并/注入/`/memory` 全子命令、AGENTS.md 层级指令系统、跨会话记忆配置全接（maxCount/maxAge/extractionModel）。

---

## P4 — 插件、MCP 与扩展能力

### 🔧 浏览器自动化能力（对标腾讯 WorkBuddy / Codex browser use）— MVP 已实现

让 agent 驱动内置 webview 替用户完成网页操作。调研稿 `docs/browser-automation-research-2026-06-16.md`，
技术方案 `docs/superpowers/specs/2026-06-16-browser-automation-mvp.md`。**2026-06-17 MVP 全实现**
（commits ac3044f9..e4b23db0）：

- [x] 选型：**CDP 驱动 Electron 内置 webview**（非 Playwright headless / 非 chrome-devtools-mcp / 非注入JS）——
  零依赖、跨平台内核一致、isTrusted 真实输入。淘汰理由全链见 spec §0，Codex 反向验证。
- [x] 登录态复用：直接用 `persist:browser` 持久分区（优于 Codex in-app 无持久化，避开 Skyvern 接管真实 Chrome 风险）；2FA/登录墙 → needsHuman 交还用户。
- [x] agent 循环：observe（`Accessibility.getFullAXTree` → 带 ref 元素列表，非截图）→ act（ref→backendNodeId→getBoxModel→`Input.dispatchMouseEvent`）→ re-observe。
- [x] token 控制：观察遮蔽（maskOldBrowserSnapshots 只留最新 snapshot，研究最高杠杆）+ a11y 列表非整页 DOM。
- [x] 安全：域名白名单 + 敏感动作（卡号/支付/删除）审批，执行层兜底不交 LLM；隔离 profile。
- [x] 工具：8 个 `browser_*`（snapshot/navigate/click/type/scroll/read_content/wait/press_enter）+ prompt 指南。
- [x] 端到端：小红书 搜→开→扒内容→总结 e2e 测试过；core 1407 + desktop 837 全绿。
- [ ] **留后**：敏感动作交互审批弹窗（现 fail-closed 自动拒）；无人值守隐藏 BrowserWindow（spec §9，复用同模块）；视觉兜底 SoM；真机 smoke（用户真机点验）。
- 独立模块 `packages/desktop/src/main/browser-driver/`（可拆/可搬去隐藏窗口）。

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

- [-] **D2** Agent 角色 settings-level 默认配置（2026-06-10 用户决策不做）：硬编码 general-purpose 兜底(agent.ts:51)对个人场景已够;可配默认子代理角色无实用价值,取消。企业/受限子代理场景如真需要:加 settings.agent.defaultType(SettingsManager.get() 已项目over用户合并)→engine 喂 ToolContext→resolveAgentTypeOverrides 按 参数→defaultType→general-purpose→首个,无效值静默退回

> 已完成归档：后台 agent 完成通知、subagent_type enum、子 agent skill 隔离、max_depth/max_threads 限制、Agent 结果汇总视图、删除 SendMessage 死代码、D1 `task` 加 agentId tag 防混入主视图（fbe6f68）。

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
