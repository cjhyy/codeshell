# 执行看板 — 未完成项

> 本文件是执行队列。**已完成项已于 2026-06-16 清理**(删去所有 `[x]`,完成态历史见 git log 与各特性 commit)。
> 这里只保留 `[ ]`(未做)/ `[~]`(部分)。完成一项就勾掉或移出;长期路线原文留在 `TODO.md`。

## 执行原则

- 先做会影响全局命名 / scope / schema 的底座，再做依赖它的 UI 和工具。
- 每个大块完成后跑对应测试；改 core 后至少跑 core 相关测试，改 desktop 后至少跑 renderer/main 相关测试和一次手动 smoke。

## 🚧 Beta 前清理清单

> 目标:第一个 beta 不追大路线图,但不能留下"设置页看起来能配,实际不知道配到哪里/是否生效"这类半成品。

- [ ] 设置页项目级 scope 入口收口:**已核实** `SettingsPage` 固定 `scope="user"`,但仍把 `activeRepoPath` 传给 Model/MCP/Environment/Agents 等 section;beta 前要明确哪些是全局、哪些先选项目再编辑,避免"看起来能配项目,实际跟随当前会话"。**决策(2026-06-08):不做设置页顶层 scope 切换;像 Hooks/Memory 一样,在需要项目维度的具体页面内先选"全局 / 某个项目",再进入编辑。**
- [~] Beta smoke checklist 跑一遍并记录:**部分(2026-06-09)** 可静态验证的全过:core 全量 993 pass、core+desktop `tsc --noEmit` 全绿、core build + renderer `vite build` 成功、env 链路有端到端测试(bash.shell-env)。**剩交互式肉眼 smoke**(新会话/模型配置/文件编辑/审查/图片附件/后台 shell/undo)需真机起 Electron 走一遍,留给你在场跑;本轮改动只触及子代理/环境设置页 + 工具 spawn env,回归面已被上述测试覆盖。

### Windows/mac Git 与 Shell 处理 〔已挖透 2026-06-14,待你拍板范围〕

> **缘起**:从「Windows PowerShell 慢 / 小白体验 / 没装 Git 连插件都装不了」一路深挖。**核心约束(用户)**:core 是要被独立做 agent / 部署进 Docker 的通用引擎,别塞 Windows 桌面专属的用户体验逻辑。
>
> **行业参照(2026-06 实测带源)**:CC = Windows 优先 **Git Bash**(`bash.exe`),没装回退 `pwsh`→`powershell`(非 cmd);`CLAUDE_CODE_GIT_BASH_PATH` 覆盖;Git for Windows 现为**可选非必需**;推 Git Bash 的官方理由是**命令兼容(POSIX)非速度**;原生 Windows 不沙箱(引导 WSL2)。Codex = Windows **硬编码 PowerShell** 不探 Git Bash,另写了原生 Windows 沙箱(受限令牌+ACL,已发布);痛点=shell 语法错配 + 孤儿进程。来源:code.claude.com/docs、developers.openai.com/codex/windows、openai.com Windows sandbox 博文、多个 GitHub issue。⚠️ 本轮已**修正旧记忆** `reference_cc_codex_windows`(CC 改可选 + 理由是兼容)。
>
> **codeshell 现状(已 grep 实证)**:
> - **Shell**:`runtime/spawn-common.ts:134` `resolveShellInvocation` win32→`shell ?? ComSpec ?? cmd.exe` 写死,**无 Git Bash 探测**;POSIX→`$SHELL ?? /bin/bash`。消费者全在 core(bash/safe-spawn/background-shell/worktree)。
> - **Git/插件**:插件市场确实靠 `git clone`(gitOps.ts,blobless+sparse)。**组件二「Git 缺失友好引导」已基本实现且分层正确**:core(`utils/exec.ts` `isGitAvailable`/`resolveGit`+`git.path` 覆盖;`gitOps.ts:50` 不可用回机器码 `GIT_NOT_FOUND:`)+ host(`desktop/src/main/marketplace-service.ts:34` `humanizeGitError` 翻成中文引导+链接)。**app 文案已在 host,正是用户要的**。
>
> **实测(mac git 失败两形态)**:① **ENOENT**(PATH 无 git):`{code:"ENOENT",message:"spawn git ENOENT"}`,三平台通用。② **mac stub**(`/usr/bin/git` 是 xcrun 垫片,CLT 没装):**spawn 成功但 exit≠0**,stderr 含 `xcrun: error` / `not a developer tool`。`isGitAvailable()` 只查 findExecutable 会被 stub **骗过**漏判。

- [ ] **缺口①(真 bug,值得修,纯 core 几行)**:mac stub 形态 B 漏判 → 全新 mac(没装 CLT)绕过友好引导,看到 `git clone ... exited 1: xcrun: error:...`。修法:`gitOps.ts runGit` 末尾对 `exitCode≠0 && /xcrun: error|not a developer tool|no developer tools/i.test(stderr)` 也归类 `GIT_NOT_FOUND`。有实测错误文本支撑。
- [ ] **缺口②(分层洁癖,可选)**:core fallback 文案的 `git-scm.com`(gitOps.ts:54)是通用/Windows 向,mac 该 `xcode-select --install`。可让 core fallback 分平台,或删空交给 host 全权。**仅影响裸用 core 的 agent,不影响 desktop**(desktop 已被 humanizeGitError 接管)。
- [ ] **组件一 Git Bash 探测 —— 建议不做 / 或独立立项**:真实部署是 Docker/Linux,探测对它**零价值**(win32 死分支,POSIX 不调);它服务 Windows 桌面用户,与 core 的 headless/Docker 定位冲突;**无实测痛点**(没有用户抱怨 POSIX 命令在 cmd 跑不了)。真要做应**单独按「host 注入策略」**(core 已有 summarize/runCommand 注入先例:`context/manager.ts`、`llm/provider-auth.ts`),core 默认 win32→cmd 不变,desktop 启动注入「探 Git Bash」策略,Docker 不注入保纯净。**不混进本次**。
- 方案选项(待用户拍板):**最小(推荐)**=只修缺口① / **小**=①+② / **大**=加组件一(host 注入,独立工程)。

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

- [~] 粘贴、拖拽、文件选择三条入口行为一致。**部分**:三条都走 buildAttachments/acceptFiles 统一管线,chip 展示一致;入口本身行为早已一致。
- [~] 当前模型不支持图片时，提示里仍保留 path 便于用户引用。**部分**:不支持时已有 banner + 仍显示 chip(含文件名);"把文件名注入文本供引用"未做(需产品确认要不要自动塞)。

### 2.2 文件结果卡片支持选择打开方式

- [~] assistant 后续回答里提到的文件路径 / repo 内位置可点击定位或打开。**部分**:Markdown 文件链接早已点击 openPath;右键/打开方式菜单接 Markdown 链接留待(需把 OpenWithMenu 包到 md-file-link,排后)。

### 2.3 四面板内文件也能用其他应用打开

> open-with 底座(openWith.ts + OpenWithMenu)已就位;本批接入面板侧(用户在场验收)。
- [~] 浏览器圈选或页面标记关联文件时，能定位到文件或用外部 app 打开。**N/A(暂)**:BrowserPanel 是 webview,无文件关联语义;留作未来。

### 2.3a Turn 级编辑卡片 / 审查入口补齐

- [~] **文件树 + 顶部动作整体对齐截图的审查工作流**:左侧按范围分组的变更文件树(unstaged/staged/committed/branch,带增删行数徽章)**✅ 已做**,顶部一排范围切换 **✅ 已做** + 提交/推送/建 PR 动作条 **(Slice 3 不做,见上:提交走聊天)**。审查只做"读",写操作走聊天。
> **优先级:这是真 bug 不是 nice-to-have**——用户实测「turn 卡片点审查 → 直接落到整工作区未提交 diff」是错的;应默认本 turn 范围,再给上述范围切换。需 desktop 审查面板较大改造,排 UI sprint。

### 2.4 四面板放大 / 缩小并可覆盖输入区

- [~] 窄屏 / 移动尺寸不遮挡关键操作。**部分**:放大态盖满聊天列、toolbar 还原键始终在;系统性窄屏适配留后。
- [~] 用 Browser / Playwright 做桌面和窄屏 smoke。**留待**:e2e smoke 归 9.2/9.x,排后(单测 + tsc + build 已过)。

### 2.6 Markdown 内容结构与渲染体验优化

- [~] 梳理 desktop / TUI Markdown 渲染差异。**搁置**:调研类大活,范围太泛,待你定优先级。
- [~] 优化标题、列表、引用、代码块、图片、链接、表格。**部分**:链接/路径链接/图片/代码块已优化(见各项);标题/列表/引用/表格的系统性微调留待。
- [~] 工具结果 Markdown 结构规范化，避免正文、JSON、日志混在一起。**搁置**:需逐工具梳理 result 结构,较大,排后。
- [~] 补长 Markdown smoke / demo。**部分**:长代码折叠有单测;另补窄屏布局 smoke(`narrow-layout.smoke.test.tsx`:用户气泡 max-w-[80%]/break-words 不撑窄屏、多图气泡渲染全部缩略图、lightbox <720px media 规则仍在)。真·像素级窄屏仍需 Playwright(人盯,归 9.x)。

### 2.7 运行中输入缓存 / 强制发送下一轮收尾 🔧

- [~] 避免与 approval/AskUser/后台通知/automation 混淆(desktop bucket+asking 态已分流;边角待复核)。

### 2.11 Shell Snapshot

- [~] 错误输出高亮标注。**部分**:CLI 文本无富样式;已有 `STDERR:` 段分隔 + 失败行标记(下条)。富色高亮属 renderer 渲染活,排后。

---

## 3. Session / Goal / 后台执行可靠性

### 3.4 错误处理与恢复 🔧

- [~] 网络断开自动重连 —— 瞬时网络错误已走 withRetry;长断网会话级重连待补。
- [~] 会话崩溃恢复补齐产品闭环。**搁置(逛街批)**:disk-权威源恢复已做(见 project_disk_authoritative_recovery),"产品闭环"含崩溃后续轮 UI 提示/一键恢复,是 UI+产品决策活。

## 4. Agent / 子代理 / 多代理能力

### 4.2 对齐 subagent_type / agents 目录机制 🔧

- [~] Agent 角色预定义到 config：用户级目录已有，补 settings-level 默认配置。**搁置(逛街批)**:触碰 agent 解析优先级(回归敏感),且与第 1 节 profile/preset 底座强耦合(用户要一起做);用户级 + 项目级目录机制已够用,settings 内联定义边际收益小。等第 1 节一起。

## 5. 安全、权限与沙箱

### 5.1 路径权限与审计收尾

- [~] 审计路径授权：批准来源、范围、过期策略、被拒原因。**部分**:permission.persist / permission.ask / permission.auto_deny 已结构化落 log(来源/decision/scope/reason);**缺**显式过期策略与统一审计视图(后者是 UI)。

## 6. 插件、MCP、Workspace 数据源与远程控制

> **🛍️ 逛街批 triage(2026-06-06):整节几乎全是 UI / 大架构,主动搁置**——
> - **6.1 末项**:reconcile 切断进行中 MCP 调用的 UX,是产品观察活。
> - **6.2 MCP 管理页**:纯 desktop renderer(合并展示配置态+插件态 MCP、来源标注、只读展示、stripNameFromServer),需肉眼验收;core 侧 mergePluginMcpServers/reconcile 早已具备(6.1 全✅),数据齐,差 UI。
> - **6.3 Workspace 数据源**:全新大子系统(资源模型/外部数据源 link/scope 分配/工具 scope 检查/管理 UI),多天活。**2026-06-09 决策:列入 next roadmap,目前太大,先搁置**(第 1 节已转 Profile 主线,不再"与第 1 节一起做")。
> - **6.4 远程控制/跨代理编排**:全新大子系统(SSH/扫码配对/远控会话/编排 Codex+CC/安全边界),多天活,需大量产品决策与真机验证。**2026-06-09:低优,搁置。**
> 这些不在"可无人值守安全做"范围,等你回来一起定方向。

### 6.1 插件 MCP 加载 / 禁用链路收尾 ✅

- [ ] 评估 reconcile 切断进行中 MCP 调用的用户体验(UI/产品观察,排后)。

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

- [~] 内置即梦 / Seedance、可灵 / Kling 适配器。**留占位**:私有 API(火山/快手)端点/鉴权需准确文档;接口+工具+后台轮询已就位,getVideoProvider 加 case 即可接入。等用户给文档。
- [~] 密钥存 user scope，非密钥设置支持 workspace scope。**搁置(逛街批)**:与连接页 UI 一起,scope 路由是设置页交互活;schema 已就位。

### 7.4 view_image 后续增量

- [~] TUI 端 inline image 渲染：iTerm / kitty graphics protocol。**搁置(逛街批)**:TUI 渲染活,需真终端(iTerm/kitty)肉眼验收 graphics protocol。
- [~] 看过一轮后把历史图降级成文字摘要，节省 token。**搁置(逛街批)**:需追踪"图已被看过"+生成摘要,有丢失模型仍需的图上下文风险,是判断活;现有 strip-vision.ts 仅对非视觉模型剥图(不同场景)。建议与你确认降级时机再做。

### 7.5 Cookie Lease — 浏览器登录态到 CLI 工具的受控桥接 🔧

> 设计文档：`docs/browser-cookie-export-design-2026-06-14.md`。
> 核心：按域名、按任务、一次性、用户审批的 Cookie Lease，把 `persist:browser` 分区 cookie 通过 `session.cookies.get()` 读出来，写临时 Netscape cookies.txt，注入 `CODESHELL_COOKIE_FILE` env 到本次工具调用，结束后 tool runtime 三层保证清理。覆盖 curl / wget / aria2 / yt-dlp / gallery-dl / streamlink 及任意脚本语言 cookie jar。

- [ ] **主进程 cookie-lease 模块**：`packages/desktop/src/main/cookie-lease.ts` — CookieLeaseManager + formatNetscapeCookies（7 字段 TAB 分隔 + #HttpOnly_ 前缀 + 键值含控制字符跳过）+ createCookieLease（按域名读 session → 写 `/tmp/codeshell-cookie-leases/`，0600）+ 三层清理（try/finally + AbortSignal 联动 + 主进程定时器 5min 硬超时 + 启动扫描残留）。
- [ ] **IPC handler + 审批弹窗**：`packages/desktop/src/main/ipc/cookie-lease-handler.ts` — 处理 `cookie-lease:create`（触发用户审批，显示请求方 skill、目标命令、域名列表、生命周期、风险提示）+ `cookie-lease:cleanup`。审批弹窗：允许本次 / 拒绝 / 查看 cookie 域名列表；不做「始终允许」。
- [ ] **Core 侧 lease 请求接口**：`packages/core/src/engine/cookie-lease.ts` — `requestCookieLease(domain, purpose)` 通过 IPC 请求主进程创建 lease，返回 `{ leaseId, filePath }`。
- [ ] **Bash/spawn 工具注入 `CODESHELL_COOKIE_FILE`**：tool executor 在 lease 存在时把 `CODESHELL_COOKIE_FILE` 注入子进程 env；命令结束 try/finally 调 cleanup；cancel/abort 时先删文件再杀进程。
- [ ] **过期检测告警**：createCookieLease 时检查 `expirationDate`，<24h 的 cookie 向用户告警（继续 / 先刷新 / 取消）。静默 webview 续期默认关闭，作为可选项。
- [ ] **403 fallback**：yt-dlp 非零退出码 + stderr 含 HTTP Error 403 时，明确提示用户去浏览器面板刷新登录态。
- [ ] **测试**：cookie-lease.test.ts（format 字段映射/HttpOnly/异常字符/空 cookies/过期告警）+ 三层清理测试（正常/取消/超时/崩溃残留）+ IPC mock 测试。

---

## 8. 上下文、记忆、指令与配置

### 8.3 智能上下文管理 🔧

- [~] 请求压缩：发送前压缩历史消息。**部分/基本覆盖**:Tier 2 LLM 摘要 + Tier 3 窗口截断已在发请求前(manageAsync)压缩历史消息(含普通 user/assistant,非仅 tool_result)。无独立"请求压缩"层。
- [~] token 预算管理：根据剩余 token 动态调整策略。**故意不做(缓存理由)**:现固定阈值 compactAtRatio:0.85 触发压缩。改成"按剩余 token 动态调整力度"与 **prompt 缓存(KV cache)目标冲突**——Anthropic 缓存是前缀匹配,任何改动靠前历史的压缩都会让那轮 messages 前缀全失效(full cache miss)。最优策略是"压得狠而稀"(压一次到更低水位、之后多轮不再压、前缀稳定),动态调整易变成"温而频"→ 命中率下降、成本上升,与直觉相反。固定阈值反而对缓存友好,保持。**注**:真正提缓存命中率的高价值改动是给 messages 数组加靠后稳定位置的 cache breakpoint(现仅 system 块有 cache_control,见 anthropic.ts:186/232)——属独立优化,非本项。
- [ ] **Automation context accounting**：把自动化运行的 context/token 成本计入产品化 TODO。每次 cron/headless run 记录 prompt tokens / completion tokens / cache hit / 历史压缩状态 / 是否读取大量文件；Triage inbox 展示单次与按 job 汇总成本；“无发现”运行优先自动归档或只保留摘要，避免低价值 transcript 长期占 sidebar 与未来上下文。目标是让 Codex-style automation 不只是“定时跑”，还要能看见并控制长期 context 成本。

### 8.5 配置系统完善

- [~] 支持 YAML 配置。**评估后暂不做(低优先级)**:settings 主要走设置页 UI + `/config` 读写,不靠手编;YAML 的优势(注释/少标点/多行)在本产品痛点不强,而多一种格式 = 多一条加载/合并/写回路径要维护(写回写 json 还是 yaml?与多文件优先级混?),复杂度 > 收益。注:agent 定义/skills frontmatter 已用 yaml 库(它们是 frontmatter+正文,天生适合),settings 是纯结构化数据 JSON 够用。
- [~] 生成配置 JSON Schema，支持 IDE 自动补全。**评估后暂不做(低优先级)**:用途是给手编 settings.json 的人在 IDE 里做字段补全/类型校验。但本产品配置走 UI 为主、手编是少数场景;且需加 `zod-to-json-schema` 依赖(zod 3.24 无原生导出)。比 YAML 略有用(能配 IDE 校验),但场景小,留待真有手编需求时再做(~30-50 行)。

---

## 9. 工程质量、性能与文档

### 9.1 Renderer / Desktop 清理项 🔧

- [ ] 继续清理 settings / repo / workspace 命名混杂点。

### 9.2 测试覆盖

- [~] builtin tools 集成测试。**进行中**:补 Glob(6)/Read(5)/Edit+Write(9)/Grep(6)/NotebookEdit(7)/ToolSearch(6)/Plan(4)/WebFetch(10)/AskUser(7)/Brief(5) 集成测试,共 65 例。WebFetch 重点覆盖 **SSRF 安全边界**(非 http 协议/blocked host/DNS 解析到 metadata 169.254.169.254 与 loopback 127.0.0.1 拒绝)+ HTML→text/截断/HTTP 错误。**顺修**:① grep fallback 漏传 fileGlob→`--include` 对齐 rg;② feature-flags.test.ts 预存 tsc 类型报错修掉,core tsc 全绿。剩余无测试工具(bash/lsp/powershell)续补——这几个重 I/O(spawn shell / LSP 进程),需更重的 mock,排后。
- [ ] E2E 完整对话流程。
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
