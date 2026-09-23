# 远程 Link 的 Host 执行契约

状态：执行链、SDK 与共享 Host 授权管理／HTTP 已实现；Desktop／Hub 产品配置、回调页面和管理界面仍待接入。不能把 SDK 交换授权码
与受控服务测试视为用户可完成的完整连接流程。首批仅支持独立 Link API v1 的 GitHub
`list_repositories`、`list_issues`、`get_issue` 只读动作。

## 授权由 Host 持有

`beginRemoteLinkAuthorization({ issuer, clientId, redirectUri, clientSecret? })` 生成 S256
授权请求及私有 attempt。配置来自 Host 管理员；issuer 必须 HTTPS，开发允许回环 HTTP。
Host 只把 `authorizationUrl` 交给浏览器，不能把 attempt、verifier 或机密客户端密钥
发给页面、Agent 或日志。客户端 ID 和精确 callback 必须先在 Link 服务登记。

Host 后续授权管理层须将 attempt 绑定发起 owner、目标凭据及配置 revision，并在回调
前后复查登录和项目。`completeRemoteLinkAuthorization(attempt, callbackUrl, id, label)`
验证 state、callback 位置和重复参数，单次消费 attempt，兑换后读取实际授权账号、连接、
操作与仓库范围，返回待保存 Credential。它不自行保存：Host 必须通过 CredentialStore
条件写入，防止授权期间另一设备删除或替换连接。共享 `createLinkService` 已提供此管理层；原生／网页产品入口尚未调用它。

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
远程服务当前每页 50 项，列表 limit 最大 50；仓库列表最多 100。请求在 Host 和 Link
两端检查操作与仓库范围，返回前再次检查本地连接是否仍有效。

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
client ID、回调地址和可选 client secret；HTTP 不接受这些配置字段。当前具体产品
还没有接入配置界面／部署参数，默认不启用远程授权。

- `startRemoteAuth` 固定目标连接及其审阅版本，保存 owner、配置和私有 PKCE attempt，
  只返回公开授权 URL 和到期时间。新连接使用独立 ID，不替换已有本地连接。
- `completeRemoteAuth` 只允许原 owner 完成；交换前后、写入前检查原登录、当前登录、
  配置、到期和取消状态，并条件写入目标凭据。一次回调只进行一次兑换。
- 原登录退出、取消、服务关闭、配置变化、过期或目标连接被另一设备修改时，不得保存。
  重启不恢复私有 attempt，需重新发起授权。
- `disconnect` 先条件写入不可用状态，再撤销远端 grant，成功后条件删除本地记录。
  远端不可用时返回失败并保留禁用记录，刷新后可重试，不假报撤销成功。
- 替换授权后尝试撤销旧 grant；撤销失败在授权结果标记
  `previousGrantRevocationPending`。回调因目标变化而不能保存时，也尝试撤销新 grant。
  **这两条清理目前尚无持久重试队列**；失败需在 Link 管理端处理，不算完整恢复能力。

HTTP 入口仍受 Host 原有身份与 Origin 校验约束：

- `POST /api/v1/links/authorizations/remote`：创建授权，使用
  `providerId=github`、`methodId=remote-link`、label、可选 connectionId 和 expectedRevision。
- `POST /api/v1/links/authorizations/:id/complete`：提交 callbackUrl，由原 owner 完成。
- 原授权查询／取消接口覆盖远程 attempt；原连接快照、改名和断开接口覆盖远程连接。

快照只返回连接元数据和 issuer，不返回 client secret、下游令牌或 PKCE verifier。
原生／网页回调页面必须保留发起的 Host／项目／授权 ID，通过受认证接口提交，
不能将回调作为不受认证的保存入口。

待完成：原生／网页配置、连接与回调 UI、设置与通知、清理的持久重试、Panel 直接
调用入口、真实账号和完整四组合验收。

## 验证

Core 测试覆盖 PKCE、真实本机 HTTP、并发轮换、丢失响应不重发、重启遗留状态、移除
与在途结果、scope 缩小／禁止扩大、明确账号选择、项目隔离和令牌禁止通用读取。

跨产品冒烟使用已构建的 Core 与显式传入的独立 Link 入口：

```sh
node scripts/smoke-remote-link.mjs /path/to/codeshell-services/apps/link-server/http.mjs
```

这是独立验收器的输入，不是产品的跨仓库源码依赖。它启动真实 Link HTTP／SQLite／
OAuth 服务，完成上游测试账号连接、共享 Host 发起授权、下游 PKCE 同意、Host 条件保存、
LinkAction、刷新、服务端撤销及 Host 断开。GitHub 响应是受控夹具，真实服务商、浏览器管理流程和桌面完整体验另行验收。
