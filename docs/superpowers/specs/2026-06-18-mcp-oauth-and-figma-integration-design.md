# MCP OAuth 能力 + Figma 官方集成卡片 — 设计文档

- 日期：2026-06-18
- 状态：**已设计，暂不实现**（spec 存档，待后续启动）
- 范围：core + desktop
- 关联记忆：`project_mcp_name_key_contract`、`project_browser_login_window`、`project_core_minimal_harness_business_layer`、`project_plugin_bundled_mcp_display`、`project_multi_account_cookie_creds`

---

## 1. 背景与动机

OpenAI Codex 把 Figma 做成一个一键"官方集成"卡片：点"连接 Figma" → 弹 OAuth 同意屏 → 跳 Figma 授权 → 回来连上 → AI 即可调用 Figma 的设计读取工具（`get_metadata` / `get_design_context` / `get_screenshot`），边读 Figma 设计边读本地代码生成 UI。

经查证，这背后**全是 Figma 官方远程 MCP server**（`https://mcp.figma.com/mcp`）在出力，Codex 本身不实现任何 Figma 业务逻辑——它只是"一个接入 Figma 官方 MCP 的客户端"。

要让 codeshell 复刻这个体验，唯一的硬门槛是 **OAuth**：

- Figma 远程 MCP **只认 OAuth 2.0，明确不支持 PAT（个人访问令牌），且该限制无法开启**（[Figma 官方文档](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)）。
- OAuth token 是**绑定到发起授权的客户端**的安全凭据，**故意不可导出/转交**——不能借用 Codex 已授权的 token，codeshell 必须作为独立 OAuth 客户端自己走一遍授权。

经查证，codeshell 已具备实现该能力的全部零件，缺的只是"把它们接起来"：

- `@modelcontextprotocol/sdk@1.29.0` 的 `StreamableHTTPClientTransport` **原生支持** OAuth（`authProvider?: OAuthClientProvider`，401 自动触发授权、PKCE、WWW-Authenticate 解析全有）。
- `packages/core/src/services/oauth.ts` 已有完整的 OAuth 2.0 + PKCE 实现（浏览器授权流、code 交换、token 刷新、localhost 回调）。
- 已有"独立 BrowserWindow 登录窗"基础设施（`project_browser_login_window`），可用于弹授权同意屏。
- 已有 `CredentialStore`（`~/.code-shell/credentials/`，`0600`）可作 token 落盘保险柜。

**但当前未接通**：`MCPServerConfig` 只支持静态鉴权（`headers`/`bearerTokenEnvVar`/`envHeaders`/`credentialRef`），`mcp-manager.ts` 连 HTTP transport 时**完全没传 `authProvider`**。

---

## 2. 目标与非目标

### 目标

1. **通用 MCP OAuth 能力**：让 codeshell 能连接任意 OAuth-only 的 streamable-HTTP MCP server，不限于 Figma。
2. **Figma 官方集成卡片**：上层放一个像 Codex 截图那样的一键卡片，预填 Figma 远程 MCP 端点，点一下走完整授权流。
3. **授权窗走应用内独立 BrowserWindow**，体验不跳出应用（对齐 Codex 的同意屏体验）。
4. **client_id 默认走 DCR**（RFC 7591 动态客户端注册，用户零配置），**可选手填** `client_id`/`secret`/`scopes` 以兼容不支持 DCR 的 server。
5. **token 由 codeshell 自己授权、自己持有、不外露**：落 `CredentialStore`（`0600`），仅 `McpOAuthProvider` 内部读取并喂给 MCP transport，刷新由 SDK 自动完成。

### 非目标（YAGNI）

- **不做 Figma REST API 路线**（PAT 走 REST）——用户已排除。
- **不做自研 Figma 工具/新面板**——授权后 Figma 工具由 server 提供，走现有 MCPTool 通道自动出现。
- **不补 STDIO 的 `cwd`/`envVars`-UI**——那是另一条"对齐 Codex 通用 MCP 配置 UI"的工作线，与本期 OAuth 无关，不在范围。
- **不做 headless/TUI 的 OAuth 授权**——本期只接 Electron 桌面；core 留好注入接口，以后接别的弹窗钩子。
- **不提供 token 导出/读取/转交接口**——OAuth token 只进不出，不接入凭证 UI 三 tab、不走 `UseCredential`、不给 AI、不给用户脚本。

---

## 3. 关键决策（来自 brainstorming 澄清）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 鉴权方式 | OAuth（非 PAT） | Figma 官方远程 MCP 只认 OAuth，PAT 无法用于官方 MCP |
| 入口形态 | 通用 OAuth MCP 能力 + Figma 独立卡片 | 对齐 Codex：Figma 是独立集成卡片，不挤进通用 MCP 列表；底层做通用 |
| 授权窗 | 应用内独立 BrowserWindow | 复用现有登录窗设施，体验不跳出应用 |
| client_id | DCR 优先 + 可选手填 | 最通用，Figma 支持 DCR 故用户零配置 |
| token 处理 | 自己授权、自己持有、落盘但不外露 | OAuth token 不可导出/转交，安全设计 |
| OAuth 链路定位 | **独立链路**，不复用现有凭证 UI/UseCredential | 静态密钥 vs 动态授权流，本质不同；只借 CredentialStore 物理存储 |

### OAuth 为何是独立链路

| | 现有 link/token 凭证 | OAuth（本期新链路） |
|---|---|---|
| 怎么拿到 | 用户手填一个值 | 弹浏览器 → Figma 同意 → 换回 token |
| 过期 | 静态不过期 | access token 过期，refresh token 自动续 |
| 客户端身份 | 不需要 | 需要 client_id（DCR 动态注册） |
| 取用方式 | `UseCredential` 读出值给 AI/工具 | **只进不出**，SDK 内部用，不暴露 |
| 触发者 | 用户 | SDK 连接时遇 401 自动触发 |

结论：OAuth 不复用 `CredentialsPage` 手填表单、不复用 `UseCredential` 工具；新增独立 `McpOAuthProvider`；token 借 `CredentialStore` 落盘但绝不接进"取凭证给 AI"那套。

---

## 4. 架构与数据流

```
┌─ Figma 集成卡片 (renderer/settings)              ← Codex 截图3 那个一键卡片
│   预填 url=https://mcp.figma.com/mcp,
│        transport=streamable-http, auth=oauth
│   点"连接" → 写入 mcpServers.figma → 触发连接
│
├─ MCPServerConfig 扩展 (core/src/types.ts)
│   新增 auth?: "oauth"
│        oauth?: { clientId?, clientSecret?, scopes?, registration?: "dynamic"|"manual" }
│
├─ McpOAuthProvider (core 新文件, implements SDK OAuthClientProvider)
│   ├─ 复用 services/oauth.ts 的 PKCE / code 交换 / 刷新
│   ├─ 默认 DCR (RFC 7591) 注册 client；config 有手填 clientId 则用手填
│   ├─ tokens()/saveTokens()/clientInformation() → CredentialStore (id: mcp-oauth-<server>)
│   └─ redirectToAuthorization(url) → 调用注入的"弹窗钩子"（不直接碰 Electron）
│
├─ mcp-manager.ts performConnect()
│   检测 config.auth==="oauth"
│     → new McpOAuthProvider({ server, credStore, openAuthWindow })
│     → new StreamableHTTPClientTransport(url, { authProvider })
│   首次连 → 401 → SDK 自动调 redirectToAuthorization
│
└─ desktop main: openAuthWindow 钩子实现
    → 开独立 BrowserWindow 加载授权 URL (复用 browser-login-window 设施)
    → 用户在 Figma 同意 → 重定向到 localhost 回调端口 → 抓 ?code= → 关窗
    → SDK 用 code 换 token → McpOAuthProvider 存 CredentialStore → 连接完成
```

### 边界原则（符合 `project_core_minimal_harness_business_layer`，业务可整块拎出）

- `McpOAuthProvider` 是自包含 core 模块，依赖：`services/oauth.ts` + `CredentialStore` + 一个**注入的弹窗钩子**。
- **core 不直接碰 Electron**——`redirectToAuthorization` 通过依赖注入的 `openAuthWindow(url, redirectUri): Promise<code>` 钩子由 desktop 实现。headless/TUI 以后注入别的钩子（如 `shell.openExternal`）。
- token 落 `CredentialStore`，下次连接免授权（SDK 自动用 refresh token）。

---

## 5. 组件拆分

### 5.1 core 改动

**A. `packages/core/src/types.ts` — 扩展 `MCPServerConfig`**
- 新增 `auth?: "oauth"`（缺省=现有静态鉴权，向后兼容）。
- 新增 `oauth?: { clientId?, clientSecret?, scopes?: string[], registration?: "dynamic" | "manual" }`。
- 所有字段可选，旧配置不受影响。
- 注意 `project_mcp_name_key_contract`：server 名由 record key 承载，新增字段不引入 `name` 必填回归。

**B. `packages/core/src/tool-system/mcp-oauth-provider.ts` —（新文件）实现 SDK `OAuthClientProvider`**
- 实现 SDK 要求的方法：`redirectUrl`、`clientMetadata`、`clientInformation()`、`saveClientInformation()`、`tokens()`、`saveTokens()`、`redirectToAuthorization()`、`saveCodeVerifier()`、`codeVerifier()`、`state()` 等。
- DCR：首次无 client 信息时走动态注册；config 提供 `clientId` 则跳过 DCR 用手填。
- 持久化：client 信息 + tokens 存 `CredentialStore`，key=`mcp-oauth-<serverName>`，`0600`。
- `redirectToAuthorization(url)` → 调用构造时注入的 `openAuthWindow` 钩子，等待回调返回的 authorization code，交给 SDK 完成 token 交换。
- 复用 `services/oauth.ts` 已有的 PKCE 生成、localhost 回调端口（18910+随机）、token 刷新逻辑（抽出可复用部分，避免重复实现）。

**C. `packages/core/src/tool-system/mcp-manager.ts` — `performConnect()` 接 authProvider**
- HTTP/streamable-http 分支：若 `config.auth==="oauth"`，构造 `McpOAuthProvider` 并传入 `new StreamableHTTPClientTransport(url, { authProvider, requestInit })`。
- 静态鉴权路径保持不变（`buildHttpHeaders` 原样）。
- `openAuthWindow` 钩子从 manager 的构造/配置注入（由宿主提供），core 不硬依赖 Electron。

**D. `packages/desktop/src/main/mcp-probe-service.ts` — 探测时的处理**
- 探测（probe）OAuth server 时：若无有效 token，不应阻塞 UI 弹授权；标记为"需授权"状态返回，由用户在卡片上主动点"连接"才触发授权流。
- 已授权（有 token）则正常探测工具列表。

### 5.2 desktop 改动

**E. `openAuthWindow` 钩子实现（main 进程）**
- 复用 `project_browser_login_window` 的独立 BrowserWindow 设施：开窗加载授权 URL，监听重定向到 `redirect_uri`（localhost），抓 `?code=` 与 `state`，校验 state 后关窗返回 code。
- 处理用户关窗/拒绝授权 → reject，上层显示"授权已取消"。
- 复用现有登录窗的坑规避（SPA 浮窗注入、`loadURL` 吞 `ERR_ABORTED`、防外链门）。

**F. Figma 集成卡片 UI（renderer/settings）**
- 在 MCP 设置区域上方放一个独立"官方集成"卡片（参考 `project_plugin_bundled_mcp_display` 的分组渲染习惯，但这是独立卡片不是插件组）。
- 卡片内容：Figma logo + "连接 Figma" + 状态（未连接/已授权/授权失败）。
- 点"连接" → 写入 `mcpServers.figma = { url: "https://mcp.figma.com/mcp", transport: "streamable-http", auth: "oauth" }` → 触发连接（进而触发授权流）。
- 已连接显示工具数 + "断开"（断开=删 mcpServers.figma + 清 `mcp-oauth-figma` 凭证）。
- 走现有 toast/confirm 反馈（`project_desktop_toast`、`project_dialog_unification`），i18n 走 `useT`（`project_desktop_i18n`，加 key 必 zh+en）。

**G.（可选，低优先）通用 MCP 编辑器加 OAuth 选项**
- 在 `McpSection.tsx` 的 HTTP 模式 advanced 里加一个 "OAuth" 鉴权选项（auth=oauth + 可选手填 client_id），让用户也能手动加任意 OAuth MCP，不止 Figma。
- 本期可只做 Figma 卡片，通用编辑器 OAuth 选项留作紧随其后的小步。

---

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 用户关闭授权窗/拒绝 | `openAuthWindow` reject → 卡片显示"授权已取消"，不写坏配置 |
| DCR 注册失败（server 不支持） | 提示"该 server 不支持自动注册，请手填 client_id"，引导走手填路径 |
| token 过期 | SDK 自动用 refresh token 续；续失败 → 标记"需重新授权"，用户点卡片重走授权 |
| 回调 state 不匹配 | 拒绝（防 CSRF），提示授权失败重试 |
| 401 但非 OAuth server | 沿用现有 `humanizeError`（`project_mcp_auth_error_ux`）三类提示，不误导 |
| 网络/超时 | 复用现有 MCP 连接错误展示；注意 RPC 长任务超时豁免（`project_rpc_30s_timeout_freeze`），授权流可能耗时长 |
| token 存储读写失败 | 降级为"未授权"，不崩 engine（参考 `project_bashoutput_preset_whitelist_bug` 软回灌习惯） |

---

## 7. 测试策略

- **单元（core）**：
  - `McpOAuthProvider` 各方法：mock CredentialStore，验证 client 信息/token 存取、DCR vs 手填分支、code verifier 持久化。
  - mock SDK 的 401→redirect→token 流，验证 `redirectToAuthorization` 调用注入钩子并完成交换。
  - 向后兼容：`auth` 缺省时静态鉴权路径不变。
- **单元（oauth.ts 复用部分）**：PKCE 生成、state 校验、token 刷新。
- **集成（desktop）**：mock `openAuthWindow` 返回固定 code，验证 manager 接通 authProvider 后能建立连接（用一个 mock OAuth MCP server）。
- **真机冒烟（待用户跑）**：实连 `mcp.figma.com/mcp`，点 Figma 卡片 → 独立窗弹 Figma 同意屏 → 授权 → 工具列表出现 `get_design_context` 等 → 给一个 Figma URL 让 AI 读设计生成代码。
- 测试隔离注意 `project_test_pollutes_real_settings`：用 `CODE_SHELL_HOME` 隔离，core 写路径用 `userHome()` 不裸 `homedir()`；bun test 带 `src/` 避 dist 旧测试。

---

## 8. 实施注意（动手时）

- **走 worktree，不动 main**（`feedback_git_commit_on_main`：功能/大改动走 worktree）。
- 改 core 必 rebuild，desktop 有独立 typecheck/build（`project_extensions_ui`）。
- 测新功能必在对应 worktree 跑 app（`project_browser_login_window` 教训）。
- SDK 版本 `@modelcontextprotocol/sdk@1.29.0` 已支持 OAuth，无需升级。

---

## 9. 待澄清/留口（不阻塞 spec）

- 通用 MCP 编辑器的 OAuth 选项（5.2-G）做不做、何时做。
- 多 Figma 账号/多 workspace 是否需要（本期单连接，多账号留后）。
- headless/TUI 的授权钩子形态（本期只 desktop）。
