# Desktop Web 与独立 Hub 共用工作台

状态：2026-09-09，当前源码实现说明；本轮面板运行能力增量已构建并更新到本机 Hub。部署操作见 [Node.js](../deployment.md) 和 [Docker](../docker-deployment.md)；多用户规划仍见 [Hub 架构](codeshell-hub-remote-service-architecture.md)。

## 共用范围

桌面端开启的 Web 和独立部署的 Hub 运行同一个 `packages/web/app/Workbench.tsx`。导航、对话消息、输入框、草稿保护，以及模型、Skills、MCP、历史、文件、面板和独立 Link 页面均从这里组合。原来的桌面 mobile 入口现在只加载 `DesktopApp`；Electron 原生 renderer 仍保留原来的界面和 IPC，不要求一起替换。

| 边界       | Desktop 开启的 Web                                         | 独立 Hub                                       |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------- |
| 浏览器入口 | `/mobile/` → `DesktopApp`                                  | 站点根目录 → `AuthGate` → `App`                |
| 状态适配   | `useRemoteApp` 驱动 Desktop controller                     | `useHubController` 使用 `ProtocolClient`       |
| 对话传输   | 既有设备配对与 mobile-remote 协议                          | 管理员 Cookie 与受限 `/ws` RPC                 |
| 执行进程   | 既有 `AgentBridge` 和 Desktop Worker，不为 Web 再建 Worker | `WorkerBridgeCore` 管理独立 Core/Coding Worker |
| 工作区     | 桌面项目与会话中已知的目录，由宿主再次解析                 | 启动时固定的 `--cwd`                           |
| 管理接口   | `createDesktopWebApi` 挂在既有远程监听器                   | Headless host 挂载相同业务 handler             |
| 用户身份   | 已配对设备，代表当前桌面用户                               | 一个管理员，可有多个登录设备                   |

共享 UI 不要求先统一两种 WebSocket 协议。`WorkbenchController` 提供浏览器视图需要的状态与动作；Desktop 特有项目、room、Pet、目标等控件由 adapter 注入，不写进 Hub 的执行逻辑。

## 认证与同一 Worker

Desktop Web 在既有配对成功后，用设备凭据向 `/api/v1/desktop/session` 换取短期 HttpOnly Cookie，供管理 HTTP 接口使用；它不创建 Hub 管理员账号。接口同时检查 Origin、Cookie、磁盘中的设备信任和桌面已知 Workspace。撤销设备会取消关联连接探测与授权；关闭远程服务会清理 Cookie 和服务实例，重新启动不会恢复旧 Cookie。

Hub 则持久保存管理员与登录设备，HTTP 和 WebSocket 都按 Hub 身份认证。两种身份策略都只向浏览器开放受限操作，不提供任意路径、任意配置 RPC 或任意 CLI 参数接口。

Desktop 的配置保存经过 `AgentBridge.withWebConfigurationMutation`，与桌面及远程任务共用运行门禁，空闲时向原 Worker 发送 `agent/configure` 的 `reloadModels` / `reloadSettings`。Hub 使用相同 Core 热更新机制更新其 Worker。保存会通知在线页面；不需要为了日常配置写入杀掉 Worker。热更新失败会明确报错并阻止使用不确定配置开始新任务，重新保存或重启宿主后恢复。

## 共用业务服务

| 功能   | 共用实现与数据边界                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 模型   | Server `hub/configuration` 与 Core `SettingsManager`；写 Workspace 本地配置层，API 不返回已保存的密钥                              |
| Skills | Server `hub/skills-management` 与 Core `internal/skills`；项目文件增删改、完整 GitHub Skill 目录预览/安装/更新，用户及插件来源只读 |
| MCP    | Server `hub/mcp-configuration` 与 Core 客户端；配置、启停、继承和临时探测，命令在宿主执行                                          |
| 历史   | Server `hub/session-management`、共享会话标题存储和历史投影；Desktop 使用原会话目录，Hub 使用自己的 Worker 数据目录                |
| 文件   | Server `hub/files`；只读 Workspace 浏览、预览和下载，路径与敏感文件过滤共用                                                        |
| Link   | Server `links`、Link 包的展示类型和 Core 验证/执行；token、CLI 绑定与设备授权共用管理流程                                          |

Link 新连接为宿主用户级凭证，同一用户下各 Workspace 共用；连接更改广播到该宿主的在线页面。断开连接允许运行中执行，Core 凭证订阅会终止仍使用该连接的 LinkAction。验证、设备授权等待和最终写入都检查发起者及已审阅版本，取消或过期操作不会在稍后悄悄落盘。细节见 [Link 服务端说明](link-headless-server-feasibility.md)。

面板管理和浏览器运行服务也由两种宿主共用，支持 GitHub 审阅安装、更新、项目绑定和打开。运行实例可以续租而不重载 iframe，通过事件轮询交付进程输出、任务状态和工具调用。进程查找、启动与取消、受控目录和文件下载、独立 `agent.task`、面板工具注册与回调均已接入；主 Hub 会话调用面板工具的完整链路已回归。可执行文件和任务内部审批由可信父页面确认，面板不能自行批准。

具体能力以宿主返回的 `availableMethods` 为准。媒体、音频、Cookie、自动化和 PDF 等尚未完整接入，进程确认也不代表完整操作系统沙箱。可用范围与环境依赖见 [Web 面板](../web-panels.md)。

## 保留的环境差异

下一阶段的独立 Link Server 已确定为双向 OAuth 服务：集中管理第三方连接，并向 CodeShell
和其他应用授予有限的数据访问权；两种 Web 共用 Link 管理体验。此设计尚未实现，详见
[Link Server 架构](link-server-oauth-architecture.md)，不改变下面的当前实现边界。

- 工具、Skill 脚本、MCP 和 Link CLI 都在当前宿主执行：Desktop Web 指桌面电脑，Hub 指服务器，Docker 指容器。浏览器所在手机或电脑不会提供其本地程序和登录态。
- Desktop 保留系统钥匙串、Electron IPC、窗口和 Panel 集成；Hub 使用纯 Node 存储与进程能力。Web 管理服务不会让这些系统集成自动跨主机迁移。
- 独立 Hub 当前仍是单管理员、单 Workspace，未实现多用户 Runtime/凭证/CLI HOME 隔离。多账号是后续宿主控制面的工作，无需再复制一套工作台 UI。
- Electron 原生窗口选择远端 Hub、云端 Link Server、Link 自动 OAuth 续期、插件市场和完整原生 Panel SDK 的 Web 适配尚未实现。

## 构建与上线状态

Hub 执行 `bun run build:server` 后重启服务，Docker 重新构建镜像并保留卷重建容器。Desktop 源码安装依赖并构建工作区后，还需执行 `bun run --cwd packages/desktop build`，重新启动桌面应用再开启 Web 访问；只刷新手机页面不能升级旧 Desktop 主进程。

2026-09-08 本机 `127.0.0.1:8790` 已完成备份、重建和重启，正在提供共享工作台与 Link 的新构建。原有账号、工作区、凭据和会话文件的校验值保持不变；因隔离验收早期的同主机 Cookie 冲突，原浏览器需重新登录。Desktop 主进程、preload、renderer 和 mobile 构建均通过，运行中的桌面应用需重启才能加载新主进程。完整证据见 [验收记录](hub-usability-polish.md)。

2026-09-08 的五个官方面板安装/绑定、基础 Web 运行及 Docker 验收已完成。2026-09-09 新增的续租、进程、独立任务、工具回调和目录下载已构建并重启到 `http://127.0.0.1:8790`。原有账号和五个面板绑定保留；升级前 165 个文件已私有备份，工作区、配置与安装文件中的 164 个文件保持不变，认证文件仅更新登录 sessions。

本地 `yt-dlp` 已使用合成素材走通获取信息、下载和文件落地；Mimi 当前历史仅在本次打开期间显示，重开归零。真实浏览器已打开授权目录并显示文件链接，文件 HTTP 内容与原始素材一致，尚未点击浏览器保存下载。live Mimi 已完成初始化并显示本地工具就绪，旧的进程与 Agent Task 缺失提示消失，Cookie 限制仍保留；未在真实账号中触发模型请求或用户媒体下载，不据此宣称外站或全部下载场景通过。最终 Server/Web 构建、Desktop 构建和 11 个工作区类型检查均通过，分轮证据见 [Web 面板验收记录](web-panels-validation.md)。
