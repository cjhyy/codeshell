# 远程 Link 的 Host 执行契约

状态：Host 与独立 Link 已实现现有全部 10 个 provider、26 个动作的远程执行契约，
包括授权、资源选择、下游令牌轮换、撤销与断开。Core／Server 和独立服务的 production
模块已通过受控上游 HTTP 验证；Hub、配对 Web、Electron 云端窗口、原生 Desktop 和
Docker 的既有 GitHub 授权流程已有实际程序验收。真实第三方账号、其他 provider 的
生产应用配置和全部端到端登录仍待逐家验收，不能用 fixture 结果替代。

| Provider | 现有远程动作                                                         | 必须明确选择的资源             |
| -------- | -------------------------------------------------------------------- | ------------------------------ |
| GitHub   | 仓库、README、文件、Issue 列表／详情、PR 列表／详情、创建 Issue（8） | 仓库                           |
| GitLab   | 项目、分配给当前用户的 Issue（2）                                    | 项目                           |
| Sentry   | 组织、组织中的项目（2）                                              | 组织                           |
| Vercel   | 项目、部署（2）                                                      | 安装所属账号／团队中的项目     |
| Slack    | 频道、最近消息（2）                                                  | 频道                           |
| Notion   | 搜索、页面属性（2）                                                  | 页面／数据库                   |
| Linear   | 分配给当前用户的 Issue、团队（2）                                    | 团队                           |
| Todoist  | 项目、任务（2）                                                      | 项目                           |
| Airtable | Base、表结构（2）                                                    | Base                           |
| Figma    | 文件摘要、评论（2）                                                  | 用户输入并经上游验证的文件 key |

服务仅发布已配置的 provider。Host 取远端 catalog 与编译内静态 adapter 的交集；未知
provider、动作、额外 scope、含糊资源组或错误授权机制均不能扩大执行权限。旧 API v1
的 GitHub 三个只读动作仍兼容，缺少 catalog 的 404／501 仅回退到这三个动作。

不同授权方式已接入首版通用 UI，见 [Link 授权 UI 通用化方案](todo/link-authorization-ui-unification.md)。
Desktop 与 Hub Web 共用授权 controller 和步骤视图，Host 提供统一任务及步骤提交 API；
Token、CLI 会话、设备码和全部 10 个 provider 的远端网页授权已有适配器。扫码和追加验证码目前仅有
公共视图，不作为生产连接能力发布。独立 Link 服务 `a9923817` 已于 2026-10-08 更新线上实例。

## 授权由 Host 持有

`beginRemoteLinkAuthorization({ issuer, clientId, redirectUri, clientSecret? })` 生成 S256
授权请求及私有 attempt。配置来自 Host 管理员；issuer 必须 HTTPS，开发允许回环 HTTP。
Host 只把 `authorizationUrl` 交给浏览器，不能把 attempt、verifier 或机密客户端密钥
发给页面、Agent 或日志。客户端 ID 和精确 callback 必须先在 Link 服务登记。

Host 后续授权管理层须将 attempt 绑定发起 owner、目标凭据及配置 revision，并在回调
前后复查登录和项目。`completeRemoteLinkAuthorization(attempt, callbackUrl, id, label)`
验证 state、callback 位置和重复参数，单次消费 attempt，兑换后读取实际授权账号、连接、
操作与资源组范围，返回待保存 Credential。它不自行保存：Host 必须通过 CredentialStore
条件写入，防止授权期间另一设备删除或替换连接。共享 `createLinkService` 已提供此管理层，Hub／配对 Web 和原生桌面入口均已接入。

保存的记录为 OAuth 类型，`linkExecutionBackend=remote`、`linkExecutionRuntime=server`、
`agentExposable=false`。凭据存储沿用 Host 的 cipher：Desktop 使用主进程密钥；其他 Host
沿用既有存储策略，不宣称所有 Node Host 都自动提供密文存储。第三方原始 token 永远
留在独立 Link，Host 保存的是下游受限访问／刷新令牌。

## 执行与选择

`LinkAction` 支持 `connectionId`。同一服务保存多个连接时必须明确选择，包括其中一个
已失效的情况；不能因为远程连接不可用而自动换成本地账号。查询结果按连接提供可用
动作。已有单连接本地动作、CLI 绑定、项目凭据隔离继续有效。

Node Host 通过 CredentialAccess 在本进程执行远程动作；Desktop worker 通过
`desktop/remoteLinkAction` 把连接 ID、grant ID、动作和业务参数交给主进程，只收数据。
通用凭据读取、Shell 环境和 MCP bearer 解析不能取出这类令牌。返回数据标记为外部
不可信内容，不作为指令。

动作沿用本地参数／输出形状：仓库列表包装为 `repositories`；Issue 列表使用
`owner/repo` 参数、排除 Pull Request、包装为 `issues`；单条 Issue 使用 `issue_number`。
其他 provider 保留各自的 `projects`／`channels`／`results` 等包装，不冒用仓库字段。
授权元数据包含 provider、账号、`actions`、`<provider>:<action>` scopes 及唯一的
`resourceGroups: [{ id, items: [{ id, label }] }]`；GitHub 另保留旧 `repositories`。
Host 每次执行前检查 token scope、保存的 capability 和静态动作交集，按 provider
规范化资源 ID、验证参数，再次过滤列表；返回前复查账号、grant、资源组和连接状态。

资源发现最多 10 页／1000 项，同意页最多选择 100 项。动作保留各自的有界 limit：
Slack 最近消息最多 15 条、频道最多 200，Linear 最多 50，其他多数列表最多 100。
截断结果返回 `truncated`／`has_more`；当前不提供跨多个已选资源的复合 cursor 续页，
不能把上游某一个资源的 cursor 用到聚合列表。GitHub 保留 API v1 的 `page` 兼容。
创建 GitHub Issue 同时要求独立写 scope 和每次操作的用户批准；写请求不会自动重试。

## 轮换、重启和撤销

刷新前通过 CredentialStore CAS 持久写入 `refreshing`。同一进程的并发调用共享一次
刷新，其他进程不能重复发送；更新成功后先保存新令牌，再继续动作。令牌 scope 只能
缩小。刷新响应丢失、无效或网络失败会留下 `reconnect`，必须重新授权；Host 在刷新中
退出后留下的 `refreshing` 也不能自动重放。

OAuth 请求使用 Node 单次 HTTP 发送，不使用可能在连接中断时自动重发 POST 的 fetch。
请求不跟随重定向，具有超时和响应大小限制；错误使用固定消息，服务端响应正文不进入
错误提示。连接在刷新或数据读取期间被移除时不能复活或返回结果。Link 服务端撤销导致
401 后，Host 将连接标记为需要重新授权。

## 共享 Host 授权管理

`createLinkService` 的 `remoteLink` getter 是受信任的 Host 配置入口，提供 issuer、
client ID、回调地址和可选 client secret；HTTP 不接受这些配置字段。Hub 通过部署参数
接入，缺省不启用远程授权。

- `startRemoteAuth` 固定目标连接及其审阅版本，保存 owner、配置和私有 PKCE attempt，
  只返回公开授权 URL 和到期时间。新连接使用独立 ID，不替换已有本地连接。
- `completeRemoteAuth` 只允许原 owner 完成；交换前后、写入前检查原登录、当前登录、
  配置、到期和取消状态，并条件写入目标凭据。一次回调只进行一次兑换。
- 原登录退出、取消、服务关闭、配置变化、过期或目标连接被另一设备修改时，不得保存。
  重启不恢复私有 attempt，需重新发起授权。
- `disconnect` 先条件写入不可用状态，再撤销远端 grant，成功后条件删除本地记录。
  远端不可用时返回失败并保留禁用记录，刷新后可重试，不假报撤销成功。
- 新令牌返回后、读取账号／授权信息之前，先保存私有清理记录。授权不能完成时，
  即使账号信息读取失败，也有记录供后续撤销。此记录不是可用连接。
- 保存新连接、移除其临时清理记录、保留被替换的旧 grant，使用同一次凭据文件原子
  条件写入。目标已变化时不替换旧连接，未采用的新授权进入撤销队列。
- 清理失败保留记录并退避重试；授权结果以 `previousGrantRevocationPending` 提示，
  快照只返回 `remoteCleanupPending` 数量，原生／Web 页面显示待清理状态。

### 遗留授权的持久清理

私有记录存入同一凭据文件的独立记录类型，不进入普通 list、resolve、脱敏列表、
环境变量或 Agent 凭据选择。整个记录内容使用 Host 注入的凭据 cipher；桌面沿用
safeStorage，Headless 的默认策略仍是权限为 0600 的明文存储，不能因此宣称云端已加密。
旧版凭据存储会将这个未知类型原样保留，普通凭据修改不会删除清理记录。

每个运行中的 Link 服务启动时及之后每 30 秒扫描，每轮最多处理 8 条。失败退避从
30 秒递增至最多一小时，重启保留退避；跨窗口／进程领取记录使用同一文件锁和 60 秒
租约，旧领取者不能确认删除新领取者的记录。外部 HTTP 请求不持有文件锁。撤销是幂等
操作：租约过期、响应丢失后允许重试，不承诺网络层恰好调用一次。

尚在授权中的新令牌保留到 attempt 到期后一分钟再允许后台领取；正常完成时原子采用，
失败／取消时立即转为待清理。领取会跳过当前凭据域仍在使用的相同 grant／令牌，
已经被领取或丢失清理记录的新授权不能再保存为可用连接。普通断开仍保留原有语义：
撤销失败时保留禁用连接，用户刷新后重试断开。

桌面在安装凭据 cipher 后即启动清理，不依赖打开 Link 页；Web／Hub 在相应 Host
服务运行时处理。电脑关闭或项目执行环境停止期间不会发起请求，后续启动继续。
密钥不可用、记录无法读取或客户端已撤销时保留记录，需恢复密钥／配置或在 Link 管理端处理。

边界：Host 根本未收到可解析令牌、取得令牌后尚未来得及落盘即硬崩溃、或者磁盘拒绝
写入，均不能保证存在可恢复记录；存储失败时仅尝试即时撤销，并报告授权失败。
不能将网络与本地磁盘解释为一个分布式原子事务。这类结果不明的授权可在 Link 管理端撤销。

HTTP 入口仍受 Host 原有身份与 Origin 校验约束：

- `POST /api/v1/links/authorizations/remote`：创建授权，使用
  `providerId`（10 个静态 provider 之一）、`methodId=remote-link`、label、可选 connectionId 和 expectedRevision。
- `POST /api/v1/links/authorizations/:id/complete`：提交 callbackUrl，由原 owner 完成。
- 原授权查询／取消接口覆盖远程 attempt；原连接快照、改名和断开接口覆盖远程连接。

快照只返回连接元数据和 issuer，不返回 client secret、下游令牌或 PKCE verifier。
原生／网页回调页面必须保留发起的 Host／项目／授权 ID，通过受认证接口提交，
不能将回调作为不受认证的保存入口。

## Hub 部署与浏览器流程

在独立 Link 中登记下游应用，准确回调为 `https://你的工作台域名/link/callback`。
Hub CLI 支持以下环境配置；实际值放在部署私密配置中：

```sh
CODE_SHELL_REMOTE_LINK_ISSUER=https://link.example
CODE_SHELL_REMOTE_LINK_CLIENT_ID=registered-client-id
# 机密客户端可另外配置 CODE_SHELL_REMOTE_LINK_CLIENT_SECRET；公开客户端使用 PKCE。
code-shell-serve --auth hub --public-url https://hub.example --cwd /workspace
```

配置缺少 issuer／client ID、使用不安全地址或没有明确 public URL 时启动失败，错误不
回显输入。SDK 的 `startHeadlessServer` 和 `startProjectControlServer` 接受 `remoteLink`；
公开 `/links` 入口导出 `remoteLinkHostConfiguration` 和 `remoteLinkFromEnvironment`。
`--runtime docker` 将配置加入已有项目私密挂载文件，默认不加入 Docker 命令或环境列表。
项目配置改变后，先停止项目再启动；运行中的旧容器不会静默换配置。所有项目使用同一
工作台回调地址，浏览器另行保存准确项目路由，不需要为每个项目注册一个回调 URL。
可选客户端密钥从普通 Agent worker 和 Panel Agent worker 环境中剔除。

浏览器在 Link 页选择“通过 Link 添加账号”，填写名称后前往授权。首次连接直接进入
相应 provider 登录和授权，随后明确选择资源并审阅请求范围，不需要注册或登录 Link，也不需要
管理员密码。回调页立即清除地址栏中的授权码，通过原工作台登录完成授权；返回时仍打开
原项目的 Link 页。多个远程账号和本地连接可同时存在，远程连接支持改名、重新授权和断开。
拒绝授权会取消原私有 attempt。回调请求结果不明时仅提供查询，不重复提交授权码。

Link 的用户授权会话与管理后台会话独立，用户只能授权本会话经 GitHub 验证的账号。
服务端已有连接及管理员登录不会赋予用户访问其他账号的权限。用户会话最长 30 分钟，
有效期内可复用已验证账号；“使用其他 GitHub 账号”会重新进入 GitHub 验证。
管理员密码仅用于服务部署后的客户端登记、连接管理和撤销，不出现在普通连接流程中。

支持 `browserHandoff: 1` 的 Hub 通过短期单次 ticket 打开授权页，原工作台保留登录和轮询，
不依赖 sessionStorage，也不向系统浏览器传递 owner cookie。独立浏览器回到 Host 的公开
`/link/callback` 后，Host 使用发起时捕获的 owner、项目、私有 PKCE attempt 和任务 ID 完成
授权；每次重新检查原登录、配置、连接 revision 和项目租约。授权码只兑换一次，结果页面
重定向到不含 code/state 的 `/link/authorization-result`。授权期间关闭、退出或取消不能保存。
新 project gateway 为兼容旧 private runtime 提供同一 broker；private runtime 本身不声明公共回调能力。

缺少此能力的旧 Host 仍使用原浏览器导航。其 sessionStorage 只存授权 ID、state、到期时间和 Host／项目路由，不存令牌或 PKCE
verifier；读取后移除。普通工作台启动不依赖 sessionStorage，可用性受限的旧浏览器会在
授权流程给出明确错误。回调页面不绕过身份校验，换登录或原登录撤销后需要重新授权。

## 桌面云端窗口和配对 Web

Electron 云端窗口只将自身 Host origin 的 `/link/authorize?ticket=...` 单次入口交给系统
浏览器，不创建内嵌 OAuth 窗口。云端工作台保留原页面和登录；系统浏览器既没有 Desktop
preload，也不获得云端 owner cookie。Figma 等不支持嵌入式浏览器的 provider 因此使用正常
系统浏览器授权。票据、state 和私有 attempt 最长十分钟，过期或原权限失效后不能兑换。
旧 Host 的兼容导航仍限制为配置 Link origin、静态允许的十家 provider HTTPS 登录域名、
匹配 provider 的 `/oauth/upstream/<provider>/callback` 和原 Host 回调；其他弹窗及外部导航继续拦截。

配对 Web 使用不同的注册回调：`https://你的电脑远程域名/mobile/link/callback`。
在 Desktop 主进程启动环境设置：

```sh
CODE_SHELL_REMOTE_LINK_WEB_ORIGIN=https://desktop.example
CODE_SHELL_REMOTE_LINK_ISSUER=https://link.example
CODE_SHELL_REMOTE_LINK_CLIENT_ID=registered-desktop-web-client
```

`WEB_ORIGIN` 必须是实际访问电脑的稳定 HTTPS origin，不能带路径或从请求头推断。
精确移动端回调须先在 Link 登记，建议为配对 Web 单独登记公开 PKCE 客户端。
未配置该 origin 时不启用配对 Web 远程授权。普通局域网 HTTP 地址不支持 OAuth 回调；
本机回环 HTTP 仅用于开发。现有公网隧道地址改变后必须同步注册回调和部署配置；
此接入本身不提供稳定设备目录或中继地址。

移动端入口在建立新的配对 HTTP 会话之前处理回调，使用发起时已有 cookie 和项目
路由完成授权。回调仅访问保存的授权 ID／workspace，成功后返回 `/mobile/` 的原工作区。
设备被撤销后拒绝完成，不能换成新登录代为提交。返回管理工作区时若当前聊天仍属于
另一个工作区，发送会明确拒绝，需选择本项目会话或新建任务。独立 Link 的客户端密钥
也从桌面普通 Agent 和配对 Web Panel Agent 的子进程环境中剔除。

授权提交已经保存临时状态后，Link 编辑器清除自己的未保存提示再跳转；其他草稿的
离页保护保持生效。回调记录无效时，配对页面返回 `/mobile/`，不会跳到不存在的根首页。

## 原生桌面 Link 管理

原生凭证页的 Link 标签将独立服务连接统一放在“服务器连接”中。GitHub 卡片点击
“连接”即在系统浏览器进入 GitHub 网页授权，无需预先填写连接名称或登录 Link；随后选择允许访问的
仓库，授权完成后自动保存并显示账号。
“管理”弹窗提供添加账号、改名、重新授权和断开，服务地址收在“服务详情”中。
本地 CLI／Token 连接继续可用；保存多个连接时必须明确选择，失效后不自动换账号。
GitHub 原始凭据留在 Link，原生页面只收到脱敏快照及授权结果。

Desktop 主进程启动环境可配置：

```sh
CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN=http://127.0.0.1:43827
CODE_SHELL_REMOTE_LINK_ISSUER=https://link.example
CODE_SHELL_REMOTE_LINK_CLIENT_ID=registered-desktop-client
```

在 Link 为原生桌面登记公开 PKCE 客户端和精确回调
`http://127.0.0.1:43827/link/callback`。主进程在打开系统浏览器前绑定该回环 HTTP 地址，
只监听 `127.0.0.1`，不开放局域网端口。回调 origin 来自受信启动配置，当前原生桌面入口
固定使用 `http://127.0.0.1:43827`；不能带路径。端口被其他进程占用时明确报错，
不会改用未登记的端口。未设置 `DESKTOP_ORIGIN` 时不启用新增原生授权。

原生桌面和配对 Web 回调地址不同，需分别登记。当前两个入口共享该进程的
`CLIENT_ID`；同时启用时，在同一个公开 PKCE 客户端中登记两个准确回调。若分开部署，
可各自使用单独客户端。不要把单一回调的原生客户端直接当作配对 Web 客户端使用。

系统浏览器沿用用户自己的浏览器登录态，GitHub 登录、二次验证与 SSO 由服务商网页完成；
CodeShell 不读取浏览器 Cookie，也不再用内置窗口拦截这些网页导航。共享回调接收器按
每次授权的 state 路由到原窗口和工作区。回调只接受准确 Host、路径和合法 GET 参数，
未知 state 不消费其他任务；Host 继续验证 owner、state、PKCE、期限和连接版本。
只有 Host 验证并保存成功后，网页才显示完成，并激活原 CodeShell 窗口。

授权绑定发起窗口和已授权工作区；在 CodeShell 取消、超时、刷新或关闭主窗口会取消流程，
移除相应回调路由；最后一个任务结束后关闭监听。关闭系统浏览器标签页本身不会发送取消，
仍可在 CodeShell 取消或重新打开同一授权页面。
请求在准入前被取消也不会迟到打开浏览器。改名和断开使用版本校验；重新授权替换旧
授权，断开先撤销远端。桌面通用凭据写入／删除及旧 MCP OAuth 入口拒绝改动远程 Link
记录，避免绕过撤销流程；此限制不等同对所有 Core／Agent 修改入口的全局审计。

待完成：部署服务仓库采用兼容公开包、
可视化配置与通知、
Panel 直接调用入口、真实账号和完整四组合验收。

## 验证

Core 测试覆盖 PKCE、真实本机 HTTP、并发轮换、丢失响应不重发、重启遗留状态、移除
与在途结果、scope 缩小／禁止扩大、明确账号选择、项目隔离和令牌禁止通用读取。

跨产品冒烟使用已构建的 Core 与显式传入的独立 Link 入口：

```sh
node scripts/smoke-remote-link.mjs /path/to/codeshell-services/apps/link-server/http.mjs
```

全部 provider 的跨仓验收使用：

```bash
node scripts/smoke-remote-link-providers.mjs /path/to/codeshell-services/apps/link-server/http.mjs
```

它调用构建后的 Core／Server、独立服务真实 HTTP／SQLite／OAuth 和 production provider
模块，只有官方上游 HTTP 响应由合成 fixture 提供。覆盖 10 次逐家授权、全部 26 个动作、
10 次下游轮换、资源选择、跨 provider 拒绝、撤销和 Host 断开；不读取真实凭据，也不
宣称第三方账号验收完成。官方 OAuth 配置及账号验收必须另行记录。

这是独立验收器的输入，不是产品的跨仓库源码依赖。它启动真实 Link HTTP／SQLite／
OAuth 服务，完成上游测试账号连接、共享 Host 发起授权、下游 PKCE 同意、Host 条件保存、
LinkAction、刷新、服务端撤销及 Host 断开。GitHub 响应是受控夹具，真实服务商和桌面完整体验另行验收。

`node scripts/smoke-remote-link-web.mjs /path/to/codeshell-services/apps/link-server/http.mjs`
使用已构建 Web、真实 Node Hub 和独立 Link，在 390／1440px Chromium 完成授权、回调、
返回连接列表、断开以及拒绝授权，并核对服务端 grant 撤销。
可追加 `electron` 验证实际桌面的隔离云端窗口和系统浏览器交接。测试只替换 OS 浏览器
启动器为独立 Chromium，核验不新增 Electron OAuth 窗口、系统浏览器拿不到 owner cookie、
不能访问 Hub 的认证 API、干净回调后原工作台轮询完成、断开撤销和拒绝授权。Web 的
390／1440px 使用实际弹出页完成同一交接。上游 OAuth 仍是受控响应，未验证真实 provider 登录。
追加 `paired` 验证实际 Desktop 的配对 Web（390px、原工作区返回、错误
项目回调和设备撤销拒绝）。配对测试将隔离测试进程的网络接口枚举置空以采用已有回环
回退，不打开 LAN 监听，也不修改用户真实项目或网络设置。它不代替真实公网隧道、物理
手机、真实服务商或实际 Docker 项目授权验收。

追加 `native` 验证生产 Electron 的原生凭证页、系统浏览器打开入口、本地回调和真实独立 Link。
测试无需 Link 登录、管理账号隔离、两个不同的受控账号、改名、重新授权、拒绝、取消、主窗口刷新、通用凭据及旧
OAuth 入口拒绝绕过、断开后远端全部授权撤销。上游账号仍为夹具，不代表真实 GitHub。

为 `smoke-remote-link.mjs` 追加 `desktop-retirement`，可验证真实独立 Link 授权留下
私有清理记录后，启动生产 Electron、不进入任何 Link 页面即完成远端撤销并移除记录。

### 实际 Docker 项目验收

在 Docker Desktop 运行、已构建当前服务和项目镜像的机器上执行：

```sh
node scripts/smoke-docker-link.mjs /path/to/codeshell-services/apps/link-server/http.mjs codeshell-project-runtime:local
```

需要 OpenSSL、Node 和已安装的 Playwright Chromium。验证器启动原生 Node 控制服务、
两个真实隔离项目容器、独立 Link 和临时 HTTPS 代理。项目镜像仅额外信任本次公开
测试证书，通过 `host.docker.internal` 访问 Link；**没有关闭容器 Node 的 TLS 校验**。
浏览器用本地解析规则和测试证书例外访问这套夹具，不能替代真实域名及公开 CA 验收。
此脚本针对 Docker Desktop；普通 Linux 的真实部署应使用正常可解析、可验证的 Link 域名。

390px 浏览器完成授权、回调和返回原项目；错误项目回调拒绝，另一项目的连接列表为空，
容器内公开 LinkAction 工具不能用另一项目的连接访问服务。原项目调用真实 Link 只读
接口取得受控上游结果，停止／重启后保持同一连接，断开后 Link grant 确认撤销。
工作台顶栏持续显示当前项目和执行位置，切换项目同步更新。

清理只处理本次安装标签匹配的容器／网络／卷及唯一的临时证书镜像，移除测试密钥、
数据库和控制配置，仅保留浏览器截图。基础项目镜像保留。测试不会读取真实 GitHub
凭据或模型配置，不代表真实 GitHub、物理手机、Agent 模型调用或公网部署完成。
