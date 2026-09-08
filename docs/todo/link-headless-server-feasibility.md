# Link 在 Desktop Web 与 headless Hub 中的实现

状态：2026-09-08。原核验于 2026-09-06 发现的 Worker 凭证接线缺口已修复；当前源码还提供两种 Web 共用的 Link 管理界面与纯 Node 服务。部署与操作入口见 [Node 部署说明](../deployment.md#link-连接)，双宿主结构见 [共享 Web 工作台](shared-web-workbench.md)。

## 当前链路

```text
HubLinks（两种 Web 共用）
  → 受限 /api/v1/links HTTP API
  → createLinkService（目录、验证、保存、设备授权与取消）
  → Core CredentialStore / provider 验证器
  → Core LinkAction（实际操作、权限审批、凭证变更时取消）
```

Hub 的 HTTP 入口检查管理员 Cookie 与 Origin；Desktop facade 检查配对设备换取的 Cookie、Origin 和桌面已知 Workspace。授权等待绑定到发起设备的登录 Session。读取结果只含账号摘要、状态和能力，不返回 token、refresh token、原始 secret metadata 或私有 device code。

| 共享位置                                        | 职责                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/link/src/`                            | 服务商 manifest、授权说明及浏览器安全的管理展示类型                       |
| `packages/server/src/links/catalog.ts`          | 将 manifest 与 Core 已实现的 provider/action 对齐                         |
| `packages/server/src/links/service.ts`          | token / CLI / 设备授权、连接状态、版本校验、owner 与生命周期管理          |
| `packages/server/src/links/http.ts`             | 有界 JSON、固定路由、身份复查和脱敏错误                                   |
| `packages/server/src/links/device-oauth.ts`     | 从 Desktop 提取的 GitHub/GitLab 设备授权 broker                           |
| `packages/core/src/credentials/`                | 可注入 cipher、CredentialStore、原子 compare-and-swap、凭证访问和变更订阅 |
| `packages/core/src/links/`                      | 固定服务商验证、CLI / HTTP 执行、LinkAction 与审批                        |
| `packages/desktop/src/main/link-connections.ts` | 保留 Desktop 验证和交互登录行为，复用共享保存服务                         |

Desktop 原有 catalog 与设备授权模块保留薄 re-export；原生窗口的 token / CLI 保存也走共享服务。Web 和 Desktop 没有再各写一套 provider REST 客户端。Link 包仍是元数据与展示契约，未变成一个云端服务。

## Web 支持的操作

| HTTP 路径                     | 操作                        |
| ----------------------------- | --------------------------- |
| `GET /api/v1/links`           | 服务商及脱敏连接快照        |
| `POST /connections/token`     | 按服务商验证 token 后保存   |
| `POST /connections/cli`       | 绑定当前宿主已经登录的 CLI  |
| `PATCH /connections/:id`      | 重命名连接                  |
| `DELETE /connections/:id`     | 断开连接                    |
| `GET /providers/:id/cli`      | 检查安装与登录状态          |
| `POST /authorizations/device` | 发起 GitHub/GitLab 设备授权 |
| `GET /authorizations/:id`     | 查询发起者自己的授权状态    |
| `DELETE /authorizations/:id`  | 取消授权                    |

表中除首行外均相对于 `/api/v1/links`。写入携带已审阅的 `expectedRevision`；新建使用 `null` 表示只能创建，编辑/删除使用具体版本，避免较慢的验证覆盖另一台设备的新凭证。输入不接受任意 URL、CLI 参数或秘密元数据。

token 验证和 CLI 绑定完成后、进入宿主写入门禁后、最终落盘前都会复查身份与版本。设备授权支持显式取消、设备撤销和宿主关闭；即使外部验证器较晚返回，也不能在取消后继续写入。普通配置修改需要宿主空闲；断开允许在任务运行中进行，以便 Core 终止仍依赖该连接的操作。

## 凭证与执行环境

“本地 Link”中的本地指执行宿主。Desktop Web 使用桌面电脑的 CLI、网络和凭证；Node Hub 使用运行服务的系统用户；Docker Hub 使用容器环境。手机或浏览器所在电脑的 CLI 登录态不会自动提供给宿主。

新建连接写入宿主用户级 `$HOME/.code-shell/credentials.json`；项目级既有连接可查看但 Web 不修改。Link 连接不是模型配置中的 `credentials[]`，也不是 MCP 配置。当前产品仍是一个宿主用户的连接集合，不提供每个浏览器账号独立的凭证库，也不承诺按对话手选多个同服务商账号。

Core 的加密接口一直可注入，未依赖 Electron：

- Desktop 主进程安装系统加密适配，Worker 通过 IPC 的凭证访问接口取得所需凭证。
- Hub 为 stdio Worker 显式设置 `CODE_SHELL_CREDENTIAL_ACCESS=local`，使用本地凭证访问。纯 Node 默认使用权限为 `0600` 的本地明文存储，不依赖系统钥匙串。
- 本地凭证访问订阅用户/项目文件变化；Desktop 通过原凭证快照订阅通知。断开或更换正在使用的连接会让活跃 LinkAction 取消，HTTP 请求和 CLI 子进程遵循其取消信号。

Desktop 加密文件不能直接复制到另一个系统后当作可用凭证；应在目标宿主重新连接。Docker 默认将 `/data/home` 持久化，Link 文件随 `/data` 卷保存；各 CLI 的登录配置需按其实际路径保留。

## OAuth 与云端服务边界

2026-09-08 新需求已确认：另设独立 Link Server，同时作为第三方 OAuth 客户端和面向
CodeShell/外部应用的 OAuth 授权服务器，按连接、操作及数据范围授权取数。见
[双向 OAuth 架构与实施阶段](link-server-oauth-architecture.md)。下面仍描述当前宿主实现，
新增服务尚未实现或部署。

GitHub/GitLab 设备授权分别读取宿主环境变量 `CODESHELL_GITHUB_APP_CLIENT_ID` 与 `CODESHELL_GITLAB_OAUTH_CLIENT_ID`。它们需要相应应用配置，不是 Hub 登录账号，也不是用户 token。Web 显示服务商授权地址与用户代码，由宿主轮询并保存验证后的授权结果。

**当前没有 Link 自动 OAuth 续期。** 服务快照按 `expiresAt` 标出过期状态，Core LinkAction 不会使用已过期的 OAuth token；用户需要重新授权。保留 refresh token 的存储结构不等于已实现自动刷新。Core 的通用 MCP OAuth 流程也不等于 Link 已接入该刷新流程。

仓库内没有另一个可直接部署的 Link Server；manifest 中的 server / managed-oauth 方式仍为规划状态。当前 token、CLI 与设备授权均由 Desktop 或 Hub 宿主直接处理，不应称为云端托管授权服务。团队多账号仍需统一实现 Worker、凭证目录、CLI HOME 与权限隔离，不能只在 HTTP 请求上增加用户 ID。

## 验证与发布边界

相关测试使用临时目录、本机假 provider 和模拟设备 broker，覆盖脱敏、原子版本冲突、项目只读、取消/撤销/关闭后的晚返回、设备授权归属、OAuth 过期拒绝执行，以及原 Desktop catalog / device OAuth 行为。真实 Node stdio 子进程回归覆盖本地与 IPC 两种凭证路径；没有借此声称完成真实外部账号授权验收。

2026-09-06 的最初问题是 stdio Worker 无条件替换为 IPC 凭证访问，而 headless 没有相应 Desktop 应答者。该历史缺口现已修复，不再要求带外写凭证才能使用 Web Link。

这些是当前源码能力。Desktop 和 Hub 的构建已通过，本机 8790 已升级到共享工作台与 Link；运行中的旧桌面应用仍需重启才能加载新主进程。实际验收见 [打磨记录](hub-usability-polish.md)。
