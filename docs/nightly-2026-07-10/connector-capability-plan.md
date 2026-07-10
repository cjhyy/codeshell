# CodeShell Connector 能力补齐方案

> 任务：E1 · open-connector 调研 → CodeShell connector 能力补齐方案  
> 调研日期：2026-07-10（Asia/Shanghai）  
> open-connector 基线：`main@55c15b29685ed76e342ca852aa19df8b70c0c26a`  
> 文档性质：调研与实施建议，不代表已经实现

## 0. 结论先行

open-connector 值得 CodeShell 学的不是“多接几个 MCP server”，而是一层完整的 connector control plane：

1. 用稳定的 **Provider/App → Action → Connection → Execution** 模型描述外部服务。
2. 由 catalog 同时驱动发现、表单、输入输出 schema、scope/permission 提示和运行状态。
3. 把 provider credential 留在可检查、可加密、可审计的 runtime 边界内；Agent 只看到账号身份、授权范围、Action 契约和结果。
4. 把 MCP、HTTP/OpenAPI、SDK/CLI 当成同一 Action runtime 的不同入口，而不是各自维护一套集成。
5. 在执行前叠加 runtime token、connection alias、Action allow/block policy，在执行后记录脱敏 run log。

CodeShell 已经拥有三个很好的底座：成熟的 MCP client、分层且桌面端可加密的 CredentialStore、workspace capability overlay。但三者仍是平行能力，缺少把它们串起来的领域层。最核心的差距不是 transport，而是：

- 没有 Provider/Action catalog 和 schema-driven connection form；
- 没有独立于 secret 的 Connection（账号身份、granted scopes、健康状态、多账号 alias）；
- 没有 workspace 数据源的“需求声明 → 本地授权 → 运行时解析”模型；
- MCP server 只能按 server 开关，不能给不同 workspace 稳定绑定不同账号/资源范围；
- OAuth 已有存储结构和展示骨架，但 login/refresh 仍未闭环；
- 没有 connector 级 Action policy 与统一脱敏审计。

建议定位是：**MCP 继续做协议面，credentials 继续做 secret 面，新建 connector 领域层做 catalog / connection / workspace binding / policy / audit。** 不建议把 open-connector 的 1,000+ provider executor 复制进 CodeShell；推荐以 adapter 接入它或其它兼容 backend。

接入策略采用“两步走”：

- 先用现有 MCP client 接 `POST /mcp`，零领域改造验证 catalog search/guide/execute 的产品价值；
- 一旦进入 Workspace 多账号绑定，改用 open-connector `/v1` HTTP adapter 作为一等路径，因为 HTTP 调用可逐请求选择 named connection alias；调研基线中的 MCP `execute_action` 没有 alias 参数，MCP handler 也没有把请求 header alias 传入 ActionRunner。

完整方案分 6 个阶段。可最先做的 TOP 5 是：OpenConnector MCP 冒烟、OAuth refresh 闭环、connector 领域 schema、workspace requirement/grant 分离、只读数据源 MVP。

---

## 1. 调研范围与证据

### 1.1 open-connector 官方资料

- [中文 README](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/README.zh-CN.md)
- [中文 README raw 原文](https://raw.githubusercontent.com/oomol-lab/open-connector/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/README.zh-CN.md)
- [Runtime API 与 MCP](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/runtime-api.md)
- [Credentials 与本地存储](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/credentials.md)
- [Catalog 格式](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/catalog-format.md)
- [配置与执行策略](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/docs/configuration.md)
- [Provider/Action/Auth 核心类型](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/src/core/types.ts)
- [MCP 元工具实现](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/src/mcp.ts)
- [Connection 与 OAuth refresh](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/src/connection-service.ts)
- [Action policy](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/src/core/action-policy.ts)
- [ActionRunner 与脱敏 run log](https://github.com/oomol-lab/open-connector/blob/55c15b29685ed76e342ca852aa19df8b70c0c26a/src/server/actions/action-runner.ts)

### 1.2 CodeShell 源码与设计稿

- `packages/core/src/tool-system/mcp-manager.ts`
- `packages/core/src/tool-system/builtin/mcp-tools.ts`
- `packages/core/src/types.ts:755-822`
- `packages/core/src/settings/schema.ts:13-42,269-335`
- `packages/core/src/settings/manager.ts:34-55,160-180,205-286`
- `packages/core/src/capability-control/project.ts:52-83`
- `packages/core/src/capability-control/overlay.ts`
- `packages/core/src/credentials/`
- `packages/desktop/src/main/mcp-probe-service.ts`
- `packages/desktop/src/renderer/settings/McpSection.tsx`
- `packages/desktop/src/renderer/credentials/LinkTab.tsx`
- `packages/desktop/src/renderer/credentials/link-catalog.ts`
- `docs/todo/mcp-http-auth-oauth-link-tech-design.md`
- `docs/todo/workspace-profile-讨论稿.md`
- `TODO.md:13,35-37`

注意：`TODO.md` 与 `docs/todo/README.md` 对 OAuth 的“未实现”描述已经部分过期。源码里已经有 `CredentialType = token | link | cookie | oauth`、OAuth secret/status、MCP Bearer 注入、MCP 认证方式 UI 和 LinkTab 状态展示；真正未完成的是 OAuth login/refresh 服务、多账号执行绑定与 workspace 数据源模型。

---

## 2. open-connector 核心要点

### 2.1 它是什么

open-connector 是面向 Agent/App 的开源 connector gateway。它把大量第三方服务的 catalog、Action schema、credential、OAuth、policy、执行器与运行日志收拢到一个 runtime，再通过以下入口复用：

| 入口 | 用途 |
|---|---|
| Connector SDK | 应用内 TypeScript client |
| oo CLI | 本地 Agent 的搜索、查看、执行中继 |
| MCP `POST /mcp` | Agent host 接入 |
| HTTP `/v1/*` | 脚本、SDK、自定义 client 与逐 Action 执行 |
| OpenAPI `/openapi.json` | API importer、文档与类型生成 |
| Action guide `/api/actions/:id/agent.md` | 给 Agent 的单 Action 契约说明 |
| Web Console | catalog、credential、OAuth、token、调试、run log 管理 |

它的核心承诺是“连接一次账号，在多个 Agent/App 入口复用”，并让 provider secret 不进入 Agent 进程。

### 2.2 概念模型

#### Provider / App

Provider 是 catalog 的一级实体，稳定键是 `service`。它声明：

- 展示信息：`displayName`、description、categories、homepage/icon；
- 支持的 auth 类型；
- auth 表单/流程 schema；
- 该 provider 下的 Action 列表。

`authTypes` 目前是：

- `no_auth`
- `api_key`
- `custom_credential`
- `oauth2`

#### Action

Action 是可发现、可校验、可执行的稳定契约。核心字段是：

- 全局唯一 `id`，通常为 `<service>.<name>`；
- `service`、`name`、description；
- `inputSchema`、`outputSchema`；
- `requiredScopes`、`providerPermissions`；
- 可选 follow-up Actions；
- 可选 start/status/cancel 异步生命周期。

Action definition 是纯 catalog 数据，不依赖凭据、网络或 executor。executor 与定义分离并按执行加载。

#### Connection

Connection 不是 credential 的别名，而是“某 Provider 的一个可执行账号实例”：

- 身份键：`service + connectionName`；
- authType；
- `profile.accountId`、`displayName`、`grantedScopes`；
- default/named connection；
- no-auth provider 以 virtual connection 表达；
- OAuth token 到期时在取 credential 的执行边界自动 refresh 并回写。

同一 Provider 可以有 `default`、`work`、`personal` 等多个 named connection。HTTP 执行可用 `x-oo-connector-alias` 或 query `alias` 逐请求选账号。

#### Runtime Action status

Catalog 可见不等于本地可执行。runtime 会补充：

- `locallyExecutable`
- `catalogOnly`
- `requiredAuthTypes`
- `needsCredential`
- `noAuthRunnable`

这个区分很重要：UI/Agent 可以先发现完整契约，但必须在执行前知道本 runtime 是否真的装有 executor、是否缺 connection。

#### Policy 与 Run

执行前经过 Action policy：exact action id 或 `service.*` allow/block；provider proxy 有单独 allow/block，且配置了 Action policy 后 proxy 默认拒绝，必须显式 allow。

执行后记录 Run：caller、action、时间、耗时、成功/失败、connection profile、脱敏且有深度/长度上限的 input summary、错误码/错误信息。

### 2.3 协议与 schema

#### MCP

open-connector 的 MCP 不是“一 Action 一 MCP tool”，而是固定的 4 个发现型元工具：

1. `list_apps`
2. `search_actions`
3. `get_action_guide`
4. `execute_action`

这样可以承载数千 Action，而不会把所有 tool schema 一次塞进模型上下文。服务端是 stateless Streamable HTTP：`POST` JSON-RPC + JSON response，不维持 `GET` SSE stream。

MCP discovery 返回的 capability 会同时带 execution status、auth types、required scopes、provider permissions、policy decision 和当前 connection profile。执行输出使用结构化的 `ok/data` 或 `ok/error`。

#### HTTP / OpenAPI

HTTP runtime 的稳定面是：

- `GET /v1/providers`
- `GET /v1/actions`
- `GET /v1/actions/search`
- `GET /v1/actions/:actionId`
- `POST /v1/actions/:actionId`
- `GET /v1/apps*`
- `POST /v1/proxy/:service`

成功响应统一为 `success/message/data/meta`，失败增加稳定 `errorCode`；Action 执行 `meta` 带 `executionId` 与 `actionId`。OpenAPI 和单 Action guide 由同一 catalog/schema 生成。

#### Auth schema 驱动表单与校验

Provider auth metadata 不只是展示字段：

- API key 固定有 `apiKey`，可声明 extra fields；
- custom credential 必须完全匹配 provider 声明的 fields；
- OAuth 可声明 authorization/token URL、scopes、PKCE、token endpoint auth method、请求字段映射、response envelope、额外 client config fields；
- 未声明字段会被拒绝，避免 UI、脚本和 provider definition 漂移后静默存错。

### 2.4 鉴权边界

open-connector 有两层不同的鉴权，不能混为一个 token：

| 层 | 保护对象 | 典型凭据 |
|---|---|---|
| Provider connection auth | 调 GitHub/Gmail/Notion 等上游服务 | API key、custom fields、OAuth access/refresh token |
| Runtime client auth | CodeShell/SDK/MCP client 调 connector runtime | runtime Bearer token |
| Runtime admin auth | Web Console、`/api/*`、docs | admin Bearer token |

本地 Node runtime 用 SQLite 保存 connection、OAuth client/state 和 run log；Cloudflare 版用 D1，临时文件用 R2。Provider credential/OAuth client secret 可由外部提供的 encryption key 做 AES-256-GCM 加密；持久化 runtime token 只存 hash。日志和 run summary 都做敏感字段脱敏。

Connection profile 把“将以哪个账号执行、已授予什么 scope”暴露给用户和 Agent，但不暴露 raw token。

### 2.5 能力边界

open-connector 解决的是 **Action gateway**，不是完整的 Workspace 知识库：

- 它擅长在线发现和调用 SaaS Action、复用账号、隔离 secret、做 policy/audit；
- 它没有 CodeShell 的 workspace/profile 概念，不负责“这个 repo 只能看哪个 Figma file、哪个 issue project、哪个云盘目录”；
- catalog scope 是 provider 原生 OAuth 权限，不等于产品层的数据选择范围；
- 它有临时文件中转，但不是长期同步、增量索引、向量检索或离线 mirror；
- catalog 中可能只有 schema、没有开源 executor，必须识别 `catalogOnly`；
- 自托管 OAuth 通常仍要求团队自己注册 provider OAuth app；托管版主要替用户消化这部分上线成本；
- provider proxy 是逃逸能力较强的通用入口，必须独立 allowlist；
- 研究基线的 named connection 选择在 HTTP runtime 可用，但 MCP `execute_action` schema 没有 alias，MCP handler 也没有将请求 alias 传入执行上下文。因此不能假设“给 MCP transport 加静态 alias header”就实现了可靠的 workspace 多账号路由。

这意味着 CodeShell 的「Workspace 数据源绑定」必须建在 connector runtime 之上，而不是期待 open-connector 自带。

---

## 3. CodeShell 现状对标

### 3.1 MCP：协议面较成熟，领域面缺失

已有能力：

- `stdio` 和 Streamable HTTP client；URL-only config 可推断 HTTP transport；
- stdio env allowlist、按环境变量名转发 secret；
- HTTP static headers、Bearer env、任意 env header、`credentialRef`；
- 连接超时、并发 connect 合并、shared pool owner union 与热 reconcile；
- `listTools` 后动态注册，每个外部 tool 默认 `permissionDefault: ask`；只有明确 `readOnlyHint` 才并发安全/只读；
- tool call 传递 AbortSignal；MCP output 标为 untrusted；大图落盘且有大小/数量上限；
- list/read resources，且跨 session 枚举时按 allowed server 过滤；
- Desktop 有短连接 probe、tool count/list 与基础 auth 错误文案；
- project capability overlay 能按 workspace force on/off 一个 MCP server。

锚点：

- `packages/core/src/tool-system/mcp-manager.ts:48-210,330-384,386-478,569-829`
- `packages/core/src/tool-system/builtin/mcp-tools.ts`
- `packages/core/src/types.ts:755-822`
- `packages/core/src/settings/schema.ts:269-335`
- `packages/core/src/capability-control/project.ts:52-83`

局限：

1. MCP server 与 tool/resource 是协议对象，没有 Provider、Action、Connection、account identity 或 granted scope 模型。
2. 大型 server 默认“一 tool 一注册”，CodeShell 自身没有 catalog search/guide/execute facade；接 open-connector 时因为对方只暴露 4 个元工具，问题暂时被对方解决。
3. `credentialRef` 在 shared MCPManager 中以 `cwd = undefined, scope = full` 解析，源码明确按 user-global 处理；不能自然绑定 project credential。
4. shared pool 按 server name 只有一个连接，HTTP header 在 connect 时固定。两个 workspace 同时要同一 server、不同账号时会争用同一 connection identity。
5. capability overlay 只决定 server 能否用，不能限制 provider/action/resource selection，也不能表达 read-only/read-write grant。
6. `listResources/readResource` 只抽取 text，尚无 resource template、blob、subscription、prompt 等更完整的数据源语义。
7. 类型/schema 接受 `sse` 和 `inprocess`，manager 实际用 StreamableHTTP transport 处理 `sse` 且不支持 `inprocess`，存在声明/实现不一致。
8. connector 级调用没有独立、本地统一的 identity/policy/run audit；目前主要依赖普通 tool transcript 和对端日志。

### 3.2 credentials：secret 基础不错，尚未升格为 Connection

已有能力：

- `token | link | cookie | oauth` 四类；
- user 与 project 两层，full 模式下 project 同 id 覆盖 user；project/isolated engine 可隔离 user credential；
- Desktop main 用 Electron `safeStorage`；core/headless 明确退化为 owner-only `0o600` plaintext；
- renderer/worker 只拿 masked snapshot，secret 按需经 main IPC 解析；
- OAuth secret 已版本化并包含 access/refresh/expiry/token endpoint/client/scopes；
- OAuth public status 可显示 valid/expired/missing/invalid；
- `UseCredential` 有逐次/本会话/自动批准 gate，敏感结果从展示与 transcript 脱敏；
- cookie 可 materialize 为临时 Netscape 文件或经独立审批注入内置浏览器；
- MCP HTTP `credentialRef` 能识别 OAuth，未过期时只注入 access token。

锚点：

- `packages/core/src/credentials/types.ts:1-106`
- `packages/core/src/credentials/store.ts:14-208`
- `packages/core/src/credentials/access.ts`
- `packages/core/src/credentials/oauth.ts`
- `packages/core/src/credentials/use-credential-tool.ts`
- `packages/core/src/credentials/inject-credential-tool.ts`
- `packages/desktop/src/main/credential-cipher.ts`

局限：

1. Credential 是 auth material，不是 Connection；没有稳定 provider id、account identity、granted scopes、连接健康、默认/命名账号。
2. `meta.scopes` 更像展示信息，不是经过 provider validator 确认的 grant，也没有执行前的 required-vs-granted 检查。
3. OAuth login/callback 服务未落地；LinkTab/MCP 设置里的登录和刷新仍只 toast “待实现”。
4. MCP 检测到 OAuth 过期时即使 refresh data 完整也直接报错，源码明确写着 automatic refresh 尚未接线。
5. `link` 含义仍模糊：既像 app 入口/注册信息，又可能含 client id/secret；不适合承载账号连接状态。
6. `UseCredential` 会在审批后把 token/link value 交给 Agent tool。connector provider secret 应走 host-owned resolution 或外部 runtime，不应借这条路径暴露给 Agent。
7. user/project credential 与 shared MCP user-global resolution 存在语义错位。
8. 部分源码注释仍写“只存 token/link、cookie 不进库”，与实际四类型实现不一致，后续演进前应先清理文档漂移。

### 3.3 LinkTab / MCP Auth UI：已有交互骨架，不只是空白页

LinkTab 当前：

- catalog 写死在 renderer，仅有少量 communication/design 项；
- 会读取 OAuth credential 并显示状态、label/id、expiry；
- logout 能删除 user credential；
- login 和 refresh 只显示 pending toast；
- catalog 没有 auth schema、Action、required scopes、account identity、连接健康或 backend 来源。

MCP 设置页当前已经比 TODO 描述更进一步：

- 有 none/bearer/headers/oauth 认证方式；
- 可从已有 OAuth credential 选择；
- 能显示 OAuth status；
- login/refresh 仍 pending；
- auth 错误主要靠字符串匹配，probe result 没有稳定的 `authStatus` enum。

锚点：

- `packages/desktop/src/renderer/credentials/LinkTab.tsx:10-161`
- `packages/desktop/src/renderer/credentials/link-catalog.ts:1-88`
- `packages/desktop/src/renderer/settings/McpSection.tsx:97-132,786-826,869-963,1188-1294`
- `packages/desktop/src/main/mcp-probe-service.ts:43-58,94-139,149-236`

### 3.4 Workspace / Profile / 数据源 TODO

现有 capability overlay 已能按 workspace 开关 skills/plugins/agents/MCP/builtin；WorkspaceProfile 讨论稿也计划让 profile force-enable MCP server。这只是“能力可见性”，还不是“数据源绑定”。

`TODO.md:36` 对差距的判断是准确的：当前没有 workspace-scoped resource model、外部源 link，也没有 Figma/issue/云盘的数据范围分配与按 workspace/profile 注入的读取面。

还需要进一步明确一个安全边界：

- repo 可提交的是 **需求**，例如“需要 Figma read-only、只允许 file X”；
- 用户本机批准的是 **grant**，例如“用我的 work-Figma 账号满足这个需求”；
- repo 文件不能仅凭一个 credential id 就静默领用宿主全局账号。

CodeShell 已有 workspace trust，会从不可信 project settings 剥离 `mcpServers` 等危险字段。新的 connector grants 也必须进入同等级 trust root，且最好根本不写进可提交文件。

---

## 4. 差距总表

| 能力 | open-connector | CodeShell 现状 | 差距判断 |
|---|---|---|---|
| Catalog | Provider/App + Action + auth/schema | MCP tool/resource metadata；静态 Link catalog | 缺统一、可扩展 catalog |
| Action contract | input/output schema、scope、permission、execution status | MCP tool input schema；无统一输出/scope/status | 部分可复用，领域字段缺失 |
| Connection | provider + named alias + profile + granted scopes | credential id；MCP server credentialRef | 核心缺口 |
| 多账号 | HTTP 每请求 alias | shared MCP 每 server 一连接，header 固定 | 核心缺口 |
| OAuth | 登录、callback、refresh、回写 | secret/status/UI 骨架；登录/刷新未接 | 半成品 |
| Credential boundary | provider secret 留 runtime，Agent 不见 | desktop 可安全存；UseCredential 可把 token 交给 Agent | connector 路径需 host-only |
| Runtime/client auth | runtime token 与 provider credential 分层 | MCP credentialRef 只有“给 server 的 credential”概念 | 需语义化 |
| Workspace binding | 无 workspace 模型 | capability server on/off | CodeShell 自己必须补 |
| Resource scope | provider scopes + connection profile | 无 Figma file/issue project/drive folder selection | 核心缺口 |
| Policy | Action/proxy allow-block | MCP tool 默认 ask、server on/off | 缺 action/resource 细粒度 policy |
| Audit | connection-aware redacted run log | 普通 tool transcript/对端日志 | 缺 connector audit |
| 大 catalog 上下文 | 4 个发现型元工具 | 默认逐 MCP tool 注册 | 需 facade/搜索层 |
| File transit | 临时上传/TTL/上限 | MCP image spill、工作区附件 | 语义未统一 |
| Deployment | local/Fly/Cloudflare/hosted | Agent host | 不应复制，应 adapter 对接 |

---

## 5. 建议的目标架构

### 5.1 角色分工

```text
Agent / Session
    │
    ▼
Connector Tool Facade
SearchActions / GetGuide / ExecuteAction / ListSources
    │
    ▼
Workspace Binding Resolver ── Workspace Trust / Profile Requirements
    │                         └─ Local User Grant
    ▼
Connector Policy Gate ── account identity / scopes / resource selection / action allow-block
    │
    ▼
Connector Adapter
    ├─ OpenConnector HTTP adapter（首选一等实现，支持 per-request alias）
    ├─ MCP adapter（复用现有 MCPManager）
    └─ future: OpenAPI/native adapter
    │
    ▼
External runtime / Provider MCP / SaaS API
```

横切能力：CredentialAccess 只向 adapter 解析 secret；ConnectorAudit 记录脱敏路由与结果；renderer 展示 catalog、connection 与 workspace binding。

### 5.2 领域模型建议

不要把所有概念塞回 `MCPServerConfig` 或 `Credential.meta`。建议引入四层：

#### A. IntegrationDefinition（Provider/App）

描述“可连接什么”，包括稳定 provider id、展示信息、auth schema、Action 摘要、backend 来源与 catalog revision。第一版可以直接映射 open-connector ProviderDefinition，CodeShell 自有字段放 envelope，避免 fork 上游 schema。

#### B. ConnectorActionDefinition

最小规范化字段：

- id/provider id/description；
- input/output schema；
- required provider scopes/permissions；
- execution availability；
- side-effect/risk metadata（若 backend 没有，默认 unknown → ask）；
- backend opaque metadata。

#### C. Connection

描述“用哪个账号连接”：

- `id`、provider id、backend id；
- `authOwner: codeshell | backend`；
- CodeShell-owned 时引用 `credentialRef`，backend-owned 时引用 remote alias，均不复制 secret；
- accountId/displayName/grantedScopes；
- health、expiresAt、lastCheckedAt；
- default/named、多账号信息。

#### D. Workspace source requirement 与 grant

必须拆成两类数据：

```text
DataSourceRequirement（可分享/可进项目或 Profile）
  provider/action/resource 需求 + 最大权限，不指定用户账号

WorkspaceSourceGrant（本机用户批准，不进 repo）
  requirementId → connectionId + 实际 resource selection + 有效 policy
```

Grant 至少包含：

- workspace identity；
- connection id；
- resource selection（如 Figma file、issue project/repo、Drive folder）；
- action allow/block；
- access mode：read-only/read-write；
- exposure mode：on-demand，未来再做 indexed/context-summary；
- created/updated/revoked 与 consent revision。

`provider OAuth scopes`、`resource selection`、`CodeShell action policy` 是三种不同维度，schema 命名必须分开，不能都叫 `scope`。

### 5.3 存储与安全建议

| 数据 | 建议位置 | 原因 |
|---|---|---|
| Connector/backend 定义 | user settings 或 plugin/adapter manifest | 非 secret、可复用 |
| 项目 DataSourceRequirement | `.code-shell/settings.json` 或 Profile | 可分享，只表达需求 |
| WorkspaceSourceGrant | `~/.code-shell/workspace-bindings/<workspace-key>.json` 或等价 user-owned store | 不让 repo 选择宿主账号 |
| CodeShell-owned provider credential | 现有 CredentialStore | 复用 safeStorage/IPC/redaction |
| OpenConnector runtime token | CredentialStore，类型先用 token，meta 标注 runtime audience | 只用于 CodeShell → runtime |
| OpenConnector provider credential | OpenConnector runtime | 避免双份 secret 与 Agent 暴露 |
| Connector run audit | user-owned runtime store | 需要跨 workspace 查询且不能进 repo |

新的 requirement/grant 字段要加入 workspace trust 与 protected-setting 审计。执行时 fail closed：grant 不存在、connection identity 变化、scope 不满足、catalog revision 不兼容、Action 不在 allowlist 时都不得发请求。

### 5.4 Adapter 选择

#### 立即接入：MCP

优点：CodeShell 已支持，配置 OpenConnector endpoint 和 runtime token 即可；只出现 4 个元工具，上下文成本低。

边界：适合 default connection 的功能验证；不能作为研究基线下 workspace named-account routing 的最终方案。

#### 一等 OpenConnector 集成：HTTP `/v1`

优点：

- catalog、Action schema、connected apps 都是结构化 API；
- 每请求可带 alias，天然适合 workspace binding；
- 错误码、execution id、OpenAPI 与 guide 更适合 UI/审计；
- CodeShell 可以在真正发请求前做自己的 policy gate。

因此第一版一等 adapter 应直接对 `/v1`，MCP 保留为 generic adapter 和零改造入口。

#### 不建议：把 provider catalog/executor 全量移植进 CodeShell

这会让 CodeShell承担 provider API 漂移、OAuth app、scope、验证器、executor、品牌资产与发布节奏，偏离 core-first 的 Agent orchestration 定位，也失去独立 credential runtime 的安全边界。

---

## 6. 分阶段补齐方案

体量沿用仓库约定：XS/S/M 可独立交付；L 需要再拆设计与实现 PR。阶段按依赖排序，但每阶段都有可单独验证的产物。

### Phase 0：OpenConnector MCP 兼容性基线

**目标**

用现有能力证明“CodeShell → MCP → OpenConnector → Provider”全链路可用，并锁定 MCP 与 HTTP 的职责边界。不引入正式 connector schema。

**体量**：XS

**实施锚点**

- `packages/core/src/tool-system/mcp-manager.ts:118-210,569-709`
- `packages/core/src/types.ts:755-795`
- `packages/desktop/src/main/mcp-probe-service.ts`
- open-connector `POST /mcp`、`GET /mcp/tools`

**步骤**

1. 把 OpenConnector runtime token 存为 CodeShell token credential。
2. 配一个 Streamable HTTP MCP server，`credentialRef` 只引用 token id。
3. 依次验证 `list_apps`、`search_actions`、`get_action_guide`、`execute_action`。
4. 先跑 Hacker News no-auth，再跑 GitHub default connection。
5. 单独验证 HTTP `/v1` 的 named alias，并记录 MCP alias 不可用，作为 adapter 决策测试。

**验收**

- MCP probe 显示 4 个工具；
- no-auth Action 与一个带凭据 Action 各成功一次；
- 删除 runtime token 后稳定得到 401，settings/log/transcript 不出现 token 明文；
- Stop 能取消 in-flight 调用；
- 形成固定 fixture/手工验收记录，明确“default account 走 MCP，named account 走 HTTP”。

### Phase 1：Connector 领域 contract 与只读 catalog adapter

**目标**

建立独立于 MCP/credentials 的最小领域模型，并能从 OpenConnector HTTP runtime 只读展示 Provider、Action、execution status、Connection summary。

**体量**：M

**实施锚点**

- 新建议目录：`packages/core/src/connectors/`
- `packages/core/src/types.ts:755-822`（只作为 adapter 引用，不继续堆领域字段）
- `packages/core/src/settings/schema.ts:269-335`
- `packages/desktop/src/renderer/credentials/link-catalog.ts`
- open-connector `/v1/providers`、`/v1/actions`、`/v1/apps`

**步骤**

1. 定义 IntegrationDefinition、ConnectorActionDefinition、ConnectionSummary、Adapter interface。
2. 实现 OpenConnector HTTP catalog reader；runtime token 经 CredentialAccess 注入，不回 renderer。
3. 保留 backend opaque metadata 与 catalog revision，避免 CodeShell schema 阻塞上游新增字段。
4. 正确区分 `catalogOnly`、`locallyExecutable`、`needsCredential`。
5. Link catalog 改为 adapter 数据源；静态 catalog 仅做 fallback/demo。

**验收**

- 用固定 open-connector catalog fixture 做 contract test；
- 同一数据能在 core 与 renderer 显示稳定 provider/action id；
- `catalogOnly` Action 不显示为可执行；
- renderer 网络/状态中不出现 runtime token；
- backend 不可达时保留 last-known metadata 并明确标 stale，不伪装为 connected。

### Phase 2：Connection 与 OAuth/Auth 闭环

**目标**

把“credential id”升级为“可识别、可刷新、可选择的账号 Connection”，补完现有 OAuth 骨架；同时明确 CodeShell-owned 与 backend-owned credential 的边界。

**体量**：M

**实施锚点**

- `packages/core/src/credentials/types.ts:6-100`
- `packages/core/src/credentials/oauth.ts`
- `packages/core/src/tool-system/mcp-manager.ts:159-210`
- `packages/desktop/src/renderer/credentials/LinkTab.tsx:10-161`
- `packages/desktop/src/renderer/settings/McpSection.tsx:786-826,936-963,1257-1294`
- `docs/todo/mcp-http-auth-oauth-link-tech-design.md:188-404`

**步骤**

1. 实现 OAuth login/callback/refresh/logout host service，provider-specific 字段由 catalog auth schema 驱动。
2. refresh 抽成 host-owned async service；MCP connect/probe 共用，不再各自解析后直接失败。
3. Connection 记录 account identity、granted scopes、health、expiry；credential 只保留 secret/material。
4. OpenConnector backend-owned connection 只保存 runtime endpoint/token 与 remote alias，不把 provider token复制到 CodeShell。
5. LinkTab 更名/演进为 Connections，展示账号与 scope，而不是只展示 OAuth credential id。
6. probe result 增加稳定 auth status enum，停止依赖 renderer 文案 regex 判断。

**验收**

- mock OAuth 的 login → callback → MCP probe → expiry → refresh → reconnect 全链路通过；
- refresh token 永不进入 renderer、tool result、日志；
- 同 provider 至少能展示两个 named connections 与不同 identity；
- logout/revoke 后引用该 connection 的执行 fail closed；
- `UseCredential` 不列出或不返回 connector-internal OAuth/runtime secret。

### Phase 3：Workspace requirement/grant 与只读数据源 MVP

**目标**

落地 TODO 中“Workspace 数据源绑定”的最小安全闭环：项目/Profile 声明需要什么，本机用户选择哪个账号并授权什么范围；Agent 只获得 on-demand 只读面。

**体量**：M

**实施锚点**

- `packages/core/src/settings/schema.ts:13-42,361-385`
- `packages/core/src/settings/manager.ts:34-55,160-180,205-286`
- `packages/core/src/capability-control/overlay.ts`
- `docs/todo/workspace-profile-讨论稿.md:100-132,245-270`
- `TODO.md:35-37`
- 新建议：`packages/core/src/connectors/workspace-binding.ts`

**步骤**

1. 设计 DataSourceRequirement（shareable）与 WorkspaceSourceGrant（user-owned）schema。
2. 把 connector requirements/grants 纳入 workspace trust/protected root 审计。
3. UI 完成“选择 provider → 选择 connection → 选择资源范围 → read-only 授权”。
4. 运行时按 session workspace 解析 grant；不再让 shared MCPManager 的 user-global credentialRef 代表 workspace 绑定。
5. 第一版只支持 OpenConnector HTTP adapter 的 read-only Action 与 discovery/guide；不做自动全量 prompt 注入。
6. Profile 只能声明 requirement，不携带 connection id/credential id；激活 Profile 时提示补 grant。

**验收**

- Workspace A/B 绑定同 provider 不同账号/资源，查询结果与 audit identity 不串；
- 未信任 repo 里的 requirement 不会自动创建 grant，更不能触发外部请求；
- 复制 repo 到另一台机器只看到“需要连接”，不会继承原账号；
- read-only grant 下写 Action 在本地被拒，provider 未收到请求；
- 没有 grant、grant 被撤销、connection identity 变化都 fail closed；
- prompt 只注入短的 source summary/identity，不注入整个 catalog 或外部数据正文。

### Phase 4：统一 Action facade、Policy 与 Audit

**目标**

提供跨 adapter 的小型发现/执行工具集，并把 workspace grant、账号身份、scope、Action risk 和审批统一放到一次可审计的执行边界。

**体量**：M/L

**实施锚点**

- `packages/core/src/tool-system/registry.ts`
- `packages/core/src/tool-system/permission.ts`
- `packages/core/src/tool-system/mcp-manager.ts:350-384,625-709`
- `packages/core/src/tool-system/tool-result-redaction.ts`
- 新建议：`packages/core/src/connectors/tool-facade.ts`
- 新建议：`packages/core/src/connectors/policy.ts`
- 新建议：`packages/core/src/connectors/audit.ts`

**步骤**

1. 提供少量元工具：ListSources/SearchActions/GetActionGuide/ExecuteAction。
2. discovery/guide 标只读；execute 默认 ask。backend 有可信 readOnly annotation 时也要与 workspace grant 取交集。
3. 执行前展示 provider、account displayName、resource selection、required/granted scopes 与可能副作用。
4. policy 次序固定：workspace trust → grant → connection health → execution availability → scope → allow/block → user permission。
5. audit 记录 workspace/binding/action/identity/latency/status/execution id 和脱敏 input summary。
6. external result 继续标记 untrusted；保留 structured output，避免当前 MCP 文本抽取丢失结构。

**验收**

- deny decision 发生在网络请求前；
- 写 Action 必须有 read-write grant 且经过审批；
- required scope 不满足时给出可行动错误，不尝试调用；
- audit 可按 workspace/provider/action 查询，secret 字段与超长输入被脱敏/截断；
- 大 catalog 下模型初始 tool 数保持常数级，搜索后按需取 guide；
- MCP 与 OpenConnector HTTP adapter 通过同一 facade contract tests。

### Phase 5：多 backend、多账号 MCP、文件与 Profile 深化

**目标**

在 MVP 安全模型稳定后扩展 generic MCP、OpenAPI、文件型数据源、Profile 自动装配与可选索引能力。

**体量**：L，必须拆子阶段

**实施锚点**

- `packages/core/src/tool-system/mcp-manager.ts:386-478,481-623`
- `packages/core/src/tool-system/builtin/mcp-tools.ts`
- `packages/core/src/credentials/cookie-jar.ts`
- `packages/core/src/engine/input-attachments.ts`
- `docs/todo/workspace-profile-讨论稿.md`

**候选子阶段**

1. Generic MCP connection pool 从 `serverName` 升级为 `server instance + connection/grant`，解决多 workspace 不同账号并发；同步解决 tool name collision 与生命周期回收。
2. 完整 MCP resource templates/blob/prompts 支持，resource URI 进入 binding selection。
3. OpenAPI adapter 与 Action contract importer。
4. transit file 与 CodeShell attachment/image spill 统一生命周期、上限、审计。
5. Profile requirements、切换事务与“缺 grant”提示；Profile 永不携带真实账号授权。
6. 可选 `indexed` exposure：增量同步、离线缓存、删除传播、TTL、数据驻留策略另立设计，不与 on-demand MVP 混做。

**验收**

- 同一 generic MCP server 在两个 workspace 使用不同账号可并发、无 header/工具串台；
- adapter conformance suite 覆盖 catalog/search/guide/execute/cancel/error/redaction；
- resource/blob/file 有大小、TTL、删除和 workspace 隔离测试；
- Profile 切换撤销旧 requirement 的运行时可见面，但不删除用户 Connection；
- indexed 模式关闭时不产生任何长期外部数据副本。

---

## 7. 可先做候选 TOP 5

| 排名 | 候选 | 体量 | 为什么先做 | 独立验收 |
|---:|---|---:|---|---|
| 1 | OpenConnector MCP 冒烟基线 | XS | 几乎零架构成本，最快验证 4 元工具与现有 credentialRef 是否够用 | no-auth + GitHub default connection 各跑通一次，token 不泄漏 |
| 2 | OAuth refresh 接线 | S/M | 结构、状态和 UI 已存在，缺口集中；同时修真实 MCP 可用性 | expired OAuth 自动 refresh 后 probe/连接成功 |
| 3 | Connector 领域 schema + OpenConnector catalog reader | M | 后续 UI、binding、policy 的共同语言；避免继续把字段塞进 MCP/Credential | fixture contract test + dynamic provider/action list |
| 4 | Requirement / Grant 分离 schema | S/M | Workspace 数据源 feature 的安全根；先定错以后迁移代价最高 | repo requirement 无法自行选择/取用 user credential |
| 5 | 单 backend、只读 Workspace 数据源 MVP | M | 首个用户可感知闭环，范围可控；先验证 Figma/issue/云盘其中一种 | 两 workspace 两账号不串，写操作本地拒绝 |

如果只允许先开一个实现任务，选 TOP 1；如果希望先解决现有产品“按钮能看不能用”的断点，选 TOP 2；如果要正式启动 `Workspace 数据源绑定` 大 feature，先做 TOP 3 + TOP 4 的设计/contract PR，再做 TOP 5。

---

## 8. 推荐的第一个垂直样板

建议首个样板不要选“全功能 Gmail”，而选一个能同时验证 identity、resource selection 与 read-only policy 的窄场景：

### 候选 A：GitHub issues（推荐）

- Connection identity 易验证；
- resource selection 可用 owner/repo；
- read action（list/get/search issue）和 write action（comment/close/create）边界清楚；
- PAT 与 OAuth 都可覆盖；
- mock 与 CI fixture 相对容易。

### 候选 B：Figma file

- 命中 TODO 原例和 LinkTab 已有静态入口；
- file key 是清晰的数据选择范围；
- 对设计型 WorkspaceProfile 有产品价值；
- 但 OAuth app、API 限制和可写能力验收通常比 GitHub 麻烦。

### 候选 C：Google Drive folder

- 最贴近“云盘数据源”；
- 能验证 folder selection、文件中转和多类型内容；
- 但 OAuth、增量同步、导出格式与数据驻留会过早放大范围，适合 Phase 5。

建议顺序：GitHub issues → Figma file → Drive folder。

---

## 9. 需要提前拍板的设计决策

1. **一等 backend**：建议 OpenConnector HTTP adapter；MCP 是 generic/quick path，不承担 named alias 路由。
2. **Connections 页面命名**：建议从 Link 迁为 Connections；`link` 保留为兼容 credential type，不再做新领域主语。
3. **账号授权存放**：建议 user-owned workspace grant store；project/Profile 只放 requirements。
4. **默认 exposure**：建议 on-demand；任何 indexed/context injection 都后置。
5. **默认权限**：无可信只读证据时一律 unknown/write-risk，执行 ask；read-only grant 永不允许未知/写 Action。
6. **Provider secret 归属**：OpenConnector-owned connection 的 provider secret 不复制进 CodeShell；CodeShell 只存 runtime token。Generic MCP OAuth 才由 CodeShell CredentialStore 持有。
7. **Profile 边界**：Profile 能要求某类数据源和最大权限，不能绑定个人账号；用户在每个 workspace 本地满足 requirement。

---

## 10. 风险与规避

| 风险 | 表现 | 规避 |
|---|---|---|
| 把 credential 当 connection | 无法表达账号身份、scope、健康和多账号 | 独立 Connection model |
| repo 静默领用宿主账号 | 恶意项目用 credential id 发外部请求 | requirement/grant 分离 + trust gate + user-owned grant |
| shared MCP 多账号串台 | 同 server 不同 workspace 共用固定 header | named alias 先走 HTTP；generic MCP 后续按 connection 实例化 |
| 大 catalog 撑爆 tool context | 数千 Action 全注册 | 固定元工具 + search/guide 按需加载 |
| 把 provider scope 当资源范围 | OAuth 允许 Drive 全盘，但 workspace 只该看一个 folder | providerScopes/resourceSelection/actionPolicy 三字段分离 |
| OAuth refresh 两套实现漂移 | probe 能刷新但正式连接不能，或相反 | host-owned async refresh service，共用 header resolver |
| secret 走 UseCredential 泄露给 Agent | connector token 出现在 tool result | adapter 只走 CredentialAccess purpose=connector，内部 credential 不对 UseCredential 可见 |
| 对端日志不足 | 难以解释谁在哪个 workspace 调了哪个账号 | CodeShell 本地 routing audit + 对端 execution id 关联 |
| catalogOnly 被误当可执行 | UI/Agent 选中后运行才失败 | discovery 和 policy 都强制检查 execution status |
| 过早做同步/索引 | 数据驻留、删除传播、成本复杂度爆炸 | MVP 仅 on-demand；indexed 独立设计与开关 |
| TODO/源码漂移误导排期 | 重复实现已有 OAuth 类型/UI | 实现前以源码和 feature inventory 为准，更新旧 TODO 状态 |

---

## 11. 最终建议

CodeShell 不需要成为第二个 open-connector。更合适的分工是：

- CodeShell 负责 Workspace、Profile、Agent 工具编排、用户审批和本地 binding policy；
- open-connector/Provider MCP 负责 provider catalog、OAuth/credential boundary 与 Action executor；
- adapter contract 把二者解耦，避免绑定单一供应商；
- Connection 与 WorkspaceSourceGrant 把“已连接账号”安全地分配给具体 workspace；
- 少量元工具和统一 audit 把大 catalog 变成可控的 Agent 能力。

最短可行路径是 Phase 0 先跑通，Phase 1/2 把 catalog 与 Connection 补齐，Phase 3 交付 read-only Workspace 数据源，Phase 4 再开放写 Action。这样每一步都能单独验证，也不会把 TODO 中的 L 级大 feature 一次性压进 MCPManager、CredentialStore 或 LinkTab。
