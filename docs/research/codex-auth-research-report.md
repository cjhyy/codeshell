# Codex CLI / Codex Desktop 登录态管理机制调研报告

> 调研截止：2026-08-07  
> 证据等级：A＝OpenAI 官方文档；B＝openai/codex 当前源码；C＝GitHub Issue 的特定版本复现；D＝社区资料。  
> 注意：Issue 和社区经验不能视为官方产品承诺；`main` 分支实现也可能晚于当前稳定发行版。

## 摘要

Codex 公开支持三类主要认证方式：

1. ChatGPT OAuth 登录；
2. OpenAI Platform API Key；
3. ChatGPT Business/Enterprise 的 Codex Access Token。

ChatGPT OAuth 会产生 access token、refresh token 和 ID token，并由客户端自动刷新。API Key 不存在 OAuth 刷新流程。Codex Access Token 则是面向可信企业自动化的、由 workspace 管理的非交互凭证。[Authentication — OpenAI Codex Docs](https://learn.chatgpt.com/docs/auth)（A）；[Access tokens — OpenAI Codex Docs](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）

两个重要结论：

- "约 8 天"不是 access token 的固定寿命。当前实现优先依据 JWT 的 `exp`，在剩余约 5 分钟时刷新；约 8 天只是无法依据 `exp` 判断时，对 `last_refresh` 的兜底阈值。[Auth manager — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)（B）
- Codex 主登录和 MCP OAuth 是两套独立凭证系统。主登录刷新正常，不代表 MCP token 在所有发行版中也会正常刷新。[MCP OAuth implementation — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth.rs)（B）

## 1. 认证方式

| 方式 | 入口与用途 | 存储与刷新 |
|---|---|---|
| ChatGPT OAuth | `codex login`；支持浏览器 OAuth，以及 beta 的 `codex login --device-auth` | 保存 ID/access/refresh token；使用期间自动刷新 |
| Platform API Key | `printenv OPENAI_API_KEY \| codex login --with-api-key` | 可持久化到主凭证存储；没有 refresh token |
| 单次 API Key | 只对一次 `codex exec` 设置 `CODEX_API_KEY` | 不写入登录缓存，适合 CI |
| Codex Access Token | `CODEX_ACCESS_TOKEN`，或传给 `codex login --with-access-token` | 环境变量模式不落盘；login 模式持久化 agent identity |
| 自定义 provider 凭证 | provider 配置中的 `env_key`、宿主 headers 或外部 auth tokens | 由外部提供方管理，不是普通 OpenAI 登录菜单 |

来源：[Authentication](https://learn.chatgpt.com/docs/auth)（A）；[Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)（A）；[Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）

补充行为：

- `codex login status` 查看状态，`codex logout` 清除登录。
- CLI 与 IDE 扩展共享登录缓存，一处退出后另一处也需重新登录。
- Codex Cloud 必须使用 ChatGPT 登录；本地 CLI、IDE 和 App 可选择 ChatGPT 或 API Key，但 API Key 模式可能缺少部分 ChatGPT 账号能力。
- 企业可设置 `forced_login_method = "chatgpt"` 或 `"api"`，以及 `forced_chatgpt_workspace_id`。凭证与强制策略不匹配时，客户端会退出当前登录并要求重新认证。

来源：[Authentication](https://learn.chatgpt.com/docs/auth)（A）

## 2. OAuth 登录流程

### 2.1 浏览器 OAuth + PKCE

当前源码中的流程如下：

1. CLI 启动 loopback HTTP 回调服务器，默认从本地端口 1455 开始。
2. 生成随机 `state`、PKCE verifier 和 S256 challenge。
3. 打开 `https://auth.openai.com` 的授权页，请求 `openid`、`profile`、`email`、`offline_access` 及连接器相关 scope。
4. 用户在浏览器完成 ChatGPT 登录和 workspace 选择。
5. 授权服务器回调 `http://localhost:<port>/auth/callback`。
6. CLI 校验 `state`，然后向 `/oauth/token` 提交 authorization code、redirect URI、client ID 和 PKCE verifier。
7. 服务端返回 ID token、access token、refresh token。
8. 客户端验证 workspace 约束，并写入 keyring 或 `auth.json`。

实现来源：[Browser login server — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)（B）

在 SSH 环境中，官方支持转发 loopback 回调端口，也允许将已登录机器上的 `auth.json` 复制到远程机器。不过官方明确要求把该文件当作密码处理；新的无头部署应优先使用 device auth。[Authentication](https://learn.chatgpt.com/docs/auth)（A）

### 2.2 Device-code 流程

Device auth 当前为 beta，必须在个人安全设置或 workspace 权限中启用。入口为：

```text
codex login --device-auth
```

实现序列：

1. 客户端向 `/api/accounts/deviceauth/usercode` 请求 device auth ID、一次性用户码和轮询间隔。
2. 用户在另一台有浏览器的设备打开 Codex device 页面，输入一次性码。
3. CLI 轮询 `/api/accounts/deviceauth/token`；当前实现最长等待约 15 分钟。
4. 成功后得到 authorization code 和 PKCE 材料。
5. 再向 `/oauth/token` 交换 ID/access/refresh token。
6. 使用与浏览器登录相同的凭证存储策略。

来源：[Device-code auth — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)（B）；[Authentication](https://learn.chatgpt.com/docs/auth)（A）

[#3820 — Enable Headless or Command-line Authentication](https://github.com/openai/codex/issues/3820) 记录了早期 browser-only 登录对 SSH 环境不友好的问题；该 Issue 后来以重复项关闭，当前 device-auth 已覆盖其主要诉求。（C）

## 3. Token 存储

### 3.1 主凭证存储模式

`cli_auth_credentials_store` 支持：

- `file`：保存到 `$CODEX_HOME/auth.json`；
- `keyring`：只保存到系统凭证库，不可用时失败；
- `auto`：优先 keyring，不可用时退化到文件；
- 当前内部 schema 还存在进程内 `ephemeral` 模式，但不是主要公开登录配置。

一个容易混淆的点是：**当前 CLI 主登录的默认值仍是 `file`，不是 `auto`**；MCP OAuth 的默认策略才是 `auto`。OpenAI 内部受管环境则显式强制使用 keyring。[CLI login source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/login.rs)（B）；[Configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)（B）；[Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)（A）

在 `auto` 模式中：

- 读取时先查 keyring，再退回文件；
- keyring 写入成功后可移除旧 `auth.json`；
- keyring 不可用或写入失败时会产生明文 `auth.json`。

来源：[Auth storage — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)（B）

### 3.2 macOS、Windows、Linux Keyring

当前主凭证条目使用：

- service：`Codex Auth`
- account：`cli|<hash>`
- `<hash>`：规范化 `CODEX_HOME` 路径的 SHA-256 前 16 个十六进制字符
- password/value：序列化后的完整 auth JSON

因此不同 `CODEX_HOME` 会对应不同 keyring account，可用于账户隔离。[Auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)（B）

平台映射：

| 平台 | 后端 |
|---|---|
| macOS | Security.framework / Keychain |
| Windows | Windows Credential Manager |
| Linux | Linux native keyring、kernel keyutils 与 DBus Secret Service 持久层 |
| 部分 BSD/Unix | Secret Service 后端 |

来源：[Codex keyring-store Cargo.toml](https://github.com/openai/codex/blob/main/codex-rs/keyring-store/Cargo.toml)（B）；[keyring-store implementation](https://github.com/openai/codex/blob/main/codex-rs/keyring-store/src/lib.rs)（B）；[Rust keyring backend features](https://docs.rs/crate/keyring/3.6.2/source/Cargo.toml.orig)（B）

Linux 上是否真正可用，取决于桌面会话、DBus、Secret Service 和系统 keyring 状态；无头 runner 因此更容易退化到文件。

### 3.3 `auth.json` 格式

典型 ChatGPT 登录文件：

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "<JWT>",
    "refresh_token": "<rotating secret>",
    "account_id": "<workspace/account id>"
  },
  "last_refresh": "<RFC3339 UTC>"
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `auth_mode` | 当前认证模式 |
| `OPENAI_API_KEY` | API Key 或兼容路径使用的可选值 |
| `tokens.id_token` | 身份及组织信息 JWT |
| `tokens.access_token` | 请求 Codex 服务的 bearer token |
| `tokens.refresh_token` | 用于轮换 access token 的秘密 |
| `tokens.account_id` | 可选账户/workspace 标识 |
| `last_refresh` | 最近一次成功刷新时间 |

当前 `main` 还存在 `agent_identity`、`personal_access_token`、`bedrock_api_key` 等可选兼容字段；这些属于演进中的实现细节，不宜作为稳定 schema 依赖。[Auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)（B）；[Token data model](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs)（B）

Unix 下文件权限为 0600，但内容仍是明文，能够被同一用户权限下的进程、错误备份或恶意扩展读取。

### 3.4 MCP OAuth 存储

MCP OAuth 独立使用：

- 配置：`mcp_oauth_credentials_store`
- keyring service：`Codex MCP Credentials`
- 文件回退：`$CODEX_HOME/.credentials.json`

MCP 条目包含 server name、URL、client ID、token response、access token、refresh token、scope 和可选 `expires_at`。它不会存入主登录的 `auth.json`。[MCP OAuth implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth.rs)（B）

## 4. Token 刷新策略

### 生命周期

| 凭证 | 固定有效期 | Codex 行为 |
|---|---|---|
| ChatGPT access token | 官方未公开承诺固定 TTL | 根据 JWT `exp`，到期前约 5 分钟刷新 |
| ChatGPT refresh token | 官方未公开固定 TTL | 可轮换、过期、撤销或被判定为 reused |
| `last_refresh` | 不是 token TTL | 无法利用 `exp` 时，约 8 天作为兜底刷新阈值 |
| API Key | 非 OAuth token | 无客户端 refresh |
| Codex Access Token | 创建时选择有限期限；管理员可决定是否允许无到期 | 到期后由企业流程轮换 |
| MCP token | 由 MCP provider 的 `expires_in` 决定 | 当前 `main` 在到期前约 30 秒进入刷新路径 |

来源：[Auth manager](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)（B）；[CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)（A）；[Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）；[MCP OAuth implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth.rs)（B）

### 主登录刷新过程

1. 检查 access-token JWT `exp`。
2. 剩余不超过约 5 分钟时主动刷新。
3. 若无法使用 `exp`，检查 `last_refresh` 是否超过约 8 天。
4. 同一进程内使用单许可 semaphore 串行刷新。
5. 刷新前重新加载存储；若其他执行者已经写入新凭证，则跳过远端刷新。
6. 向 `https://auth.openai.com/oauth/token` 发送 refresh-token grant。
7. 保存返回的新 access、ID 和 refresh token，更新 `last_refresh`。
8. 主动刷新临时失败时，可暂时返回旧 auth；后续请求若收到 401，则重新加载、刷新并有限重试。
9. `refresh_token_expired`、`refresh_token_reused`、`refresh_token_invalidated` 会被视为永久失败，并提示重新登录。

来源：[Auth manager](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)（B）

### Refresh token 是否 single-use

证据显示它采用旋转、单链消费语义：

- 成功刷新后客户端保存服务端返回的新 refresh token；
- 源码明确识别 `refresh_token_reused`；
- 官方 CI 文档要求一份 `auth.json` 只能由一台机器或一个串行 job 流消费；
- 多个 Issue 复现了旧 token 被再次使用后失败。

因此工程上应把它视为 single-use rotating token：一台机器兑换后，其他副本中的旧值可能立即失效。官方没有把所有协议细节写成长期稳定契约，最可靠的规则是**禁止并发复制和消费同一 refresh-token 链**。[CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)（A）；[Auth manager](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)（B）；[#9634 — refresh token already used](https://github.com/openai/codex/issues/9634)（C）

## 5. `~/.codex/` 目录结构

`CODEX_HOME` 默认是 `~/.codex`，可指向其他已经存在的目录。[Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)（A）

| 路径 | 作用 |
|---|---|
| `config.toml` | 用户配置、认证存储策略、MCP servers、功能开关 |
| `auth.json` | 主登录文件凭证 |
| `.credentials.json` | MCP OAuth 文件凭证 |
| `sessions/YYYY/MM/DD/*.jsonl` | 会话 rollout |
| `session_index.jsonl` | 会话索引 |
| `history.jsonl` | 可选交互历史 |
| `memories/` | memory 功能内容；当前名称是复数 |
| `log/`、`codex-login.log` | 运行与登录诊断日志 |
| `state_*.sqlite`、`logs_*.sqlite` 等 | 内部线程、日志和索引数据库 |

来源：[Config and state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)（A）；[App server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)（B）；[Agent Safehouse Codex investigation](https://agent-safehouse.dev/docs/agent-investigations/codex)（D）

`state_4.sqlite`、`state_5.sqlite`、`logs_2.sqlite` 等数字属于 schema generation，不是稳定 API，不应写死在备份或迁移脚本中。InventiveHQ 的目录文章可作布局参考，但属于特定版本快照。[Where Codex configuration files are stored — InventiveHQ](https://inventivehq.com/knowledge-base/openai/where-configuration-files-are-stored)（D）

## 6. CI/CD 与无头环境

推荐优先级：

1. **普通 CI 使用 API Key。** 官方将其列为默认方案，并推荐 Codex GitHub Action。单次执行使用 `CODEX_API_KEY`，避免把秘密暴露给整个会执行仓库代码的 job。[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode#use-api-key-auth)（A）
2. **Business/Enterprise 使用 Codex Access Token。** Token 绑定用户和 workspace，适用于可信非交互工作流。[Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）
3. **环境变量注入优先。** `CODEX_ACCESS_TOKEN` 不落盘；`codex login --with-access-token` 才会持久化凭证。
4. **ChatGPT `auth.json` 方案仅用于高级场景。** 必须使用可信私有 runner，持久化每次刷新产生的新文件，不能在每个 job 开始时用旧 seed 覆盖。
5. **一个文件只允许一个写者。** 临时 runner 必须有加密 write-back 和跨 job 串行锁。

Codex Access Token：

- 支持 ChatGPT Business 和 Enterprise；
- 由 ChatGPT workspace 管理；
- token 创建权限与 Codex Local 权限是两个独立控制项；
- 可选择 7、30、60、90 天等期限，最短自定义期限为 1 天；
- 管理员可决定是否允许无到期；
- token 只显示一次；
- 推荐轮换顺序为"创建新 token—替换 secret—验证—撤销旧 token"。

来源：[Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）

app-server 的身份 token 不能直接充当 WebSocket transport token；业务身份和传输层认证是不同边界。[Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)（A）

## 7. 多账号切换

截至调研截止日，Codex 没有在同一个 `CODEX_HOME` 下维护多个命名登录凭证并原生切换的稳定功能。相关 `--auth-profile` 请求仍在公开 Issue 中。[#4432 — First-class multi-account auth](https://github.com/openai/codex/issues/4432)（C）

现有 `--profile` 是配置层选择，不是认证账户切换器。[Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)（A）

较安全的社区做法是每个账号使用独立 `CODEX_HOME`：

```bash
CODEX_HOME="$HOME/.codex-work" codex
CODEX_HOME="$HOME/.codex-personal" codex
```

这会隔离：

- `auth.json`
- Codex 配置
- MCP 凭证
- sessions/history/memories
- 当前实现中的 keyring account

来源：[Auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)（B）；[codex-profiles discussion #30852](https://github.com/openai/codex/discussions/30852)（D）

社区还存在 shell alias、codex-profiles、codex-switcher 等工具。它们不是 OpenAI 官方功能；若工具需要导出或复制 `auth.json`，会增加 token 泄露、刷新分叉和供应链风险。[Switch between multiple Codex accounts — Reddit](https://www.reddit.com/r/codex/comments/1ot9zck/switch_between_multiple_codex_accounts_instantly/)（D）；[Using more than one account — Reddit](https://www.reddit.com/r/codex/comments/1ql0pai/using_more_than_1_account/)（D）

独立 `CODEX_HOME` 不会隔离浏览器 cookie、SSH agent、Git credential helper 等 OS 级身份；强隔离需要不同 OS 用户、容器、虚拟机或 runner。

## 8. 已知问题

| 问题 | 发现与判断 |
|---|---|
| `auth.json` 跨机器复制 | [#15502](https://github.com/openai/codex/issues/15502) 报告 CLI 0.116 中复制后刷新成功但会话仍被拒绝；结合 rotating refresh token，最可能是两台机器产生分叉或旧 seed 覆盖新状态。（C） |
| "refresh token already used" | [#9634](https://github.com/openai/codex/issues/9634) 记录相同后端错误。应使用单写者、device auth 或各机器独立登录。（C） |
| Desktop 重连死循环 | [#25599 — Desktop stays offline](https://github.com/openai/codex/issues/25599) 报告 Windows Desktop 在 refresh token reused 后持续离线、重连无效。（C） |
| 活动会话中 token revoked 后卡住 | [#25443 — Desktop gets stuck with refresh-token-revoked](https://github.com/openai/codex/issues/25443) 报告 macOS 当前 thread 无法恢复；维护者未获得确定复现。（C） |
| MCP token 启动前不刷新 | [#27165](https://github.com/openai/codex/issues/27165) 在 bundled CLI 0.137 alpha 中观察到已过期 access token、有 refresh token，却没有请求 token endpoint。（C） |
| Routed MCP OAuth 不刷新 | [#17265](https://github.com/openai/codex/issues/17265) 报告 `.credentials.json` 中的 MCP token 需要手工重新登录。（C） |
| 早期无头登录缺口 | [#3820](https://github.com/openai/codex/issues/3820) 后被 device-auth 方案覆盖。（C） |

当前 `main` 的 MCP 实现已有：

- 到期时间检查；
- 约 30 秒刷新裕量；
- refresh 锁和事务；
- 在首次请求前把已过期 token 标记为需要刷新。

但 #27165 和 #17265 的复现来自较早发行版，Issue 仍不能据 `main` 源码直接宣告在所有稳定版本中已修复。[MCP OAuth implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth.rs)（B）

## 9. 安全设计

1. **高安全环境显式使用 keyring。** 建议配置 `cli_auth_credentials_store = "keyring"` 和 `mcp_oauth_credentials_store = "keyring"`。OpenAI 内部环境也采用这两个设置。[Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)（A）
2. **不要认为 `auto` 保证不落盘。** keyring 失败时它会回退到明文文件。
3. **使用强制登录策略。** 企业可强制 ChatGPT/API 登录并固定 workspace。[Authentication](https://learn.chatgpt.com/docs/auth)（A）
4. **沙箱不是凭证加密。** Sandbox 控制文件、网络及受保护路径，approval 控制越界操作；它只能降低凭证被不可信代码读取或外传的机会，不能替代 keyring 和秘密轮换。[Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)（A）
5. **主登录和 MCP 文件都按密码处理。** `auth.json` 和 `.credentials.json` 都可能含长期可轮换秘密。
6. **限制网络出口。** 企业可通过托管网络策略限制允许域，并使用 OTEL/合规日志审计 Codex 行为。[Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)（A）
7. **日志必须脱敏。** `codex-login.log`、回调 URL、bearer token、workspace/account ID 不应直接上传到公开 Issue。
8. **企业 TLS 检查使用自定义 CA。** 支持 `CODEX_CA_CERTIFICATE`，兼容回退为 `SSL_CERT_FILE`；不应关闭 TLS 校验。[Authentication](https://learn.chatgpt.com/docs/auth)（A）

## 10. 总结对照表

| 维度 | Codex 做法 |
|---|---|
| 认证方式 | ChatGPT OAuth、Platform API Key、企业 Codex Access Token |
| Browser OAuth | Loopback callback、state、PKCE S256、authorization-code exchange |
| Device flow | 一次性码、浏览器确认、CLI 轮询、最终 token exchange |
| 主凭证文件 | `$CODEX_HOME/auth.json` |
| 主 keyring | service 为 `Codex Auth`，account 与 `CODEX_HOME` 哈希绑定 |
| 平台安全存储 | macOS Keychain、Windows Credential Manager、Linux keyring/Secret Service |
| 主登录默认存储 | 当前 CLI 为 `file`；可显式改为 `keyring` 或 `auto` |
| MCP 存储 | `Codex MCP Credentials` 或 `.credentials.json`；默认策略为 `auto` |
| Access token 刷新 | JWT 到期前约 5 分钟 |
| 约 8 天 | `last_refresh` 兜底阈值，不是 access-token TTL |
| Refresh token | 旋转、旧值可能 single-use；可过期、撤销或 reused |
| 刷新失败 | 临时失败保留旧 auth；401 后重新加载/刷新/有限重试；永久失败要求重登 |
| CI/CD | 默认 API Key；企业可用 Access Token；`auth.json` 仅限可信单写者 runner |
| 多账号 | 无原生 auth-profile；使用独立 `CODEX_HOME` |
| Desktop 已知问题 | reused/revoked token 后可能进入离线或重新认证死循环 |
| MCP 已知问题 | 部分历史发行版不会在启动或请求前自动刷新 OAuth token |
| 安全边界 | keyring、forced login/workspace、sandbox、approval、网络策略和审计共同构成 |

## 最终结论

Codex 主登录机制具备完整 OAuth、PKCE、token rotation、主动刷新和 401 恢复路径。实际故障最集中的地方不是"客户端完全不刷新"，而是多个消费者共享或复制同一 refresh-token 链。

建议按场景选择：

- 个人交互：ChatGPT OAuth + 显式 keyring；
- SSH/无头：优先 device auth；
- 普通 CI：最小范围注入 API Key；
- Business/Enterprise 自动化：Codex Access Token；
- 必须在 CI 使用 ChatGPT 权益：可信私有 runner、持久化最新 `auth.json`、严格单写者；
- 多账号：每个账号独立 `CODEX_HOME`；
- MCP：单独检查 MCP keyring/`.credentials.json` 和实际发行版本，不能由 Codex 主登录状态推断其刷新是否正常。
