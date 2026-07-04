# TODO

整理范围：来自 2026-07-01 Codex 规划与 Claude Code 只读复核。bug 类待办已全部修复或删除（记录在 git 历史与记忆）；Critical/High/Medium/Low/Follow-up/Hardening 均已清。

现状：只剩发布关键路径（beta1 用户亲自做）+ 延后项（记 release notes）+ 大路线图（留存方向）。

# beta 真机测试反馈（v0.6.0-rc.2，2026-07-02 起）

> 用户在 macOS arm64 真机测试 v0.6.0-rc.2（桌面端 + CLI）。发现的问题按报告顺序记录在此,待批量修复。

- ✅ **[浏览器面板/跨session] 切换 session 时旧浏览器内容串到新 session 的浏览器面板**(worktree beta-rc2-fixes)— 根因:所有 session 的 webview 共享全局 `partition="persist:browser"`(`WebviewHost.tsx:25` 硬编码 + `main/index.ts:1078` 强制),存储/会话不隔离(终端对比:pty 按 sessionId 隔离所以没问题)。修:WebviewHost 加 `partition` prop(冻结,默认仍 persist:browser 兼容 popout);BrowserPanel 透传;PanelArea 按 bucket 传 `persist:browser:${bucket}`(每 session 独立分区);main will-attach-webview 只放行 `persist:browser` 前缀分区(防越权)。⚠️ 真机验 webview 隔离。原始描述: 复现:session A 面板开了浏览器(某网页),切到 session B(B 面板也有浏览器),A 的浏览器内容自动出现在了 B 的浏览器面板上。期望:浏览器 webview 内容按 session 隔离,各 session 的浏览器互不串。疑似浏览器面板/webview 是全局单例(或按 panel 而非 session 归属),切 session 时没换成该 session 自己的 webview/URL。与"权限弹窗归属错 session"同类(跨 session 状态未隔离)。待定位:浏览器面板组件的 webview 实例/URL 归属——是全局共享一个 webview 还是按 sessionId 分。关联 `project_browser_panel_nav_bugs`、`project_browser_selection_echo_session`(浏览器按 session 归桶)、`project_desktop_four_panels`。⚠️ 需真机验(webview 行为)。
> 已修:桌面端启动崩溃 `Cannot find package 'cross-spawn'`（predist 依赖闭包,见 `project_release_ci_pipeline`）。

<!-- 用户反馈问题追加到这里,格式:
- ⬜ **[模块] 一句话现象** — 复现步骤 / 期望 vs 实际 / 相关文件(如已知)
-->

- ✅ **[项目边界] 项目归属改为:有 git 用 git 根,无 git 用 cwd**（架构改进,非 bug）— 现状:codeshell 纯按 cwd 归项目(`project_disk_authoritative_recovery`),monorepo 里在仓库根 vs `packages/desktop` 分别打开会被当成**两个不同项目**。期望(对齐 CC):cwd → 向上找 `.git` 仓库根,有则用 git 根作项目 key(子目录归父项目);无 git 则用 cwd 本身。保留 `isNoRepoCwd` 护栏(no-repo/临时目录仍归 NO_REPO_KEY,不建项目)。
  - **✅ 已做最小版(worktree beta-rc2-fixes)**:核心诉求"添加项目时若选的是 git 子目录,归到仓库根,非 git 才按目录本身"已实现——core 新增 `resolveProjectRoot(cwd)`(`git/utils.ts`:`git rev-parse --show-toplevel`,非 git/失败→原样返回,不抛)+ export;desktop `dialog:pickDir`(main)选目录后先 `applyGitPathFromSettings()` 再 `resolveProjectRoot` 归一化,子目录自动 snap 到仓库根 → `handleAddRepo` 按 path 去重即命中同一项目。带 3 例单测(子目录→root/非git→自身/不存在→不抛)。**不碰存量**(旧项目不变)。
  - **✅ 剩完整版已做(2026-07-03)**:① picker/projects:add 强制 `resolveProjectRoot`;② automation 源头 cwd 归一化,覆盖 rebuildFromDisk/importRuns/liveSession 自动归桶;③ 启动回填存量 localStorage repo 时先 resolveRoot 去重,子目录项目合并到 git 根;④ `resolveProjectRoot` 先 realpath 防 symlink,并补 symlink 单测。

- ✅ **[设置/catalog] 语音类型模型无选项 + 语音模型配置展示不出来**（rc.3 已修：ModelCatalogPanel 补 audio 类型下拉） — 复现:设置里的模型/连接页。实际:模型类型分类里没有"语音/STT(/TTS)"这一类,配好语音模型后配置项也不展示。期望:catalog 支持语音类型模型,能像文本/图/视频那样在连接页配置并展示。背景:STT 听写桌面端已实现,但记忆 `project_voice_input_stt` 记它是"纯 UI 非工具+回退复用 OpenAI 凭证",可能从没进 catalog 的模型类型枚举。关联 `project_unified_model_catalog_design`/`project_model_catalog`/`project_voice_input_stt`。
  - **调查结论(agent)**:audio 类型其实已 90% 接好——✅ catalog 枚举含 `audio`(`core/model-catalog/types.ts:77` `tag: enum(text,image,video,audio)`);✅ builtin 有 2 条 audio(`builtin.ts:390-425` openai-transcribe / groq-transcribe);✅ 连接页有 audio 分组(`SearchConnectionsPanel.tsx:73-79`)+ 按 tag 过滤渲染(`TextConnectionsPanel.tsx:55,99`);✅ STT 后端已走 catalog 读 audio 连接(`core/stt/resolve-transcribe.ts:54-84`,无连接时回退 OpenAI 凭证)。
  - **唯一确认缺口**:`ModelCatalogPanel.tsx:319-323` 模型类型下拉 options 只有 text/image/video,**漏了 audio** → 用户在 catalog 编辑器手动加/编辑模型时看不到"语音"类型。修法:options 补 `{value:"audio",label:...}`;顺带 `catalogEditor.ts` blankEntry 默认值 + i18n 标签(`settingsX.textConn.headingAudio`/`searchConn.groupAudio*`)核实存在。
  - **用户真机确认(2026-07-02)**:两处都缺,都要修——① **连接页 audio 没像图片那样默认展示**;② **模型页面(Catalog 编辑器)没有 audio 类型**。
  - ⚠️ **纠偏**:agent 看的 `SearchConnectionsPanel.tsx:57-79` 里 image/video/audio **全是 `defaultOpen={false}`(折叠)**,只有 web search 默认展开——所以用户说的"图片默认展示出来"**不是这个面板**。用户实际看的是另一个页面(image 在那里直接铺开展示),audio 在**那个页面**缺席。待重新定位:哪个页面把 image 直接展示(不折叠)?ModelSection / 主连接页 / GenConnectionsPanel?找到后 audio 要在同一处同样默认展示。别再认 SearchConnectionsPanel 这个折叠面板。
  - **✅ 已修(worktree beta-rc2-fixes)**:`ModelCatalogPanel.tsx:320-323` 类型下拉补了 audio 选项——catalog 编辑器现在能建/编辑 audio 类型条目。
  - **✅ UX 已做(2026-07-03)**:回退态(复用 OpenAI key 的隐式 STT provider)现在在 audio 空态中渲染为只读连接卡,并有专用提示文案;添加正式 audio 连接后自动替代它。

- ✅ **[会话切换] 点击未渲染过的 session 先闪"新建页面"再渲染内容**（rc.3 已修：fallbackState 区分真新建 vs 待 hydrate，ChatView 显示 loading 占位） — 复现:点侧边栏一个本 renderer 进程还没打开过的 session。实际:先闪空的新建/欢迎态,随后异步 hydrate 出历史内容。期望:加载期显示 loading 或占位,不露出新建态。
  - **根因(已定位)**:`App.tsx:809-816` `fallbackState`——`transcripts[activeBucket]` 尚无(undefined)时兜底读 localStorage,该 session 从没在本 renderer 打开过 → localStorage 空 → `local.messages.length===0` → 返回 `INITIAL_STATE`;`ChatView.tsx:598` `isNewChat = messages.length===0` 遂为 true,渲染欢迎页;`App.tsx:701-787` 异步 `subscribeSession` hydrate 到达后才切成内容。
  - **修法方向**:fallbackState 里区分"真新建" vs "已存在但未 hydrate"——查 sessionIndices 里该 session 存在但 localStorage 空时,返回带 loading/占位标志的 state(而非 INITIAL_STATE),ChatView 据此显示 loading 而非新建态。参考 `project_settings_page_loading_flash`(缓存快照 seed)。⚠️ 别误伤真正的新建草稿态(关联 `project_draft_session_autojump_bug` / `project_new_chat_panel_inherit`)。

- ✅ **[窗口控件/标题栏] 红绿灯占位 + 标题栏 padding 需按平台 + 全屏状态适配**（rc.3 已修：preload 下发 platform、TopBar 按平台+全屏显隐占位、main 监听 fullscreen 事件、SettingsPage 同理） — 三个子点:① **非 Mac(Win/Linux)**:窗口控件(最小化/缩略/关闭)样式很奇怪——疑似照搬 Mac 无边框假设,Win/Linux 没原生红绿灯却留了空/画错。② **设置页左上角**:给 Mac 红绿灯预留的空位/padding 需按平台判断,非 Mac 不该留 Mac 式空位。③ **Mac 全屏**:进入全屏后红绿灯消失,左上角预留留白也要跟着去掉(现全屏了留白仍在)。期望:标题栏/控件占位随 `process.platform` + 全屏状态动态调整。
  - **根因(agent 已定位)**:① 窗口配置本身有平台判断——`main/index.ts:1117` `titleBarStyle: darwin?"hiddenInset":"default"`(对);② 但 renderer **`TopBar.tsx:76` 硬编码 `<span className="w-[68px] shrink-0">` 红绿灯占位,所有平台都渲染,无平台判断** ← 非 Mac 突兀根因;③ **全屏事件完全没监听**——main(`index.ts:1061-1277` 窗口事件列表里)无 `enter-full-screen`/`leave-full-screen`,renderer(App.tsx)无 fullscreen 响应 ← Mac 全屏留白不消失根因;④ platform 没经 preload 正式下发,renderer 只靠 `navigator.platform`(App.tsx:2967)兜,不够可靠。
  - **改动清单(agent)**:(a) `preload/index.ts` 暴露 `window.codeshell.platform=process.platform`;(b) `TopBar.tsx:76` 占位改 `{isMac && !isFullscreen && <span…/>}`;(c) `main/index.ts:~1271` 加 `enter/leave-full-screen` 监听 + IPC 下发 fullscreen;(d) `App.tsx:2966` 订阅 fullscreen 态控制占位;(e) `SettingsPage.tsx:177` 左上角同样按平台判断(设置页左上角问题在此);(f) 可选 `window-state-store.ts` 加 fullscreen 字段。⚠️ 改完必在 Win + Mac(含全屏)真机验。

- ✅ **[Windows] 原生菜单栏突兀 + nsis 安装器不友好(不能选安装位置)**（2026-07-03 已做；2026-07-04 Windows 真机冒烟通过） — Windows/Linux 不再安装原生应用菜单(`Menu.setApplicationMenu(null)`),窗口仍设 `autoHideMenuBar`;NSIS 已配置 `oneClick:false` + `allowToChangeInstallationDirectory:true` + 桌面/开始菜单快捷方式。⚠️ 未签名 exe,SmartScreen 仍会拦(已在 release notes 注明)。
  - **Codex 参照**:Codex 是纯 CLI(npm 全局装),**没有 Electron 桌面端 + nsis 安装器**,所以菜单栏/安装位置这块 Codex 无直接可参照做法。这两点走 Electron/electron-builder 标准解法即可(见上)。CLI 侧 codeshell 本就有 `npm i -g` 路径与 Codex 一致。

- ✅ **[面板按钮] 右侧面板切换按钮在非 chat 页(自动化/凭证)仍显示**（rc.3 已修：panelAvailable 加 view.viewMode === "chat" 判断） — 复现:chat 页右上角有面板开关按钮(文件/浏览器/审查/终端),切到自动化凭证页后右上角**还有**这些面板按钮。期望:面板按钮是 chat 专属,切到非 chat 页(自动化/凭证/设置等)应隐藏。关联 `project_desktop_four_panels`(文件/浏览器/审查/终端四面板)。
  - **根因(agent 已定位)**:按钮在 `TopBar.tsx:107-117`(`PanelRight` IconButton),`panelAvailable` 控制显隐;`App.tsx:3008` `panelAvailable={activeSessionId !== null}` **只判断有活跃会话,没判断当前是 chat 视图**。视图模式是 `view.viewMode`(`view.ts` ViewMode:chat/credentials/automation/customize/...),credentials/automation 等复用同一主渲染树(含 TopBar),只有 `settings_page` 单独返回。所以切到非 chat 页只要还有 activeSession,按钮就错误显示。
  - **修法**:`App.tsx:3008` 改 `panelAvailable={activeSessionId !== null && view.viewMode === "chat"}`。

- ✅ **[权限] 审批弹窗在错的 session 弹出(弹窗归属 session 错位)**（rc.3 已修：core ApprovalRequest 补 sessionId → main envelope 填 sessionId → renderer approvalBucketsRef 按来源 bucket 路由弹窗） — 复现:session A 的工具触发权限请求。实际:弹窗弹到了当前正在看的 session B(不相关会话);选"本会话允许"后**作用在正确的 A**(A 的工具放行、缓存生效),**但触发它的 session UI 归属错了**——弹窗显示在 B,B 不知道这是 A 的请求。即:审批语义/缓存是对的(按 A),错的是**弹窗 UI 挂到了当前活跃 session 而非请求来源 session**。期望:权限弹窗只在**请求来源 session** 显示;切到别的 session 时不该看到 A 的弹窗(或明确标注是哪个 session 的请求)。关联 `project_permission_session_cache`、`project_askuser_deny_green_check`、`project_cc_room_render_alignment`。⚠️ 权限系统敏感,修时别动审批语义(那部分是对的),只修弹窗归属路由。
  - **根因(agent 已定位,三层,关键在 renderer)**:① **Core** `types.ts:299` `ApprovalRequest` 无 `sessionId` 字段 → 全链路不带来源标识;② **Main** `index.ts:362` 发给 renderer 的 envelope 只有 `roomId` 没填 sessionId,而 `preload/types.d.ts:89` 的 `ApprovalRequestEnvelope` **已定义 `sessionId?` + 注释"renderer routes the modal to the right tab"**(设计要按 session 路由,没接上);③ **Renderer** `App.tsx:1713-1714` approval **跳过 bucket 解析**,直接 `setApproval` 成全局态弹给当前 activeSession。**对照:AskUser 弹窗 `App.tsx:1654-1686` 是对的**——调 `resolveBucket(env.sessionId)` 按来源 session 归桶(`streamRouting.ts:68 findAskUserOrigin`),approval 漏了这套。
  - **修法**:让 approval 复用 AskUser 的归桶——(a) core `ApprovalRequest`/传递链补 sessionId 一路带到 envelope;(b) main `index.ts:362` envelope 填 sessionId;(c) renderer `App.tsx:1713` approval 也走 `resolveBucket(env.sessionId)`,ChatView 仅当 `approval 来源 bucket === activeBucket` 时显示。这条与"Windows Bash 卡住不弹窗"可能相关(若弹窗归错 session,来源 session 就永远等不到结果 → 卡)。

- ✅ **[Windows/Bash] Windows 上用 Bash 卡住、审批弹窗不出**（rc.3 已修 off.ts `-c` 回归；2026-07-04 已补 Windows shell 梯度 Git Bash → PowerShell → cmd，并经 Windows 真机冒烟通过） — 用户确认:**Mac 正常,Windows 上**默认权限档用 Bash 就卡住/没弹窗,**和 session 无关**。用户机器装了 Git(理论上有 Git Bash)。
  - **代码核对(纠正早前"没 bash"猜测)**:`spawn-common.ts:130-142 resolveShellInvocation` **有 win32 分支** —— Windows 上 Bash 命令实际走 **`cmd.exe /c`**(不是 `/bin/bash`;注释明说 `$SHELL` 在 win 被忽略,cmd.exe 是安全默认)。所以不是"找不到 bash 才卡"。**真因未定,别下结论**,候选:① Bash 工具产生的**命令是 bash 语法**(`ls`/`&&`/`$(...)`/管道/引号),cmd.exe 跑不了 → 报错或挂;② 卡在**审批流本身**(Windows 上审批弹窗没弹或 spawn 卡死),与 shell 解析无关;③ node-pty/后台 shell 在 win 的 spawn 问题(关联 `project_killprocessgroup_pgid_guard`)。
  - ⚠️ **必须 Windows 真机复现 + 抓日志定位**(Mac 复现不了,不能靠推断)。看:命令实际发给 cmd.exe 长什么样、有没有 exec 错误被吞、审批请求有没有产生。关联 `project_windows_compat_audit`、`project_windows_port`、`project_executor_error_boundary`(是否 fail-loud)。
  - 🎯 **真根因(用户 2026-07-02 定位 + 亲验确认)**:`off.ts:6-7` sandbox off backend 的 `wrap()` **硬编码 `args: ["-c", command]`**(POSIX flag);而 `spawn-common.ts:163` `if (opts.sandbox)` —— **off backend 是 truthy 对象,永远命中 sandbox 分支** → 调 `off.wrap()` 拿到 `-c` → **永远绕过 `resolveShellInvocation`(那个才正确按 win 给 `/c`)**。`spawn-common.ts:167` 注释还写 `// No sandbox (the off backend / Windows)...` 自以为 off 会走到那行,实际走不到=注释与行为不符。Windows 上 → `cmd.exe -c "..."` → cmd 不认 `-c` 掉进交互模式**卡死到超时**="根本没执行"。**这就是多个 Windows 问题的共同根**:Bash 没执行 + seed 的 `git clone` 卡死 → skill/市场空,全因此。
  - **修法(Mac 即可修+测,逻辑 bug 非平台特定;用户定:先记不修)**:**推荐方案 = `resolveSpawnTarget` 对 `name==="off"` 的 backend 跳过 wrap,直接走 `resolveShellInvocation`**。理由:①off 语义=不沙箱,本不该 wrap;②`spawn-common.ts:167` 注释本就假设 off 走 resolveShellInvocation,让代码符合注释意图;③平台 shell flag 知识集中在 resolveShellInvocation 一处,不散。次选:off.wrap 内部改调 resolveShellInvocation(平台逻辑会散两处)。补 win32 单测(off backend + win → 期望 `/c`)。⚠️ 别破坏真 sandbox(seatbelt)wrap 语义。
  - **用户拍板的根治方向(2026-07-02) + CC 做法佐证**:Bash 工具生成的是 bash 语法(`ls`/`&&`/`$()`/管道),`cmd.exe` 跑不了 = Windows 卡住真因。**改 shell 选择梯度(抄 CC,见 `reference_cc_codex_windows`)**:装了 Git for Windows → **Bash 工具走 Git Bash**(探测 git 路径推 `…\bin\bash.exe`,支持 env 覆盖如 `CODE_SHELL_GIT_BASH_PATH`);没 git → **PowerShell**(探 `pwsh.exe`→`powershell.exe`,用户确认"powershell 也能用");最后才 `cmd.exe` 兜底。这也解释上一条"检测 git 只显示可用没回填 path"——检测到 git 但没把 Git Bash 路径接进 shell 选择。
  - **✅ 已落地(2026-07-04)**:`spawn-common.ts` Windows 默认 shell 顺序改为 **Git Bash → PowerShell/pwsh → ComSpec/cmd.exe**;Git Bash 用 `-c`,PowerShell 用 `-Command`,cmd 用 `/c`;支持 `CODE_SHELL_GIT_BASH_PATH` / `CODE_SHELL_POWERSHELL_PATH` 覆盖。`safe-spawn` + `background-shell` 统一走该入口,并补 `CODESHELL_SPAWN_PROFILE=1` 轻量诊断。相关单测通过,Windows 真机冒烟确认 Bash/权限/终端/marketplace/skill 无异常。
  - **历史核实(2026-07-02)**:当时全 core grep `git.?bash`/`GIT_BASH`/`Program Files\Git`/env 覆盖 **全空** → core 原先零 Git Bash 探测逻辑,Windows 无条件走 cmd.exe。2026-07-04 已补齐探测与回退。

- ✅ **[git 检测 · UX] "检测 git"只回可用性不回填 path + GUI 没继承 PATH 可能探不到 git**（rc.3 已修：git:check 在可用时回填 path 到 settings.git.path） — 用户困惑:检测 git 检测到了却没把 path 回填,且"PATH 里好像没 git"。**核实了现有逻辑**:
  - **"检测 git"干什么活**:`AdvancedSections.tsx:GitSection` 有两件独立的事——① `checkGit`(进设置页自动探 `:668` + 点"检查"按钮)→ main `index.ts:1679 git:check` → core `utils.ts:38 isGitAvailable()` 跑 `git --version` → **只回 `{available:true/false}`(绿勾/红叉),设计上从不产出/回填路径**;② `pickGit`(`:696`)= 用户**手动**选 git 二进制存 `settings.git.path`,给"GUI 启动没继承 PATH"兜底(注释 `645-648` 原话)。`applyGitPathFromSettings`(`index.ts:1365`)只读手配的 `git.path`,**不自动检测**。
  - **所以"检测到没回填 path"= 设计如此**(checkGit 只是可用性探针)。**改进方向**:检测到 git 后自动拿路径回填(`where git`/`git --exec-path`),免用户手选——正是用户预期的"git 找到后回显"。
  - **"PATH 里没 git"= 很可能是 Windows 真正卡因之一**:双击启动的 GUI Electron **常不继承终端 PATH** → 即使终端有 git,codeshell 的 `isGitAvailable()` 也探不到 → 市场 clone 失败 → 市场空/插件列不出。这是**独立于 `off.ts` `-c` bug 的另一条线**(两者都致市场空)。修向:GUI 启动时补 PATH(macOS `fix-path`/`shell-env` 那类拿登录 shell 的 PATH;Windows 读注册表/常见 git 安装位),或检测不到时引导用户 pickGit。关联 `project_windows_compat_audit`。

- ✅ **[macOS/分发] 别人下载安装后显示"包已损坏"**（rc.3 已修：移除 dist/pack 脚本的 CSC_IDENTITY_AUTO_DISCOVERY=false，恢复 electron-builder 默认 ad-hoc 签名） — 有人反馈 macOS 下载安装后报"已损坏,无法打开/应移到废纸篓"。**根因(已核实,非真损坏)**:App 未签名未公证——`codesign -dv` 显示 `Signature=adhoc`/`TeamIdentifier=not set`,`spctl` 判定 Gatekeeper 不放行。**别人从浏览器下 dmg → 文件被打 `com.apple.quarantine` 隔离属性 → Gatekeeper 校验未签名 App → 较新 macOS 报"已损坏"(极误导,其实没坏)**。用户自己装没报=用 `gh release download` 下的,没经浏览器无 quarantine。
  - **短期缓解(不签名)**:release notes / 下载页明确写绕过步骤——① 右键 App → 打开 → 仍要打开;或 ② 终端 `xattr -cr /Applications/code-shell.app` 去隔离属性;或 ③ 设置→隐私与安全性→"仍要打开"。**注意"已损坏"这个措辞下,右键打开有时也不行,`xattr -cr` 最可靠**,下载页要给这条命令。
  - **🎯 真因(2026-07-02 实证对比,推翻"纯签名缺失"结论)**:和用户另一个 app `video-download-eletron` 对比——**两个都无 Apple 账号无签名、都 dmg 浏览器下载,但 video downloader 不报损坏,codeshell 报**。差异:① **codeshell `dist`/`pack` 脚本带 `CSC_IDENTITY_AUTO_DISCOVERY=false`**,video downloader 是**裸 `electron-builder`**。裸 electron-builder 找不到证书时**自动做完整 ad-hoc 签名**;而 `CSC_IDENTITY_AUTO_DISCOVERY=false` **显式禁用签名发现 → 签名封装不完整** → `spctl` 报 `code has no resources but signature indicates they must be present`(codeshell 实测就是这个错)。② codeshell 有 **`asarUnpack: node-pty`**,解出的 `.node`(adhoc/linker-signed)没被 app 整体签名正确封装,加剧签名不一致;video downloader 无 asarUnpack。**结论:codeshell 是"半吊子签名"比 video downloader 的"完整 ad-hoc"更被 Gatekeeper 拒。**
  - **🟢 免费修法(Mac 可改+验,优先试)**:**去掉 `packages/desktop/package.json` scripts 里 `pack`/`dist` 的 `CSC_IDENTITY_AUTO_DISCOVERY=false`**,让 electron-builder 自动 ad-hoc 签名(学 video downloader)。大概率把"损坏"降级成温和的"未验证开发者"(右键可开)。可能需配合确保 asarUnpack 的 node-pty 被签名覆盖(或 `signIgnore` 处理)。改完本地 `bun run dist` + 浏览器下载模拟(`xattr -w com.apple.quarantine` 打标)+ `spctl -a` 验。⚠️ CI release.yml 也走 electron-builder,同步核对有没有传这个 env。
  - **根治(要花钱)**:Apple 开发者账号($99/年)→ Developer ID 签名 + 公证(notarize)+ stapler。`project_macos_signing_notarization` 记账号到位改 4 处。⚠️ Windows 同理未签名(SmartScreen 拦),已在 release.yml body 注明。

- ✅ **[Windows/性能] Windows 上进程/终端起 cmd.exe 开销大(真机实测慢)**（2026-07-04 已收口：默认 shell 改为 Git Bash → PowerShell → cmd,并加 `CODESHELL_SPAWN_PROFILE=1` 诊断；Windows 真机冒烟未再发现明显问题） — 用户 Windows 真机实测慢,AI 当时给的结论是"每次 Bash 工具都起 cmd.exe pty 开销大"。
  - ⚠️ **纠偏(已核实代码,推翻 AI 结论)**:**Bash 工具根本没用 node-pty** —— core `bash.ts`/`safe-spawn.ts` grep 无 node-pty,走普通 `child_process.spawn`。node-pty **只用在两处**:`packages/desktop/src/main/pty-service.ts` + `renderer/panels/TerminalPanel.tsx`(即**只有终端面板**用 pty)。所以"每次 Bash 都起 pty"不成立。
  - **✅ 收口(2026-07-04)**:Bash 工具默认不再优先 cmd；前台 Bash 与后台 shell 增加 `CODESHELL_SPAWN_PROFILE=1` 诊断日志(记录 shell/flag/resolveMs/lifecycleMs 或 spawn elapsed)。Windows 真机冒烟覆盖 Bash、权限、终端面板、session 切换、重启恢复,未发现明显性能/卡死问题。若后续用户再次反馈慢,用该诊断开关抓具体阶段。

- ✅ **[种子/预装 · Windows] 默认预装 skill 没出现 + 默认市场列表空(Windows 新装机)**（2026-07-04 已收口：Windows shell 梯度 + seed 失败诊断已做；Windows 真机确认 marketplace/skill 无问题） — 复现:**Windows** 全新装 v0.6.0-rc.2 首启。实际:① 应预装的 skill 在列表看不到;② marketplace 页没有默认源列表。期望:首启软预装官方 skill/plugin + 市场默认列出官方源。背景:官方 repo=`cjhyy/mimi-plugins`,首启软预装,`project_official_marketplace_seed`。
  - ⚠️ **平台更正(2026-07-02)**:用户在 **Windows 新装机**遇到,**不是 Mac**。下面 agent 的验证是在 **Mac 仓库/`dist/mac-arm64`** 上做的,**不代表 Windows**——Windows 打包是否带种子、Windows 上 git clone 是否能跑,都得单独在 Windows 验。**极可能与 Windows bash/git 那条同源**:seed 的 `addMarketplace` 要 `git clone cjhyy/mimi-plugins`,若 Windows 上 git/shell spawn 有问题(见 Windows/Bash 条),clone 失败 → 市场空 + skill 装不上。关联 `project_official_marketplace_seed`、`project_marketplace_version_display`。
  - **调查结论(agent,仅 Mac 验证)**:✅ 种子资源打包+路径**在 Mac 上**都对——`known-marketplaces-seed.json`(官方+mimi-plugins 2 项)+ `resources/agents` 进了 `dist/mac-arm64/.../Resources/packages/desktop/resources/`,`resourcePath()`(`seed-defaults.ts:38-48`)打包/dev 分支路径匹配。✅ 首启 seed 每次启动跑(幂等):`index.ts:1412-1414` `seedDefaults()→bootstrapCorePlugins()`。**⚠️ 这些是 Mac 证据,Windows 打包 extraResources 是否同样落地、路径分隔符(`\` vs `/`)是否影响 `resourcePath` join,需 Windows 单独验。**
  - **最可能根因(agent 代码推断,未经真机证实)**:`seedMarketplaces`(`seed-defaults.ts:94-104`)调 `addMarketplace` 去 **clone `cjhyy/mimi-plugins` 失败(网络/超时/git)→ 错误被 `console.error` 静默吞** → `known_marketplaces.json` 没写入 → 市场列表空 + `bootstrapCorePlugins`(`bootstrap-core-plugins.ts:86-120`)找不到市场源 → skill 装不上。次因:曾部分装过 → marker 记 pre-existing 但实际不可见。
  - **✅ 已真机证实(2026-07-04)**:Windows 装包级冒烟中 marketplace 默认源、可下载插件清单、默认 skill/agent 均正常;Bash/权限/终端/重启恢复也无异常。seed 现在会写诊断文件 `%USERPROFILE%\.code-shell\plugins\seed_marketplaces_status.json`,记录 attempted/added/skipped/failed；后续若市场空,优先看该文件。
  - **用户补充(2026-07-02)**:"**哪些插件可以下载目前没有看到**"——即市场里可下载插件清单也没展示。用户预期链:git 找到→回显→能用 git bash→插件能下载。**极可能同一根**:`off.ts` `-c` bug 让 Windows 上 `git clone` 市场 repo 卡死 → repo 没拉下来 → 自然列不出里面有哪些插件。所以修了 off backend 的 `-c` bug 后,这条大概率连带解决。若修完 clone 通了仍列不出,再单查市场详情页读 repo 内插件清单的逻辑(`project_marketplace_version_display`/`project_official_marketplace_seed`)。

---

# 发布关键路径（beta1，必须用户亲自做）

> 原 `TODO-beta1.md` 合并进来。代码侧 review 确认 bug 已修;剩下是当前改动收口 + 发布信息校验。

## 当前缺口（先做）

- 🔴 **收口当前未提交改动**:确认 model catalog/user override/model pool、safe-spawn/grep、TUI 消息渲染/store 这批改动是否进 beta1;若进,先跑相关测试,再 commit。
  - 建议测试:`bun test packages/core/src/model-catalog` / `bun test packages/core/src/tool-system/builtin/edit-model-catalog.test.ts` / `bun test packages/core/src/engine/model-connections-pool.test.ts` / `bun test packages/tui/src/ui/store-notify.test.ts`。
- 🟡 **todo 索引整理**:`docs/todo/README.md` 还没登记 `core-harness-and-plugin-panels.md`、`desktop-streaming-markdown-autoscroll-plan.md`、`session-cumulative-cache-usage-plan.md`;已完成的计划后续移到 `docs/archive/`。

- 🟡 **npm 包**（若本轮要发）:**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）;**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**:中/英切换走主流程,确认无未翻译泄漏 / 无 localStorage 报错。
- ✅ **Windows P8 真机冒烟**（2026-07-04 用户确认通过）:Windows 装包级检查覆盖安装/启动、marketplace/skill seed、Git/Bash、权限弹窗、终端面板、浏览器/session 隔离、模型连接、重启恢复等,未发现明显问题。关联 `project_windows_port`。
- ✅ **插件安装队列/状态可见性**（2026-07-05 已做）:main 持有安装 job registry,状态含 queued/installing/installed/failed;renderer 市场首页/详情页拉取并订阅全局安装列表。切走再回来仍显示等待/安装中/失败/已安装,失败可重试,完成后刷新插件/能力状态。
- ✅ **插件市场推荐列表**（2026-07-05 已做）:市场页新增推荐列表,默认从固定 GitHub JSON (`packages/desktop/resources/recommended-marketplaces.json`) 读取;失败时走缓存/内置推荐兜底。推荐项支持显示来源/简介/format/官方标记/插件数量(已添加时),并可一键添加。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**:① 已修(per-window `randomUUID()` nonce);② `persist:login-*` 分区只清 cookie,localStorage/IndexedDB/SW 残留 → 改非持久分区或 `clearStorageData`;③ BrowserHost phase-2 webview 收编未预留类型/未抽共享 helper。
- ⚪️ **内部浏览器 Network 可视化/请求复用 UX**:当前内置浏览器面板看不到 Network,调试网页/站点操作时只能手点 UI,很多流程本可通过抓请求后模拟更快完成。方向:给浏览器面板提供 Network 观察能力(请求列表/过滤/查看 payload/response/copy as fetch 或转工具调用),让用户/agent 可在授权上下文内复用请求而不是反复操作页面。注意隐私与凭证边界,默认只对当前 session/browser partition 可见。
- ⚪️ **JSON-Schema 导出未接线**:`schema-export.ts` 无 caller → 宿主启动写 `~/.code-shell/settings.schema.json` 或 release notes 注明不暴露。
- ⚪️ **i18n 收尾（增量）**:`"新对话"` 哨兵常量化;非 React helper 硬编码 localStorage key 应 import KEY;mobile(~149 处)单独接同套 i18n。

---

# 大路线图（beta1 不做，留存方向）

- **core 通用化 + 插件面板**（`docs/todo/core-harness-and-plugin-panels.md`,2026-07-02 全仓 review 产出）:① core=无 coding/git 预设的通用 harness——4 个内核 git 触点参数化 / harness-min preset + CI 纯度 smoke / coding pack 外移(git/lsp/review/worktree/cc-orchestrator/quota…);② 插件={UI 面板+能力}——PanelRegistry / manifest `panels` / csplugin:// 沙箱 host / 按 permissions 过滤的 scoped bridge,能力侧 v1 走自带 MCP。**Phase A(工具元数据合一,消灭「加工具改三处」+ PanelRegistry)最小可先做;面板线只依赖 A②,不被 core 改造阻塞**。与 `architecture-debt.md` P1-⑤⑥ 重叠处合并执行。
- **Workspace / Profile / 数字人**（`docs/todo/workspace-profile-讨论稿.md` v0.5）:base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。下一步 P3 seedance 手动落地。
- **Workspace 数据源绑定**（P4）:资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配。大子系统。
- **聊天软件接入（channel，参考 OpenClaw）**:微信/Telegram 做成可插拔 channel 前端。要点:① core 保持 channel-agnostic,平台接入做外部插件;② 接入做成一类凭证进 CredentialStore(微信扫码登录 token 存本地,Telegram bot token);③ 扫码微信号绑死为收发身份 + 必配 allowlist + 绑定目标 agent;④ 微信当前只私聊 + 媒体,不支持群聊。未立项。
- **工程质量 P7**:builtin tools 集成测试(已补 65 例)/ E2E / CI 覆盖率 >60% / 性能 / 文档。
  - **Electron e2e 设施**（playwright 现是孤儿依赖）:用 `_electron` API 驱动真机 app,沉淀 `verifier-electron` 基座。最小落地:`playwright.config.ts` + `e2e/`;`launchApp()` 按 title/URL 抓主窗（**别用 `firstWindow()`,会抓 DevTools 窗**）;第一个用例验浏览器面板;`package.json` 加 `test:e2e`。难点:抓错窗 / webview 嵌套需 `frameLocator` / node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。约半天。
- **Markdown 渲染一致性**（desktop/TUI）。
- **view_image TUI inline**（iTerm/kitty graphics protocol）+ 历史图降级文字摘要省 token。
- **设置/命名清理**:settings/repo/workspace 命名收口;ModelSection 1065 行深度重排。

### 明确不做（已决策，留因）

- **每轮主动请求压缩 / token 预算动态调档**:与 Anthropic prompt cache 冲突,固定 ratio 门控刻意保留。
