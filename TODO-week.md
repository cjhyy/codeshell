# 本周 TODO — 2026-06-03 → 2026-06-09

> 本周全量执行队列：把 `TODO.md` 的未完成项和本周新增产品项都拍到这里。完成一项就勾掉或移出；本文件暂时作为唯一执行看板。

## 执行原则

- 先做会影响全局命名 / scope / schema 的底座，再做依赖它的 UI 和工具。
- 每个大块完成后跑对应测试；改 core 后至少跑 core 相关测试，改 desktop 后至少跑 renderer/main 相关测试和一次手动 smoke。
- 已确认完成的旧项从本周看板移除；长期路线原文留在 `TODO.md`，这里按执行顺序重排。

## 🎯 下一步起点（新 session 从这里开始）

**✅ 3.2 Session 内后台命令支持已完成（2026-06-06）** —— core 层全做完(spec §10 五步),
仅 desktop UI 面板留二期。实现位置见下方 3.2 各勾选项;核心文件:
`runtime/{spawn-common,output-clean,ring-file,background-shell}.ts` +
`tool-system/builtin/background-shell-tools.ts`。共 6 commit 在 main。

**首选纯 core 活**（无需 UI 验收）：
- 4.1 同步 Agent 超 120s 自动转后台(用户已决策做;与 7.1 长任务不阻塞同源)
- 7.1 图片/视频生成(用户选定的下一步主攻)
- 5.1 剩余:路径前缀规则/审批范围选项(机制已具备,差 UI;归 UISprint)

**需要你盯着做的 UI 活**（建议有人在）：2.1~2.6、2.8~2.11（open-with 菜单、面板放大、
annotations rehype 样式、markdown 渲染、图片下载、手动停止样式、Undo、Shell Snapshot UI）。

**大路线图（多天）**：第 1 节 Workspace 概念升级 + Profile 管理、6.3 数据源、6.4 远程控制、7.1 图片/视频生成。

> 注：动任何"待实现"项前先 grep 现状 + 跑/读测试 —— 上一轮发现大量项其实早已实现只差勾选。

---

## 1. Workspace / 设置 Scope / 预设底座

### 1.1 项目概念升级为 Workspace

当前“项目/project”和 workspace 本质上是同一个对象，先做概念升级，避免后续设置页继续扩散 project 命名。

- [ ] UI 文案、侧边栏、设置页 scope、session 归属统一改成 workspace 认知。
- [ ] Hooks / 环境 / 子代理 / 预设选择器统一使用 workspace 选择交互。
- [ ] 底层 `.code-shell/settings.json` 路径语义可以保持，只消除命名混乱，不做重兼容迁移。
- [ ] 梳理 renderer/main/preload 类型里 `project` / `repo` / `workspace` 的边界，必要时分阶段改名。

### 1.2 设置页统一 Workspace 选择器

- [ ] 抽一个可复用 workspace picker，用于 Hooks、环境、子代理、预设等 project-scope 表单。
- [ ] 切换 workspace 时加载对应 `.code-shell/settings.json`。
- [ ] 保存只写当前选中的 workspace。
- [ ] 有未保存改动时给出脏状态提示，避免切换丢失。

### 1.3 本地环境设置支持切换 Workspace

- [ ] 环境页像 Hooks 一样先选 workspace。
- [ ] setup / cleanup 脚本按 workspace 读取和保存。
- [ ] KEY=VALUE 变量按 workspace 读取和保存。
- [ ] macOS / Linux / Windows 分 tab 的内容切换 workspace 后保持正确。

### 1.4 设置页子代理配置改为 Workspace 优先

- [ ] 子代理设置页先选 workspace，再编辑该 workspace 的子代理配置。
- [ ] 明确用户级默认子代理与 workspace 覆盖规则。
- [ ] 子代理列表、详情编辑、保存、删除都绑定当前 workspace。
- [ ] 交互参考 Hooks 的 workspace-scope 编辑模式。

### 1.5 整套预设管理：从 Prompt 到子代理

补完整 preset/profile 层，而不是只改单项设置。

- [ ] 明确概念命名：`general` 作为底座 preset；`terminal-coding` 更像内置 coding profile；Seedance 这类是 workspace profile。
- [ ] 常规页增加入口选择：让用户选择“写代码”还是“普通用户/通用任务”，对应启用 coding profile 或 general profile。
- [ ] 在设置页、会话顶栏或 workspace 信息区显示当前 active profile，让用户知道当前不是隐式跑在 terminal-coding。
- [ ] 增加 Profile 配置页：可查看、编辑、复制、导入、导出 profile。
- [ ] 设计 profile schema：base preset、主 agent prompt / 自定义指令、模型、权限、工具默认值、skills、hooks、env、子 agent 定义与路由配置。
- [ ] 梳理 prompt 组装顺序：customSystemPrompt、appendSystemPrompt、preset 段、personalization、AGENTS.md、skills、agent types。
- [ ] 梳理子 agent 继承 / 覆盖规则：模型、工具、skills、prompt、env、权限。
- [ ] 设置页支持创建、选择、编辑、复制、删除、导入、导出 profile。
- [ ] Profile 可按用户级和 workspace 级应用。
- [ ] 启动新 session 时明确当前使用的 workspace + profile，以及 profile 选择的 base preset。

---

## 2. Desktop 工作台与输入体验

> **🌙 无人值守执行批次(2026-06-06 夜)** —— 用户睡前授权「按推荐执行,不确定的先搁置并标注」。
> 本批我挑了风险低、可单测、隔离好的项动手:**2.5 / 2.9 / 2.1 / 2.2~2.3**。
> 下列项**主动搁置**(需有人盯/需先设计/需 core 配合),已在各项标 `⏸️ 搁置(夜批)` + 原因:
> - **2.4 面板放大覆盖输入区** —— 触碰 PanelArea 布局 + 草稿/queued 保活,回归面大,需肉眼 smoke。
> - **2.6 Markdown 渲染大改** —— 范围太泛(desktop/TUI 差异梳理),易过度发挥,先放着待你定优先级。
> - **2.8 手动停止消息样式** —— 需 core 补 stop_reason 区分(手动/超时/错误/自然结束)再做 UI,跨层。
> - **2.10 Undo 系统** —— 大特性,涉及文件备份 + git 集成,需先 brainstorm 设计。
> - **2.11 Shell Snapshot** —— 后端为主,与 3.2 后台 shell 输出有交集,需先理清归属。

### 2.1 输入框图片附件显示 / 携带路径

- [x] 输入框里的图片附件同时显示缩略图和 path。✅ chip 从「裸缩略图 + hover tooltip」改成横向卡片:小缩略图 + 可见文件名(truncate) + 字节数 + 移除键。**注**:浏览器 File API 出于安全只给文件名不给绝对路径,故 paste/drag 图只能显示文件名;真绝对路径仅"文件面板拖入"那条入口可得(见下条,待做)。
- [x] 发送给模型 / 工具时携带 path 元数据。✅ 本就已携带——`encodeAttachmentsForWire` 的 `<codeshell-image name="...">` 块带 name;assistant/工具可据此引用。(同上:name=文件名,非绝对路径)
- [~] 粘贴、拖拽、文件选择三条入口行为一致。**部分**:三条都走 buildAttachments/acceptFiles 统一管线,chip 展示一致;入口本身行为早已一致。
- [ ] 文件模块对话框支持直接拖入文件，方便从 Finder / 文件面板快速添加。**留待**:这是唯一能拿到真绝对路径的入口(文件面板内部有 root+rel),需单独接,排后。
- [x] `chat/attachments.ts` title / wire payload 保留图片来源信息。✅ wire 带 name;title 走 titleFromWire(图片占位不漏 base64)。
- [~] 当前模型不支持图片时，提示里仍保留 path 便于用户引用。**部分**:不支持时已有 banner + 仍显示 chip(含文件名);"把文件名注入文本供引用"未做(需产品确认要不要自动塞)。

### 2.2 文件结果卡片支持选择打开方式

- [x] 抽统一的文件引用 / 打开底层能力。✅ `chat/openWith.ts`(openDefault/revealInFolder/openInEditor 三动作,window.codeshell 薄封装) + `chat/OpenWithMenu.tsx`(shadcn DropdownMenu,可传自定义 trigger 或默认 ⋯ 按钮)。
- [x] assistant 输出的文档卡片增加“打开方式”菜单。✅ AttachmentCard 加 hover ⋯ trigger 接 OpenWithMenu(左键仍开系统默认)。
- [x] 已编辑文件卡片也能打开方式选择，而不只展示 diff / 路径。✅ FileToolCard path 行加 OpenWithMenu(read/edit/write 详情都有;write 输出本就走 AttachmentCard 自动继承)。
- [x] 菜单项。✅ 走 A 固定菜单项:用系统默认应用打开 / 用编辑器打开 / 在文件夹中显示。编辑器走新 `shell:openInEditor` IPC(`editor.ts` 纯解析:CODE_SHELL_EDITOR 覆盖,默认 cursor→code 链,vscode 系用 --goto 保留行号;测试 editor.test.ts 8 例)。
- [x] 抽复用的 open-with 行为，避免每个卡片重复实现。✅ 即 openWith.ts/OpenWithMenu,各卡片只传 path/cwd。
- [~] assistant 后续回答里提到的文件路径 / repo 内位置可点击定位或打开。**部分**:Markdown 文件链接早已点击 openPath;右键/打开方式菜单接 Markdown 链接留待(需把 OpenWithMenu 包到 md-file-link,排后)。

### 2.3 四面板内文件也能用其他应用打开

> 夜批:open-with 底座(openWith.ts + OpenWithMenu)已就位,四面板接入是机械活但需肉眼验收各面板交互,先接了卡片侧;面板侧留待。
- [ ] 文件面板里的文件入口接入同一套打开方式菜单。（底座已就位,接 FilesPanel 行即可,留待 UI 验收）
- [ ] 审查面板 / diff 文件入口接入同一套打开方式菜单。（同上,接 diff 文件头）
- [ ] 浏览器圈选或页面标记关联文件时，能定位到文件或用外部 app 打开。
- [ ] Terminal 面板里可点击文件路径时，复用打开方式能力。

### 2.4 四面板放大 / 缩小并可覆盖输入区  ⏸️ 搁置(夜批,需肉眼 smoke)

- [ ] `PanelArea` 增加放大 / 缩小状态。
- [ ] 放大态可临时覆盖或占用输入框区域，给文件预览、diff、浏览器更多空间。**已定(2026-06-06):覆盖输入区**(非压缩);返回普通态保留草稿/附件/queued input。
- [ ] 返回普通态时保留输入草稿、附件、queued input。
- [x] 切到设置页 / 其他全页视图再回来，也必须保留输入草稿、附件、queued input。✅ 草稿 / 附件已提升到 App 按 bucket 保存，ChatView 卸载后回来不丢；queued input 原本已在 App。
- [ ] 窄屏 / 移动尺寸不遮挡关键操作。
- [ ] 用 Browser / Playwright 做桌面和窄屏 smoke。

### 2.5 `<codeshell-annotations>` 标注块独立样式

- [x] 写 rehype 插件把 `<codeshell-annotations>` 转成可样式化节点。✅ 走 `extractAnnotations`(anchors.ts 纯解析,encodeAnchorsForWire 的逆)在 MessageStream 用户消息渲染处把块拆出,而非 rehype——因为标注块是 user 消息整体文本不走 ReactMarkdown,在 decode 层拆更干净。
- [x] 样式用左侧色条 + 浅底色 + 圆角边框，和普通消息区分。✅ `messages/AnnotationsBlock.tsx`(border-l-2 border-l-primary + bg-primary/5 + 圆角)。
- [x] 覆盖 Markdown 纯文本、列表中嵌入、长内容换行。✅ 条目用 ol/dl,locator 网格,comment/label 全 break-words 长内容换行。
- [x] 补 Markdown 渲染测试。✅ `anchors.test.ts`(5 例:无标注/拆块/解析条目/无prose/单条) + attachments.test.ts 补 titleFromWire 剥标注 1 例。
- 顺修:`titleFromWire` 剥掉标注块,避免「仅评论」turn 用 `<codeshell-annotations>` 当侧边栏标题。

### 2.6 Markdown 内容结构与渲染体验优化  ⏸️ 搁置(夜批,范围太泛待定优先级)

- [ ] 梳理 desktop / TUI Markdown 渲染差异。
- [ ] 优化标题、列表、引用、代码块、图片、链接、表格。
- [ ] 代码块补语言标签、复制按钮、长代码折叠 / 滚动策略。
- [ ] 工具结果 Markdown 结构规范化，避免正文、JSON、日志混在一起。
- [ ] 补长 Markdown smoke / demo。

### 2.7 运行中输入缓存 / 强制发送下一轮收尾 🔧

- [x] desktop 当前轮运行中继续输入、queued input、空闲自动 flush 已实现且稳定(queuedInput.ts + App.tsx;测试 queuedInput.test.ts)。
- [ ] 确认 TUI 行为一致(待补)。
- [~] 避免与 approval/AskUser/后台通知/automation 混淆(desktop bucket+asking 态已分流;边角待复核)。
- [x] 强制发送/打断进入下一轮 UI + "已缓存 N 条"提示。✅ desktop 对齐 Codex 风格:busy 时 placeholder 为「要求后续变更」,缓存内容显示为「后续变更」卡片;每条可「引导」(打断当前轮并优先发送该条)或「删除」。
- [ ] 清理 composer / 运行态里偏蓝、像链接的子 agent 状态文字，统一成 Codex 风格的低对比灰色状态行 / 卡片。

### 2.8 手动停止消息样式  ⏸️ 搁置(夜批,需 core 先补 stop_reason)

- [ ] 用户手动停止 / 中断 turn 时，用独立的轻量状态行展示，例如“你在 18s 后停止了”。
- [ ] 这类手动停止提示不需要折叠，不进入 tool / thinking 折叠卡片。
- [ ] 放在对应 assistant 输出下方，视觉上参考截图：右侧弱文本 + 分隔线，避免打断正文阅读。
- [ ] 区分用户手动停止、超时停止、错误停止、模型自然结束。
- [ ] 补 renderer 流事件 / message 分组测试。

### 2.9 图片预览支持放大 / 下载

- [x] 图片除了能在消息 / 输入框 / tool result 中预览，也要支持点击放大查看和下载按钮。✅ Lightbox toolbar 加下载/复制路径/在文件夹中显示。
- [~] 做完整 lightbox：原图查看、关闭按钮视觉居中、下载、复制路径、在文件夹中显示、切换下一张 / 上一张。✅ 除「切换上一张/下一张」外全做完;**prev/next 留待**——需调用方维护图片列表(MessageStream/Markdown 各自传单图),是更大改动,搁置(夜批)。
- [x] lightbox 关闭按钮基础样式修复：不用裸 `×` 文本，改为居中的图标按钮并预留 toolbar。
- [x] 下载支持生成图、用户上传图、paste / drag 图片，以及本地 `codeshell-path:` 图片。✅ `images:save` IPC 收 data URL(渲染端图全是 data URL),decode→save dialog→写盘;覆盖三类来源。
- [x] 下载时保留合理文件名；没有文件名时按来源和时间生成。✅ `image-save.ts` suggestImageFilename(优先源文件名,剥目录,补扩展名;无名→`image-<ISO时间戳>.<ext>`)。测试 image-save.test.ts(9 例)。
- [x] 图片 lightbox / 附件卡 / tool result 图片入口复用同一套下载行为。✅ 统一走 `window.codeshell.saveImage`;Lightbox 是各入口公用组件。
- [~] 下载失败时给出明确提示，并保留“在文件夹中打开”兜底。**部分**:saveImage 失败/取消返回 null 不抛;明确 toast 提示留 UI sprint(desktop 暂无统一 toast 通道,reveal 兜底已在 toolbar)。

### 2.10 Undo / 撤销系统  ⏸️ 搁置(夜批,大特性需先设计)

- [ ] 文件操作前自动备份。
- [ ] `/undo` 撤销最近一次文件修改。
- [ ] `/undo all` 撤销当前会话所有修改。
- [ ] 撤销前显示 diff 预览并确认。
- [ ] 评估与 git 集成：stash 或 undo commit。

### 2.11 Shell Snapshot  ⏸️ 搁置(夜批,与 3.2 后台 shell 交集需理清)

- [ ] 捕获命令执行后的 stdout/stderr 完整输出。
- [ ] 超长输出保留头尾 + 中间摘要。
- [ ] 错误输出高亮标注。
- [ ] 非零退出码语义化标记为失败。

---

## 3. Session / Goal / 后台执行可靠性

### 3.1 Goal 模式最大轮次优化 🔧

- [x] 调研：Goal 模式由 on_stop 裁判 hook(goal-stop-hook)+ complete_goal 主动声明协作;停止条件 = maxStopBlocks(默认8 连续) + maxTurns 上限 + run-scoped token/time budget(goal.ts GoalBudgetTracker)。
- [x] 判断问题:**核心 bug = goal 运行仍用交互默认 maxTurns 100**,无人值守长目标被静默截断,且无 goal 级配置。
- [x] 按 goal 配置默认 max turns:`resolveMaxTurns` 优先级 = 显式 config > goal.maxTurns > GOAL_DEFAULT_MAX_TURNS(300) > 交互默认(100);`GoalConfig.maxTurns` 经 normalizeGoal 归一(floored,非正丢弃)。
- [x] 接近上限提示 + 失败总结:turn-loop 已有 turnsRemaining===2 预警 / ===0 强制总结;goal 续跑达 maxStopBlocks 上限输出「先停下」;judge 失败/不可解析不放行(P0)。
- [ ] 运行中续轮 / 加预算(UI 交互层,需 desktop 配合,排后)。

### 3.2 Session 内后台命令支持

已有设计：`docs/superpowers/specs/2026-06-05-background-shell-design.md`。

- [x] 把 spec 拆成实现 plan。✅ 按 spec §10 五步顺序实现(spawn-common→manager→生命周期→工具→回归/automation)。
- [x] Bash 增加 `run_in_background`。✅ `bash.ts` runInBackground 分支;schema 加 run_in_background 参数。
- [x] 新增 BashOutput / KillShell / ListShells。✅ `tool-system/builtin/background-shell-tools.ts` + 注册进 BUILTIN_TOOLS。
- [x] core 层实现 `BackgroundShellManager`。✅ `runtime/background-shell.ts`(单例,与 asyncAgentRegistry 完全分离)。
- [x] 进程组杀净，避免孤儿进程。✅ detached 进程组 + `spawn-common.ts` killProcessGroup(SIGTERM→3s→SIGKILL);pidfile + reapOrphansFromPidfiles。
- [x] 运行中不灌 context，靠主动拉取输出。✅ 默认不进 context;BashOutput 增量游标拉取;退出仅一行通知(notificationQueue)。
- [x] 落盘 8MB 环绕覆盖。✅ `runtime/ring-file.ts`(内存 tail 权威 + 落盘镜像,超 cap 环绕,didWrap→头部 "(older output discarded)")。
- [x] app 退出 / 删除 session 时清理后台命令。✅ closeAll→killAll(app退出);handleCloseSession→killSession + desktop sessions:delete 转发 + TUI 退出 closeAll;idle-sweep 不杀。
- [x] automation 禁用后台 shell。✅ AUTOMATION_DISABLED_TOOLS 加三工具 + automation-host allowBackgroundShells:false;run_in_background 参数在 headless/子代理被拒。
- [ ] desktop UI 面板二期排入实现。（二期：把 ListShells/日志/停止接到侧边栏或设置面板。本轮仅工具层。）

### 3.3 LLM / Engine 待确认问题

- [x] OpenAI 截断续写触发条件统一 ✅：`isTruncatedStop` 已归一 length/max_tokens,turn-loop 两处都用。
- [x] RunManager approval / input resume 竞态审查 ✅：修两处——并发 resume 加 `resolvingRuns` 每-run 串行守卫;handle 在场但 input 不匹配改为报错(原会重新入队重复执行)。测试 RunManager.resume-race.test.ts(去守卫后失败证明有效)。
- [x] `resolveSandboxBackend` 缓存 ✅：EngineRuntime.resolveSandbox + Engine.resolveSandboxWithoutRuntime 均 cache by (mode,cwd),run 路径走缓存版,rejection 不缓存。测试 runtime.sandbox-cache.test.ts。
- [x] Plugin SessionStart hook 运行时验证 ✅：全链路通(runPluginCommandHook 三形态 additionalContext→messages,engine splice 进 user prompt 前 system-reminder)。测试 pluginCommandHook.test.ts。
- [x] 自动化 run 首个 LLM 前卡住的链路复核 ✅：lock release/失败恢复已闭环(finally 块 + recover stale-heartbeat);两个真因(rpc 30s 超时 d50c365、main 同步 fs 阻塞 178abc8)已在 main 修。

### 3.4 错误处理与恢复 🔧

- [x] LLM API 指数退避重试和可配置 retry policy —— client-base withRetry 已实现(指数退避封顶30s、retryMaxAttempts 可配、429 retryAfter、4xx 含埋藏 status 非重试)。测试 client-error.test.ts。
- [~] 网络断开自动重连 —— 瞬时网络错误已走 withRetry;长断网会话级重连待补。
- [ ] 会话崩溃恢复补齐产品闭环。
- [ ] 工具执行超时和可取消性一致化。
- [ ] 错误消息用户友好，并包含下一步建议。

### 3.5 ApplyPatch 原子性确认 ✅

- [x] 审查 `packages/core/src/tool-system/builtin/apply-patch/` 原子性实现 —— plan-then-commit + 内存快照回滚已就位。
- [x] 补多文件 patch 某个 hunk 失败时全部回滚测试 —— `apply-patch/atomicity.test.ts`。

---

## 4. Agent / 子代理 / 多代理能力

### 4.1 后台 agent 完成通知机制

> 核实(2026-06-06):前 3 项早已实现;120s 自动转后台已按用户决策实现;outputFile/删 AgentStatus
> 是**被现架构超越的旧计划**,不照抄(现架构走 notificationQueue 注入而非 outputFile;
> AgentStatus 作为可选 companion 保留,schema 已劝退轮询)。详见各项注解。

- [x] 改 Agent 工具 schema description 和 tool prompt：后台 agent 会自动通知完成，不要 sleep / poll。✅ `agent.ts` agentToolDef.description + run_in_background 参数描述均明写 "do NOT sleep, poll"。
- [x] 改 background spawn tool_result 文本：明确 async agent 已启动、结果会自动回来。✅ `agent.ts` 后台分支返回 "Async agent launched... notified automatically... results will arrive in a subsequent message"。
- [x] `markCompleted` / `markFailed` 后把结果作为下一 turn 输入注入主 session。✅ markCompleted/Failed→notificationQueue.enqueue;Engine.run wait-loop→drainAll→buildNotificationMessage 注入下一 turn(engine.ts ~1700)。
- [x] outputFile：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`。✅ `agent-output-file.ts`(writeAgentOutputFile 带 header+status+task,best-effort 不抛;路径 sanitize 防遍历;clearAgentOutputFiles 在 closeAll 清)。两条完成路径(后台 spawn + 120s 自动转后台)的 markCompleted/markFailed 后都落盘。notificationQueue 仍是主路径,文件是外部 tail/跨 session 副本。测试 agent-output-file.test.ts(6 例,含 HOME 隔离/遍历防护/写失败不抛)。
- [x] 删除或替换 AgentStatus 轮询路径。**已定(2026-06-06):不硬删,保留作查询工具**——明确定位为「主动查询单个/列当前」而非「轮询等完成」(schema description 已劝退轮询);结果回灌仍走 notificationQueue。默认只列当前 session(见下方 4.4 末项)。
- [x] 同步 `Agent(...)` 超过 120s 自动转后台。✅ 用户决策做(阈值 120s,语义=转后台+立即回提示+下轮接)。`agent.ts` 同步路径改成 Promise.race(runPromise, 120s timer):超时则 handoffToBackground**不杀**子代理(它继续在同一 signal 上跑)、注册进 asyncAgentRegistry、完成走 notificationQueue——主代理依赖结果时,Engine.run wait-loop 会等它并注入下轮。阈值可经 CODE_SHELL_AGENT_BG_MS 覆盖(测试用)。测试 agent.auto-background.test.ts。

### 4.2 对齐 subagent_type / agents 目录机制 🔧

- [x] 把 `agent_type` 升级为 schema enum（`agentToolDefWithTypes` 动态注入 enum=已 load 的 kind 名;空 registry 维持自由串以跑临时 agent）。
- [x] 动态注入已 load 的 kind 名，让 LLM 看得见可选子代理（enum + 描述块双管）。
- [x] `AsyncAgentEntry.name` 填 kind name：省略 `name` 时回退到 resolvedType,dock 显示有意义标签而非裸 "Agent"。
- [x] 主 agent kind 选择指南：已由 `buildAgentTypesBlock` 注入 Agent 工具描述（CC 范式,指南随工具走不重复进 system prompt）。
- [ ] Agent 角色预定义到 config：用户级目录已有，补 settings-level 默认配置。

### 4.3 子 agent skill 隔离 ✅

- [x] `agent/agent-definition.ts` 解析并保留 `skills`（YAML 列表 / 逗号串归一，复用 normalizeNameList，tools 一并升级）。
- [x] `serializeAgentDefinition` 对称回写 `skills`。
- [x] 构造子 engine 时把 `def.skills` 作为 skill allowlist 下传（overrides.skillAllowlist → SubAgentSpawnRequest.skillAllowlist → EngineConfig.skillAllowlist）。
- [x] `skills/scanner.ts` 支持 allowlist（ScanSkillsOptions.skillAllowlist，[] = 无 skill,undefined = 继承全量）。
- [x] `tool-system/builtin/skill.ts` 列出 / invoke 时按 allowlist 过滤（ctx.skillAllowlist；池外 skill 报「not available to this sub-agent」而非 not found）。
- [x] 未在 allowlist 的 skill 不进入 system prompt（PromptComposer.skillAllowlist），也拒绝 invoke。
- [x] `buildAgentTypesBlock` 显示受限 agent 的 skill 集（仅当 role 限制时显示，避免噪声）。
- [x] 未配 `skills:` 维持继承项目全量池。
- [x] 测试：`scanner.allowlist.test.ts` / `agent-definition.skills.test.ts` / `skill.allowlist.test.ts`（15 用例,含未配行为不变）。

### 4.4 多代理控制与结果视图 🔧

- [x] `max_depth`：现为有意的扁平层级(depth=1),isSubAgent 双把关,子 agent 不能 spawn。
- [x] `max_threads`：`MAX_BACKGROUND_AGENTS=6` 已存在并把关(对齐 Codex)。
- [x] `job_max_runtime_seconds`：有意不设同步墙钟超时(旧 5min 误杀重活+double agent_end 竞态),靠 maxTurns+工具超时+abort。
- [x] Agent 间通信:**删除半成品** SendMessage/agentCoordinator(死代码,register/receive 从未被调,扁平无状态设计不需要 mailbox,回灌走 notificationQueue)。
- [x] `task` 加 `agentId` tag，避免子 agent task 混进主视图。✅ **核实早已端到端实现**:子 agent 的 stream 事件跨到父流时被 `engine.ts:1054` 统一打 `{...event, agentId: req.agentId}`;desktop reducer `types.ts:488` `if (event.agentId) return state` 直接把带 agentId 的 task_update 丢出主面板。只差勾。
- [~] Agent 执行结果汇总视图。**搁置(逛街批)**:真 UI 特性(把各后台 agent 结果聚合成一个可浏览视图),需 renderer 设计 + 肉眼验收。core 侧数据已具备(asyncAgentRegistry.transcript + outputFile + notificationQueue 回灌)。
- [x] `AgentStatus` 支持按当前 session 过滤 / 默认只列当前 session 的后台 agent。✅ 加 `listForSession`;AgentStatus 默认只列当前 session(`all:true` 才列全进程),无 session context 回退全列。测试 agent-status.test.ts(5 例)+ agent-registry.test.ts 补 listForSession。

> 注:原 4.5 Guardian 子代理审批已按用户决策删除(2026-06-06)——现有 permission 体系
> (规则匹配 / YOLO 分类器 / 危险命令强制 ask / 会话级操作缓存)已够用,不引入 LLM 审批官。

---

## 5. 安全、权限与沙箱

### 5.1 路径权限与审计收尾

- [~] 路径级权限规则：如允许写入 `src/`。**机制已具备**(PermissionRule.argsPattern + ruleMatches 支持任意 arg 正则,可写 `{tool:"Write",argsPattern:{file_path:"^src/"}}`);**缺**:buildProjectRule 对非 Bash 工具仍只到工具粒度,没从审批 UI 生成路径前缀规则。要做需配套 UI 让用户选「本路径/本目录」范围 → 归到 `/permissions` UISprint。
- [x] 命令模式匹配：如允许 `bun test`、`bun run build`。✅ 机制已就位:PermissionClassifier.matchesRule→ruleMatches 按 argsPattern.command 正则匹配;buildProjectRule 把 Bash 收窄到 head 命令(`bun`→放行所有 `bun ...`)。注:当前粒度是 head 命令而非子命令(`bun test` vs `bun`)。**已定(2026-06-06):保持 head 粒度**,不做子命令粒度(标为不做)。
- [x] 会话级权限缓存：同一会话内相同操作不重复询问。✅ InteractiveApprovalBackend 会话缓存改按**操作**(buildProjectRule 收窄,Bash→head 命令)而非工具名 keying;修了「批准 git status 整会话放行 rm -rf」的安全 bug。测试 permission.session-cache.test.ts。
- [ ] `/permissions` 命令查看和管理当前权限规则。**UI 活**(slash command + renderer 列表/编辑),需肉眼验收,留给有人盯的 UI sprint。
- [~] 路径策略 block 时展示原因，并允许批准本次 / 本会话 / 特定路径。**部分**:已展示原因 + 「允许本次/拒绝」(enforcePathPolicyWithApproval);「本会话/特定路径」选项需扩 askUser options + 把审批结果回灌 sessionAllowRules,与上面路径级规则 + UISprint 一起做。
- [x] 用户批准路径后，Read / Glob / Grep / NotebookEdit / ApplyPatch 等原工具继续执行。✅ 见下方「统一 path policy」——六个文件工具现全走 enforcePathPolicyWithApproval,批准后继续。
- [~] 审计路径授权：批准来源、范围、过期策略、被拒原因。**部分**:permission.persist / permission.ask / permission.auto_deny 已结构化落 log(来源/decision/scope/reason);**缺**显式过期策略与统一审计视图(后者是 UI)。
- [x] 修复路径审批弹窗匹配过宽 ✅：改为精确 `=== "允许本次"`(原 startsWith 会把未来的「允许本会话」误判为一次性允许)。
- [x] 修复路径审批标题误导 ✅：按 `c.reason.startsWith("sensitive")` 区分——敏感文件标「敏感文件权限/工具想读取敏感文件」,工作区外标「路径权限/工作区外路径」(敏感文件可在 workspace 内,旧固定标题误导)。测试 path-policy-approval.test.ts。
- [x] 统一 `notebook-edit` / `apply-patch` / `glob` / `grep` 的 approval path policy。✅ 四者从 enforcePathPolicy(对 "ask" 硬拒)迁到 enforcePathPolicyWithApproval(走 askUser 审批,与 read/write/edit 一致),实现「用户批准路径后原工具继续执行」。测试 path-policy-approval-unify.test.ts。

### 5.2 沙箱执行系统

- [ ] macOS 基于 `sandbox-exec` / Seatbelt 实现文件系统与网络隔离。
- [ ] Linux 基于 Landlock / bubblewrap 实现沙箱。
- [ ] 定义 `SandboxPolicy`：allowed paths read/write、network access、process policy。
- [ ] Bash 工具集成沙箱包装。
- [ ] 沙箱失败时优雅降级，并给出可理解的权限 / 风险提示。
- [ ] 配置项：`sandbox.enabled`、`sandbox.allowNetworkFor` 等白名单。
- [x] 与后台 shell 的 `spawn-common` 统一，避免两套进程安全边界。✅ `runtime/spawn-common.ts` 抽 resolveSpawnTarget(沙箱wrap)+buildSandboxEnv(env allowlist)+killProcessGroup;前台 safeSpawnShell 与后台 spawnBackground 共用,bash.ts 删本地 env 副本。

---

## 6. 插件、MCP、Workspace 数据源与远程控制

### 6.1 插件 MCP 加载 / 禁用链路收尾 ✅

- [x] 安装插件后，新 session 自动加载插件 MCP（mergePluginMcpServers)。
- [x] 禁用插件后，不再合并 MCP server（reconcile 按 enabled 过滤)。
- [x] 禁用插件后，已连接 server 被 disconnect（reconcile 把 stale 全 disconnect)。
- [x] 禁用插件后，`ToolRegistry` 对应 MCP tools 被 unregister（disconnect finally 逐工具 unregister)。
- [x] 重新启用插件后，可重新 connect / register（connectAll 幂等)。
- [x] `engine.ts` 的 async reconcile 加 catch / 日志兜底（原 void 无 catch,失败=未处理拒绝可崩主进程;已加 catch→日志。测试 engine-config-hot-reload.test.ts)。
- [ ] 评估 reconcile 切断进行中 MCP 调用的用户体验(UI/产品观察,排后)。

### 6.2 MCP 管理页展示插件提供的 MCP server

- [ ] MCP 管理页合并展示配置态 MCP 与运行态 / 插件提供 MCP。
- [ ] server 增加来源 / 所有者信息：`source`、`owner`、`editable`。
- [ ] 插件 MCP 只读展示：状态、工具数、工具列表、错误信息。
- [ ] UI 标注“由 xxx 插件管理”。
- [ ] 用户配置 MCP 保留编辑 / 启停能力；插件 MCP 启停走插件开关。
- [ ] `McpSection.stripNameFromServer` 剥掉 `source` / `editable`，避免污染 settings。

### 6.3 Workspace 数据源绑定与作用域分配

- [ ] 定义 workspace 级资源模型：path、linked data sources、allowed scopes、默认读取策略。
- [ ] 支持 link 外部数据源：Figma、文档库、issue / PR、云盘、知识库、数据库等。
- [ ] 支持按 workspace 分配数据源范围。
- [ ] Agent 读取上下文时自动发现当前 workspace 已授权的数据源与范围。
- [ ] 工具调用检查 workspace scope，避免跨 workspace 读取未分配内容。
- [ ] 管理 UI / 命令：查看当前 workspace 绑定的数据源和可读资源。
- [ ] 记录授权来源、更新时间、失效 / 撤销状态。

### 6.4 远程控制入口 / 跨代理编排

- [ ] 支持 SSH 连接远程机器或开发环境。
- [ ] 支持手机扫码 / 临时配对码完成设备授权与会话绑定。
- [ ] 定义远程控制会话：下发任务、跟踪状态、收集日志与产物。
- [ ] 支持编排 Codex CLI、Claude Code 等外部 coding agent。
- [ ] 统一管理外部 agent 的 cwd、权限、审批、日志、产物与失败恢复。
- [ ] 明确安全边界：不自动外发密钥，不绕过外部 agent 自身审批，不允许未授权远控。

---

## 7. 模型、图片 / 视频、工具能力扩展

### 7.1 多 provider 图片 / 视频生成工具

- [x] 抽 `ImageProvider` 适配器接口。✅ image-providers.ts(块1)。
- [x] 内置 OpenAI `gpt-image` 适配器，迁移现有实现。✅ OpenAIImageProvider,wire 与原实现字节一致。
- [x] 内置 Gemini Nano Banana / Gemini 2.5 Flash Image 适配器。✅ GeminiImageProvider(块2,generateContent 端点 + x-goog-api-key + inline_data/inlineData 双兼容,据官方文档)。
- [x] provider / model 从配置读取，不再写死 `gpt-image-2`。✅ resolveImageProvider 按 kind + DEFAULT_IMAGE_MODEL。
- [x] GenerateImage 入参加可选 `provider` / `model`。✅
- [x] 新增 `GenerateVideo` 内置工具，产物写 `.code-shell/generated_videos/`。✅ generate-video.ts(块3),fire-and-forget 后台轮询 + 完成通知。
- [x] 抽 `VideoProvider` 适配器接口，支持 submit / poll / download。✅ video-providers.ts(submit/poll/download 三段式 + FakeVideoProvider 端到端测试)。
- [~] 内置即梦 / Seedance、可灵 / Kling 适配器。**留占位**:私有 API(火山/快手)端点/鉴权需准确文档;接口+工具+后台轮询已就位,getVideoProvider 加 case 即可接入。等用户给文档。
- [x] 长任务与超时对齐 GenerateImage 600s 放宽逻辑，必要时走后台任务 + 完成通知。✅ GenerateVideo 直接 fire-and-forget(后台轮询+notificationQueue 通知),不占工具超时;图片仍同步 600s。
- [ ] 连接页新增“图片生成”“视频生成”两个 provider 分组。**UI 活**,等你在场。
- [ ] settings schema：`imageGen.providers[]` / `videoGen.providers[]`，各带 default provider。**已定(2026-06-06):拆独立 schema**——与 LLM provider 解耦,各带 default provider,连接页可独立分组、可单独配生图专用 key。注:commit eeac759 已在朝 imageGen.providers[](id+kind) 走,与此决策一致;videoGen.providers[] 同样拆出。
- [ ] 密钥存 user scope，非密钥设置支持 workspace scope。(与上条 schema 一起,UI sprint)
- [~] 实现 image / video probe。**部分**:isGenerateImageAvailable / isGenerateVideoAvailable 已做(按是否配置 provider 决定工具可见性);独立 probe 命令是 UI 活。
- [ ] 泛化 `isGenerateImageAvailable`。
- [ ] 新增 `isGenerateVideoAvailable`。
- [ ] tool prompt / 描述按已配置 provider 动态生成。
- [ ] 测试未配置隐藏、配置后可用、多 provider 默认和覆盖。

### 7.2 Model Provider 增强

- [ ] 支持通过外部命令获取 token：`auth.command`。
- [ ] 支持自定义 HTTP headers：`env_http_headers`。
- [ ] `reasoning_summary` 参数支持。
- [ ] `service_tier` 参数支持。
- [ ] 模型自动降级：主模型失败时切换备用模型。

### 7.3 Code Review 内置命令

- [ ] `/review` 命令审查当前 git diff 或指定文件。
- [ ] 结构化 findings：优先级 P0-P3、置信度、位置。
- [ ] 支持 JSON 输出格式，便于 CI/CD。
- [ ] 可配置审查维度：安全、性能、可读性、正确性。
- [ ] 支持增量审查：只审查变更部分。

### 7.4 view_image 后续增量

- [ ] TUI 端 inline image 渲染：iTerm / kitty graphics protocol。
- [ ] 看过一轮后把历史图降级成文字摘要，节省 token。

---

## 8. 上下文、记忆、指令与配置

### 8.1 跨会话记忆系统 🔧

- [x] 记忆合并：dream-consolidation.ts + 手动 Dream 按钮(runDreamConsolidation)。
- [x] 新会话启动时自动加载相关记忆到 prompt：PromptComposer.getMemoryContext → buildMemoryContext 注入 system-reminder。
- [ ] `/memories list`、`/memories clear`、`/memories edit`(CLI 待补)。
- [~] 配置：memories.maxCount ✅(schema+orchestrator 透传到 parseExtractionResponse,测试 extract-memories.test.ts);maxAge/extractionModel 留位待接。

### 8.2 AGENTS.md 层级指令系统 ✅

instruction-scanner.ts 早已实现,补测试锁定。

- [x] 深层目录指令覆盖浅层(depth 0→N,combineInstructions root→cwd 排序,深层在后)。
- [x] 支持 `AGENTS.local.md`(每名派生 .local.md,source:local)。
- [x] 指令作用域标注(sourceLabel:project depth N / local override / user-level)。
- [x] 按作用域排序注入(managed→user→project→local,止于 git root)。测试 instruction-scanner.test.ts。

### 8.3 智能上下文管理 🔧

- [x] 文件内容缓存去重：dedupeFileReads Tier 0d 始终运行,同 path 旧 Read 清成指向新读的指纹,仅 Read 参与。测试 dedupe-file-reads.test.ts。
- [x] tool result 压缩：已有 Tier 0a 落盘 / 0b 硬截断 / 0c 预算 / Tier1 microcompact。
- [ ] 请求压缩：发送前压缩历史消息。
- [ ] token 预算管理：根据剩余 token 动态调整策略。

### 8.4 Feature Flags 系统 🔧

- [x] 定义 `FeatureFlags` 类型和默认值（feature-flags.ts FEATURE_FLAGS）。
- [x] 从配置文件加载 flags（settings.featureFlags Zod 字段）。
- [x] 各模块检查 flag 状态（isFeatureEnabled;engine toolDefs 按 flag 隐藏 WebSearch/Bash）。
- [x] `/features` 命令查看 flags（TUI,只读;切换走 settings.json）。
- [x] 候选 flags 登记齐：web_search/shell_tool(默认开)、fast_mode/undo/shell_snapshot(默认关)。测试 feature-flags.test.ts。

### 8.5 配置系统完善

- [ ] 支持 YAML 配置。
- [ ] 生成配置 JSON Schema，支持 IDE 自动补全。
- [ ] `/config` 命令交互式编辑配置。
- [ ] 配置迁移机制：版本升级时自动迁移旧配置。

---

## 9. 工程质量、性能与文档

### 9.1 Renderer / Desktop 清理项 🔧

- [x] `App.tsx` 抽 `makeCreateRepoForCwd`，收拢重复 `createRepoForCwd` 闭包 —— 5 处相同闭包收拢成 `repos.ts` 一个工厂(返回 `{createRepoForCwd, changed()}`,内部 didChange 替代各处 let reposChanged)。
- [x] `repos.ts` 的 `loadRemovedRepoPaths` 在磁盘重建循环里 hoist —— 工厂构造时快照 removed-path 成 Set 一次,替代原每会话 `isRepoPathRemoved`(每次重读+JSON.parse)。测试 repos.test.ts。
- [ ] 继续清理 settings / repo / workspace 命名混杂点。

### 9.2 测试覆盖

- [ ] builtin tools 集成测试。
- [ ] E2E 完整对话流程。
- [ ] GitHub Actions CI。
- [ ] 测试覆盖率 > 60%。
- [ ] 清理已知不稳定 / 待修测试。

### 9.3 性能优化

- [ ] 启动时间优化：懒加载非核心模块。
- [ ] 流式渲染优化：减少不必要重渲染。
- [ ] 大文件处理优化：分块读取、增量搜索。
- [ ] MCP 连接池复用。

### 9.4 文档

- [ ] 用户指南：Getting Started、Configuration、Tools Reference。
- [ ] 开发者文档：Contributing Guide。
- [ ] API 文档：公开 API 的 TypeDoc。
- [ ] 中文文档。
