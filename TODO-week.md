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

## 🚧 Beta 前清理清单

> 目标:第一个 beta 不追大路线图,但不能留下"设置页看起来能配,实际不知道配到哪里/是否生效"这类半成品。

- [ ] 设置页项目级 scope 入口收口:**已核实** `SettingsPage` 固定 `scope="user"`,但仍把 `activeRepoPath` 传给 Model/MCP/Environment/Agents 等 section;beta 前要明确哪些是全局、哪些先选项目再编辑,避免"看起来能配项目,实际跟随当前会话"。**决策(2026-06-08):不做设置页顶层 scope 切换;像 Hooks/Memory 一样,在需要项目维度的具体页面内先选"全局 / 某个项目",再进入编辑。**
- [x] 子代理设置页支持项目切换:✅ **已做(2026-06-09)** `AgentsSection` 改成 `{repos}`,像 Hooks/Memory 一样先 ProjectPicker(含「全局子代理」行)再进编辑;list/save/delete 绑定所选 store(全局=user / 项目=该 cwd)。
- [x] 子代理启用/禁用 scope 明确:✅ **已做(2026-06-09)** 全局视图开关写 user `disabledAgents`(二态 Switch);项目视图每个 agent 三态下拉(继承全局 / 强制启用 / 强制禁用)写该项目 `capabilityOverrides.agents` overlay(inherit→写 null 删键,deepMerge 当删除处理)。core overlay(`effectiveDisabledList`)本就在,只补 UI 写路径。
- [x] 本地环境设置页支持项目切换:✅ **已做(2026-06-09)** `EnvironmentSection` 改成 `{repos}`,先 ProjectPicker 再进 `ProjectEnvEditor({cwd})`;读写该项目 `.code-shell/settings.json` 的 setup/cleanup/env/sandbox。去掉原「默默跟随 activeRepoPath」。
- [x] 本地环境设置实际生效链路接通:✅ **已做(2026-06-09)** ① **env 进工具执行环境**:`spawn-common.mergeShellEnv`(项目 env 叠在 sandbox/off 基底上,bypass deny regex——用户自填的不同信任级);`ToolContext.shellEnv` 由 `Engine.buildToolContext`(新 `readShellEnv(cwd)` 读 project scope)填;bash.ts 前台 + background-shell.ts 后台都 merge。② **setup 在新建 worktree 时跑一次**:`worktree.selectPlatformScript`(平台→default 回退,空脚本视为缺省)+ `runWorktreeSetup`(复用 safeSpawnShell+sandbox+shellEnv,**失败只警告不回滚 worktree** 按决策);`enterWorktreeTool` 读 `Engine.readWorktreeSetupScripts(cwd)` 选脚本跑,结果附在工具返回里。③ cleanup 按决策**不做**自动收尾(UI 文案已说明)。测试:spawn-common(+5)/worktree-setup(9)/engine.shell-env(4)/bash.shell-env(3);core 全量 993 pass 0 fail。
- [~] Beta smoke checklist 跑一遍并记录:**部分(2026-06-09)** 可静态验证的全过:core 全量 993 pass、core+desktop `tsc --noEmit` 全绿、core build + renderer `vite build` 成功、env 链路有端到端测试(bash.shell-env)。**剩交互式肉眼 smoke**(新会话/模型配置/文件编辑/审查/图片附件/后台 shell/undo)需真机起 Electron 走一遍,留给你在场跑;本轮改动只触及子代理/环境设置页 + 工具 spawn env,回归面已被上述测试覆盖。

## 📱 Remote / 手机端续跑与会话接管 〔低优,搁置 —— 2026-06-09〕

> **2026-06-09 决策**:特性一/二整体**降为低优、搁置**。当前主线是 Profile/数字人(§1.5)。
> 房间续跑与手机操作 session 价值在,但不阻塞数字人闭环;待主线告一段落再回。
> 下方实现笔记(代码位置/选型)保留,以便重启时不必重新调研。

> 背景核实:现在「房间(room)」和「codeshell session」是**两套互不相通的世界**。
> - 房间 = 一个常驻外部 `claude --print` 子进程(`resident-agent.ts`),上下文只活在进程内存里,**没有 session 概念**;`messages.jsonl` 仅供手机重连回放,不参与上下文重建。进程一死(desktop 重启/崩溃/close)上下文蒸发,无 id 可找回。
> - codeshell session = core `Engine`,上下文落 `~/.code-shell/sessions/<id>/{state.json,transcript.jsonl}`,续跑走 `engine.run(task,{sessionId})` 已内建;手机现在**碰不到**这套。
> - 已确认 claude CLI 支持 `--session-id <uuid>` / `--resume <id>`(resume only works with `--print`,正好匹配),特性一可行。
> - agent-bridge 里已有 `outboundTaps`,注释写明「用于 mobile remote 镜像」—— 特性二的接线点早已预留。

### 特性一:给房间补续跑(A 方案,先做,小而闭环)

让房间那个常驻 claude 进程跨重启续跑。**实现选择待定:首选 C**(标志位走快路径 + `--resume` 失败优雅回退新 session + 提示「上下文已丢失」,扛得住 claude session 文件被 GC)。

- [ ] 房间创建时生成 uuid,存进 `room.json` 新增字段(如 `claudeSessionId` + `claudeSessionStarted`)。`room-manager.ts:85-111` 创建逻辑、`room-manager.ts:13-23` RoomMeta。
- [ ] `ResidentAgentProcess.start()` 带上 `--session-id <uuid>`(首次)/ `--resume <uuid>`(续跑);`resident-agent.ts:106-127`(当前参数列表完全没传 session/resume)。
- [ ] 别再把 `system`/init 行当噪音丢(`resident-agent.ts:73`)—— 若改用「抓 claude 自报 id」路线需要它;走 `--session-id` 自控 id 则可不动,二选一记清。
- [ ] resume 失败兜底:解析错误 → 回退 `--session-id` 新建 + 通过 room 事件提示手机/desktop「上下文已丢失,已新开」。
- [ ] `open(roomId)` 决策点接上标志位(`room-manager.ts:176-186`)。

### 特性二:手机操作 codeshell 的所有 session(范围更大,特性一落地后单独 brainstorm + spec)

手机不再只连「房间」,而是直接列出/打开/驱动 desktop 那套真实 codeshell session。**走 core,不碰外部 claude;续跑天然走 `engine.run({sessionId})`。**

- [ ] 范围(Q2 已定 = 1+2):手机能**列出/续跑历史 session**(`listDiskSessions`)+ **新建 session**(选 cwd、选模型)。暂不要求接管「桌面正在跑着」的 session。
- [ ] 权限(Q3 已定):审批最终手机/desktop 都要支持;**现阶段手机端 session 先强制 `acceptEdits` 档免审批**,手机审批 UI 留后。
- [ ] 接线方向:手机 WebSocket 接到现有 session IPC 通道(`agent/run` / `subscribeSession` / `listDiskSessions` / `getSessionTranscript`),复用 `outboundTaps`(`agent-bridge.ts:124-145`)镜像事件,而非接到跑外部 claude 的房间。
- [ ] 「房间」何去何从待定(Q4 未答):废弃 / 保留作匿名临时对话入口与 session 并存 —— 进特性二 brainstorm 时再定。

**首选纯 core 活**（无需 UI 验收）：
- 4.1 同步 Agent 超 120s 自动转后台(用户已决策做;与 7.1 长任务不阻塞同源)
- 7.1 图片/视频生成(用户选定的下一步主攻)
- 5.1 剩余:**路径前缀规则**(仍缺,需扩 buildProjectRule 非 Bash 工具到路径粒度);审批范围选项(once/session/project)✅ 已做(f5f57ac,ApprovalCard split-button)

**需要你盯着做的 UI 活**（建议有人在）：2.1~2.6、2.8~2.11（open-with 菜单、面板放大、
annotations rehype 样式、markdown 渲染、图片下载、手动停止样式、Undo、Shell Snapshot UI）。

**大路线图（多天）**：第 1 节 Workspace 概念升级 + Profile 管理、6.3 数据源、6.4 远程控制、7.1 图片/视频生成。

> 注：动任何"待实现"项前先 grep 现状 + 跑/读测试 —— 上一轮发现大量项其实早已实现只差勾选。

---

## 1. Workspace / 设置 Scope / 预设底座

> **2026-06-09 重估**：本节大改方向。Profile/数字人/Team 的完整设计已外移到
> `docs/workspace-profile-讨论稿.md`（v0.5）。1.2/1.3 经核实**已实现**（ProjectPicker
> 已复用于 Hooks/环境/记忆/插件等设置页）；1.4 待勾验；1.5 被讨论稿接管；1.1 降 backlog。

### 1.1 项目概念升级为 Workspace 〔backlog，不在 MVP〕

当前“项目/project”和 workspace 本质同一对象。纯命名卫生，非 Profile 功能。
v0.5 既已决定「MVP 只做全局 Profile 库、不做 workspace 级独立库」，改名紧迫性下降 → 降级 backlog，等 Profile/Team UI 真要展示 workspace 时再顺手统一。**别删。**

- [ ] UI 文案、侧边栏、设置页 scope、session 归属统一改成 workspace 认知。
- [ ] 梳理 renderer/main/preload 类型里 `project` / `repo` / `workspace` 的边界，必要时分阶段改名。

### 1.2 设置页统一 Workspace 选择器 ✅ **已实现**

核实（2026-06-09）：`settings/ProjectPicker.tsx` 即可复用选择器，已接入 Hooks /
环境 / 记忆 / 插件 / MCP / 权限等设置页（`AdvancedSections.tsx:282,494`、`MemorySection.tsx:72` 等）。

- [x] 可复用 workspace/project picker，用于各 project-scope 表单。
- [x] 切换 workspace 时加载对应 `.code-shell/settings.json`。
- [x] 保存只写当前选中的 workspace。

### 1.3 本地环境设置支持切换 Workspace ✅ **已实现**

核实（2026-06-09）：`AdvancedSections.tsx:492` “本地环境按项目维护(setup / cleanup
脚本、KEY=VALUE 变量、沙箱边界)。选择一个项目以查看 / 编辑。” + ProjectPicker。

- [x] 环境页像 Hooks 一样先选 workspace。
- [x] setup / cleanup 脚本、KEY=VALUE 变量按 workspace 读取和保存。

### 1.4 设置页子代理配置改为 Workspace 优先 〔待勾验〕

机制与 Hooks/环境同源（同一 ProjectPicker + 项目级 settings），大概率已实现；
未逐字核到 AgentsSection 是否已接 picker。**动手前先 grep 验证现状再决定。**

- [ ] 〔验〕子代理设置页是否已先选 workspace 再编辑。
- [ ] 〔验〕用户级默认子代理与 workspace 覆盖规则是否已生效（capabilityOverrides.agents 已存在）。

### 1.5 整套 Profile / 数字人管理 → 见 `docs/workspace-profile-讨论稿.md`

本条已被讨论稿接管并大幅升级（数字人 = base preset + plugins/skills/mcp/子代理 +
主指令 + 可移植经验三层；可切换；Team Board；本地安装；marketplace 后置）。
原 TODO 散点保留作 checklist，实现以讨论稿 §6 实施路径为准：

- [ ] 概念命名定稿：`general` 底座 preset / `terminal-coding` 内置 coding profile / Seedance 这类是 workspace profile（数字人）。见讨论稿 §1、§8 待拍板①。
- [ ] 会话顶栏 / workspace 信息区显示当前 active profile（讨论稿 §5.4）。
- [ ] Profile 配置页：查看/编辑/复制/导入/导出（讨论稿 §5.6，marketplace 后置）。
- [ ] profile schema：base preset + 主指令 + 模型/权限/工具默认 + skills/hooks/env + 子 agent 路由（讨论稿 §5.1）。
- [ ] prompt 组装顺序：本地 CLAUDE.md（最高）> profile.mainInstruction > preset 段 + personalization + skills（讨论稿 §5.3、§8 已决策）。
- [ ] 经验三层注入：全局 / 数字人 / 局部（讨论稿 §5.5）。
- [ ] 启动新 session 时明确当前 workspace + profile + base preset。
- [ ] **P3 先行**：seedance 手动落地验证体验（独立目录 `~/code-shell-profiles/seedance/`，讨论稿 §6 P3）。

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
- [x] 文件模块对话框支持直接拖入文件，方便从 Finder / 文件面板快速添加。✅ **所有文件行都可拖**到输入框,composer 按类型分流:**图片→暂存为附件**(buildPathAttachment,name=绝对路径,chip+wire 带真路径);**其他文件→插入 `@绝对路径` 引用**到草稿(同 @mention 约定,用户/模型可引用)。另有「📎 添加到输入框」点击按钮(仅图片)。拖拽实现:行 `draggable`,dragstart 写路径到自定义 MIME `application/x-codeshell-path`;composer drop 识别该 MIME + classifyPath 分流;dragenter/over 都 preventDefault 才能 drop。**文件夹也可拖**→插入 `@目录路径`(让模型知道看哪个目录;文件夹不可能是图片附件,只插路径)。链路 App.attachImageByPath/ChatView.insertPathReference→FilesPanel。测试 attachments.test.ts(5 例)。
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

> open-with 底座(openWith.ts + OpenWithMenu)已就位;本批接入面板侧(用户在场验收)。
- [x] 文件面板里的文件入口接入同一套打开方式菜单。✅ FilesPanel 文件行加 hover ⋯ 触发器接 OpenWithMenu(e.path 绝对路径,传 root 作 cwd)。
- [x] 审查面板 / diff 文件入口接入同一套打开方式菜单。✅ ChangedFilesList 每条变更文件加 hover ⋯(e.path 相对路径 + 传 cwd 解析)。
- [~] 浏览器圈选或页面标记关联文件时，能定位到文件或用外部 app 打开。**N/A(暂)**:BrowserPanel 是 webview,无文件关联语义;留作未来。
- [x] Terminal 面板里可点击文件路径时，复用打开方式能力。✅(夜批)`terminalLinks.ts` 纯检测(URL + path:line,单测 13 例)+ TerminalPanel 接 xterm `registerLinkProvider`:路径走 openPath、http(s) 走 openExternal;URL 优先、路径在 URL 内不二次匹配、尾随标点/包裹括号剥离。

### 2.3a Turn 级编辑卡片 / 审查入口补齐

- [x] 每个 turn 后面的“编辑 / 文件变更”卡片点审查时，默认只审查该 turn 产生的文件 / diff，而不是直接落到整个工作区未提交 diff。✅ **bug 已修**:ReviewPanel 收到 turn 的 files 时默认 `scope="turn"`,文件树只列这些文件(reviewScope.filterByScope),不再落整工作区。
- [x] 审查入口支持切换范围：本 turn、未暂存、已暂存、提交、分支、上轮对话。**已做**:本轮改动 / 未暂存 / 已暂存 / 全部未提交(porcelain XY 分流) + **Slice 2 新增 committed(HEAD~1..HEAD)/ branch(base...HEAD,base 取 main/master/upstream)**。range scope 文件树走 `getGitRangeChanges`,逐文件 diff 走 `getGitRangeDiff`(新 IPC `git:rangeChanges`/`git:rangeDiff`/`git:branchBase`)。「上轮对话」未单列(turn 快照已覆盖单轮回看)。
- [x] 审查面板文件树按范围展示变更文件，区分 unstaged / staged。**已做**:按 scope 过滤展示,porcelain code 区分 staged(X)/unstaged(Y);**Slice 2 补增删行数徽章**(`getGitNumstat` / range 的 numstat → `+N/-N` 徽章)。
- [~] 提供“提交或推送”“创建拉取请求”等顶部动作，但按钮状态要按当前范围和 git 状态禁用 / 启用。**Slice 3 待做(用户决策搁置 2026-06-07)**:涉及 git 写操作(commit/push)+ 调 gh 建 PR,风险比只读 diff 高;且当前仓库有并行 mobile-remote / 权限改动在动,易冲突。审查工作流(范围切换 + diff + 行数徽章)已可用,动作条是增量,等并行改动落地、确认写操作交互后再做。
- [x] turn 级文件卡片与审查面板共享同一套 diff 数据来源，避免卡片显示 A、审查打开 B。✅ **修「看不了之前 turn 对比」**:card 的 `codeshell:review-files` 事件现带上该轮的 diff 快照(sessionDiffText)→ App reviewDiff → PanelArea → ReviewPanel turnDiff。本轮范围下 viewer 直接渲染这份快照(UnifiedDiffViewer diffText 短路,不查 git),所以**即使改动已被后续提交,仍能看那一轮当时改了什么**(之前只过滤 live git status,提交后就空了)。卡片内联 ReviewModal 本就用同一份 sessionDiffText,数据源一致。
- [x] 当前缺口(原 bug):turn 卡片“审查”落到整工作区 + 看不了历史轮对比。✅ 两者均已修(默认本轮范围 + 快照查看)。committed/branch 范围切换 Slice 2 已补。
- [~] **文件树 + 顶部动作整体对齐截图的审查工作流**:左侧按范围分组的变更文件树(unstaged/staged/committed/branch,带增删行数徽章)**✅ 已做**,顶部一排范围切换 **✅ 已做** + 提交/推送/建 PR 动作条 **(Slice 3 搁置,见上)**。审查的"读"形态已完整,剩"写"动作条。
> **优先级:这是真 bug 不是 nice-to-have**——用户实测「turn 卡片点审查 → 直接落到整工作区未提交 diff」是错的;应默认本 turn 范围,再给上述范围切换。需 desktop 审查面板较大改造,排 UI sprint。

### 2.4 四面板放大 / 缩小并可覆盖输入区

- [x] `PanelArea` 增加放大 / 缩小状态。✅ `maximized` state + toolbar 放大/还原按钮(Maximize2/Minimize2,在关闭键旁)。
- [x] 放大态可临时覆盖或占用输入框区域。✅ **覆盖**(按决策非压缩):App 把 `<main>`(聊天+composer)与 dock 包进 `relative` 容器(不含侧边栏);maximized 时面板 `absolute inset-0 z-30` 盖住整个聊天列(含输入区),侧边栏仍可见。停靠态维持原 width+border-l;放大态隐藏左缘 resize 把手。
- [x] 返回普通态时保留输入草稿、附件、queued input。✅ 放大只是视觉覆盖,**ChatView 不卸载**,草稿/附件/queued 全在 App state,还原后原样在。
- [x] 切到设置页 / 其他全页视图再回来，也必须保留输入草稿、附件、queued input。✅ 草稿 / 附件已提升到 App 按 bucket 保存,ChatView 卸载后回来不丢;queued input 原本已在 App。
- [~] 窄屏 / 移动尺寸不遮挡关键操作。**部分**:放大态盖满聊天列、toolbar 还原键始终在;系统性窄屏适配留后。
- [~] 用 Browser / Playwright 做桌面和窄屏 smoke。**留待**:e2e smoke 归 9.2/9.x,排后(单测 + tsc + build 已过)。

### 2.5 `<codeshell-annotations>` 标注块独立样式

- [x] 写 rehype 插件把 `<codeshell-annotations>` 转成可样式化节点。✅ 走 `extractAnnotations`(anchors.ts 纯解析,encodeAnchorsForWire 的逆)在 MessageStream 用户消息渲染处把块拆出,而非 rehype——因为标注块是 user 消息整体文本不走 ReactMarkdown,在 decode 层拆更干净。
- [x] 样式用左侧色条 + 浅底色 + 圆角边框，和普通消息区分。✅ `messages/AnnotationsBlock.tsx`(border-l-2 border-l-primary + bg-primary/5 + 圆角)。
- [x] 覆盖 Markdown 纯文本、列表中嵌入、长内容换行。✅ 条目用 ol/dl,locator 网格,comment/label 全 break-words 长内容换行。
- [x] 补 Markdown 渲染测试。✅ `anchors.test.ts`(5 例:无标注/拆块/解析条目/无prose/单条) + attachments.test.ts 补 titleFromWire 剥标注 1 例。
- 顺修:`titleFromWire` 剥掉标注块,避免「仅评论」turn 用 `<codeshell-annotations>` 当侧边栏标题。

### 2.6 Markdown 内容结构与渲染体验优化

- [~] 梳理 desktop / TUI Markdown 渲染差异。**搁置**:调研类大活,范围太泛,待你定优先级。
- [~] 优化标题、列表、引用、代码块、图片、链接、表格。**部分**:链接/路径链接/图片/代码块已优化(见各项);标题/列表/引用/表格的系统性微调留待。
- [x] 代码块补语言标签、复制按钮、长代码折叠 / 滚动策略。✅ 语言标签+复制按钮早已有(md-code-head);本批补**长代码折叠**:>24 行的代码块折叠成 420px 上限可滚动盒+底部渐隐,「展开全部 (N 行)」/「收起」切换。测试 Markdown.test.tsx 补 2 例。
- [~] 工具结果 Markdown 结构规范化，避免正文、JSON、日志混在一起。**搁置**:需逐工具梳理 result 结构,较大,排后。
- [~] 补长 Markdown smoke / demo。**部分**:长代码折叠有单测;另补窄屏布局 smoke(`narrow-layout.smoke.test.tsx`:用户气泡 max-w-[80%]/break-words 不撑窄屏、多图气泡渲染全部缩略图、lightbox <720px media 规则仍在)。真·像素级窄屏仍需 Playwright(人盯,归 9.x)。

### 2.7 运行中输入缓存 / 强制发送下一轮收尾 🔧

- [x] desktop 当前轮运行中继续输入、queued input、空闲自动 flush 已实现且稳定(queuedInput.ts + App.tsx;测试 queuedInput.test.ts)。
- [x] 确认 TUI 行为一致。✅ 核实 TUI(`ui/App.tsx`)早有同款模型:运行中输入→`queuedInputs` 缓存;轮结束 + 输入框空闲→`useEffect` 逐条 auto-flush;`/force <msg>` cancel 当前轮并把消息插队下一轮(对齐 desktop 的「引导」)。**补齐唯一差距**:TUI 之前静默缓存无提示,现加 `已缓存 N 条…(/force 立即打断并优先发送)` 提示行(输入框上方),对齐 desktop「后续变更」卡片的可见性。
- [~] 避免与 approval/AskUser/后台通知/automation 混淆(desktop bucket+asking 态已分流;边角待复核)。
- [x] 强制发送/打断进入下一轮 UI + "已缓存 N 条"提示。✅ desktop 对齐 Codex 风格:busy 时 placeholder 为「要求后续变更」,缓存内容显示为「后续变更」卡片;每条可「引导」(打断当前轮并优先发送该条)或「删除」。
- [x] 清理 composer / 运行态里偏蓝、像链接的子 agent 状态文字，统一成 Codex 风格的低对比灰色状态行 / 卡片。✅ composer「后台 N 个子代理运行中…」由 `text-status-running`(偏蓝)改 `text-muted-foreground`,仅保留小脉冲点用运行色。核实 AgentMessageView/LiveActivityLine 早已是 muted 灰;其余 status-running 用法是语义状态(spinner/任务进行中/连接中)非链接文字,保留。

### 2.8 手动停止消息样式  ⏸️ 搁置(夜批,需 core 先补 stop_reason)

> **核实(你在场批):此前判"需 core 补 stop_reason"过保守**——手动停止是纯 renderer 事件(App.stop()),不需要 core 改动。用 busySinceRef 记轮起始时间算耗时即可。
- [x] 用户手动停止 / 中断 turn 时，用独立的轻量状态行展示，例如"你在 18s 后停止了"。✅ 新 `turn_end` 消息 kind + `appendTurnEndMessage`;App.stop() 读 busySinceRef 算 elapsed→dispatch。文案"你在 Ns 后停止了"。
- [x] 这类手动停止提示不需要折叠，不进入 tool / thinking 折叠卡片。✅ TurnEndMessageView 是独立 message kind,不进任何 fold 卡片。
- [x] 放在对应 assistant 输出下方，视觉上参考截图：右侧弱文本 + 分隔线。✅ flex 行:左侧 flex-1 分隔线 + 右侧 11px muted 文本。
- [x] 区分用户手动停止、超时停止、错误停止、模型自然结束。✅ `turn_end.reason: "stopped"|"timeout"|"error"`(各有文案);自然结束不发此消息。当前只接手动停止;timeout/error 复用同 kind 待接(类型已留)。
- [x] 补 renderer 流事件 / message 分组测试。✅ types.test.ts 补 appendTurnEndMessage(含双击 stop 替换不堆叠)。

### 2.9 图片预览支持放大 / 下载

- [x] 图片除了能在消息 / 输入框 / tool result 中预览，也要支持点击放大查看和下载按钮。✅ Lightbox toolbar 加下载/复制路径/在文件夹中显示。
- [x] 做完整 lightbox：原图查看、关闭按钮视觉居中、下载、复制路径、在文件夹中显示、切换下一张 / 上一张。✅(夜批)prev/next 已补:Lightbox 接受可选 `items[]`+`index` 图集,>1 张时显示左右 chevron + 绑 ←/→ 键(环绕步进,纯函数 `stepIndex`/`navDeltaForKey` 单测)。图集范围=同一条消息内的兄弟图(MessageStream 多图 paste 传整组);Markdown 内联单图仍单图无导航。
- [x] lightbox 关闭按钮基础样式修复：不用裸 `×` 文本，改为居中的图标按钮并预留 toolbar。
- [x] 下载支持生成图、用户上传图、paste / drag 图片，以及本地 `codeshell-path:` 图片。✅ `images:save` IPC 收 data URL(渲染端图全是 data URL),decode→save dialog→写盘;覆盖三类来源。
- [x] 下载时保留合理文件名；没有文件名时按来源和时间生成。✅ `image-save.ts` suggestImageFilename(优先源文件名,剥目录,补扩展名;无名→`image-<ISO时间戳>.<ext>`)。测试 image-save.test.ts(9 例)。
- [x] 图片 lightbox / 附件卡 / tool result 图片入口复用同一套下载行为。✅ 统一走 `window.codeshell.saveImage`;Lightbox 是各入口公用组件。
- [x] 下载失败时给出明确提示，并保留“在文件夹中打开”兜底。✅(夜批)新增统一 toast 通道(`ToastProvider`+`useToast`,纯 reducer `toastState.ts` 单测 6 例,挂 main.tsx 根);Lightbox 下载成功→「图片已保存」、失败→「保存失败」、取消(返回 null)不提示;复制路径→「已复制路径」;代码块复制→「已复制代码」。reveal 兜底仍在 toolbar。

### 2.10 Undo / 撤销系统  🔧 首版 /undo 单步已做(cc25b03,spec 2026-06-07-undo-single-step)

- [x] 文件操作前自动备份。✅ Write/Edit 早有 + 本轮补 ApplyPatch。
- [x] `/undo` 撤销最近一次文件修改。✅ FileHistory 快照 + latestUndoTarget(按 timestamp)。
- [x] 撤销前显示 diff 预览并确认。✅ 两段式 /undo → /undo confirm + renderDiffPreview。
- [x] `/undo all` 撤销当前会话所有修改。✅ (cafe9e4) 每文件回到首次编辑前(earliestSnapshotsPerFile)+ 两段式多文件预览。
- [ ] 评估与 git 集成：stash 或 undo commit。(留后)

### 2.11 Shell Snapshot

- [x] 捕获命令执行后的 stdout/stderr 完整输出。✅ bash.ts 合并 stdout + `STDERR:` 段(safe-spawn 已分流捕获),无输出给占位。
- [x] 超长输出保留头尾 + 中间摘要。✅ **改掉原"只留头丢尾"**:`runtime/truncate-output.ts` truncateHeadTail——超 cap(100KB)保留头+尾,中间换成「[N chars omitted — showing first X + last Y]」标记,失败命令的尾部(错误/总结行)不再被丢。行边界对齐(单巨行回退硬切)。测试 truncate-output.test.ts(6 例)。
- [~] 错误输出高亮标注。**部分**:CLI 文本无富样式;已有 `STDERR:` 段分隔 + 失败行标记(下条)。富色高亮属 renderer 渲染活,排后。
- [x] 非零退出码语义化标记为失败。✅ 非零退出码→`Exit code: N (command failed)`;信号杀→`Killed by signal: X`;状态行在截断后 prepend,永不丢失。

---

## 3. Session / Goal / 后台执行可靠性

### 3.1 Goal 模式最大轮次优化 ✅

- [x] 调研：Goal 模式由 on_stop 裁判 hook(goal-stop-hook)+ complete_goal 主动声明协作;停止条件 = maxStopBlocks(默认8 连续) + maxTurns 上限 + run-scoped token/time budget(goal.ts GoalBudgetTracker)。
- [x] 判断问题:**核心 bug = goal 运行仍用交互默认 maxTurns 100**,无人值守长目标被静默截断,且无 goal 级配置。
- [x] 按 goal 配置默认 max turns:`resolveMaxTurns` 优先级 = 显式 config > goal.maxTurns > GOAL_DEFAULT_MAX_TURNS(300) > 交互默认(100);`GoalConfig.maxTurns` 经 normalizeGoal 归一(floored,非正丢弃)。
- [x] 接近上限提示 + 失败总结:turn-loop 已有 turnsRemaining===2 预警 / ===0 强制总结;goal 续跑达 maxStopBlocks 上限输出「先停下」;judge 失败/不可解析不放行(P0)。
- [x] **maxStopBlocks 调大 + 可配**:原硬编码 `?? 8` 对复杂目标偏紧(裁判连判 8 次「还没完」就强停,正常推进也可能被掐)。改:`GOAL_DEFAULT_MAX_STOP_BLOCKS=25`(命名常量)+ `GoalConfig.maxStopBlocks`(normalizeGoal 归一)+ `EngineConfig.maxStopBlocks`(engine 级覆盖)+ `resolveMaxStopBlocks`(config > goal > 默认 25)。真正的兜底仍是 token/时间预算 + maxTurns(300),这个 cap 只防「无进展死循环」。`extend()` 加轮时已顺带清 stopBlockCount。测试 goal.test.ts(5 例)。
- [x] 运行中续轮 / 加预算。✅ **端到端打通**:
  - core:`applyGoalExtension` 纯函数(加轮/加预算;未设预算时按当前用量 seed 出高于现值的新 cap)+ `TurnLoop.extend()`(改 config.maxTurns + 活 goalTracker.goal 预算,loop 每轮重读即下轮生效;加轮顺带清 stopBlockCount)+ `Engine.extendGoalRun()`(经 activeTurnLoop,仅顶层 run 挂)。
  - 协议:`agent/goalExtend` method + handleGoalExtend(按 sessionId 路由,无活跃 run 报错)+ ChatSession.extendGoalRun 转发。preload:`window.codeshell.goalExtend(...)` + 类型。
  - **触发时机=上限前 2 轮**(对齐 turn-loop 已有 turnsRemaining===2 预警):goal run 在此发 `goal_progress(approaching_limit, turnsRemaining)` 事件;GoalProgressView 渲染「目标接近轮次上限 · 还剩 N 轮 · [再续 50 轮]」按钮,点击→extendGoal→goalExtend IPC。reducer 把 approaching_limit 当瞬时标记(再来 goal_progress 时 prune 掉,不堆叠/不残留)。
  - 测试:goal.test.ts applyGoalExtension(6) + types.test.ts approaching_limit reducer(3,含 prune)。

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
- [x] desktop UI 面板二期排入实现。✅ 后台 Shell dock 面板:新增「后台 Shell」tab(ServerCog 图标)。新 RPC `agent/backgroundShells`(server.ts handleBackgroundShells,action=list/output/kill,直接读 backgroundShellManager 单例并按 sessionId 校验所有权——shell 跨 run 存活,不依赖活 ChatSession)+ preload listBackgroundShells/backgroundShellOutput/killBackgroundShell。`BackgroundShellPanel.tsx`:列本会话后台 shell(命令/状态点/端口/退出码),点开看完整输出(按需拉,非流),运行中可「停止」;3s 轮询刷新列表。engineSessionId 经 App.resolveActiveEngineSessionId→PanelArea→PanelBody 传入。跨进程链路:renderer→main(rpc)→worker(协议 server)→manager。

### 3.3 LLM / Engine 待确认问题

- [x] OpenAI 截断续写触发条件统一 ✅：`isTruncatedStop` 已归一 length/max_tokens,turn-loop 两处都用。
- [x] RunManager approval / input resume 竞态审查 ✅：修两处——并发 resume 加 `resolvingRuns` 每-run 串行守卫;handle 在场但 input 不匹配改为报错(原会重新入队重复执行)。测试 RunManager.resume-race.test.ts(去守卫后失败证明有效)。
- [x] `resolveSandboxBackend` 缓存 ✅：EngineRuntime.resolveSandbox + Engine.resolveSandboxWithoutRuntime 均 cache by (mode,cwd),run 路径走缓存版,rejection 不缓存。测试 runtime.sandbox-cache.test.ts。
- [x] Plugin SessionStart hook 运行时验证 ✅：全链路通(runPluginCommandHook 三形态 additionalContext→messages,engine splice 进 user prompt 前 system-reminder)。测试 pluginCommandHook.test.ts。
- [x] 自动化 run 首个 LLM 前卡住的链路复核 ✅：lock release/失败恢复已闭环(finally 块 + recover stale-heartbeat);两个真因(rpc 30s 超时 d50c365、main 同步 fs 阻塞 178abc8)已在 main 修。

### 3.4 错误处理与恢复 🔧

- [x] LLM API 指数退避重试和可配置 retry policy —— client-base withRetry 已实现(指数退避封顶30s、retryMaxAttempts 可配、429 retryAfter、4xx 含埋藏 status 非重试)。测试 client-error.test.ts。
- [~] 网络断开自动重连 —— 瞬时网络错误已走 withRetry;长断网会话级重连待补。
- [~] 会话崩溃恢复补齐产品闭环。**搁置(逛街批)**:disk-权威源恢复已做(见 project_disk_authoritative_recovery),"产品闭环"含崩溃后续轮 UI 提示/一键恢复,是 UI+产品决策活。
- [x] 工具执行超时和可取消性一致化。✅ **核实早已统一**:所有工具走 ToolRegistry.executeTool(registry.ts:96),超时优先级 options.timeoutMs > tool.timeoutMs > 120s 默认;子 AbortController 同时挂超时与父 signal,signal 注入工具 args;Agent/Arena/Bash 声明更长超时。非 per-tool 各搞一套。
- [x] 错误消息用户友好，并包含下一步建议。✅ `friendly-error.ts`(纯,可测):friendlyError 按消息模式映射 auth/rate-limit/timeout/network/context/quota/5xx → 清晰消息 + 下一步建议;未知错误原样透传不乱套话。turn-loop 三处 error 发射改走 formatFriendlyError。测试 friendly-error.test.ts(8 例)。

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
- [~] Agent 角色预定义到 config：用户级目录已有，补 settings-level 默认配置。**搁置(逛街批)**:触碰 agent 解析优先级(回归敏感),且与第 1 节 profile/preset 底座强耦合(用户要一起做);用户级 + 项目级目录机制已够用,settings 内联定义边际收益小。等第 1 节一起。

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
- [x] Agent 执行结果汇总视图。✅ 首版(c46e155,spec 2026-06-07-agent-summary-view):并行 fan-out ≥2 sibling 子代理在消息流里折成汇总卡(N 个·✓X ✗Y·tools·并行墙钟,折叠/展开,复用 AgentMessageView)。纯 renderer post-pass foldAgentGroups(reconcile 后跑,递归进 turn_process_group)。**留后**:跨会话/跨轮聚合成独立可浏览面板(用 asyncAgentRegistry.transcript+outputFile)是更大特性。
- [x] `AgentStatus` 支持按当前 session 过滤 / 默认只列当前 session 的后台 agent。✅ 加 `listForSession`;AgentStatus 默认只列当前 session(`all:true` 才列全进程),无 session context 回退全列。测试 agent-status.test.ts(5 例)+ agent-registry.test.ts 补 listForSession。

> 注:原 4.5 Guardian 子代理审批已按用户决策删除(2026-06-06)——现有 permission 体系
> (规则匹配 / YOLO 分类器 / 危险命令强制 ask / 会话级操作缓存)已够用,不引入 LLM 审批官。

---

## 5. 安全、权限与沙箱

### 5.1 路径权限与审计收尾

- [x] 路径级权限规则：如允许写入 `src/`。✅ **核实 2026-06-09 已完成**:`buildProjectRule(toolName,args,{pathScope})` 已支持非 Bash 文件工具的路径粒度(`permission.ts:306-324`,PATH_SCOPED_TOOLS 命中按 file_path 生成前缀规则);审批 UI `ApprovalCard.tsx:77-93` 已暴露「本文件/本目录」path-scoped 选项(折叠进 更多范围 ▾),全链路透传 `ApprovalCard→onDecide(pathScope)→App.tsx:1531→approve(...pathScope)→buildProjectRule`。原"缺非 Bash 路径粒度"描述已过时。
- [x] 命令模式匹配：如允许 `bun test`、`bun run build`。✅ 机制已就位:PermissionClassifier.matchesRule→ruleMatches 按 argsPattern.command 正则匹配;buildProjectRule 把 Bash 收窄到 head 命令(`bun`→放行所有 `bun ...`)。注:当前粒度是 head 命令而非子命令(`bun test` vs `bun`)。**已定(2026-06-06):保持 head 粒度**,不做子命令粒度(标为不做)。
- [x] 会话级权限缓存：同一会话内相同操作不重复询问。✅ InteractiveApprovalBackend 会话缓存改按**操作**(buildProjectRule 收窄,Bash→head 命令)而非工具名 keying;修了「批准 git status 整会话放行 rm -rf」的安全 bug。测试 permission.session-cache.test.ts。
- [x] `/permissions` 命令查看和管理当前权限规则。✅ TUI `/permissions` 原仅切换 mode;升级:`/permissions rules` 列出生效规则(按匹配序,decision/tool/argsPattern/reason)。core 加 `Engine.getPermissionRules()`(preset 默认 + mode 派生 + settings.permissions.rules,与分类器同序),经 config 查询透传。**"管理(增删改)"仍是 desktop renderer 编辑活,搁置**;查看已成。测试 engine.permission-rules.test.ts(3 例)。
- [x] 路径策略 block 时展示原因，并允许批准本次 / 本会话 / 特定路径。✅ **核实 2026-06-09 已完成**:本次/本会话/本项目(f5f57ac)+「特定路径」本文件/本目录(ApprovalCard path-scoped 选项 + buildProjectRule pathScope)均已就位。
- [x] 用户批准路径后，Read / Glob / Grep / NotebookEdit / ApplyPatch 等原工具继续执行。✅ 见下方「统一 path policy」——六个文件工具现全走 enforcePathPolicyWithApproval,批准后继续。
- [~] 审计路径授权：批准来源、范围、过期策略、被拒原因。**部分**:permission.persist / permission.ask / permission.auto_deny 已结构化落 log(来源/decision/scope/reason);**缺**显式过期策略与统一审计视图(后者是 UI)。
- [x] 修复路径审批弹窗匹配过宽 ✅：改为精确 `=== "允许本次"`(原 startsWith 会把未来的「允许本会话」误判为一次性允许)。
- [x] 修复路径审批标题误导 ✅：按 `c.reason.startsWith("sensitive")` 区分——敏感文件标「敏感文件权限/工具想读取敏感文件」,工作区外标「路径权限/工作区外路径」(敏感文件可在 workspace 内,旧固定标题误导)。测试 path-policy-approval.test.ts。
- [x] 统一 `notebook-edit` / `apply-patch` / `glob` / `grep` 的 approval path policy。✅ 四者从 enforcePathPolicy(对 "ask" 硬拒)迁到 enforcePathPolicyWithApproval(走 askUser 审批,与 read/write/edit 一致),实现「用户批准路径后原工具继续执行」。测试 path-policy-approval-unify.test.ts。

### 5.2 沙箱执行系统

> **核实(逛街批):沙箱早已完整实现**,只差勾选。核心 `tool-system/sandbox/`(index.ts + seatbelt.ts + bwrap.ts + off.ts + sandbox.test.ts)。
- [x] macOS 基于 `sandbox-exec` / Seatbelt 实现文件系统与网络隔离。✅ `sandbox/seatbelt.ts`(sandbox-exec profile builder)。
- [x] Linux 基于 Landlock / bubblewrap 实现沙箱。✅ `sandbox/bwrap.ts`(bubblewrap mount namespace);auto 模式按平台选 seatbelt/bwrap,否则降级 off。
- [x] 定义 `SandboxPolicy`：allowed paths read/write、network access、process policy。✅ `SandboxConfig`{mode, writableRoots, deniedReads, network:"allow"|"deny"}(index.ts:28);expandConfig 展开 ${workspace}/路径。
- [x] Bash 工具集成沙箱包装。✅ `runtime/safe-spawn.ts` + `spawn-common.ts` resolveSpawnTarget→sandbox.wrap();前后台共用(见下条)。
- [x] 沙箱失败时优雅降级，并给出可理解的权限 / 风险提示。✅ auto 找不到 backend→warnAutoDowngrade 一次性警告+降级 off;writableRoots 含不存在路径→warnMissingWritableRoots 提示。
- [x] 配置项：`sandbox.enabled`、`sandbox.allowNetworkFor` 等白名单。✅ schema `sandbox`{mode(off 即禁用), writableRoots(写白名单), deniedReads(读黑名单), network(allow/deny)}(schema.ts:433);语义等价,字段名按本仓约定。
- [x] 与后台 shell 的 `spawn-common` 统一，避免两套进程安全边界。✅ `runtime/spawn-common.ts` 抽 resolveSpawnTarget(沙箱wrap)+buildSandboxEnv(env allowlist)+killProcessGroup;前台 safeSpawnShell 与后台 spawnBackground 共用,bash.ts 删本地 env 副本。

---

## 6. 插件、MCP、Workspace 数据源与远程控制

> **🛍️ 逛街批 triage(2026-06-06):整节几乎全是 UI / 大架构,主动搁置**——
> - **6.1 末项**:reconcile 切断进行中 MCP 调用的 UX,是产品观察活。
> - **6.2 MCP 管理页**:纯 desktop renderer(合并展示配置态+插件态 MCP、来源标注、只读展示、stripNameFromServer),需肉眼验收;core 侧 mergePluginMcpServers/reconcile 早已具备(6.1 全✅),数据齐,差 UI。
> - **6.3 Workspace 数据源**:全新大子系统(资源模型/外部数据源 link/scope 分配/工具 scope 检查/管理 UI),多天活。**2026-06-09 决策:列入 next roadmap,目前太大,先搁置**(第 1 节已转 Profile 主线,不再"与第 1 节一起做")。
> - **6.4 远程控制/跨代理编排**:全新大子系统(SSH/扫码配对/远控会话/编排 Codex+CC/安全边界),多天活,需大量产品决策与真机验证。**2026-06-09:低优,搁置。**
> 这些不在"可无人值守安全做"范围,等你回来一起定方向。

### 6.1 插件 MCP 加载 / 禁用链路收尾 ✅

- [x] 安装插件后，新 session 自动加载插件 MCP（mergePluginMcpServers)。
- [x] 禁用插件后，不再合并 MCP server（reconcile 按 enabled 过滤)。
- [x] 禁用插件后，已连接 server 被 disconnect（reconcile 把 stale 全 disconnect)。
- [x] 禁用插件后，`ToolRegistry` 对应 MCP tools 被 unregister（disconnect finally 逐工具 unregister)。
- [x] 重新启用插件后，可重新 connect / register（connectAll 幂等)。
- [x] `engine.ts` 的 async reconcile 加 catch / 日志兜底（原 void 无 catch,失败=未处理拒绝可崩主进程;已加 catch→日志。测试 engine-config-hot-reload.test.ts)。
- [ ] 评估 reconcile 切断进行中 MCP 调用的用户体验(UI/产品观察,排后)。

### 6.2 MCP 管理页展示插件提供的 MCP server

> **核实(你在场批):6.2 大半早已实现**——McpSection 经 `mcp:listMerged` 合并展示配置态+插件态,McpCard 已有 plugin 徽章/只读门控/共享 probe 状态。本批补"owner 命名"。
- [x] MCP 管理页合并展示配置态 MCP 与运行态 / 插件提供 MCP。✅ listMergedMcpServers→mergePluginMcpServers 合并;同一列表 + 同一 probe 管线出状态/工具数/错误。
- [x] server 增加来源 / 所有者信息：`source`、`owner`、`editable`。✅ main 标注 source/editable(index.ts:642);本批加 `ownerPluginOf`(从 `<plugin>:<server>` key 取插件名)。
- [x] 插件 MCP 只读展示：状态、工具数、工具列表、错误信息。✅ McpCard 对插件 server 同样跑 probe(StatusPill/tools link/error),仅禁编辑。
- [x] UI 标注“由 xxx 插件管理”。✅ 徽章「插件: xxx」+ 只读戳「只读：由「xxx」插件管理」(取 ownerPluginOf;无前缀回退通用文案)。
- [x] 用户配置 MCP 保留编辑 / 启停能力；插件 MCP 启停走插件开关。✅ isEditableMcpServer 门控:插件 server toggle/编辑/删除禁用,提示"由插件管理,不能在这里启停"。
- [x] `McpSection.stripNameFromServer` 剥掉 `source` / `editable`，避免污染 settings。✅ stripNameFromServer 剥 name;persistableMcpServers 过滤掉插件 server 不回写。测试 McpSection.plugin.test.ts(4 例,含 ownerPluginOf)。

### 6.3 Workspace 数据源绑定与作用域分配 〔next roadmap,太大先搁置 — 2026-06-09〕

- [ ] 定义 workspace 级资源模型：path、linked data sources、allowed scopes、默认读取策略。
- [ ] 支持 link 外部数据源：Figma、文档库、issue / PR、云盘、知识库、数据库等。
- [ ] 支持按 workspace 分配数据源范围。
- [ ] Agent 读取上下文时自动发现当前 workspace 已授权的数据源与范围。
- [ ] 工具调用检查 workspace scope，避免跨 workspace 读取未分配内容。
- [ ] 管理 UI / 命令：查看当前 workspace 绑定的数据源和可读资源。
- [ ] 记录授权来源、更新时间、失效 / 撤销状态。

### 6.4 远程控制入口 / 跨代理编排 〔低优,搁置 — 2026-06-09〕

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
- [x] 连接页新增“图片生成”“视频生成”两个 provider 分组。✅ 图片生成组早已有(ImageGenConnectionsPanel:openai/google,配置/测试/默认);本批补**视频生成组**——CollapsibleGroup + `VideoGenConnectionsPanel`。**故意做成占位说明而非完整面板**:核心 schema/工具/适配器接口都就绪,但 `getVideoProvider()` 无任何已接厂商(VIDEO_PROVIDER_KINDS 空,Seedance/Kling 等私有 API 待文档),也无 probeVideo IPC——做完整配置/测试面板会测一个无法生视频的后端(测试按钮必败)。占位组诚实说明现状,getVideoProvider 加 case 后换成与图片一致的面板即可。连接页头部提示同步加「视频生成」。
- [x] settings schema：`imageGen.providers[]` / `videoGen.providers[]`，各带 default provider。✅ imageGen 早已拆出(eeac759);本批补 `videoGen.providers[]`(同 shape,id+kind+baseUrl+apiKey+defaultModel + defaultProvider),listConfiguredVideoProviders 优先读 videoGen.providers[](仅有 adapter 的 kind)再回退 LLM providers[]。连接页 UI 分组仍待你在场。
- [~] 密钥存 user scope，非密钥设置支持 workspace scope。**搁置(逛街批)**:与连接页 UI 一起,scope 路由是设置页交互活;schema 已就位。
- [x] 实现 image / video probe。✅ isGenerateImageAvailable / isGenerateVideoAvailable 已做(BUILTIN_TOOL_GUARDS 按是否配 provider 决定工具可见性);独立 probe 命令归 UI sprint。
- [x] 泛化 `isGenerateImageAvailable`。✅ 已支持 imageGen.providers[](id+kind)与 LLM providers[] 回退两路;补 listConfiguredImageProviders 列可用 provider。
- [x] 新增 `isGenerateVideoAvailable`。✅ 早已存在(generate-video.ts),核实并补 listConfiguredVideoProviders。
- [x] tool prompt / 描述按已配置 provider 动态生成。✅ generateImageToolDefFor/generateVideoToolDefFor 把已配 provider 名追加进描述;engine toolDefs 组装的 .map 里替换(与 Agent 动态描述同范式)。
- [x] 测试未配置隐藏、配置后可用、多 provider 默认和覆盖。✅ generate-image.tool.test.ts 补 6 例(可用性 true/false、back-compat 列举、imageGen.providers[] 列举、动态描述命名/回退);**顺修该测试缺 HOME 隔离 bug**——SettingsManager(cwd,"full") 读到开发者真 ~/.code-shell 的 imageGen 配置污染 4 个用例(见 project_test_pollutes_real_settings)。

### 7.2 Model Provider 增强

- [x] 支持通过外部命令获取 token：`auth.command`。✅ schema providers[]/models[] 加 `authCommand`;`provider-auth.ts` resolveAuthCommand(execSync stdout 首行,60s 缓存,runCommand 可注入测试) + resolveApiKey(apiKey>authCommand>env)。OpenAI/Anthropic client 构造时解析。
- [x] 支持自定义 HTTP headers：`env_http_headers`。✅ schema 加 `httpHeaders`(record);值 `$ENV` 在 build 时从环境解析(resolveHeaders,空值丢弃);两 client 设 defaultHeaders。provider 级 + model 级合并(model 覆盖)。
- [x] `reasoning_summary` 参数支持。✅ schema models[].`reasoningSummary`→LLMConfig→OpenAI 仅在 reasoning 为对象形(openrouter/responses 风格)时挂 `summary`;bare reasoning_effort 形不挂(chat-completions 无此字段,避免发非法参数)。
- [x] `service_tier` 参数支持。✅ schema models[].`serviceTier`→LLMConfig→OpenAI 请求体 `service_tier` 透传。
- [x] 模型自动降级：主模型失败时切换备用模型。✅ schema `fallbackModelKeys[]`;ModelFacade 加 fallbacks,主 client 终态错误(非 context/非 abort/非重试)时按序试备用 client(withModelFallback),首个成功即返回,全失败抛最后一个错。Engine.resolveFallbackClients 从设置构建(跳过无效/与主同一身份/构建失败)。测试 model-facade.fallback.test.ts(6)+ provider-auth.test.ts(12)。

### 7.3 Code Review 内置命令

- [x] `/review` 命令审查当前 git diff 或指定文件。✅ TUI `/review` 命令已存在但很基础;升级:`/review [file] [--json] [--dimensions=...] [--staged]`,走核心 buildReviewPrompt。
- [x] 结构化 findings：优先级 P0-P3、置信度、位置。✅ `review/review-prompt.ts` 提示含 P0-P3 优先级指南 + 要求每条给 location(file:line)+ confidence。
- [x] 支持 JSON 输出格式，便于 CI/CD。✅ `--json` 输出严格 JSON 对象({summary, findings:[{priority,dimension,confidence,location,title,detail,suggestion}]}),无散文。
- [x] 可配置审查维度：安全、性能、可读性、正确性。✅ parseDimensions 解析 `--dimensions=security,performance,...`(逗号/空格,丢无效,空回退全选);提示只列所选维度。
- [x] 支持增量审查：只审查变更部分。✅ 默认审 git diff(incremental);`--staged` 审暂存区。`buildReviewPrompt` incremental 标志切 diff/code 措辞与围栏。测试 review-prompt.test.ts(9 例)。
- 注:`buildReviewPrompt`/`parseDimensions` 抽到 core 并 export,desktop 后续接 UI 可复用同一套。

### 7.4 view_image 后续增量

- [~] TUI 端 inline image 渲染：iTerm / kitty graphics protocol。**搁置(逛街批)**:TUI 渲染活,需真终端(iTerm/kitty)肉眼验收 graphics protocol。
- [~] 看过一轮后把历史图降级成文字摘要，节省 token。**搁置(逛街批)**:需追踪"图已被看过"+生成摘要,有丢失模型仍需的图上下文风险,是判断活;现有 strip-vision.ts 仅对非视觉模型剥图(不同场景)。建议与你确认降级时机再做。

---

## 8. 上下文、记忆、指令与配置

### 8.1 跨会话记忆系统 🔧

- [x] 记忆合并：dream-consolidation.ts + 手动 Dream 按钮(runDreamConsolidation)。
- [x] 新会话启动时自动加载相关记忆到 prompt：PromptComposer.getMemoryContext → buildMemoryContext 注入 system-reminder。
- [x] `/memories list`、`/memories clear`、`/memories edit`(CLI 待补)。✅ 已有 `/memory`(list/add/delete/open);补 `clear`(软删全部→memory-trash)、`edit <name>`(给出 editor+文件路径)子命令 + `/memories` 别名。走 MemoryManager.loadAll/delete。
- [x] 配置：memories.maxCount / maxAge / extractionModel 全接。✅ **maxCount**(orchestrator→parseExtractionResponse);**extractionModel**(resolveExtractionClient:命名有效 pool model 则用它跑提取,否则回退 aux→primary);**maxAge**(MemoryEntry 加 updatedAt=文件 mtime;`filterByAge` 纯函数按天过滤,未知 mtime 永不隐藏;buildMemoryContext({maxAgeDays})→PromptComposer.memoriesMaxAgeDays→engine 读 settings.memories.maxAge)。测试 memory.maxage.test.ts(4 例)+ extract-memories.test.ts。

### 8.2 AGENTS.md 层级指令系统 ✅

instruction-scanner.ts 早已实现,补测试锁定。

- [x] 深层目录指令覆盖浅层(depth 0→N,combineInstructions root→cwd 排序,深层在后)。
- [x] 支持 `AGENTS.local.md`(每名派生 .local.md,source:local)。
- [x] 指令作用域标注(sourceLabel:project depth N / local override / user-level)。
- [x] 按作用域排序注入(managed→user→project→local,止于 git root)。测试 instruction-scanner.test.ts。

### 8.3 智能上下文管理 🔧

- [x] 文件内容缓存去重：dedupeFileReads Tier 0d 始终运行,同 path 旧 Read 清成指向新读的指纹,仅 Read 参与。测试 dedupe-file-reads.test.ts。
- [x] tool result 压缩：已有 Tier 0a 落盘 / 0b 硬截断 / 0c 预算 / Tier1 microcompact。
- [~] 请求压缩：发送前压缩历史消息。**部分/基本覆盖**:Tier 2 LLM 摘要 + Tier 3 窗口截断已在发请求前(manageAsync)压缩历史消息(含普通 user/assistant,非仅 tool_result)。无独立"请求压缩"层。
- [~] token 预算管理：根据剩余 token 动态调整策略。**故意不做(缓存理由)**:现固定阈值 compactAtRatio:0.85 触发压缩。改成"按剩余 token 动态调整力度"与 **prompt 缓存(KV cache)目标冲突**——Anthropic 缓存是前缀匹配,任何改动靠前历史的压缩都会让那轮 messages 前缀全失效(full cache miss)。最优策略是"压得狠而稀"(压一次到更低水位、之后多轮不再压、前缀稳定),动态调整易变成"温而频"→ 命中率下降、成本上升,与直觉相反。固定阈值反而对缓存友好,保持。**注**:真正提缓存命中率的高价值改动是给 messages 数组加靠后稳定位置的 cache breakpoint(现仅 system 块有 cache_control,见 anthropic.ts:186/232)——属独立优化,非本项。

### 8.4 Feature Flags 系统 🔧

- [x] 定义 `FeatureFlags` 类型和默认值（feature-flags.ts FEATURE_FLAGS）。
- [x] 从配置文件加载 flags（settings.featureFlags Zod 字段）。
- [x] 各模块检查 flag 状态（isFeatureEnabled;engine toolDefs 按 flag 隐藏 WebSearch/Bash）。
- [x] `/features` 命令查看 flags（TUI,只读;切换走 settings.json）。
- [x] 候选 flags 登记齐：web_search/shell_tool(默认开)、fast_mode/undo/shell_snapshot(默认关)。测试 feature-flags.test.ts。

### 8.5 配置系统完善

- [~] 支持 YAML 配置。**评估后暂不做(低优先级)**:settings 主要走设置页 UI + `/config` 读写,不靠手编;YAML 的优势(注释/少标点/多行)在本产品痛点不强,而多一种格式 = 多一条加载/合并/写回路径要维护(写回写 json 还是 yaml?与多文件优先级混?),复杂度 > 收益。注:agent 定义/skills frontmatter 已用 yaml 库(它们是 frontmatter+正文,天生适合),settings 是纯结构化数据 JSON 够用。
- [~] 生成配置 JSON Schema，支持 IDE 自动补全。**评估后暂不做(低优先级)**:用途是给手编 settings.json 的人在 IDE 里做字段补全/类型校验。但本产品配置走 UI 为主、手编是少数场景;且需加 `zod-to-json-schema` 依赖(zod 3.24 无原生导出)。比 YAML 略有用(能配 IDE 校验),但场景小,留待真有手编需求时再做(~30-50 行)。
- [x] `/config` 命令交互式编辑配置。✅ 核实 TUI 已有 `/config [show | get <key> | set <key> <value>]`(core-commands.ts,走 SettingsManager 读写,点号路径)。
- [x] 配置迁移机制：版本升级时自动迁移旧配置。✅ `settings/migrate-config.ts`:版本化迁移框架——`configVersion` 字段 + 有序 `MigrationStep[]{from,to,migrate}`,`migrateConfig` 按当前版本顺序应用到 CURRENT(纯函数,不改入参,支持从中间版本续跑、空列表只盖版本号)。导出供使用。注:**框架就位但 MIGRATIONS 现为空**(schema 仍 v0,无破坏性变更)——故**暂不接入 manager 写回**(否则每次 load 都给文件盖 configVersion:0,纯 churn 无收益);首个破坏性 schema 变更落地时 append 一个 step + bump 版本 + 接 manager 即可。已有的 `migrateModels`(字段级 legacy models[] 迁移)继续独立工作。测试 migrate-config.test.ts(9 例,含注入样例迁移链验证顺序/续跑/no-op/不可变)。

---

## 9. 工程质量、性能与文档

### 9.1 Renderer / Desktop 清理项 🔧

- [x] `App.tsx` 抽 `makeCreateRepoForCwd`，收拢重复 `createRepoForCwd` 闭包 —— 5 处相同闭包收拢成 `repos.ts` 一个工厂(返回 `{createRepoForCwd, changed()}`,内部 didChange 替代各处 let reposChanged)。
- [x] `repos.ts` 的 `loadRemovedRepoPaths` 在磁盘重建循环里 hoist —— 工厂构造时快照 removed-path 成 Set 一次,替代原每会话 `isRepoPathRemoved`(每次重读+JSON.parse)。测试 repos.test.ts。
- [ ] 继续清理 settings / repo / workspace 命名混杂点。

### 9.2 测试覆盖

- [~] builtin tools 集成测试。**进行中**:补 Glob(6)/Read(5)/Edit+Write(9)/Grep(6)/NotebookEdit(7)/ToolSearch(6)/Plan(4)/WebFetch(10)/AskUser(7)/Brief(5) 集成测试,共 65 例。WebFetch 重点覆盖 **SSRF 安全边界**(非 http 协议/blocked host/DNS 解析到 metadata 169.254.169.254 与 loopback 127.0.0.1 拒绝)+ HTML→text/截断/HTTP 错误。**顺修**:① grep fallback 漏传 fileGlob→`--include` 对齐 rg;② feature-flags.test.ts 预存 tsc 类型报错修掉,core tsc 全绿。剩余无测试工具(bash/lsp/powershell)续补——这几个重 I/O(spawn shell / LSP 进程),需更重的 mock,排后。
- [ ] E2E 完整对话流程。
- [x] GitHub Actions CI。✅ 核实 `.github/workflows/ci.yml` 已有(guards/engine-bypass + typecheck + SDK smoke,push main + PR 触发)。
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
