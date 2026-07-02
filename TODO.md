# TODO

整理范围：来自 2026-07-01 Codex 规划与 Claude Code 只读复核。bug 类待办已全部修复或删除（记录在 git 历史与记忆）；Critical/High/Medium/Low/Follow-up/Hardening 均已清。

现状：只剩发布关键路径（beta1 用户亲自做）+ 延后项（记 release notes）+ 大路线图（留存方向）。

# beta 真机测试反馈（v0.6.0-rc.2，2026-07-02 起）

> 用户在 macOS arm64 真机测试 v0.6.0-rc.2（桌面端 + CLI）。发现的问题按报告顺序记录在此,待批量修复。
> 已修:桌面端启动崩溃 `Cannot find package 'cross-spawn'`（predist 依赖闭包,见 `project_release_ci_pipeline`）。

<!-- 用户反馈问题追加到这里,格式:
- ⬜ **[模块] 一句话现象** — 复现步骤 / 期望 vs 实际 / 相关文件(如已知)
-->

- ⬜ **[项目边界] 项目归属改为:有 git 用 git 根,无 git 用 cwd**（架构改进，rc.3 延后）（架构改进,非 bug）— 现状:codeshell 纯按 cwd 归项目(`project_disk_authoritative_recovery`),monorepo 里在仓库根 vs `packages/desktop` 分别打开会被当成**两个不同项目**。期望(对齐 CC):cwd → 向上找 `.git` 仓库根,有则用 git 根作项目 key(子目录归父项目);无 git 则用 cwd 本身。保留 `isNoRepoCwd` 护栏(no-repo/临时目录仍归 NO_REPO_KEY,不建项目)。
  - **要点**:所有"cwd → 项目"映射点都要过这层归一化(不止一处——记忆提示 placement 的 rebuildFromDisk/importRuns/liveSession + automation/projectOptions.ts 至少 4 处)。抽一个 `resolveProjectKey(cwd)` = isNoRepoCwd ? NO_REPO_KEY : (gitRootOf(cwd) ?? cwd),各处统一调用。git 根探测走 `git rev-parse --show-toplevel` 或向上找 `.git`(注意 realpath 防 symlink,关联 `project_path_containment_realpath`)。CC 做法参考 `reference_cc_codex_workspace_trust`(trust 也按目录向上继承,和项目边界同源)。⚠️ 已存量 session 的项目 key 会变,需考虑迁移/兼容。

- ✅ **[设置/catalog] 语音类型模型无选项 + 语音模型配置展示不出来**（rc.3 已修：ModelCatalogPanel 补 audio 类型下拉） — 复现:设置里的模型/连接页。实际:模型类型分类里没有"语音/STT(/TTS)"这一类,配好语音模型后配置项也不展示。期望:catalog 支持语音类型模型,能像文本/图/视频那样在连接页配置并展示。背景:STT 听写桌面端已实现,但记忆 `project_voice_input_stt` 记它是"纯 UI 非工具+回退复用 OpenAI 凭证",可能从没进 catalog 的模型类型枚举。关联 `project_unified_model_catalog_design`/`project_model_catalog`/`project_voice_input_stt`。
  - **调查结论(agent)**:audio 类型其实已 90% 接好——✅ catalog 枚举含 `audio`(`core/model-catalog/types.ts:77` `tag: enum(text,image,video,audio)`);✅ builtin 有 2 条 audio(`builtin.ts:390-425` openai-transcribe / groq-transcribe);✅ 连接页有 audio 分组(`SearchConnectionsPanel.tsx:73-79`)+ 按 tag 过滤渲染(`TextConnectionsPanel.tsx:55,99`);✅ STT 后端已走 catalog 读 audio 连接(`core/stt/resolve-transcribe.ts:54-84`,无连接时回退 OpenAI 凭证)。
  - **唯一确认缺口**:`ModelCatalogPanel.tsx:319-323` 模型类型下拉 options 只有 text/image/video,**漏了 audio** → 用户在 catalog 编辑器手动加/编辑模型时看不到"语音"类型。修法:options 补 `{value:"audio",label:...}`;顺带 `catalogEditor.ts` blankEntry 默认值 + i18n 标签(`settingsX.textConn.headingAudio`/`searchConn.groupAudio*`)核实存在。
  - **用户真机确认(2026-07-02)**:两处都缺,都要修——① **连接页 audio 没像图片那样默认展示**;② **模型页面(Catalog 编辑器)没有 audio 类型**。
  - ⚠️ **纠偏**:agent 看的 `SearchConnectionsPanel.tsx:57-79` 里 image/video/audio **全是 `defaultOpen={false}`(折叠)**,只有 web search 默认展开——所以用户说的"图片默认展示出来"**不是这个面板**。用户实际看的是另一个页面(image 在那里直接铺开展示),audio 在**那个页面**缺席。待重新定位:哪个页面把 image 直接展示(不折叠)?ModelSection / 主连接页 / GenConnectionsPanel?找到后 audio 要在同一处同样默认展示。别再认 SearchConnectionsPanel 这个折叠面板。
  - **确认要改**:`ModelCatalogPanel.tsx:319-323` 类型下拉补 audio。

- ✅ **[会话切换] 点击未渲染过的 session 先闪"新建页面"再渲染内容**（rc.3 已修：fallbackState 区分真新建 vs 待 hydrate，ChatView 显示 loading 占位） — 复现:点侧边栏一个本 renderer 进程还没打开过的 session。实际:先闪空的新建/欢迎态,随后异步 hydrate 出历史内容。期望:加载期显示 loading 或占位,不露出新建态。
  - **根因(已定位)**:`App.tsx:809-816` `fallbackState`——`transcripts[activeBucket]` 尚无(undefined)时兜底读 localStorage,该 session 从没在本 renderer 打开过 → localStorage 空 → `local.messages.length===0` → 返回 `INITIAL_STATE`;`ChatView.tsx:598` `isNewChat = messages.length===0` 遂为 true,渲染欢迎页;`App.tsx:701-787` 异步 `subscribeSession` hydrate 到达后才切成内容。
  - **修法方向**:fallbackState 里区分"真新建" vs "已存在但未 hydrate"——查 sessionIndices 里该 session 存在但 localStorage 空时,返回带 loading/占位标志的 state(而非 INITIAL_STATE),ChatView 据此显示 loading 而非新建态。参考 `project_settings_page_loading_flash`(缓存快照 seed)。⚠️ 别误伤真正的新建草稿态(关联 `project_draft_session_autojump_bug` / `project_new_chat_panel_inherit`)。

- ✅ **[窗口控件/标题栏] 红绿灯占位 + 标题栏 padding 需按平台 + 全屏状态适配**（rc.3 已修：preload 下发 platform、TopBar 按平台+全屏显隐占位、main 监听 fullscreen 事件、SettingsPage 同理） — 三个子点:① **非 Mac(Win/Linux)**:窗口控件(最小化/缩略/关闭)样式很奇怪——疑似照搬 Mac 无边框假设,Win/Linux 没原生红绿灯却留了空/画错。② **设置页左上角**:给 Mac 红绿灯预留的空位/padding 需按平台判断,非 Mac 不该留 Mac 式空位。③ **Mac 全屏**:进入全屏后红绿灯消失,左上角预留留白也要跟着去掉(现全屏了留白仍在)。期望:标题栏/控件占位随 `process.platform` + 全屏状态动态调整。
  - **根因(agent 已定位)**:① 窗口配置本身有平台判断——`main/index.ts:1117` `titleBarStyle: darwin?"hiddenInset":"default"`(对);② 但 renderer **`TopBar.tsx:76` 硬编码 `<span className="w-[68px] shrink-0">` 红绿灯占位,所有平台都渲染,无平台判断** ← 非 Mac 突兀根因;③ **全屏事件完全没监听**——main(`index.ts:1061-1277` 窗口事件列表里)无 `enter-full-screen`/`leave-full-screen`,renderer(App.tsx)无 fullscreen 响应 ← Mac 全屏留白不消失根因;④ platform 没经 preload 正式下发,renderer 只靠 `navigator.platform`(App.tsx:2967)兜,不够可靠。
  - **改动清单(agent)**:(a) `preload/index.ts` 暴露 `window.codeshell.platform=process.platform`;(b) `TopBar.tsx:76` 占位改 `{isMac && !isFullscreen && <span…/>}`;(c) `main/index.ts:~1271` 加 `enter/leave-full-screen` 监听 + IPC 下发 fullscreen;(d) `App.tsx:2966` 订阅 fullscreen 态控制占位;(e) `SettingsPage.tsx:177` 左上角同样按平台判断(设置页左上角问题在此);(f) 可选 `window-state-store.ts` 加 fullscreen 字段。⚠️ 改完必在 Win + Mac(含全屏)真机验。

- ⬜ **[Windows] 原生菜单栏突兀 + nsis 安装器不友好(不能选安装位置)**（rc.3 延后：Windows 整条待真机统一过） — 两个子点:① **菜单栏"文件/编辑"看着奇怪**:`packages/desktop/src/main/menu.ts:138-139` 有自定义菜单模板(`buildFromTemplate`+`setApplicationMenu`),但没针对 Windows 优化——Mac 菜单在顶部全局栏,Windows 菜单贴窗口内很突兀。修法方向:Windows 上要么隐藏/精简原生菜单(`setApplicationMenu(null)` 或 `autoHideMenuBar`),要么把菜单项收进应用内自绘 UI;菜单模板按平台分支(Mac 保留全局菜单,Win/Linux 精简)。② **nsis 安装不能选目录**:`build.win` **无 `nsis` 配置段** → electron-builder 默认一键装 AppData、不让选路径。修法:package.json build 加 `nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, createDesktopShortcut: true, ... }`。⚠️ 未签名 exe,SmartScreen 仍会拦(已在 release notes 注明)。
  - **Codex 参照**:Codex 是纯 CLI(npm 全局装),**没有 Electron 桌面端 + nsis 安装器**,所以菜单栏/安装位置这块 Codex 无直接可参照做法。这两点走 Electron/electron-builder 标准解法即可(见上)。CLI 侧 codeshell 本就有 `npm i -g` 路径与 Codex 一致。

- ✅ **[面板按钮] 右侧面板切换按钮在非 chat 页(自动化/凭证)仍显示**（rc.3 已修：panelAvailable 加 view.viewMode === "chat" 判断） — 复现:chat 页右上角有面板开关按钮(文件/浏览器/审查/终端),切到自动化凭证页后右上角**还有**这些面板按钮。期望:面板按钮是 chat 专属,切到非 chat 页(自动化/凭证/设置等)应隐藏。关联 `project_desktop_four_panels`(文件/浏览器/审查/终端四面板)。
  - **根因(agent 已定位)**:按钮在 `TopBar.tsx:107-117`(`PanelRight` IconButton),`panelAvailable` 控制显隐;`App.tsx:3008` `panelAvailable={activeSessionId !== null}` **只判断有活跃会话,没判断当前是 chat 视图**。视图模式是 `view.viewMode`(`view.ts` ViewMode:chat/credentials/automation/customize/...),credentials/automation 等复用同一主渲染树(含 TopBar),只有 `settings_page` 单独返回。所以切到非 chat 页只要还有 activeSession,按钮就错误显示。
  - **修法**:`App.tsx:3008` 改 `panelAvailable={activeSessionId !== null && view.viewMode === "chat"}`。

- ✅ **[权限] 审批弹窗在错的 session 弹出(弹窗归属 session 错位)**（rc.3 已修：core ApprovalRequest 补 sessionId → main envelope 填 sessionId → renderer approvalBucketsRef 按来源 bucket 路由弹窗） — 复现:session A 的工具触发权限请求。实际:弹窗弹到了当前正在看的 session B(不相关会话);选"本会话允许"后**作用在正确的 A**(A 的工具放行、缓存生效),**但触发它的 session UI 归属错了**——弹窗显示在 B,B 不知道这是 A 的请求。即:审批语义/缓存是对的(按 A),错的是**弹窗 UI 挂到了当前活跃 session 而非请求来源 session**。期望:权限弹窗只在**请求来源 session** 显示;切到别的 session 时不该看到 A 的弹窗(或明确标注是哪个 session 的请求)。关联 `project_permission_session_cache`、`project_askuser_deny_green_check`、`project_cc_room_render_alignment`。⚠️ 权限系统敏感,修时别动审批语义(那部分是对的),只修弹窗归属路由。
  - **根因(agent 已定位,三层,关键在 renderer)**:① **Core** `types.ts:299` `ApprovalRequest` 无 `sessionId` 字段 → 全链路不带来源标识;② **Main** `index.ts:362` 发给 renderer 的 envelope 只有 `roomId` 没填 sessionId,而 `preload/types.d.ts:89` 的 `ApprovalRequestEnvelope` **已定义 `sessionId?` + 注释"renderer routes the modal to the right tab"**(设计要按 session 路由,没接上);③ **Renderer** `App.tsx:1713-1714` approval **跳过 bucket 解析**,直接 `setApproval` 成全局态弹给当前 activeSession。**对照:AskUser 弹窗 `App.tsx:1654-1686` 是对的**——调 `resolveBucket(env.sessionId)` 按来源 session 归桶(`streamRouting.ts:68 findAskUserOrigin`),approval 漏了这套。
  - **修法**:让 approval 复用 AskUser 的归桶——(a) core `ApprovalRequest`/传递链补 sessionId 一路带到 envelope;(b) main `index.ts:362` envelope 填 sessionId;(c) renderer `App.tsx:1713` approval 也走 `resolveBucket(env.sessionId)`,ChatView 仅当 `approval 来源 bucket === activeBucket` 时显示。这条与"Windows Bash 卡住不弹窗"可能相关(若弹窗归错 session,来源 session 就永远等不到结果 → 卡)。

- ✅ **[Windows/Bash] Windows 上用 Bash 卡住、审批弹窗不出**（rc.3 已修：off.ts sandbox wrap 从硬编码 -c 改调 resolveShellInvocation，根因是 cmd.exe -c 不认；Windows 上彻底修复需再补 Git Bash 探测 + PowerShell 回退） — 用户确认:**Mac 正常,Windows 上**默认权限档用 Bash 就卡住/没弹窗,**和 session 无关**。用户机器装了 Git(理论上有 Git Bash)。
  - **代码核对(纠正早前"没 bash"猜测)**:`spawn-common.ts:130-142 resolveShellInvocation` **有 win32 分支** —— Windows 上 Bash 命令实际走 **`cmd.exe /c`**(不是 `/bin/bash`;注释明说 `$SHELL` 在 win 被忽略,cmd.exe 是安全默认)。所以不是"找不到 bash 才卡"。**真因未定,别下结论**,候选:① Bash 工具产生的**命令是 bash 语法**(`ls`/`&&`/`$(...)`/管道/引号),cmd.exe 跑不了 → 报错或挂;② 卡在**审批流本身**(Windows 上审批弹窗没弹或 spawn 卡死),与 shell 解析无关;③ node-pty/后台 shell 在 win 的 spawn 问题(关联 `project_killprocessgroup_pgid_guard`)。
  - ⚠️ **必须 Windows 真机复现 + 抓日志定位**(Mac 复现不了,不能靠推断)。看:命令实际发给 cmd.exe 长什么样、有没有 exec 错误被吞、审批请求有没有产生。关联 `project_windows_compat_audit`、`project_windows_port`、`project_executor_error_boundary`(是否 fail-loud)。
  - 🎯 **真根因(用户 2026-07-02 定位 + 亲验确认)**:`off.ts:6-7` sandbox off backend 的 `wrap()` **硬编码 `args: ["-c", command]`**(POSIX flag);而 `spawn-common.ts:163` `if (opts.sandbox)` —— **off backend 是 truthy 对象,永远命中 sandbox 分支** → 调 `off.wrap()` 拿到 `-c` → **永远绕过 `resolveShellInvocation`(那个才正确按 win 给 `/c`)**。`spawn-common.ts:167` 注释还写 `// No sandbox (the off backend / Windows)...` 自以为 off 会走到那行,实际走不到=注释与行为不符。Windows 上 → `cmd.exe -c "..."` → cmd 不认 `-c` 掉进交互模式**卡死到超时**="根本没执行"。**这就是多个 Windows 问题的共同根**:Bash 没执行 + seed 的 `git clone` 卡死 → skill/市场空,全因此。
  - **修法(Mac 即可修+测,逻辑 bug 非平台特定;用户定:先记不修)**:**推荐方案 = `resolveSpawnTarget` 对 `name==="off"` 的 backend 跳过 wrap,直接走 `resolveShellInvocation`**。理由:①off 语义=不沙箱,本不该 wrap;②`spawn-common.ts:167` 注释本就假设 off 走 resolveShellInvocation,让代码符合注释意图;③平台 shell flag 知识集中在 resolveShellInvocation 一处,不散。次选:off.wrap 内部改调 resolveShellInvocation(平台逻辑会散两处)。补 win32 单测(off backend + win → 期望 `/c`)。⚠️ 别破坏真 sandbox(seatbelt)wrap 语义。
  - **用户拍板的根治方向(2026-07-02) + CC 做法佐证**:Bash 工具生成的是 bash 语法(`ls`/`&&`/`$()`/管道),`cmd.exe` 跑不了 = Windows 卡住真因。**改 shell 选择梯度(抄 CC,见 `reference_cc_codex_windows`)**:装了 Git for Windows → **Bash 工具走 Git Bash**(探测 git 路径推 `…\bin\bash.exe`,支持 env 覆盖如 `CODE_SHELL_GIT_BASH_PATH`);没 git → **PowerShell**(探 `pwsh.exe`→`powershell.exe`,用户确认"powershell 也能用");最后才 `cmd.exe` 兜底。这也解释上一条"检测 git 只显示可用没回填 path"——检测到 git 但没把 Git Bash 路径接进 shell 选择。
  - **落地**:改 `spawn-common.ts:130-142 resolveShellInvocation` 的 win32 分支(现在硬 `cmd.exe /c`);抽 `resolveShell()` + Git Bash 探测 + PowerShell 回退,一次性解 `project_windows_compat_audit` 记的 `/bin/bash` 写死 5 处(bash.ts/background-shell.ts/safe-spawn.ts/worktree.ts/updater.ts)。PowerShell 用 `-Command`、Git Bash 用 `-c`、cmd 用 `/c`(resolveShellInvocation 已按 pwsh/cmd 分 flag,补 bash 分支)。⚠️ Windows 真机验。
  - **已核实(2026-07-02)**:全 core grep `git.?bash`/`GIT_BASH`/`Program Files\Git`/env 覆盖 **全空** → **core 目前零 Git Bash 探测逻辑**,也无 env 覆盖入口。所以不是"找 Git Bash 没找到",是**根本没实现探测**,Windows 无条件走 cmd.exe。改时是**新增**探测(推荐:`where git`/`git --exec-path` 反推 `…\Git\bin\bash.exe`,或查 `C:\Program Files\Git\bin\bash.exe` + 环境变量覆盖如 `CODE_SHELL_GIT_BASH_PATH`)。

- ✅ **[git 检测 · UX] "检测 git"只回可用性不回填 path + GUI 没继承 PATH 可能探不到 git**（rc.3 已修：git:check 在可用时回填 path 到 settings.git.path） — 用户困惑:检测 git 检测到了却没把 path 回填,且"PATH 里好像没 git"。**核实了现有逻辑**:
  - **"检测 git"干什么活**:`AdvancedSections.tsx:GitSection` 有两件独立的事——① `checkGit`(进设置页自动探 `:668` + 点"检查"按钮)→ main `index.ts:1679 git:check` → core `utils.ts:38 isGitAvailable()` 跑 `git --version` → **只回 `{available:true/false}`(绿勾/红叉),设计上从不产出/回填路径**;② `pickGit`(`:696`)= 用户**手动**选 git 二进制存 `settings.git.path`,给"GUI 启动没继承 PATH"兜底(注释 `645-648` 原话)。`applyGitPathFromSettings`(`index.ts:1365`)只读手配的 `git.path`,**不自动检测**。
  - **所以"检测到没回填 path"= 设计如此**(checkGit 只是可用性探针)。**改进方向**:检测到 git 后自动拿路径回填(`where git`/`git --exec-path`),免用户手选——正是用户预期的"git 找到后回显"。
  - **"PATH 里没 git"= 很可能是 Windows 真正卡因之一**:双击启动的 GUI Electron **常不继承终端 PATH** → 即使终端有 git,codeshell 的 `isGitAvailable()` 也探不到 → 市场 clone 失败 → 市场空/插件列不出。这是**独立于 `off.ts` `-c` bug 的另一条线**(两者都致市场空)。修向:GUI 启动时补 PATH(macOS `fix-path`/`shell-env` 那类拿登录 shell 的 PATH;Windows 读注册表/常见 git 安装位),或检测不到时引导用户 pickGit。关联 `project_windows_compat_audit`。

- ✅ **[macOS/分发] 别人下载安装后显示"包已损坏"**（rc.3 已修：移除 dist/pack 脚本的 CSC_IDENTITY_AUTO_DISCOVERY=false，恢复 electron-builder 默认 ad-hoc 签名） — 有人反馈 macOS 下载安装后报"已损坏,无法打开/应移到废纸篓"。**根因(已核实,非真损坏)**:App 未签名未公证——`codesign -dv` 显示 `Signature=adhoc`/`TeamIdentifier=not set`,`spctl` 判定 Gatekeeper 不放行。**别人从浏览器下 dmg → 文件被打 `com.apple.quarantine` 隔离属性 → Gatekeeper 校验未签名 App → 较新 macOS 报"已损坏"(极误导,其实没坏)**。用户自己装没报=用 `gh release download` 下的,没经浏览器无 quarantine。
  - **短期缓解(不签名)**:release notes / 下载页明确写绕过步骤——① 右键 App → 打开 → 仍要打开;或 ② 终端 `xattr -cr /Applications/code-shell.app` 去隔离属性;或 ③ 设置→隐私与安全性→"仍要打开"。**注意"已损坏"这个措辞下,右键打开有时也不行,`xattr -cr` 最可靠**,下载页要给这条命令。
  - **🎯 真因(2026-07-02 实证对比,推翻"纯签名缺失"结论)**:和用户另一个 app `video-download-eletron` 对比——**两个都无 Apple 账号无签名、都 dmg 浏览器下载,但 video downloader 不报损坏,codeshell 报**。差异:① **codeshell `dist`/`pack` 脚本带 `CSC_IDENTITY_AUTO_DISCOVERY=false`**,video downloader 是**裸 `electron-builder`**。裸 electron-builder 找不到证书时**自动做完整 ad-hoc 签名**;而 `CSC_IDENTITY_AUTO_DISCOVERY=false` **显式禁用签名发现 → 签名封装不完整** → `spctl` 报 `code has no resources but signature indicates they must be present`(codeshell 实测就是这个错)。② codeshell 有 **`asarUnpack: node-pty`**,解出的 `.node`(adhoc/linker-signed)没被 app 整体签名正确封装,加剧签名不一致;video downloader 无 asarUnpack。**结论:codeshell 是"半吊子签名"比 video downloader 的"完整 ad-hoc"更被 Gatekeeper 拒。**
  - **🟢 免费修法(Mac 可改+验,优先试)**:**去掉 `packages/desktop/package.json` scripts 里 `pack`/`dist` 的 `CSC_IDENTITY_AUTO_DISCOVERY=false`**,让 electron-builder 自动 ad-hoc 签名(学 video downloader)。大概率把"损坏"降级成温和的"未验证开发者"(右键可开)。可能需配合确保 asarUnpack 的 node-pty 被签名覆盖(或 `signIgnore` 处理)。改完本地 `bun run dist` + 浏览器下载模拟(`xattr -w com.apple.quarantine` 打标)+ `spctl -a` 验。⚠️ CI release.yml 也走 electron-builder,同步核对有没有传这个 env。
  - **根治(要花钱)**:Apple 开发者账号($99/年)→ Developer ID 签名 + 公证(notarize)+ stapler。`project_macos_signing_notarization` 记账号到位改 4 处。⚠️ Windows 同理未签名(SmartScreen 拦),已在 release.yml body 注明。

- ⬜ **[Windows/性能] Windows 上进程/终端起 cmd.exe 开销大(真机实测慢)**（rc.3 延后：需 Windows 真机 profiling 定位，非 Mac 可修） — 用户 Windows 真机实测慢,AI 当时给的结论是"每次 Bash 工具都起 cmd.exe pty 开销大"。
  - ⚠️ **纠偏(已核实代码,推翻 AI 结论)**:**Bash 工具根本没用 node-pty** —— core `bash.ts`/`safe-spawn.ts` grep 无 node-pty,走普通 `child_process.spawn`。node-pty **只用在两处**:`packages/desktop/src/main/pty-service.ts` + `renderer/panels/TerminalPanel.tsx`(即**只有终端面板**用 pty)。所以"每次 Bash 都起 pty"不成立。
  - **真实候选(待 Windows 真机测证实)**:① **终端面板** conpty 冷启动 cmd.exe 慢(conpty 冷启已知慢,真机验面板打开耗时);② Bash 工具若慢=普通 spawn cmd.exe 的开销(和上一条 shell 选择相关——bash 命令走 cmd 本就别扭);③ 优化方向:一次性命令本就不该用 pty(现在也没用,✓);终端面板可考虑 pty 复用/预热,或 Windows 上默认起更轻的 shell。⚠️ **必须 Windows 真机 profiling 定位到底哪里慢**,别再拿 AI 结论当根因。关联 `project_desktop_four_panels`(node-pty 按 Electron ABI 重编)、`project_windows_port`。

- 🟡 **[种子/预装 · Windows] 默认预装 skill 没出现 + 默认市场列表空(Windows 新装机)**（rc.3 部分修：off.ts -c bug 修复后 git clone 应能跑通；若仍失败需真机验 seed/bootstrap fail-loud） — 复现:**Windows** 全新装 v0.6.0-rc.2 首启。实际:① 应预装的 skill 在列表看不到;② marketplace 页没有默认源列表。期望:首启软预装官方 skill/plugin + 市场默认列出官方源。背景:官方 repo=`cjhyy/mimi-plugins`,首启软预装,`project_official_marketplace_seed`。
  - ⚠️ **平台更正(2026-07-02)**:用户在 **Windows 新装机**遇到,**不是 Mac**。下面 agent 的验证是在 **Mac 仓库/`dist/mac-arm64`** 上做的,**不代表 Windows**——Windows 打包是否带种子、Windows 上 git clone 是否能跑,都得单独在 Windows 验。**极可能与 Windows bash/git 那条同源**:seed 的 `addMarketplace` 要 `git clone cjhyy/mimi-plugins`,若 Windows 上 git/shell spawn 有问题(见 Windows/Bash 条),clone 失败 → 市场空 + skill 装不上。关联 `project_official_marketplace_seed`、`project_marketplace_version_display`。
  - **调查结论(agent,仅 Mac 验证)**:✅ 种子资源打包+路径**在 Mac 上**都对——`known-marketplaces-seed.json`(官方+mimi-plugins 2 项)+ `resources/agents` 进了 `dist/mac-arm64/.../Resources/packages/desktop/resources/`,`resourcePath()`(`seed-defaults.ts:38-48`)打包/dev 分支路径匹配。✅ 首启 seed 每次启动跑(幂等):`index.ts:1412-1414` `seedDefaults()→bootstrapCorePlugins()`。**⚠️ 这些是 Mac 证据,Windows 打包 extraResources 是否同样落地、路径分隔符(`\` vs `/`)是否影响 `resourcePath` join,需 Windows 单独验。**
  - **最可能根因(agent 代码推断,未经真机证实)**:`seedMarketplaces`(`seed-defaults.ts:94-104`)调 `addMarketplace` 去 **clone `cjhyy/mimi-plugins` 失败(网络/超时/git)→ 错误被 `console.error` 静默吞** → `known_marketplaces.json` 没写入 → 市场列表空 + `bootstrapCorePlugins`(`bootstrap-core-plugins.ts:86-120`)找不到市场源 → skill 装不上。次因:曾部分装过 → marker 记 pre-existing 但实际不可见。
  - ⚠️ **待真机证实(别拿推断当定论)**:查用户机器 `~/.code-shell/plugins/` 下:①`known_marketplaces.json` 有没有内容 ②`marketplaces/mimi-plugins/` 目录在不在 ③`core_plugins_installed.json` marker 状态 ④app 控制台有没有 clone 失败的 console.error。**若真是 clone 失败静默吞** → 修法:seed/bootstrap 失败要 fail-loud(UI 提示"市场初始化失败,点重试"),别静默;考虑离线兜底(种子直接带 skill 本体而非只带 marketplace 指针,免首启必须联网)。关联 `project_executor_error_boundary`(fail-loud)。
  - **用户补充(2026-07-02)**:"**哪些插件可以下载目前没有看到**"——即市场里可下载插件清单也没展示。用户预期链:git 找到→回显→能用 git bash→插件能下载。**极可能同一根**:`off.ts` `-c` bug 让 Windows 上 `git clone` 市场 repo 卡死 → repo 没拉下来 → 自然列不出里面有哪些插件。所以修了 off backend 的 `-c` bug 后,这条大概率连带解决。若修完 clone 通了仍列不出,再单查市场详情页读 repo 内插件清单的逻辑(`project_marketplace_version_display`/`project_official_marketplace_seed`)。

---

# 发布关键路径（beta1，必须用户亲自做）

> 原 `TODO-beta1.md` 合并进来。代码侧 review 确认 bug 已修;剩下是验证 + 打包 + 发布,AI 无法代做。

- 🔴 **真机冒烟:弹窗登录抓 cookie 全链路** — 登 YouTube → 保存 → 切换账号 → AI 取用。唯一没真机验过的核心新功能。关联 `project_browser_login_window`。
- 🔴 **桌面 App 冒烟**（本机,发前必跑）:装包→Gatekeeper 右键打开→主界面→子代理列表非空→市场有源→配 OpenAI 跑一轮→切模型→默认 agent 跑一次→生成一张图→关掉重开能恢复会话。
- 🔴 **全量打包构建**:`bun run build` + `cd packages/desktop && bun run dist`（electron-builder,未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`），确认 main 进程 / node-pty ABI / asarUnpack 没崩。
- 🔴 **`git push`** 未推的 commit 到 origin/main。
- 🟡 **npm 包**（若本轮要发）:**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）;**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**:中/英切换走主流程,确认无未翻译泄漏 / 无 localStorage 报错。
- 🟡 **Windows P8 真机冒烟**:代码 P1–P8 全实现 + CI 绿,但无打包 job、无真机点验。beta1 若只发 mac 可整体延后。关联 `project_windows_port`。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**:① 已修(per-window `randomUUID()` nonce);② `persist:login-*` 分区只清 cookie,localStorage/IndexedDB/SW 残留 → 改非持久分区或 `clearStorageData`;③ BrowserHost phase-2 webview 收编未预留类型/未抽共享 helper。
- ⚪️ **JSON-Schema 导出未接线**:`schema-export.ts` 无 caller → 宿主启动写 `~/.code-shell/settings.schema.json` 或 release notes 注明不暴露。
- ⚪️ **i18n 收尾（增量）**:`"新对话"` 哨兵常量化;非 React helper 硬编码 localStorage key 应 import KEY;mobile(~149 处)单独接同套 i18n。

---

# 大路线图（beta1 不做，留存方向）

- **core 通用化 + 插件面板**（`docs/todo/core-harness-and-plugin-panels.md`,2026-07-02 全仓 review 产出）:① core=无 coding/git 预设的通用 harness——4 个内核 git 触点参数化 / harness-min preset + CI 纯度 smoke / coding pack 外移(git/lsp/review/worktree/cc-orchestrator/quota…);② 插件={UI 面板+能力}——PanelRegistry / manifest `panels` / csplugin:// 沙箱 host / 按 permissions 过滤的 scoped bridge,能力侧 v1 走自带 MCP。**Phase A(工具元数据合一,消灭「加工具改三处」+ PanelRegistry)最小可先做;面板线只依赖 A②,不被 core 改造阻塞**。与 `architecture-debt.md` P1-⑤⑥ 重叠处合并执行。
- **Cookie Lease**（`docs/browser-cookie-export-design-2026-06-14.md`）:浏览器登录态→CLI 工具受控桥接(按域/按任务/一次性/审批 + 三层清理)。整套未实现。
- **Workspace / Profile / 数字人**（`docs/workspace-profile-讨论稿.md` v0.5）:base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。下一步 P3 seedance 手动落地。
- **Workspace 数据源绑定**（P4）:资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配。大子系统。
- **远程控制 / 跨代理编排**（P5）:SSH / 扫码配对 / 远控会话 / 编排 Codex+CC / 安全边界。大子系统。
- **手机遥控**（低优）:房间续跑 + 手机驱动真 codeshell session;现 mobile 无 Markdown 渲染。
- **聊天软件接入（channel，参考 OpenClaw）**:微信/Telegram 做成可插拔 channel 前端。要点:① core 保持 channel-agnostic,平台接入做外部插件;② 接入做成一类凭证进 CredentialStore(微信扫码登录 token 存本地,Telegram bot token);③ 扫码微信号绑死为收发身份 + 必配 allowlist + 绑定目标 agent;④ 微信当前只私聊 + 媒体,不支持群聊。未立项。
- **工程质量 P7**:builtin tools 集成测试(已补 65 例)/ E2E / CI 覆盖率 >60% / 性能 / 文档。
  - **Electron e2e 设施**（playwright 现是孤儿依赖）:用 `_electron` API 驱动真机 app,沉淀 `verifier-electron` 基座。最小落地:`playwright.config.ts` + `e2e/`;`launchApp()` 按 title/URL 抓主窗（**别用 `firstWindow()`,会抓 DevTools 窗**）;第一个用例验浏览器面板;`package.json` 加 `test:e2e`。难点:抓错窗 / webview 嵌套需 `frameLocator` / node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。约半天。
- **Markdown 渲染一致性**（desktop/TUI）。
- **view_image TUI inline**（iTerm/kitty graphics protocol）+ 历史图降级文字摘要省 token。
- **设置/命名清理**:settings/repo/workspace 命名收口;ModelSection 1065 行深度重排。

### 明确不做（已决策，留因）

- **每轮主动请求压缩 / token 预算动态调档**:与 Anthropic prompt cache 冲突,固定 ratio 门控刻意保留。
