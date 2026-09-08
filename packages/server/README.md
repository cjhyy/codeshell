# @cjhyy/code-shell-server

CodeShell 服务端传输与管理服务（纯 Node、零 Electron）：mobile remote 的 HTTP/WS host、配对、passcode 门、tunnel、rooms、上传，供 Desktop Web 与 Hub 共用的配置/会话/文件/Link 服务，以及 **个人 Hub Web host（`code-shell-serve`）**。

完整的原生 Node.js 安装、模型配置、管理员初始化、systemd 后台运行、HTTPS 和备份步骤见 [服务端部署指南](../../docs/deployment.md)。

## 聚焦入口

宿主代码应选择职责最窄的稳定入口：

| 入口                                     | 职责                                                              |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `@cjhyy/code-shell-server/storage`       | 磁盘 Session、附件暂存、图片探测和稳定 client-message ID          |
| `@cjhyy/code-shell-server/worker`        | 与传输无关的 stdio worker 生命周期和行协议桥接                    |
| `@cjhyy/code-shell-server/mobile-remote` | 配对、访问门禁、rooms、上传、LAN/tunnel host 和移动端协议类型     |
| `@cjhyy/code-shell-server/serve`         | Headless HTTP/WebSocket host 与 `code-shell-serve` CLI 组合默认值 |
| `@cjhyy/code-shell-server/desktop-web`   | 设备配对换 Cookie、已知 Workspace 校验与共享管理 HTTP API         |
| `@cjhyy/code-shell-server/links`         | Link 目录、连接管理、设备授权及受限 HTTP handler                  |

```ts
import { listDiskSessions } from "@cjhyy/code-shell-server/storage";
import { RemoteHostManager } from "@cjhyy/code-shell-server/mobile-remote";
import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
```

包根入口保留 storage、worker、mobile-remote、serve 和 desktop-web 的兼容导出；
Link 使用独立 `/links` 入口。新消费方应避免根入口，以免只使用 storage
或 transport 时也求值无关的宿主组合。

`/storage`、`/worker` 和 `/mobile-remote` 没有 Coding/Web 静态导入。外部
Agent 策略由产品宿主通过 `ResidentAgentOptions.appendSystemPrompt` 注入。
`/serve` 则是有意保留的开箱即用产品入口：CLI 被调用时解析 Coding stdio
worker 和已构建的 Web app。

## 两种宿主，共用浏览器工作台

`packages/web/app/Workbench.tsx` 组合对话、模型、Skills、MCP、历史、文件及 Link 页面。
Hub 的 `App` / `useHubController` 提供管理员认证后的状态与操作；Desktop 的
`DesktopApp` 使用原有 `useRemoteApp` 和设备协议，驱动原来的 Desktop Worker。
Desktop Web 不会创建第二个 Hub Worker，也不需要再建 Hub 管理员。

`createDesktopWebApi` 将配对设备换成短期 HttpOnly Cookie，用于同一套受限 HTTP
管理服务。宿主注入已知 Workspace 解析、运行门禁和热更新回调；业务服务复用
`hub/` 与 `/links` 实现。Electron 原生 renderer 仍使用原来的 IPC。
具体文件与环境差异见 [共享 Web 工作台](../../docs/todo/shared-web-workbench.md)。

## code-shell-serve — 个人 Hub Web host

在任意机器上把一个 workspace 变成浏览器可访问的 CodeShell：

```bash
# 构建（repo 内，先按部署指南安装依赖）
bun run build:server

# 启动
node packages/server/dist/bin/code-shell-serve.js \
  --cwd ~/work/my-repo \
  --port 8790 \
  --data-dir ~/codeshell-data
```

首次启动会打印带 `#setup=` 的管理员初始化链接。创建管理员后，可在 Web「设置 → 模型与连接」添加连接并选择默认模型，也可以预先准备 Workspace 的 `.code-shell/settings.local.json`。没有可用模型时 HTTP 健康检查和配置界面仍可使用，对话需要先完成模型配置。

当前 Web 工作台提供：

- 对话、Markdown/代码/表格、模型提供的思考内容、工具结果、子任务、附件、审批与停止；刷新时恢复已保存历史和有界的当前运行事件。
- 会话搜索、重命名、归档/恢复、Markdown/JSON 导出；Workspace 文件列表、文本/图片预览和认证下载。
- 模型连接增删改、默认/辅助模型选择和真实连接测试；项目 Skills 增删改、启停、GitHub 预览安装/更新；MCP 配置、启停、工具权限和临时连接探测。
- 独立 Link 页面：token 验证连接、重命名/断开、绑定宿主已登录 CLI，以及配置了应用 client ID 的 GitHub/GitLab 设备授权。
- 单管理员登录、设备撤销、手机布局和 PWA 页面外壳。

浏览器可以连接远端 Hub；Desktop 开启的 Web 可访问桌面已知项目，独立 Hub 固定一个 Workspace。Electron 原生窗口的远端执行目标、Hub 多 Workspace、团队账号隔离、插件市场和远程 Panel Host 仍属后续范围。

### 架构

```text
浏览器 SPA（packages/web dist-app）
   │  HTTP /api/v1/* + WS /ws（管理员 Session Cookie 与 Origin 校验）
headless serve（本包 serve/）
   │  stdio line-JSON-RPC（WorkerBridgeCore：按需 spawn、崩溃记账）
agent-server-stdio worker（Core 入口 + Coding 能力包）
```

- 浏览器使用受限的 Core 协议投影：serve 自己处理会话列表/详情，只允许向 worker 转发 `agent/run`、`agent/approve`、`agent/cancel`，并在转发前校验 Workspace 与 Session 归属。配置通过专用认证 HTTP 接口修改；任意配置 RPC 和 Workspace 切换不对 Web 开放。
- 每个 tab 的请求 ID 会在 host 内重写，响应只回到发起 tab；`agent/streamEvent` 等通知才广播给所有已认证 tab，避免多 tab 使用相同本地 ID 时串包。
- 默认使用 Hub 单管理员初始化、登录与可撤销 Session Cookie；`--auth passcode` 保留旧共享口令模式。当前只支持单用户、单 Workspace。
- 默认只绑 `127.0.0.1`；远端可用 SSH 转发或 HTTPS 反向代理。HTTPS 部署需通过 `--public-url` 或对应环境变量配置实际公开 Origin，不能只改监听地址。
- 会话持久在 serve 独占的 Worker data root（默认 `<data-dir>/worker`）；重启后可恢复列表与已保存历史，不会自动继续被中断的任务。活动运行缓冲有上限，超过后明确退回持久历史。
- Server 与 Desktop 复用 Core 引擎、SettingsManager、Skills 管理及会话数据逻辑；共享的 `web` 库负责浏览器可用的消息投影。工具、MCP 和 Skill 脚本在服务端执行。桌面窗口、钥匙串、IPC 和 Panel Host 不随 Web 部署迁移。

### Hub HTTP 接口分组

这些是当前 Web 使用的受限接口，不是多租户 Gateway。除初始化、登录及健康检查等公开入口外，要求有效管理员登录；浏览器请求还受 Origin 校验。

| 路径                         | 用途                                               |
| ---------------------------- | -------------------------------------------------- |
| `/api/v1/auth/*`             | 初始化、登录/退出、登录状态及 `/sessions` 设备管理 |
| `/api/v1/uploads/:browserId` | 当前登录 Session 所属的受限附件暂存                |
| `/api/v1/configuration/*`    | 模型连接、默认值和配置摘要                         |
| `/api/v1/skills/*`           | 项目 Skill 管理与 GitHub 安装/更新                 |
| `/api/v1/mcp/*`              | MCP 配置、继承、启停和连接探测                     |
| `/api/v1/sessions/*`         | Workspace 内会话查询、标题、归档与导出             |
| `/api/v1/files/*`            | Workspace 内文件列表、预览和下载                   |
| `/api/v1/links/*`            | Link 连接、CLI 状态/绑定及设备授权                 |

审批快照、设备 lease 和运行流通过 `/ws` 协议交换。配置写入 Workspace 本地层，任务运行期间拒绝修改（409），空闲保存后通过 Core 热更新用于下一次任务。列表和详情不返回已保存的模型密钥或 MCP 敏感值。模型测试会发送一次可能计费的请求；MCP 测试只连接及列工具，stdio 测试会启动配置的程序。完整的功能边界与限额见部署指南。

Link 新连接写入宿主用户级 `CredentialStore`，不会放入模型配置的 `credentials[]`。
Web 只绑定已经登录的 CLI，不接受任意命令或启动交互式登录。token 与设备授权在验证后保存，
写入前重新检查发起者和连接版本；注销、设备撤销及关闭服务取消未完成操作。
断开绕过运行忙碌门禁，以便 Core 凭证订阅取消活跃 LinkAction。
当前 Link OAuth 过期需重新授权，没有自动续期或云端 Link Server；多设备共用一个宿主用户的连接。

### CLI 参数

| 参数            | 默认                  | 说明                                                                                    |
| --------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `--cwd`         | 当前目录              | worker 的 workspace 根                                                                  |
| `--port`        | 8790                  | 监听端口                                                                                |
| `--host`        | 127.0.0.1             | 监听地址                                                                                |
| `--auth`        | hub                   | `hub` 管理员认证或 `passcode` 旧模式                                                    |
| `--public-url`  | 根据监听地址生成      | 浏览器实际访问的根 Origin，也可用 `CODE_SHELL_SERVE_PUBLIC_URL`；非 loopback 要求 HTTPS |
| `--passcode`    | 旧模式下自动生成      | 显式传入会默认选择 passcode 模式，不能与 `--auth hub` 同用                              |
| `--data-dir`    | `~/.code-shell/serve` | 认证数据与隔离 Worker 数据根；设置 `CODE_SHELL_HOME` 时默认改为其下的 `serve`           |
| `--static-root` | 自动解析 web dist-app | 覆盖静态资源目录                                                                        |
| `--debug-logs`  | 关闭                  | 包含可能带任务正文的 Worker 诊断，仅写入私有日志                                        |

### Web 客户端开发

先运行本地 Hub（后端默认 8790），再启动 Vite。开发时把 Hub 的公开 Origin 设为实际 Vite 地址，例如 `--public-url http://127.0.0.1:5173`；Vite 代理 `/api` 和 `/ws` 到 `127.0.0.1:8790`。浏览器始终使用该 Vite Origin 登录和访问：

```bash
bun run --cwd packages/web dev:app --host 127.0.0.1 --port 5173 --strictPort
```

Docker 部署到其他机器见 [Docker 部署说明](../../docs/docker-deployment.md)。默认宿主机端口为 8791，可与原生 Node.js 服务并行。

更新 Hub 后需重建并重启服务。Desktop Web 的入口构建到 `packages/desktop/out/mobile`，
还依赖新的主进程 HTTP 接线，因此必须重新构建 Desktop 并重启应用；只更新 Hub 的 `dist-app`
或刷新旧桌面的浏览器页面不会完成升级。
