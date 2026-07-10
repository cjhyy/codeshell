# MCP HTTP OAuth 登录 / 刷新闭环技术方案

日期：2026-07-10  
体量：M  
范围：HTTP/SSE MCP 使用的 OAuth 登录、刷新、撤销与 Bearer 注入闭环；不改变普通 token/link/cookie 凭证语义。

## 1. 问题与现状

### 1.1 已经具备的能力

1. OAuth 已是正式凭证类型。`CredentialType` 已包含 `"oauth"`，secret 已能保存
   `accessToken`、`refreshToken`、`expiresAt`、`tokenEndpoint`、`clientId`、
   `clientSecret`，公开元数据也已有授权端点、scope 与 `lastRefreshAt` 的位置：
   `packages/core/src/credentials/types.ts:6`、`:8-29`、`:82-100`。
2. `packages/core/src/credentials/oauth.ts:47-150` 已实现 secret 解析、临期判断、公开状态摘要和
   refresh request 构造。临期窗口默认 60 秒（`:3`、`:86-94`），因此“何时该刷新”的基础判断已经存在。
3. Desktop main 在启动时把 Electron `safeStorage` cipher 注入 `CredentialStore`：
   `packages/desktop/src/main/index.ts:1674-1678`。`CredentialStore` 以 `0o600` 临时文件 + rename
   原子写盘，并只在磁盘边界加密：`packages/core/src/credentials/store.ts:88-105`；对应 cipher
   由 `packages/desktop/src/main/credential-cipher.ts:19-49` 提供。因此 OAuth token 不需要另造一套明文存储。
4. MCP HTTP 已能把 OAuth secret 中的 access token 作为 Bearer 注入。同步路径在
   `packages/core/src/tool-system/mcp-manager.ts:118-202`，异步 credential-access 路径在
   `:204-240`；真实 HTTP transport 在连接前调用后者并把结果固定到 `requestInit.headers`：
   `:588-598`。
5. OAuth 凭证不会被普通 `UseCredential` 暴露，只允许 MCP purpose 解析：
   `packages/desktop/src/main/credential-access-service.ts:41-57`。renderer 只能拿到 masked view 和
   `oauthStatus`，拿不到 access/refresh token：`packages/core/src/credentials/store.ts:195-207`。
6. UI 已有认证方式选择、凭证选择、有效/过期/无效状态和退出。MCP 编辑器在
   `packages/desktop/src/renderer/settings/McpSection.tsx:781-825` 展示状态，在 `:1187-1296`
   展示 OAuth 操作；Link 页面按 `oauthProvider`/`*-oauth` 归并凭证并显示状态：
   `packages/desktop/src/renderer/credentials/LinkTab.tsx:13-38`、`:79-160`。

### 1.2 真正缺失的闭环

1. 两个入口都没有调用 host。Link 页的登录和刷新只 toast pending：
   `packages/desktop/src/renderer/credentials/LinkTab.tsx:40-46`；MCP 设置同样只 toast：
   `packages/desktop/src/renderer/settings/McpSection.tsx:950-956`。
2. Desktop main 目前只有 credential list/save/remove/patch IPC：
   `packages/desktop/src/main/index.ts:1854-1893`；preload 也只暴露这些 CRUD：
   `packages/desktop/src/preload/index.ts:1034-1053`。没有 `login/refresh/logout/status` host API，
   也没有 callback listener、单飞刷新锁或 token response 落盘逻辑。
3. Core 确实已有一个授权码 + PKCE 原语，但没有任何生产调用者。`authorize()` 会生成
   verifier/challenge/state、打开浏览器、监听 localhost callback 并换 token：
   `packages/core/src/services/oauth.ts:27-159`；`refreshToken()` 在 `:161-194`。仓库内除导出外无调用，
   因而它还没有接入 Electron main。它当前还存在固定随机端口未重试、不能取消、token response
   校验弱、没有 discovery/dynamic registration、错误正文可能带敏感信息等 host 化前必须补的边界。
4. 过期 token 当前明确 fail closed。`bearerTokenFromMcpCredential()` 在临期/过期时直接抛出
   “automatic OAuth refresh ... not wired”：`packages/core/src/tool-system/mcp-manager.ts:186-198`。
   `buildOAuthRefreshRequest()` 虽已构造好刷新材料，却没有 handler 消费。
5. access token 只在 MCP 建连时解析一次并固化到 transport。长连接期间 token 过期后，后续请求不会
   重新取 token；也没有 401 后刷新并重试一次的能力：
   `packages/core/src/tool-system/mcp-manager.ts:592-598`。
6. Link catalog 目前只有展示字段，没有 OAuth profile（授权端点、client id、scope 或 MCP URL）：
   `packages/desktop/src/renderer/credentials/link-catalog.ts:13-24`、`:33-88`。因此不能把“所有 catalog
   item 的登录按钮”直接连到同一个真实流程；必须先声明哪些 item 有可用 profile，其他 item 保持禁用并解释原因。
7. 退出现在只是删除 user-scope credential：`LinkTab.tsx:48-51`、`McpSection.tsx:958-963`，
   没有调用 provider revocation endpoint，也没有统一清掉 worker credential snapshot / MCP probe cache。

## 2. 目标

1. LinkTab 与 MCP 设置页都能完成：打开系统浏览器 -> PKCE 授权 -> localhost callback -> 换 token ->
   通过 `CredentialStore` 安全落盘 -> UI 立即显示已登录。
2. 手动刷新可用；MCP 请求前若 token 在 60 秒内过期则自动刷新；服务端返回 401 时强制刷新并只重试一次。
3. 刷新 token 轮换时原子覆盖；响应未返回新 refresh token 时保留旧值；所有 renderer、settings、日志、probe
   detail 都不出现明文 token。
4. 退出优先向 revocation endpoint 撤销 token，再删除本地 credential；远端撤销失败不阻止本地退出，但要返回
   可展示的 warning。
5. 继续保留现有 `credentialRef` wire 字段和普通 Bearer/token/link 行为，不做破坏性 settings 迁移。
6. 首期采用“每个 OAuth profile/server 一个 user-scope credential”的单账号模型；project override 与多账号选择留作后续，
   但 credential id 和 service API 不封死扩展空间。

## 3. 详细修改方案

### 3.1 Core OAuth 数据与纯函数

#### `packages/core/src/credentials/types.ts`

扩充 OAuth 的非敏感发现/撤销元数据，同时保持 `version: 1` 兼容（全部新增字段可选）：

```ts
export interface OAuthCredentialSecret {
  // 现有字段保留
  issuer?: string;
  resource?: string;
  revocationEndpoint?: string;
  clientRegistration?: {
    clientId: string;
    clientSecret?: string;
    clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number;
  };
}

export interface OAuthCredentialMeta {
  // 合入现有 Credential.meta
  oauthProvider?: string;
  mcpServerName?: string;
  mcpServerUrl?: string;
  issuer?: string;
  resource?: string;
  authUrl?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  clientId?: string;
  scopes?: string[];
  lastRefreshAt?: string;
  lastRefreshFailedAt?: string;
  lastRefreshErrorCode?: "invalid_grant" | "network" | "server_error" | "invalid_response";
}
```

`lastRefreshErrorCode` 只能保存归一化错误码，不能保存 token endpoint 的原始响应正文。同步更新
`packages/core/src/credentials/oauth.ts` 的 parser/public summary、core barrel exports、
`packages/desktop/src/preload/types.d.ts:364-405` 和 renderer mirror
`packages/desktop/src/renderer/credentials/types.ts:1-39`。

#### `packages/core/src/credentials/oauth.ts`

新增并单测以下纯函数：

```ts
export function mergeOAuthTokenResponse(
  previous: OAuthCredentialSecret | undefined,
  response: OAuthTokenResponse,
  opts?: { now?: number },
): OAuthCredentialSecret;

export function shouldRefreshOAuthCredential(
  secret: OAuthCredentialSecret,
  opts?: OAuthClockOptions,
): "no" | "refresh" | "login_required";
```

规则如下：

- `access_token` 必须是非空字符串，`token_type` 缺失按 Bearer，显式为非 Bearer 则拒绝用于 MCP。
- `expires_in` 必须是有限非负数并换成 ISO `expiresAt`；若响应没有 expiry，保留“未知”而不是伪造过期时间。
- 新响应没有 `refresh_token` 时保留旧 refresh token；返回新值时按 rotation 覆盖。
- scope 以响应值优先，否则保留原值；client/discovery 字段从旧 secret 保留。
- `expiresAt <= now + 60s` 为 `refresh`；已过期且没有 refreshToken/tokenEndpoint 为 `login_required`。

### 3.2 把现有 PKCE 原语 host 化

#### `packages/core/src/services/oauth.ts`

保留其“通用 OAuth 授权码 + PKCE”定位，但把不可测试的全局副作用改为依赖注入：

```ts
export interface OAuthAuthorizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;                 // 默认 120_000
  openExternal?: (url: string) => Promise<void> | void;
  fetch?: typeof fetch;
  callbackHost?: "127.0.0.1";        // 不绑定 0.0.0.0
  callbackPort?: number;              // 0 = 系统分配
}

export async function authorize(
  config: OAuthConfig,
  options?: OAuthAuthorizeOptions,
): Promise<OAuthTokens>;
```

具体调整：先在 `127.0.0.1` 上 `listen(0)` 成功，再用实际端口生成 redirect URI 和授权 URL；所有成功、
`error=access_denied`、state mismatch、timeout、abort、server error 分支都走同一个 once-only cleanup，关闭 server 和 timer；
浏览器由 Desktop main 注入 `shell.openExternal`，core 不再自行 `execFile`。token exchange 使用
`mergeOAuthTokenResponse()` 校验，不把失败响应正文拼入对 renderer 可见的错误。

对于 MCP server URL 登录，在这个原语外复用当前依赖的 MCP SDK OAuth discovery/auth 能力（依赖落在
`packages/core/package.json:32`，实际 lock 版本见 `bun.lock:326`）：优先 RFC 9728 protected-resource metadata 和
RFC 8414/OIDC metadata；profile 已明确端点时跳过 discovery。没有预注册 client id 时，仅在 metadata 宣告支持
dynamic registration 时注册；注册结果与 token 一起进入加密 secret。这样不把 discovery、resource indicator 和动态注册
重新手写一遍，`authorize()` 仍负责已有明确端点的 PKCE/callback 基元。

### 3.3 Desktop main 的唯一 OAuth owner

#### 新增 `packages/desktop/src/main/mcp-oauth-service.ts`

该 service 是登录、刷新、撤销和安全写盘的唯一 owner：

```ts
export type McpOAuthLoginInput =
  | { source: "catalog"; profileId: string; credentialId?: string }
  | {
      source: "mcp";
      serverName: string;
      serverUrl: string;
      credentialId?: string;
      clientId?: string;
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      scopes?: string[];
    };

export interface McpOAuthActionResult {
  credential: MaskedCredential;
  warning?: "remote_revoke_failed";
}

export class McpOAuthService {
  login(input: McpOAuthLoginInput): Promise<McpOAuthActionResult>;
  refresh(credentialId: string, opts?: { force?: boolean }): Promise<McpOAuthActionResult>;
  resolveAccessToken(
    credentialId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<{ accessToken: string; expiresAt?: string }>;
  logout(credentialId: string): Promise<{ removed: true; remoteRevoked: boolean }>;
}
```

实现约束：

1. 第一版一律读写 user-scope `CredentialStore(undefined)`，与 MCPManager 当前“credentialRef 为 user-global”约定一致：
   `packages/core/src/tool-system/mcp-manager.ts:592-595`。
2. `login()` 只接受 main 内注册的 `profileId`，或经过校验的 MCP URL/advanced metadata。授权、token、registration、
   revocation endpoint 默认必须是 HTTPS；只为测试和明确的 localhost 开发地址放行 HTTP。禁止从任意 callback 参数覆盖 token endpoint。
3. 每个 credential id 一个 in-flight promise。并发自动刷新、probe 和手动刷新共享同一个 promise；锁内重新读取最新 secret，
   防止旧 refresh token 覆盖已轮换的新 token。
4. 刷新成功用一次 `store.save("user", wholeCredential)` 原子写 secret + meta，再调用
   `bridge?.pushCredentialSnapshot(undefined)` 并清理 MCP probe cache。不能先 patch meta 再 save secret，避免崩溃留下半更新状态。
5. 主动临期刷新失败但旧 access token 尚未真正过期时，可返回旧 token并记录归一化 warning；已过期、手动刷新或 401 强刷失败时必须报错。
   `invalid_grant` 转为 `login_required`，不自动删除凭证，便于 UI 显示“重新登录”。
6. `logout()` 有 revocation endpoint 时先撤销 refresh token（没有则撤销 access token），无论远端结果如何都删除本地 credential，
   推送 snapshot 并清 probe cache。日志只记 credential id/provider/错误类别。

#### 新增 `packages/desktop/src/main/mcp-oauth-profiles.ts`

main 保存可审计的 profile registry；renderer catalog 只引用 `oauthProfileId`。profile 至少含 provider id、label、MCP/server URL、
client metadata、scope 和可选显式端点。没有 profile 的 Circleback/Fireflies/Fyxer/Granola/Otter 等 item 不显示可点击的 OAuth 登录，
避免把“静态市场卡片”误当已接入集成。Figma 也只有在存在真实 client metadata 或 discovery 可完成时才启用。

### 3.4 Host IPC 与 worker credential bridge

#### `packages/desktop/src/main/index.ts`、`packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/types.d.ts`

增加类型化 API，renderer 仍只接收 masked credential：

```ts
window.codeshell.mcpOAuth.login(input): Promise<McpOAuthActionResult>;
window.codeshell.mcpOAuth.refresh(credentialId): Promise<McpOAuthActionResult>;
window.codeshell.mcpOAuth.logout(credentialId): Promise<{ removed: true; remoteRevoked: boolean }>;
```

main handler 要做字段白名单和 URL/credential id 校验，不接受 renderer 传入 secret、refresh token、client secret。登录期间 UI 关闭或
provider 返回 `access_denied` 时 promise 失败且不创建 credential。

#### `packages/core/src/credentials/access.ts`、`packages/desktop/src/main/credential-access-service.ts`、
`packages/desktop/src/main/agent-bridge.ts`

在现有 `desktop/credentialResolve` 旁增加专用的 host 能力：

```ts
interface CredentialAccess {
  resolveOAuthAccess?(req: {
    id: string;
    scope: "full";
    forceRefresh?: boolean;
  }): Promise<{ accessToken: string; expiresAt?: string }>;
}
```

IPC method 使用 `desktop/oauthAccessResolve`，main 直接委托 `McpOAuthService.resolveAccessToken()`。不要继续让 worker
拿完整 OAuth JSON 来自行刷新；worker 只得到本次请求需要的 access token，refresh token/client secret 始终留在 main。
`localCredentialAccess` 可为 TUI/SDK 提供基于 `CredentialStore` + `refreshToken()` 的实现；没有 refresh 能力的 host 继续保持当前
fail-closed 行为。

### 3.5 请求前刷新与 401 单次重试

#### `packages/core/src/tool-system/mcp-manager.ts`

保留同步 `buildHttpHeaders()` 及其现有 token/link/OAuth 单测，新增异步、按请求解析的 fetch adapter：

```ts
export function createMcpAuthenticatedFetch(
  serverName: string,
  config: MCPServerConfig,
  access?: CredentialAccess,
  baseFetch?: typeof fetch,
): typeof fetch;
```

执行顺序：

1. 非 OAuth 配置沿用现有 headers/env/credential 解析，行为不变。
2. OAuth 每次请求前调用 `resolveOAuthAccess({ forceRefresh: false })`；host 在 60 秒临期窗口内刷新，否则直接返回当前 token。
3. adapter 克隆 `Request` 作为可重放副本，发送第一次请求。只有 `status === 401`、credential 类型为 OAuth、请求未 abort 且副本可重放时，
   才调用 `forceRefresh: true`，替换 Authorization 并重试一次。403、网络错误和第二次 401 不重试；日志不得包含 header。
4. `performConnect()` 在 HTTP/SSE transport 的 options 中同时传 `requestInit`（静态非认证 headers）与该 `fetch`，而不是把 OAuth
   access token 永久固化到 `requestInit`。这同时覆盖握手、listTools 和长连接后续请求。
5. singleflight 在 main，故多个 MCP server/owner 同时撞上临期 token只产生一次 refresh。

选择“请求前临期检查 + 401 一次兜底”，而不是二选一：仅请求前检查无法处理未知 `expiresAt`、服务端提前撤销和时钟偏差；仅 401
重试会让每次正常过期都先失败一次，并可能让首次 MCP handshake 直接中断。

#### `packages/desktop/src/main/mcp-probe-service.ts`

把 `buildProbeHttpHeaders()` 的 OAuth 分支改为调用同一个 `McpOAuthService.resolveAccessToken()`，并使用同样的 401-one-retry adapter；
普通 token/link 仍可走当前同步 helper。刷新/登录/退出后显式删除对应 probe cache entry，否则一分钟 TTL 会继续显示旧状态：
当前 cache 和 hash 在 `packages/desktop/src/main/mcp-probe-service.ts:65-88`。

### 3.6 Renderer 接线

#### `packages/desktop/src/renderer/credentials/link-catalog.ts`、`LinkTab.tsx`

- `LinkIntegration` 增加 `oauthProfileId?: string`；没有 profile 时显示“尚未支持 OAuth”而非可点击登录。
- `onLogin/onRefresh/onLogout` 改为 async，按 integration id 维护 `busy/error`，操作期间禁用三个按钮，防止重复授权窗口。
- 登录调用 `mcpOAuth.login({source:"catalog", profileId})`；成功后 `load()`，失败 toast 归一化错误。
- 刷新/退出传当前 credential id；退出若 `remoteRevoked=false`，显示“已从本机退出，远端撤销失败”的非阻断 warning。
- `oauthStatus.state === "expired"` 或刷新 `invalid_grant` 时主操作文案改为“重新登录”。

#### `packages/desktop/src/renderer/settings/McpSection.tsx`

- `onOAuthLogin()` 先验证当前 HTTP/SSE server 的 name/url，再调用
  `mcpOAuth.login({source:"mcp", serverName:name, serverUrl:url, ...advancedOAuthFields})`。
- 成功后 `reloadCredentials()`，将 `credentialRef` 设为返回 id，并保持 `authMode="oauth"`；用户仍需点击编辑器“保存”来提交 server 配置。
- 手动刷新和退出改用 host API；退出后清空本地 `credentialRef`。若编辑的是已保存 server，保存时由既有 settings hot reload/reconcile
  使连接采用新绑定。
- 增加 `oauthBusy` 与 `oauthError`，pending 时禁用登录/刷新/退出/保存，避免“授权未完成但先保存空 ref”。
- advanced 区允许填写 client id/scopes/显式端点作为 discovery fallback；不提供 client secret 输入框，confidential client 的 secret 只能来自
  main profile/动态注册并进入加密 store。

## 4. 分阶段实施顺序

### 步骤 1：纯函数与 PKCE 加固

先完成 token response merge、临期判断、`authorize()` 可注入/cancel/ephemeral port 改造及单测。此步不改 UI 和 MCP 行为，便于独立审查
callback 安全与 secret 处理。

### 步骤 2：main service 与 IPC 登录闭环

落地 profile registry、`McpOAuthService.login/refresh/logout`、main/preload API 和安全写盘；接 LinkTab 与 McpSection。完成后用户可以登录、
手动刷新、退出，但 runtime 仍可暂时沿用“未过期 token 建连”。

### 步骤 3：worker host bridge 与自动刷新

增加 `resolveOAuthAccess` bridge，把 MCPManager 改为请求前临期刷新。验证 Desktop worker 永远不收到 refresh token/client secret，
credential snapshot 在 refresh 后立即更新。

### 步骤 4：401 重试、probe 与撤销收口

接入 authenticated fetch、probe 同源刷新、cache invalidation 和 revocation warning；补集成测试后删除 pending toast 文案和
“automatic refresh reserved”错误分支。

## 5. 测试策略

### Core 单元测试

- `packages/core/src/credentials/oauth.test.ts`：expiry 边界（恰好 60 秒）、无 expiry、refresh token rotation、响应缺 refresh token、
  非法 `expires_in`、非 Bearer、`invalid_grant` 归类。
- 新增 `packages/core/src/services/oauth.test.ts`：PKCE challenge、state mismatch、`access_denied`、成功 callback、timeout、AbortSignal、
  callback server/listener 全分支清理、端口占用（使用 port 0 不冲突）。browser/fetch 都注入 fake，不打开真实浏览器。
- `packages/core/src/tool-system/mcp-manager.test.ts`：有效 token 不刷新；临期 token 请求前刷新；并发请求只触发一次 host refresh；未知 expiry
  首次 401 后刷新且仅重试一次；第二次 401/403/abort/不可重放 body 不循环；token/link/header 旧行为保持。

### Desktop main 测试

- 新增 `mcp-oauth-service.test.ts`，用本地 fake authorization/token/revocation server 覆盖：登录成功原子落盘、provider 拒绝/错误/超时不落盘、
  刷新轮换、刷新响应不带 refresh token、`invalid_grant`、远端撤销成功与失败、本地 credential 都删除。
- 断言磁盘 `credentials.json` 不含明文 access/refresh token（safeStorage mock 下检查 `enc:safeStorage:`），文件 mode 保持 owner-only。
- `credential-access-service.test.ts`/AgentBridge 测试：worker 的 OAuth resolve result 只有 access token；日志与错误不含 refresh token/client secret；
  refresh 后 snapshot revision 增长。
- `mcp-probe-service.test.ts`：临期刷新后 probe 成功、401 强刷成功、强刷失败显示重新登录、刷新后旧 cache 被清除。

### Renderer 测试

- `LinkTab`：missing -> login pending -> valid；登录失败保持 missing；expired -> refresh -> valid；退出 success/warning；重复点击不发第二个 IPC。
- `McpSection.plugin.test.ts` 及新增交互测试：登录成功自动选中返回的 credentialRef；未保存 server 的 name/url 校验；刷新/退出状态；
  plugin override 仍只能编辑允许的认证补充字段。
- preload contract 测试确保 renderer 不可能传/收 secret 字段。

### 端到端回归

使用本地 mock HTTP MCP + OAuth server：首次 connect 触发登录后成功列工具；把 access token 设为临期后下一请求自动刷新；服务端主动令 token
401 时恰好刷新并重试一次；重启 Desktop 后凭证仍可解密并刷新；退出后 probe/真实连接均回到 needs-login。该测试同时跑 probe 路径和 worker
真实连接路径，防止两者 header/刷新语义再次漂移。

## 6. 风险与兼容性注意

1. **不要把 refresh 放进同步 `buildHttpHeaders()`。** 它仍是纯 helper 和兼容入口；所有网络刷新只能在 async host service/adapter 中发生。
2. **共享 MCPManager 的 cwd 语义。** 当前 pool 不带 per-session cwd，OAuth credential 也是 user-global。首期不要让 project-scope 同 id 凭证参与解析，
   否则不同 project owner 会争用同一连接和账号。
3. **刷新竞态。** token endpoint 可能旋转 refresh token；没有按 credential singleflight + 锁内重读会导致后完成的旧请求覆盖新 token。
4. **401 只能重试一次。** 不能对 403 或所有网络异常刷新，也不能无限重放带副作用的 MCP tool call。无法 clone 的 Request 直接返回首次 401。
5. **callback 攻击面。** 只监听 loopback、随机 state、S256 PKCE、短超时；callback 页面不回显 code/error detail；完成后立即关 listener。
6. **endpoint SSRF/泄露。** 自定义 endpoint 必须 HTTPS/localhost、经过 discovery/profile 校验，且 token 只发给确认过的 token/revocation endpoint；
   重定向跨 origin 时重新校验。
7. **Linux 无 keyring。** `SafeStorageCipher` 当前会回退 `plain:` + `0o600`（`credential-cipher.ts:7-11`）。本 feature 不改变既有策略，
   但 UI/文档应如实提示该平台保护级别，不能宣称所有平台都由 OS keychain 加密。
8. **撤销不是删除的前置条件。** 网络断开或 provider 不支持 revocation 时仍必须删本地 secret；warning 不能包含 endpoint response 正文。
9. **旧数据零迁移。** 现有 OAuth v1 secret、新旧 token/link credential、`credentialRef`、settings JSON 都继续可读；新增字段缺失时按当前行为处理。
10. **SDK 与自有原语边界。** MCP metadata discovery/dynamic registration 交给 MCP SDK；Desktop callback、safeStorage、credential id、状态和刷新 singleflight
    由 CodeShell host 管。不要同时让 SDK provider和自有 fetch各自刷新同一个 credential，必须由 `McpOAuthService` 单一写入。
