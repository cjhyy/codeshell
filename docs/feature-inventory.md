# codeshell 功能清单（desktop / tui）

> **⏱ 时效（2026-06-25 标注）**：本清单是 **2026-06-17 快照**，之后又合入 **~55 个 feat commit**，部分新能力尚未盘点进来。已知**未收录/已演进**的代表项：**统一后台面板**（按 shell/子代理/任务分组 + 实时刷新,core RPC `agent/backgroundWork`,commit `722b3642`,取代旧的只列 shell 的 BackgroundShellPanel）、**面板关闭保活 + 浏览器 5min 空闲淘汰**（PanelArea 常驻挂载 + display 隐藏,`722b3642`）。需要某子系统的**确切现状**时以**实际代码**为准;本清单作"功能广度总览"仍是最全的单一来源。
>
> 由多 agent review 自动盘点生成（2026-06-17）。三块分列：
> **Desktop 主进程**（Electron main，IPC 服务层）、**Desktop UI**（渲染进程，用户可见交互）、**TUI/CLI**（`code-shell` 终端）。
> 每项含：功能、做什么、入口（文件:行 + 触发点）、怎么使用。行号为盘点时快照，可能随代码演进漂移。

---

## 目录

- [一、Desktop 主进程（packages/desktop/src/main/）](#一desktop-主进程packagesdesktopsrcmain) — 30 项 IPC 服务能力
- [二、Desktop UI（packages/desktop/src/renderer/）](#二desktop-uipackagesdesktopsrcrenderer) — 56 项用户可见功能
- [三、TUI/CLI（packages/tui/src/）](#三tuiclipackagestuisrc) — 63 项 CLI 子命令 + slash 命令 + 交互能力

---

## 一、Desktop 主进程（packages/desktop/src/main/）

主进程不直接跑 Engine，而是作为 IPC 服务层：把渲染进程的请求转发给按需 spawn 的 core agent 子进程，并提供文件/终端/凭证/插件/记忆等系统能力。

### 运行核心与终端

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **会话/聊天运行核心 (AgentBridge)** | 把渲染进程聊天 JSON-RPC（agent/run、approve、cancel、configure、goalExtend、goalClear、backgroundShells、closeSession）经 `ipcMain 'agent:msg'` 转发给按需 spawn 的 core agent 子进程，stdout 逐行回传；每会话流事件存进 SessionSnapshotStore 供重挂载补齐；拦截 worker 的 `__browser_action__` 交浏览器自动化主机 | `agent-bridge.ts:208`（agent:msg）spawn `:110`；snapshot 重放 `index.ts:1921`（agent:subscribe） | 聊天框发消息触发 agent/run；批准弹窗=approve；停止=cancel。全经 preload `window.codeshell` |
| **交互式终端 (pty)** | node-pty 为每个 sessionId 起登录交互 shell（win 用 powershell），输出经 `pty:data`/`pty:exit` 流给渲染；256KB 滚动缓冲，重挂载回放 | `pty-service.ts:98`；IPC `index.ts:1795` pty:start / 1804 write / 1807 resize / 1810 kill | 打开「终端」面板即起 shell，像普通终端敲命令 |

### 文件系统

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **文件浏览面板 (只读 fs)** | 逐层目录/单文件读取，symlink-escape 防护（realpath 必须在 workspace root 内）、2MB 上限、二进制嗅探；fileExists 判断答案里路径可否点击 | `fs-service.ts:52`/`114`/`99`；IPC `index.ts:1815` fs:readDir / 1819 readFile / 1824 exists | 文件面板浏览目录树、点文件查看；答案里 `路径` 经 fs:exists 判断后渲染成可点链接 |
| **文件改动撤销/重做 (turn 级 undo)** | 基于 core FileHistory 快照（非 git）做轮级撤销：回滚最近一轮对话的文件编辑（删本轮新建文件），redo 再应用 | `file-history-service.ts`；IPC `index.ts:1774` turnUndoState / 1780 undoTurn / 1786 redoTurn | AI 改完文件后在 Files-Changed 卡片点撤销/重做 |
| **@-提及文件搜索** | composer 的 @ 弹窗做文件名模糊搜索：git 仓库用 `git ls-files`（尊重 .gitignore），否则递归 readdir；按 cwd 缓存 15s，子序列模糊打分 | `file-search-service.ts`；IPC `index.ts:1107` files:search | 聊天输入框打 @ 后接关键字，弹窗列匹配文件 |

### 浏览器自动化

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **浏览器自动化主机** | 把 agent 的 browser_* 工具落到真实 webview：CDP 驱动活跃浏览器面板 guest，支持 snapshot/click/type/navigate/scroll/readContent/waitForLoad/pressEnter；域名白名单 + 敏感操作（支付/删除/凭证）检测，未接审批器时 fail-closed 拒绝 | `browser-driver/automation-host.ts:56`/`78`；拦截 `agent-bridge.ts:270` | 浏览器面板打开网页（成活跃 guest），让 AI 执行浏览任务 |
| **浏览器面板 popout + 圈选锚点同步** | 打开独立浏览器弹出窗；统一元素圈选锚点 hub：主窗持每会话锚点状态并向所有 popout 广播同一标注集，popout 增删改回传父窗，发消息时一起清空 | `index.ts:1556` browser:popout / 1564~1604 anchor* | 浏览器面板点弹出按钮开独立窗，圈选元素生成锚点注入 composer |

### 会话与设置

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **会话管理** | 枚举 `~/.code-shell/sessions`（按更新时间）；删除会话目录（让 worker reap 后台 shell）；从磁盘分页列顶层（非子代理）desktop/automation 会话重建侧边栏；读 transcript、原始事件、LLM 标题 | `sessions-service.ts:24`/`61`/`105`；IPC `index.ts:1903` list / 1904 delete / 1926 titles / 1927 rename / 1945 transcript / 1949 listDisk / 1953 rawEvents | 侧边栏切换/重命名/删除会话；清缓存后自动从磁盘重建 |
| **设置读写 (user/project 两层)** | 读写 `~/.code-shell/settings.json`（user）与 `<cwd>/.code-shell/settings.json`（project），原子写（temp+rename）；经 settingsBus 热生效到运行中会话 | `settings-service.ts`；IPC `index.ts:1835` get / 1840 set / 1833 no-repo:cwd | 设置页改模型/权限/工具开关，按 scope 落文件，下条消息生效 |

### 凭证与模型

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **凭证管理 + 浏览器 Cookie 拓取** | core CredentialStore 列（脱敏）/存/删凭证；额外把 Electron 浏览器分区（persist:browser）的 Cookie 按域列出/预览，生成 Netscape cookies.txt 临时租约（0600 + 5 分钟过期清扫）供 yt-dlp/curl | `credentials-service.ts`；IPC `index.ts:1037` list / 1040 save / 1046 remove / 1052 cookieDomains / 1053 cookiePreview | 凭证页填 API key 保存；浏览器登录过的站点 cookie 可列/预览 |
| **模型目录/连接 + 元数据** | 返回合并 Catalog（内置+用户）；解析真实 maxContextTokens（settings→OpenRouter/硬表，6h 缓存）；列 provider 可用模型；返回推理控制元信息。切模型经 agent/configure 应用后才确认 | `model-meta-service.ts`；IPC `index.ts:1336` catalog:list / 1338 resolve-meta / 1343 reasoning-control / 1352 models:list | 连接页配置多实例 provider、复用 key、设默认；聊天切模型 |
| **Provider 探针（搜索/图像/MCP）** | 保存后真实验证而非只说「已保存」：搜索探针（Serper/Tavily/SearXNG）返回标题样例；图像探针真生成小图返回 base64；MCP 探针列工具数/连通性（TTL 缓存），错误友好化 | `search-probe-service.ts` / `image-probe-service.ts` / `mcp-probe-service.ts`；IPC `index.ts:1314` search:probe / 1325 image:probe / 1251 mcp:probe / 1260 mcp:listMerged | 连接/MCP 页保存后探测，显示连通状态+预览 |

### 扩展（插件/技能/市场/子代理/能力）

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **插件管理** | 枚举已装插件（名/源/skill 数/描述）；详情列 skills/commands/agents/hooks/MCP 五类；卸载、按记录源重装（更新）、`git ls-remote` 检查上游新提交 | `plugins-service.ts`；IPC `index.ts:1030` list / 1060 detail / 1066 uninstall / 1072 update / 1075 checkUpdate / 1095 install | 插件页看已装、点行看详情、卸载/更新 |
| **技能管理** | 扫描 project/user/plugin 三源；读 SKILL.md；从本地目录或 GitHub URL（先 inspect 预览→选→下 tarball）安装；卸载（仅 user/project）；检查/更新 | `skills-service.ts` / `github-skill-service.ts`；IPC `index.ts:1007` list / 1211 inspectGithub / 1221 installFromGithub / 1234 installLocal | 技能页粘 GitHub 链接预览并安装，或选本地文件夹 |
| **插件市场** | 列已知市场（名/源/插件数/格式）、加载某市场清单、用 owner/repo 或 git URL 添加/删除市场、从市场安装；git 缺失等友好提示 | `marketplace-service.ts`；IPC `index.ts:1085` list / 1086 load / 1089 add / 1092 remove | 市场页添加来源、浏览、安装 |
| **子代理(Agent)角色管理** | 列合并角色（项目内置4个 + 用户级）、读/存/删；写只动 user 级（编辑内置生成同名 user 覆盖） | `agents-service.ts`；IPC `index.ts:1122` list / 1126 read / 1194 save / 1203 delete | 子代理页查看/新建/编辑角色 |
| **能力总览开关** | 汇总工具/技能/插件/MCP/agent 启用状态并按 key 启停（写 user 级 disabled 列表） | `capabilities-service.ts`；IPC `index.ts:1008` list / 1012/1020 set/toggle | 扩展能力页逐项开关 |

### 记忆 / 自动化 / 系统

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **记忆管理** | core MemoryManager 的壳：按 level(user/project)×scope(user/dream) 列/读/存/删（含 pinned/origin）；project 级落该 repo 的 memory 目录 | `memory-service.ts`；IPC `index.ts:1864` list / 1872 read / 1881 save / 1887 delete | 记忆页查看/编辑/Pin/删除 |
| **Dream 手动整理** | 临时 seed 一个 Engine（取模型池+工具表）+ LLM client，跑一次 dream 一致性整理（去重/合并/删过期，仅写 dream scope） | `dream-service.ts:46`；IPC `index.ts:1896` memory:dream | 记忆页点 Dream/整理按钮真跑 LLM |
| **定时任务/自动化 (cron)** | 桥接 UI 到主进程 CronScheduler：列/取/创建/更新/删除/暂停/恢复/立即运行/取消运行 cron 任务（名/cron/prompt/cwd/时区/权限档）；读取前从磁盘 reload 纳入 worker 写的任务；用主进程内 headless Engine 执行，结果作 automation 会话进侧边栏 | `automation-service.ts`；IPC（cron:* 系列） | 自动化视图新建/启停/立即运行（见 UI 部分） |
| **应用更新器** | 检查/下载/安装更新，更新可用时通知渲染显示横幅 | `updater.ts` | 更新横幅点安装 |
| **图像处理** | image-probe（探测图像 provider）、image-save（保存生成的图） | `image-probe-service.ts` / `image-save.ts` | 图像生成/保存自动调用 |
| **手机遥控主机** | mobile-remote：WS 服务器让手机端 React 应用接入同一进程/消息（房间共享） | `mobile-remote/`（remote-host-manager.ts） | 设置→手机遥控配对 |
| **日志/搜索探针** | logs-service（ui-ink + engine 分桶日志）、search-probe（搜索连接验证） | `logs-service.ts` / `search-probe-service.ts` | 日志视图查看 |
| **菜单/窗口/信任/最近** | 应用菜单、窗口状态持久化、工作区信任 store、最近项目 store | `menu.ts` / `window-state-store.ts` / `trust-store.ts` / `recents-store.ts` | 自动 |


---

## 二、Desktop UI（packages/desktop/src/renderer/）

渲染进程是瘦客户端，只通过 `window.codeshell.*` 与主进程通信。导航分两层：主区**全屏视图**（viewMode）+ 右侧**面板坞**（PanelArea，与对话并存）。

### 导航与聊天

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **全局导航结构** | App 维护 viewMode（chat/sessions/approvals/runs/automation/settings_page/customize/credentials/logs）切主区全屏视图；独立右侧面板坞（tab=files/browser/review/terminal/shells/rooms）；顶栏显 repo/标题/忙碌点/面板开关；侧栏顶部入口、中部项目+会话树、底部设置 | `App.tsx:1795` setViewMode + 2437/2520 分发；`TopBar.tsx:64`；`Sidebar.tsx:200`；`panels/PanelArea.tsx:98` | 侧栏按钮或 ⌘K 切视图；顶栏右上「打开面板」开/关面板坞 |
| **对话/聊天（发送消息）** | 核心聊天界面：发消息给 agent，渲染消息流；空对话居中欢迎+输入框，有消息后输入框固定底部 | `ChatView.tsx:125`（composer）；`MessageStream.tsx`；入口 `Sidebar.tsx:202`「新对话」 | 侧栏点「新对话」或选会话→打字→Enter 发送（Shift+Enter 换行）|
| **图片附件（上传/拖拽/粘贴）** | 回形针选图、拖拽、粘贴；发送前按清晰度档压缩；非视觉模型拦截提示；缩略图点击放大 | `ChatView.tsx:898` 回形针 / 531 onChatDrop / 365 handlePaste；`compress.ts` | 点回形针/拖图/粘贴；点缩略图放大 |
| **@提及（文件/技能）** | 打 @ 弹补全浮层，提及工作区文件或已装技能，回车/Tab 插入 | `ChatView.tsx:800` MentionPopover；`chat/mention.ts` | 输入框打 @ → 上下键选 → 回车/Tab 插入 |
| **权限模式切换（PermissionPill）** | 输入框权限药丸，切本会话审批严格度（default/接受编辑/全自动/bypass），与 Goal 正交 | `ChatView.tsx:912`；`chat/PermissionPill.tsx` | 点权限药丸→下拉选挡位 |
| **Goal 模式开关** | 开启后消息当持久目标，agent 跑到完成；运行中在 TopBar 状态弹层看/清除/延长 | `ChatView.tsx:917` GoalToggle；`TopBar.tsx:156` ◎ + StatusPopover | 发消息前点 Goal 开关；运行中悬停状态点清除/延长 |
| **模型选择（ModelPill）** | 输入框右侧药丸切模型（catalog 多实例），显示上下文 token 环 | `ChatView.tsx:926` ModelPill + 925 ContextRing | 点模型药丸→下拉选 |
| **项目/分支选择（新对话时）** | 空对话时输入框下显项目选择器+本地标记+Git 分支选择器；会话开始后隐藏 | `ChatView.tsx:999` ProjectPicker + 1012 BranchPicker | 开新对话→选项目/看分支→发首条消息 |
| **停止 / 引导 / 后续变更队列** | 忙碌时：红停止中断当前轮；「引导」打断并立刻发；Enter 入「后续变更」队列（本轮后发），可预览/删/全部引导/清空；显后台子代理数 | `ChatView.tsx:960` 停止 / 941 引导 / 621 队列卡 / 885 后台提示 | 跑时点红方块停止/点引导插话/Enter 入队 |
| **AskUser 内联提问 / 内联审批** | agent 提问时在输入框上方钉选项；工具审批卡内联在消息流尾，滚出视口后显粘性审批条 | `ChatView.tsx:581`；`messages/AskUserMessageView.tsx`；`approvals/ApprovalCard.tsx` | 提问卡点选项；审批卡选范围或拒绝 |

### 搜索与命令

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **命令面板（⌘K）** | 模糊搜索：跳各视图、开关侧栏/详情、清空 transcript、搜索、开新窗口 | `shell/CommandPalette.tsx:19` + 104；`App.tsx:1991` | ⌘/Ctrl+K → 键入过滤 → 回车 |
| **跨项目会话搜索（⌘P）** | 模态跨所有项目按标题搜会话，无输入列近期，选中跳转 | `shell/SessionSearchModal.tsx:38`；`App.tsx:1994` / 2500 侧栏「搜索」 | ⌘/Ctrl+P 或侧栏「搜索」 |
| **当前 transcript 内搜索（⌘F）** | 当前会话消息流内查找，显匹配数，Esc 关 | `shell/SearchBar.tsx:14`；`App.tsx:1997` | 会话里 ⌘/Ctrl+F |

### 侧栏

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **侧栏项目管理** | 加项目(+)、展开/折叠、更多菜单（置顶/访达/重命名/归档全部对话/移除）、项目内 ✎ 新对话 | `Sidebar.tsx:228` / 109 repoMenu / 336 ProjectGroup | 「项目」+ 添加；悬停 ⋯ 菜单或 ✎ |
| **侧栏会话管理** | 会话行显标题+状态点（运行/待输入/未读）+时间/⌘1-9 标；悬停归档（二次确认）；右键重命名/复制 ID/归档恢复/删除 | `Sidebar.tsx:161` sessionMenu / 502 SessionRow；`App.tsx:2003` ⌘数字 | 点会话切换；右键菜单；⌘/Ctrl+1..9 跳转 |
| **设置入口 + 语言切换** | 侧栏底部「设置」上拉菜单：打开设置页 + 切换语言（中/英）级联子菜单 | `settings/SettingsMenu.tsx:36`；`Sidebar.tsx:289` | 点「设置」→打开设置/切语言 |

### 设置页（全屏，分组左导航）

> 入口统一：侧栏「设置」→「打开设置…」→左导航切模块。`settings/SettingsPage.tsx:148`（MODULE_GROUPS:89）

| 模块 | 做什么 | 入口 |
|------|--------|------|
| **常规 / 外观** | 常规设置 + 明暗主题 | `GeneralSection.tsx` / `AppearanceSection.tsx`（SettingsPage:205/208）|
| **配置（文本/图像连接）** | 文本模型连接面板 + 图像生成设置（清晰度档） | `TextConnectionsPanel.tsx`；`AdvancedSections.tsx` ImageSettingsSection（:211）|
| **个性化** | 指令文件、回复偏好、个性化（昵称/语气） | `AdvancedSections.tsx`（:217）|
| **键盘快捷键** | 展示/配置快捷键 | `AdvancedSections.tsx` ShortcutsSection（:224）|
| **能力总览** | 汇总所有能力 + 按项目覆盖（继承/开/关三态），点行跳详情 tab | `CapabilitiesOverviewSection.tsx`（:227）|
| **MCP 服务器** | 增删改、鉴权（bearer/env header）、按插件归组、连接探测+友好错误 | `McpSection.tsx`（:244）|
| **扩展** | 设置页内嵌插件/技能/MCP/市场 tab（无发现首页） | `ExtensionsPage`（:269）|
| **子代理** | 全局/按项目（三态）管理角色 | `AgentsSection.tsx`（:272）|
| **钩子** | 全局 + 项目级（core 拼接两层）+ 单条软开关 | `AdvancedSections.tsx` HooksSection（:247）|
| **连接 / Git** | 通用/搜索连接；Git 偏好 | `ConnectionsSection` / `GitSection`（:253/256）|
| **本地环境 + 沙箱** | 项目级环境变量（setup/cleanup/env）+ 沙箱策略 | `EnvironmentSection` / `SandboxSection.tsx`（:259-265）|
| **对话设置** | 对话相关（如自动提取记忆开关） | `ConversationSettingsSection.tsx`（:267）|
| **手机遥控** | 配对/密钥，配合手机端 React 应用 | `AdvancedSections.tsx` MobileRemoteSection（:268）|
| **记忆** | 选存储→查看/编辑/Pin/批量清理/手动 Dream/清空 | `MemorySection.tsx`（:278）|
| **已归档对话** | 列各项目归档会话，恢复/删除 | `AdvancedSections.tsx` ArchivedConversationsSection（:283）|

### 扩展全屏视图 + 凭证

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **扩展全屏视图（发现首页）** | 侧栏「扩展」开 CustomizeView：发现首页（搜索+已装概览）+ 下钻插件/技能/MCP/市场 tab | `customize/CustomizeView.tsx:15`；`extensions/ExtensionsPage.tsx:26`；`Sidebar.tsx:204` | 侧栏「扩展」→搜索/点已装数 |
| **插件 tab** | 列插件、启停（写 user disabledPlugins 级联）、git/市场安装、详情（hooks/MCP/技能枚举） | `extensions/PluginsTab.tsx`；`PluginDetailView.tsx` | 扩展页「插件」→启停/详情/安装 |
| **技能 tab** | 列技能、搜索/启停（user disabledSkills）、详情弹窗 | `extensions/SkillsTab.tsx`；`SkillDetailModal.tsx` | 扩展页「技能」→搜索/开关/详情 |
| **市场 tab** | 插件市场列表+详情，从官方/自定义 marketplace 浏览安装，显版本（短 SHA/local） | `extensions/MarketList.tsx`；`MarketDetail.tsx` | 扩展页「市场」→浏览→安装 |
| **凭证页（Cookie/Token/Link）** | 侧栏「凭证」三 tab：Cookie 登录态桥接、Permission Token、业务方 Link | `credentials/CredentialsPage.tsx:9`；`Sidebar.tsx:220` | 侧栏「凭证」→切 tab |
| **凭证-Cookie 登录态桥接** | 填 URL「在浏览器打开登陆」（独立浏览器窗登录，存 persist:browser）；列域名/预览可桥接 cookie 数；不长期明文存，AI 用时弹审批临时桥接 | `credentials/CookieTab.tsx:12` / 41 / 21 | Cookie→填 URL→登录→刷新看域名 |
| **凭证-Permission Token / Link** | 新增/保存命名 token（id/标签/URL/env 名）/Link 凭证，列出/删除 | `credentials/TokenTab.tsx:15`；`LinkTab.tsx:5` | 填 id/label/env→保存 |

### 全屏视图（自动化/运行/审批/会话/日志）

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **自动化视图（定时任务）** | 侧栏「自动化」：列任务、「新建自动化」用对话方式创建；每任务启停/立即运行/删除/编辑 prompt/看上次运行；权限档（只读/可写/完全）+ cron 频率（每天/工作日/每周/按小时/自定义）+时区 | `automation/AutomationView.tsx:252`（新建340/立即运行532/删除549/启停528/编辑606/查看744）| 侧栏「自动化」→新建/启停/立即运行/编辑/查看 |
| **运行视图（Runs）** | 列所有运行（headless/自动化产生），按状态过滤，选中看 transcript | `runs/RunsView.tsx:23`；命令面板 go.runs | ⌘K「打开 运行」或自动化「查看」 |
| **审批视图（全屏）** | 待批准队列（ApprovalCard）+ 历史（最近 50 条 approve/deny+工具/摘要/时间） | `approvals/ApprovalsView.tsx:18`；命令面板 go.approvals | ⌘K「打开 审批」 |
| **工具审批卡（范围批准/拒绝）** | 「仅本次」「本会话一直允许」+ ▾ 菜单（本项目/文件/目录路径范围）；拒绝可填原因；按操作而非工具名缓存 | `approvals/ApprovalCard.tsx:58` / 143 / 160 / 95；`approvalDecision.ts` | 点「仅本次/本会话」或 ▾ 选范围/填原因拒绝 |
| **会话视图（磁盘会话管理）** | 全屏列磁盘引擎会话（按 id/标题搜）、重命名、显大小/时间、删除、新建 | `sessions/SessionsView.tsx:11`；命令面板 go.sessions | ⌘K「打开 会话」 |
| **日志视图** | 全屏查看应用日志（ui-ink + engine 分桶） | `logs/LogsView.tsx`；命令面板 go.logs | ⌘K「打开 日志」 |

### 右侧面板坞（与对话并存）

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **文件面板** | 懒加载文件树（可隐藏/刷新），预览图片/Markdown 富文本切源码/代码带行号每行可加评论锚点（钉输入框）；文件/目录拖到输入框（图片→附件，其他→@路径）；聊天点路径链接在此定位 | `panels/FilesPanel.tsx:70`；PanelArea「+」→文件 或 ⌘⇧E | 面板坞「+」选文件→预览/评论/拖文件 |
| **浏览器面板** | 内置 webview：多标签、后退/前进/刷新、地址栏、外部打开、弹出独立窗；「圈选元素」框选加评论锚点（跨主窗/弹出窗回显）；聊天点 http 链接在此新标签开 | `panels/BrowserPanel.tsx`（493~567）；PanelArea「+」→浏览器 或 ⌘T | 面板坞「+」选浏览器→输 URL→圈选元素 |
| **审查面板（Diff）** | 全宽统一 diff：范围下拉（本轮/未暂存/已暂存/全部未提交/提交[子菜单]/分支 vs base），+/- 统计、本轮按文件过滤、刷新；对 diff 行加评论锚点 | `panels/ReviewPanel.tsx:46`；`diff/UnifiedDiffViewer.tsx`；PanelArea「+」→审查 或 ⌃⇧G | 面板坞「+」选审查→选范围→看 diff/加评论 |
| **终端面板** | 内置交互 shell（xterm.js + node-pty），每 tab 独立 shell 随会话存活；输出里路径/URL 可点（路径开编辑器，URL 开外部浏览器） | `panels/TerminalPanel.tsx:19`；PanelArea「+」→终端 或 ⌃\` | 面板坞「+」选终端→输命令 |
| **后台 Shell 面板** | 列当前会话后台 shell（Bash run_in_background）：状态点/命令/端口/退出码；点看输出（拉取式 3s 轻轮询），运行中可停止/刷新 | `panels/BackgroundShellPanel.tsx:12`；PanelArea「+」→后台 Shell | 面板坞「+」选后台 Shell→点看输出 |
| **房间面板** | 常驻 Claude Code（stream-json）房间，与手机端共享同进程：房间列表（从近期项目新建/关闭/刷新）+ 进房对话（历史+实时流+输入框）+权限徽标+运行状态 | `panels/RoomsPanel.tsx:15`；PanelArea「+」→房间 | 面板坞「+」选房间→新建选项目→进房发消息 |
| **面板坞放大/调宽/落地卡** | 拖左边缘调宽、放大覆盖输入区/还原；空坞显六类面板卡片网格 | `panels/PanelArea.tsx:259` / 192 / 292 | 拖边缘/点放大/空坞点卡片 |

### 其它

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **顶栏状态弹层** | 状态点 hover：当前工具/步数/耗时或任务列表；有活跃目标显 ◎ + 目标块 + 清除/延长 | `TopBar.tsx:112` StatusBadge；`topbar/StatusPopover.tsx` | 悬停顶栏右侧状态点 |
| **信任门 / 更新横幅 / 新窗口** | 未信任工作区弹信任门；有更新显横幅；⌘⇧N 或命令面板开新窗口 | `workspace-trust/TrustGate.tsx`；`updater/UpdaterBanner.tsx` | 信任门确认；横幅点安装；⌘/Ctrl+⇧+N |


---

## 三、TUI/CLI（packages/tui/src/）

`code-shell` 终端：bin → `dist/cli/main.js`。不带子命令直接运行=有位置参数走 headless，无参进交互式 REPL。

### CLI 子命令

| 命令 | 做什么 | 入口 | 用法示例 |
|------|--------|------|----------|
| **默认调用（positional task）** | 有 `[task]` 走 headless 单次（等价 run），无参进 REPL；`--prefill` 预填不提交 | `cli/main.ts:180-201` | `code-shell` / `code-shell "修复bug"` / `code-shell --prefill "草稿"` |
| **run（headless 单任务）** | 无界面执行单任务，参数或 stdin 管道；续接会话、写文件、退出是否等后台 agent；输出 text/json/jsonl/stream-json | `cli/main.ts:64-93`；`commands/run.ts` | `code-shell run "列TODO"` / `echo "分析" \| code-shell run` / `... --resume <id> -o json --output-last-message out.txt` |
| **repl（显式交互式）** | 显式进 Ink REPL，同默认无参 | `cli/main.ts:97-104`；`commands/repl.ts:63` | `code-shell repl -m anthropic/claude-opus-4-6 --effort high` |
| **公共选项** | run/repl/arena 共享：`-m/--model`、`-p/--provider`、`--preset`、`--base-url`、`--api-key`、`--permission-mode`、`-o/--output`、`--max-turns`、`--effort` | `cli/main.ts:49-60` | `code-shell run "任务" -m gpt-4o -p openai --permission-mode bypassPermissions --max-turns 50 --effort max` |
| **sessions（列会话）** | 列最近会话：ID/时间/状态/模型/轮数 | `cli/main.ts:108-127` | `code-shell sessions -n 20` |
| **arena（多模型评审擂台）** | agent 先收集相关代码上下文，多模型就主题讨论/评审/规划；`--models` 指定，`--mode review\|discussion\|planning`（可自动检测） | `cli/main.ts:131-161`；`commands/arena.ts:48` | `code-shell arena "评审认证模块" --models claude,gpt4o,deepseek --mode review` |
| **runs（长任务管理）** | list/get/submit/resume（--input/--approve/--reject）/cancel/events/recover | `commands/runs.ts:76`；注册 `main.ts:165-166` | `code-shell runs submit "重构X" --tag wip` / `runs list -s running` / `runs resume <id> --approve` / `runs events <id> -n 50` / `runs recover` |
| **plugin（CLI 插件管理）** | 从本地目录或 git（github:/https/ssh/@ref #subdir）安装、列出、按源更新（--force）、卸载；兼容 CC + Codex | `commands/plugin.ts:12`；注册 `main.ts:170-171` | `code-shell plugin install github:org/repo --name myplugin` / `plugin update myplugin --force` / `plugin uninstall myplugin` |

### slash 命令（REPL 内）

**模型 / 凭证 / 配置**

| 命令 | 做什么 | 入口 | 用法 |
|------|--------|------|------|
| `/help` | 列全部 slash 命令（Core/Git/Context/Config/Advanced 分组）| `ui/App.tsx:1471`；`registry.ts:128` | `/help` |
| `/model` · `/m` | 无参开 Ink 模型选择器，带 key 直接切 | `core-commands.ts:122`；`ModelSelector.tsx`；`App.tsx:831` | `/model` / `/model gpt4o`（Alt+M 也可） |
| `/models` | 模型管理面板：列/切/同步 OpenRouter 目录/管理 arena 参与者/增删 provider·model/统一添加向导 | `extra-commands.ts:142`；`ModelManager.tsx`；`App.tsx:940` | `/models`（Tab/↑↓/Enter，q/Esc 退） |
| `/login` · `/logout` | login 带 key 直接保存热加载，不带开 onboarding；logout 清空 model/models/providers/arena/activeKey | `extra-commands.ts:13` / 54 | `/login sk-xxxx` / `/login` / `/logout` |
| `/effort` | 设/查推理 effort（low\|medium\|high\|max） | `core-commands.ts:74` | `/effort high` |
| `/permissions` · `/perm` | 查/切权限模式（default/acceptEdits/dontAsk/bypassPermissions/auto/plan）；`rules` 列生效规则 | `permissions-command.ts:17` | `/permissions` / `/permissions plan` / `/permissions rules` |
| `/config` | show 打印全部设置；get 取点路径值；set 改（JSON 解析） | `core-commands.ts:690` | `/config show` / `/config get model.name` / `/config set model.temperature 0.5` |
| `/features` | 只读列引擎解析后的 feature flags | `features-command.ts:11` | `/features` |

**状态 / 工具 / 用量**

| 命令 | 做什么 | 入口 | 用法 |
|------|--------|------|------|
| `/cost` | token 用量与成本；`stats` 汇总，`detail` 细分 | `core-commands.ts:32` | `/cost` / `/cost stats` / `/cost detail` |
| `/status` | 模型/effort/权限/会话/CWD/工具数/git/token/成本；`env` 环境；`doctor` 诊断 | `core-commands.ts:553` | `/status` / `/status env` / `/status doctor` |
| `/tools` | 列当前可用工具及数量 | `core-commands.ts:255` | `/tools` |
| `/skills` | 列 project/user/plugin 三类 skill | `extra-commands.ts:155` | `/skills` |
| `/plugin` | REPL 内插件市场管理：marketplace add/remove/list、install/uninstall、list | `extra-commands.ts:200`；`plugin-handler.ts` | `/plugin list` / `/plugin marketplace add <url>` / `/plugin install foo@official` |
| `/mcp` | 列已配置 MCP 服务器（名/transport/command·url），无配置给示例 | `extra-commands.ts:112` | `/mcp` |

**会话 / 上下文 / 记忆**

| 命令 | 做什么 | 入口 | 用法 |
|------|--------|------|------|
| `/memory` · `/memories` | 跨会话持久记忆：list/add/delete/edit/clear（软删 memory-trash）/open | `core-commands.ts:271` | `/memory list` / `/memory add user_role 后端工程师` / `/memory clear` |
| `/compact` | 立即压缩上下文，报压缩前后 token | `core-commands.ts:360` | `/compact` |
| `/session` · `/sessions` · `/sid` | session 显当前；list 列最近；tag 打标；resume 提示恢复；sid 单打当前 ID（运行中也可用） | `core-commands.ts:197` / 180 | `/session list` / `/session tag wip` / `/sid` |
| `/resume` | 无参开 Ink 会话选择器（过滤空会话），带数字/查询词匹配恢复并重建记录 | `core-commands.ts:388`；`SessionPicker.tsx`；`App.tsx:847` | `/resume` / `/resume 2` / `/resume 重构` |
| `/export` | 导出 transcript 为 markdown（默认，含 sidecar）或 json | `core-commands.ts:651`；`export-md.ts` | `/export` / `/export json` |
| `/clear` · `/exit` · `/quit` · `/version` | 清空记录 / 退出 / 版本 | `core-commands.ts:19` / 26 / 638 | `/clear` / `/exit` / `/version` |
| `/init` | 据 cwd 选 improve/migrate/create/empty，LLM 生成/改进 CODESHELL.md 并注入上下文 | `init/index.ts:95`；`init/detect.ts` | `/init` |
| `/tasks` · `/goal` | tasks 显多步任务列表；goal 设持久目标并执行，goal 看当前，goal clear 清除 | `core-commands.ts:88`；`goal-command.ts:19` | `/tasks` / `/goal 让所有测试通过` / `/goal clear` |
| `/image` · `/img` | 读本地图片 base64 暂存到下条消息；无参列暂存，clear 清空；支持多路径/引号 | `image-command.ts:96` | `/image ./shot.png` / `/image "a b.png" c.jpg` / `/image clear` |

**Git / 评审**

| 命令 | 做什么 | 入口 | 用法 |
|------|--------|------|------|
| `/diff` · `/commit` · `/branch` | diff 显 git diff（截断）；commit 用模型生成 message 提交（或 -m）；branch 列/建/切（--create） | `core-commands.ts:532`；`git-commands.ts:24,97` | `/diff` / `/commit` / `/commit -m "fix"` / `/branch feature-x --create` |
| `/review` | git diff 做 P0-P3 结构化评审；`[file]` 限定、`--json`、`--dimensions=...`、`--staged` | `git-commands.ts:128` | `/review` / `/review src/auth.ts --dimensions=security --staged --json` |
| `/security-review` · `/sec` | 待提交 diff 安全评审（注入/越权/硬编码密钥/XSS/路径穿越），给 file:line+严重度+利用+修复 | `more-commands.ts:60` | `/security-review` |
| `/pr-comments` · `/autofix-pr` | 经 gh 拉 PR 评论；autofix 拉后让 agent 逐条修复（需 gh） | `git-commands.ts:185` / 212 | `/pr-comments 123` / `/autofix-pr <PR-url>` |

**文件 / 变更 / 实用**

| 命令 | 做什么 | 入口 | 用法 |
|------|--------|------|------|
| `/files` | 列 cwd 文件（可带 pattern），最多 50，find 经 argv 安全调用 | `more-commands.ts:13`；`list-files.ts` | `/files` / `/files *.ts` |
| `/release-notes` · `/changelog` · `/whatsnew` | 显 CHANGELOG/CHANGES/HISTORY.md，无则回退 git log -20 | `more-commands.ts:30` | `/release-notes` |
| `/log` · `/logs` | 当天日志，按 sid/turn/cat 过滤限条数；显耗时/token/工具/决策/错误 | `extra-commands.ts:217` | `/log 50` / `/log sid <id>` / `/log cat llm` |
| `/undo` | 基于 FileHistory 撤销：撤最近一轮文件改动，all 撤整会话；先预览 diff，confirm 才执行 | `utility-commands.ts:41` | `/undo` / `/undo confirm` / `/undo all confirm` |
| `/copy` | 复制最后一条 assistant 回复到剪贴板（pbcopy/clip/xclip） | `utility-commands.ts:9` | `/copy` |
| `/update` | 检查新版本，提示退出时自动装或手动 npm install | `utility-commands.ts:197` | `/update` |
| `/fullscreen` | 全屏（alt-screen+ScrollBox）与流式（终端 scrollback）切换 | `utility-commands.ts:169`；`fullscreen-mode.ts` | `/fullscreen` / `/fullscreen on\|off\|toggle` |
| `/feedback` · `/bug` | 反馈+模型/会话/平台写入 `~/.code-shell/feedback/feedback.jsonl` | `more-commands.ts:127` | `/feedback 输入框塌陷了……` |
| `/hooks` · `/voice` | 占位/未实现（提示） | `utility-commands.ts:160`；`advanced-commands.ts:8` | `/hooks` / `/voice` |
| **插件自带 slash 命令** | 已装插件命令动态注册为 `/<name>`，body（$ARGUMENTS/{args} 替换）暂存为下条消息上下文，Enter 提交 | `plugin-commands-registration.ts:34`；`App.tsx:101` | `/<插件命令> 参数` 然后回车 |

### 交互能力（Ink REPL）

| 功能 | 做什么 | 入口 | 怎么用 |
|------|--------|------|--------|
| **onboarding 向导** | 无 API key 且 TTY 时 REPL 前弹向导配 provider/模型/key；非 TTY 报错退 | `commands/repl.ts:90-114`；`OnboardingPrompt.tsx` | 首次运行自动进，或 `/login` |
| **退出打印用量/费用** | 退出时若有消耗，stderr 输出成本汇总 | `cli/main.ts:240-245` | 跑完自动显示 |
| **Slash 自动补全 + 用法提示** | 输入 / 弹可过滤下拉（↑↓/Tab·Enter/Esc），补全后空格显参数提示 | `CommandInput.tsx:92-197` | 敲 / 触发 |
| **输入历史导航** | 非命令态 ↑/↓ 浏览历史；打断时回退最后一条 | `CommandInput.tsx:117-137`；`input-history.ts` | ↑/↓ 翻历史 |
| **Vim 模式输入** | Normal/Insert/Visual/Command + 基本 motion；Esc 入 Normal | `vim-mode.ts:38` | Esc 进 Normal 用 vim 动作 |
| **运行中排队输入 + /force 插队** | 运行中输入缓存（显「已缓存 N 条」），本轮后依次发；`/force` 立即打断优先发；运行中 /sid·/help 仍可用 | `App.tsx:1425-1467`；提示 1941 | 运行中直接输入排队；`/force <text>` 插队 |
| **中断/取消（ESC / Ctrl+C）** | ESC 仅取消主查询（后台 agent 继续），保留流式文本标 [Request interrupted]；Ctrl+C 取消主查询+所有后台 agent，空闲时退出 | `App.tsx:1056-1141` | 运行中 ESC 取消；Ctrl+C 取消全部/退出 |
| **权限审批对话框** | 危险工具弹 y/n，可选 once/session/project（仅本次/会话规则/写 settings） | `PermissionPrompt.tsx`；`App.tsx:1672-1695` | 弹窗选允许/拒绝及作用域 |
| **AskUser 提问对话框** | agent 经 `__ask_user__` 提问，渲染文本输入或多选（header/multiSelect） | `AskUserPrompt.tsx`；`App.tsx:1915-1933` | 输入答案或勾选 |
| **Transcript 只读浏览（Ctrl+O）** | Ctrl+O 切只读，↑↓ 在条目间移光标高亮；Esc 取消，再 Ctrl+O 返回 | `App.tsx:1173-1202` | Ctrl+O 进，↑↓ 选，Ctrl+O 退 |
| **聊天滚动** | 全屏滚轮逐行/PageUp·Down 翻页；有未读显「N 条新消息」气泡跳底部；流式模式走终端原生 | `App.tsx:1159-1168`；`FullscreenLayout.tsx` | 滚轮/PgUp·PgDn；点气泡跳最新 |
| **Shift+Tab 循环权限模式** | 非运行态 Shift+Tab 在 plan→normal→bypass 循环，底部 ModeIndicator 显示 | `App.tsx:1087-1102` / 2237 | 按 Shift+Tab |
| **子代理 Dock + 详情切换** | 底部 AgentDock 显运行中/刚完成后台子代理；输入框空 ↓ 进 dock，↑↓ 选，Enter 看 transcript 详情，Esc 返回 | `App.tsx:993-1037` / 1955；`AgentDock.tsx` | 输入框空 ↓ 入 dock |
| **后台子代理完成自动注入** | 完成后在主 agent 空闲、输入框空、无弹窗时自动作新一轮注入，系统行显摘要 | `App.tsx:1404-1423` | 自动 |
| **状态栏 + 上下文用量条** | 底部显模型/effort/token/成本/会话+上下文占用条（>60%黄 >80%红）；运行中 spinner+动词+耗时+流式 token | `StatusLine.tsx:36`；`ContextUsageBar.tsx:13`；`SpinnerWithVerb.tsx` | 常驻显示 |
| **启动横幅 + 更新 + 欢迎提示** | 启动显 Banner（模型/effort/maxTurns/cwd）、UpdateBanner、首启 WelcomeTips | `App.tsx:1628-1634`；`Banner.tsx` 等 | 启动自动 |
| **输出格式渲染（headless）** | run/默认任务按 -o 选 text/json/jsonl/stream-json | `cli/output/renderer.ts` | `code-shell run "任务" -o stream-json` |
| **REPL 内置 cron 调度** | REPL 启动恢复已存 cron 并绑一次性 headless Engine（只读+沙箱按任务分级），定时触发 | `commands/repl.ts:232-259` | cron 任务后台按计划运行 |

---

## 附：本次 review 修复的 bug

详见 git 分支 `fix/desktop-tui-review-bugs`（commit `2b9c0e37`）。修复 9 个对抗验证确认的 bug（agent worker spawn 卡死 / cancel 漏清审批 / provider 默认值覆盖 / 损坏 settings 致设置页全挂 / settings 写竞态 / listDisk 同步阻塞 / runs parseInt / vim 越界与光标 / cookie lease 碰撞 / git ls-files 无超时），全部配回归测试。core 1408 + tui 69 + desktop main 252 测试通过。
