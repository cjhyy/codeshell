# MCP HTTP Auth / OAuth / Link Tech Design

状态: 方案稿(未动手)

## 1. 背景

CodeShell 现在已经支持 HTTP MCP 的几类底层认证字段:

- `headers`: 静态 HTTP headers, 会写入配置文件。
- `bearerTokenEnvVar`: 从环境变量读取值, 发送为 `Authorization: Bearer <value>`。
- `envHeaders`: header-name -> env-var-name, 从环境变量读取任意 header 的值。
- `credentialRef`: 从 `CredentialStore` 读取一个 token/link, 当前固定作为 Bearer token 发送。

这套能力接近 Codex 的字段模型:

- `bearer_token_env_var`
- `http_headers`
- `env_http_headers`
- `codex mcp login <server>` 的 OAuth 登录流程

但 CodeShell 是 UI-first 产品, 如果直接暴露字段名, 用户很容易把 API key 当成 Bearer token 填进去。典型问题:

- 服务要求 `x-api-key`, 用户填到 Bearer token, 结果服务返回 `Invalid token format`。
- 用户尚未登录 OAuth 服务, 测试结果只显示"连接失败", 缺少"去登录/需要认证"状态。
- `link` 凭证看起来像适合 OAuth, 但目前它不是 OAuth 会话类型, 只是一个通用链接/集成入口。

## 2. 目标

把 HTTP MCP 认证从"字段编辑"升级为"认证方式选择", 同时保持底层兼容 Codex 风格配置。

目标体验:

```text
HTTP MCP 认证方式
- 无认证
- OAuth 登录
- Bearer Token
- 自定义 API Key Header
- 高级 Headers
```

用户选择认证方式后, UI 只展示相关字段:

```text
OAuth 登录:
  状态: 未登录 / 已登录 / 已过期 / 权限不足
  操作: 登录 / 退出登录 / 重新授权

Bearer Token:
  来源: 已保存凭证 / 环境变量

自定义 API Key Header:
  Header 名: x-api-key
  环境变量名: AGIFLOW_API_KEY

高级 Headers:
  静态 headers / 环境变量 headers
```

## 3. 非目标

- 不为 Agiflow、Figma、Notion 等服务写 provider 特判。
- 不在第一期实现完整 OAuth 动态客户端注册的所有边界情况。
- 不把 OAuth token 直接伪装成普通 `link` 凭证。
- 不改变已有 `mcpServers` 配置的读取兼容性。

## 4. 现状与问题

### 4.1 当前相关文件

- `packages/core/src/types.ts`: `MCPServerConfig`, `CredentialType`
- `packages/core/src/tool-system/mcp-manager.ts`: `buildHttpHeaders()`
- `packages/core/src/credentials/types.ts`: `token | link | cookie`
- `packages/desktop/src/renderer/settings/McpSection.tsx`: MCP 设置 UI
- `packages/desktop/src/main/mcp-probe-service.ts`: MCP 探测与错误文案
- `packages/desktop/src/renderer/credentials/LinkTab.tsx`: link 集成入口, 目前是静态壳

### 4.2 当前 `link` 的真实含义

`link` 现在不是 OAuth 会话。当前注释里它更接近:

```ts
type: "link"
secret: "client id/secret 等 JSON 字符串"
meta.appUrl: "业务方 app 注册地址"
```

它适合表达"服务连接入口 / 去授权入口", 不适合保存用户 OAuth 登录后的完整会话:

```ts
access_token
refresh_token
expires_at
scope
token_type
authorization_server
resource
```

因此 OAuth 最终凭证应该新增 `oauth` 类型, UI 上可以展示在"连接/Links"里, 但数据模型上不要混成普通 `link`。

## 5. 设计方案

### 5.1 CredentialStore 增加 OAuth 类型

扩展:

```ts
export type CredentialType = "token" | "link" | "oauth" | "cookie";
```

OAuth secret 使用版本化 JSON:

```ts
interface OAuthCredentialSecretV1 {
  version: 1;
  tokenType: "Bearer";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO timestamp
  scope?: string;
  clientId?: string;
  authorizationServer?: string;
  tokenEndpoint?: string;
  resource?: string;
  discoveryState?: unknown;
}
```

OAuth credential meta:

```ts
interface OAuthCredentialMeta {
  appUrl?: string;
  provider?: string;
  accountLabel?: string;
  mcpServerName?: string;
  mcpServerUrl?: string;
}
```

### 5.2 MCP 配置增加显式认证模型

保留现有字段, 新增一个更适合 UI 的规范化层。

建议长期形态:

```ts
type McpHttpAuth =
  | { kind: "none" }
  | { kind: "oauth"; oauthCredentialRef?: string; scopes?: string[]; resource?: string; clientId?: string }
  | { kind: "bearerCredential"; credentialRef: string }
  | { kind: "bearerEnv"; envVar: string }
  | { kind: "apiKeyHeaderEnv"; headerName: string; envVar: string }
  | { kind: "advanced"; headers?: Record<string, string>; envHeaders?: Record<string, string> };

interface MCPServerConfig {
  // existing fields stay supported
  headers?: Record<string, string>;
  envHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
  credentialRef?: string;

  // new canonical shape
  auth?: McpHttpAuth;
}
```

兼容策略:

- 读取旧配置时, 根据现有字段推断 UI auth method。
- 写新配置时, 可以先继续写旧字段, 同时保存 `auth` 作为 UI 状态。
- 引擎连接时优先读 `auth`, 没有则回退旧字段。

推断规则:

```text
auth.kind exists                    -> use auth.kind
credentialRef                       -> bearerCredential
bearerTokenEnvVar                   -> bearerEnv
envHeaders has exactly one entry    -> apiKeyHeaderEnv
headers/envHeaders has many entries -> advanced
none                                -> none
```

### 5.3 OAuth 不是 `link`, 但由 Link/Connections 页面发起

建议 UI 上把"Link"逐步改名为"Connections"或"连接", 页面里有两类对象:

```text
可连接服务(Link catalog)
- Agiflow
- Figma
- Linear

已登录会话(OAuth credentials)
- Agiflow / maki@example.com / 已登录
- Figma / team-a / 已过期
```

数据上:

- `link`: 服务入口、授权入口、catalog item 或 app 注册信息。
- `oauth`: 用户登录后的 OAuth session。

这样既保留用户"OAuth 应该在 link 里面"的产品直觉, 又避免数据模型混乱。

### 5.4 MCP OAuth 服务

新增 main/core 服务:

```text
packages/desktop/src/main/mcp-oauth-service.ts
packages/core/src/services/mcp-oauth.ts
```

职责:

- `getStatus(serverName)`: 未配置 / 未登录 / 已登录 / 已过期 / 刷新失败
- `login(serverName, opts)`: 打开浏览器授权, 接收 callback, 保存 oauth credential
- `logout(serverName)`: 删除或解绑 oauth credential
- `refreshIfNeeded(oauthCredentialRef)`: 过期前刷新
- `resolveOAuthHeaders(oauthCredentialRef)`: 返回 `Authorization: Bearer <access_token>`

桌面端通过 Electron 打开系统浏览器:

```ts
shell.openExternal(authorizationUrl)
```

callback:

- 默认绑定 ephemeral localhost port。
- 未来支持用户设置固定 callback URL/port, 对齐 Codex 的 `mcp_oauth_callback_port` / `mcp_oauth_callback_url`。

### 5.5 Header 构建路径

当前:

```ts
buildHttpHeaders(serverName, config, resolveCredential)
```

问题:

- 同步函数, 不适合 OAuth refresh。
- `credentialRef` 固定等于 Bearer token。

建议:

```ts
async function resolveMcpHttpHeaders(
  serverName: string,
  config: MCPServerConfig,
  deps: {
    resolveCredential(id: string): Credential | undefined;
    refreshOAuthIfNeeded(id: string): Promise<OAuthCredentialSecretV1>;
  },
): Promise<Record<string, string>>
```

第一期可以保留 `buildHttpHeaders()` 供旧路径和测试使用, 新增 async wrapper:

```ts
async function buildHttpHeadersForConnect(...) {
  if (config.auth?.kind === "oauth") ...
  return buildHttpHeaders(...)
}
```

### 5.6 探测状态模型

不要只用 `ok | error`。UI 可以继续接收 `error`, 但 main/service 里应分类:

```ts
type McpAuthStatus =
  | "none"
  | "missing_env"
  | "needs_login"
  | "configured"
  | "rejected"
  | "forbidden"
  | "expired";
```

探测结果:

```ts
interface McpProbeResult {
  status: "ok" | "error" | "probing" | "unknown";
  authStatus?: McpAuthStatus;
  errorMessage?: string;
  errorDetail?: string;
}
```

分类规则:

```text
missing referenced env var -> missing_env
401 + oauth auth method + no oauth credential -> needs_login
401 + credentials sent -> rejected
401 + no auth configured -> needs_login
403 -> forbidden
token expired locally -> expired
```

## 6. UI 方案

### 6.1 MCP 编辑器

HTTP/SSE transport 下展示:

```text
认证方式 [select]

无认证:
  文案: 公开服务可用; 需要登录/API key 的服务请选择其他方式。

OAuth 登录:
  状态 badge
  [登录] [退出登录] [重新授权]
  scopes/resource/client id 高级折叠

Bearer Token:
  [选择已保存 token] or [环境变量名]
  提示: 仅用于 Authorization: Bearer。

自定义 API Key Header:
  Header 名
  环境变量名
  示例: x-api-key: AGIFLOW_API_KEY

高级 Headers:
  静态 headers
  环境变量 headers
```

### 6.2 MCP 列表卡片

HTTP MCP 卡片显示:

```text
agiflow   HTTP   OAuth: 未登录   需要认证
figma     HTTP   OAuth: 已登录   已连接
n8n       HTTP   Header key      已连接
```

错误区显示行动:

```text
需要认证
[登录] [编辑认证方式] [查看详情]
```

### 6.3 Credentials / Connections 页面

短期:

- `Token` tab 管 API key / Bearer token。
- `Link` tab 保持集成入口, 新增 OAuth-enabled catalog item 的"登录"按钮。
- 新增 `OAuth` filter 或 badge, 不一定新增独立 tab。

长期:

- 将 `Link` 改名为 `Connections`。
- 一个页面展示 catalog links + actual oauth sessions。

## 7. 实施阶段

### Phase 1: UI auth method 化

- MCP 编辑器增加认证方式 select。
- 继续写入现有字段:
  - Bearer credential -> `credentialRef`
  - Bearer env -> `bearerTokenEnvVar`
  - API key header -> `envHeaders`
  - advanced -> `headers` + `envHeaders`
- 探测结果分类 `authStatus`。
- 不实现 OAuth 登录, OAuth 选项先显示"即将支持"或"需要实现登录服务"。

### Phase 2: CredentialStore 支持 OAuth 类型

- `CredentialType` 增加 `oauth`。
- schema/test/renderer 类型同步。
- 凭证列表对 `oauth.secret` 做强 redaction。
- `UseCredential` 默认不直接暴露 OAuth refresh token; 只允许 MCP runtime 使用。

### Phase 3: MCP OAuth login/logout

- 新增 `mcpOAuth` preload API:
  - `status(serverName)`
  - `login(serverName)`
  - `logout(serverName)`
  - `refresh(serverName)`
- main process 打开浏览器并接 callback。
- 保存 `oauth` credential。
- MCP 连接时使用 `oauthCredentialRef` 解析 Authorization header。

### Phase 4: OAuth refresh 与多账号

- 连接前 refresh。
- 探测前 refresh。
- 支持同一个 MCP server 绑定不同 account。
- 支持 project scope override。

### Phase 5: Codex config / plugin 兼容增强

- 导入 Codex MCP 字段:
  - `bearer_token_env_var`
  - `http_headers`
  - `env_http_headers`
- 插件提供 MCP 时, user override 支持:
  - OAuth binding
  - API key header env
  - Bearer env

## 8. 迁移

不做破坏性迁移。

已有配置保持可读:

```text
credentialRef       -> Bearer Token / saved credential
bearerTokenEnvVar   -> Bearer Token / env var
envHeaders          -> Custom API Key Header or Advanced Headers
headers             -> Advanced Headers
```

如果新增 `auth`, 旧字段仍作为 wire-level fallback。

可以后续提供一次性整理按钮:

```text
Normalize MCP auth config
```

它只把 UI 状态补进 `auth`, 不删除旧字段。

## 9. 安全与隐私

- OAuth `accessToken` / `refreshToken` 不进入普通 settings JSON。
- OAuth token 必须走 `CredentialStore`, 跟现有凭证文件权限一致。
- 日志、probe detail、renderer state 禁止出现明文 token。
- `UseCredential` 不应直接返回 OAuth refresh token。
- UI 显示 scopes/resource/account, 让用户知道授权范围。
- 退出登录应删除 credential 或至少解绑 MCP server。

## 10. 测试计划

Core:

- `CredentialType` schema accepts `oauth`。
- OAuth secret parse/versioning。
- `resolveMcpHttpHeaders()`:
  - none
  - bearer credential
  - bearer env
  - api key header env
  - oauth valid
  - oauth expired + refresh ok
  - oauth expired + refresh fail

Desktop main:

- `mcp-probe-service` auth classification。
- `mcp-oauth-service` callback success/error/timeout。
- missing env var -> `missing_env`。
- 401 no auth -> `needs_login`。
- 401 with sent credential -> `rejected`。

Renderer:

- MCP editor auth method inference from legacy fields。
- Changing auth method clears stale incompatible fields。
- OAuth state renders login/logout buttons。
- Plugin-provided MCP override only exposes allowed auth supplement fields。

Integration:

- Mock HTTP MCP requiring:
  - no auth
  - Bearer
  - `x-api-key`
  - OAuth-like Bearer token
- Probe and real MCP connect use the same headers。

## 11. 开放问题

- OAuth client registration: 第一版是否只支持 server dynamic registration, 还是允许用户手填 client id?
- OAuth credential scope: 默认 user scope, 还是允许 project scope?
- Multi-account: 一个 MCP server 是否允许多个 OAuth account 并在会话里切换?
- Link 页面命名: 保留 `Link`, 还是迁移为 `Connections`?
- SDK OAuth provider: 直接用 `@modelcontextprotocol/sdk` 的 `OAuthClientProvider`, 还是自建薄封装以便 desktop callback/storage?
- Remote / mobile 场景: callback URL 是否需要走隧道?

## 12. 推荐落地顺序

1. MCP UI 先完成认证方式 select, 解决 Bearer/API key 混淆。
2. 探测结果加入 `authStatus`, 解决"未登录却显示连接失败"。
3. `CredentialType` 加 `oauth`, 但先不接真实登录。
4. 做 MCP OAuth login/logout 最小闭环。
5. 再做 refresh、多账号、插件 override 与 Connections 页面整合。
