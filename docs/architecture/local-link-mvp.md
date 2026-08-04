# Local-first Link MVP

## 目标与边界

Link 是第三方应用连接层，不是 MCP。MCP 继续处理标准 MCP Server；Link 负责 GitHub、Figma、
Slack 等 Provider 的账号连接、固定 Action 和本地/服务器执行路由。

本阶段交付 10 个无需 CodeShell Server 回调的本地 Provider，其中 GitHub、GitLab、Notion、Todoist、
Vercel 可直接绑定官方 CLI 登录态，且不把服务商 Token 复制进 CodeShell；10 个 Provider 均保留手动
Token / App 备用方式。每个 Provider 在页面中同时保留本地和服务器两种独立连接方式，后续接
GitHub App / OAuth / Link Server 时不改 Action ID。

## 当前实现

```text
@cjhyy/code-shell-link（可独立发布）
├── provider manifest：分类、展示、连接方式
├── auth guide：官方入口、最小权限、双语步骤
├── quickAuth：可复用的官方 CLI 会话声明
└── actionIds：跨本地/服务器保持稳定

Core local executor
├── HTTP Token backend：每次从安全凭证库实时解析 Token
├── CLI session backend：固定命令/参数 allowlist，不导出服务商 Token
└── actions[]：discovery/read 直接执行，write 固定审批

Desktop Link page
├── local connection -> Electron main -> safeStorage CredentialStore
└── server connection -> OAuth / Link Server（独立 credential，后续接入）

Chat LinkAction
├── 每次调用重新解析 credential
├── CLI Action 每次核对当前账号与连接时账号一致
├── local ACTIVE + capability match -> local executor
├── local 不可用 -> future server executor
└── disconnected/replaced -> abort in-flight + fail next call
```

实现落点：

- `packages/link`：零 CodeShell 依赖的独立 Provider 清单包；可以后续迁成单独仓库并独立发版。
- `packages/core/src/links/providers.ts`：可信 Provider 校验和固定 Action 执行器，不反向依赖清单包。
- `packages/core/src/links/http.ts`：HTTPS host allowlist、20 秒超时、禁止重定向、1 MB 流式响应上限。
- `packages/core/src/links/cli.ts`：五个官方 CLI 的固定 argv、账号校验、输出裁剪、超时与取消。
- `packages/core/src/links/link-action-tool.ts`：聊天工具、local-first 解析、写操作审批、断连取消。
- `packages/desktop/src/main/index.ts`：验证与保存的原子 IPC；Token 不返回 renderer。
- `packages/desktop/src/main/link-provider-catalog.ts`：在宿主边界校验独立清单与可信执行器的 Provider / Action 版本并组合。
- `packages/desktop/src/renderer/credentials/LinkTab.tsx`：本地/服务器双栏、账号状态、连接和断开。

桌面 Renderer 不直接运行时导入 workspace package。Main 通过 `links:listLocalProviders` IPC 返回序列化
清单，Renderer 只把通用 `accent / icon / category` 映射为组件。Provider 的说明、授权入口或权限变化只改
`packages/link/src/catalog.ts`，不再维护第二份桌面目录。

## 10 个本地 Provider

| Provider | 推荐本地连接                    | MVP Actions                                                       | 使用提醒                                                |
| -------- | ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| GitHub   | `gh` 会话 / Fine-grained PAT    | 仓库、README、指定文件、Issue 列表/详情、PR 列表/详情、创建 Issue | 创建 Issue 固定审批                                     |
| GitLab   | `glab` 会话 / PAT               | 项目、分配的 Issue                                                | 当前先支持 gitlab.com                                   |
| Figma    | PAT                             | 文件摘要、评论                                                    | 传 `file_url_or_key`；Figma 没有全局文件列表 API        |
| Notion   | `ntn` 会话 / Integration token  | 搜索、页面属性                                                    | CLI 使用用户会话；Integration 方式只看到已 Share 内容   |
| Linear   | Personal API key                | 分配的 Issue、团队                                                | 官方 OAuth 需要注册应用，当前保留服务器方式             |
| Slack    | Slack App token                 | 频道、频道消息                                                    | Slack CLI 是 App 开发工具，不能替代工作区 Web API Token |
| Sentry   | Organization auth token         | 组织、项目                                                        | `sentry-cli` 不提供可直接复用的通用用户 API 登录态      |
| Airtable | PAT                             | Base、表和字段                                                    | PAT 必须选择对应资源和 schema 权限                      |
| Todoist  | `td` 只读会话 / Developer token | 项目、未完成任务                                                  | CLI 登录固定请求只读权限                                |
| Vercel   | `vercel` 会话 / Access token    | 项目、部署                                                        | `vercel api` 当前为 beta，执行层保持固定只读端点        |

每个本地连接弹窗均显示官方凭证创建入口、当前 Actions 所需最小权限、分步授权说明和官方文档。
检测到上述五个官方 CLI 时，弹窗优先显示浏览器登录或复用当前账号；未安装时提供官方安装入口，
下方仍保留手动 Token 流程。Figma、Linear、Slack、Sentry、Airtable 没有适合直接复用为这些 Actions 的
官方用户 CLI 会话，因此不展示虚假的“一键登录”。

## GitHub MVP 验收

1. 打开 `凭证 → Link → 本地连接 → GitHub → 连接本地`。若本机已有 GitHub CLI 登录，可一键
   绑定；未登录时可由 GitHub CLI 打开浏览器完成设备授权。CodeShell 不调用 `gh auth token`，只保存
   一条随机的本地绑定记录；每次 Action 仍由 `gh api` 执行。
2. 若要把权限限制在指定仓库，点击“打开创建页面”。GitHub 的 Fine-grained PAT 页面会预填
   Metadata 读取、Contents 读取、Issues 写入与 Pull requests 读取；用户选择资源所有者和仓库，
   生成后粘贴回来。
3. 只有 GitHub `/user` 和仓库范围校验成功后才保存；卡片显示 GitHub 用户名与最近更新的可访问仓库预览。
4. 在聊天中可直接说：
   - “列出我 GitHub Token 能访问的仓库。”
   - “读取 owner/repo 的 README。”
   - “读取 owner/repo 的 path/to/file.ts。”
   - “列出并查看 owner/repo 的 Issue / Pull Request。”
   - “在 owner/repo 创建标题为 … 的 Issue。”（必须弹审批）
5. 点“断开本地”后再次执行 Action 必须立即失败；正在执行的 HTTP 请求或 CLI 子进程都会收到取消
   信号。Token 更新或 CLI 账号切换也不会继续使用旧连接身份。

## 安全不变量

- renderer 只提交 Token，不接收 Token；验证和保存发生在 Electron main 的同一个操作中。
- CLI 方式不读取或复制服务商 Token；凭证库只保存随机绑定标记，Action 使用固定的 provider CLI。
- CLI 子进程不经过 shell，命令和 argv 模板由 Core allowlist 固定；输出上限 2 MB，并支持超时和取消。
- CLI 环境中的 Token override 变量会被移除；每次 Action 都核对当前 CLI 账号与连接账号。
- Provider-owned Link credential 设置 `agentExposable: false`，`UseCredential` 不列出也不返回原始 Token。
- Action 不能传任意 URL 或 HTTP method；所有 host 和路径模板由 Provider manifest 固定。
- 错误只返回归一化消息，不包含 Authorization、请求 body 或完整响应 body。
- 本地连接和服务器连接使用不同 credential ID，可同时存在，断开一侧不删除另一侧。
- 每次 Action 都从实时 credential snapshot 解析；连接删除或 replacement snapshot 会取消在途请求。
- 写 Action 不自动 fallback 或重试，避免在本地/服务器两侧重复创建对象。

## 借鉴的开源实现

没有单个仓库完整覆盖“桌面本地 + 云端可并存 + AI Actions”。实现采用组合借鉴：

- Activepieces 的
  [`createPiece({ auth, actions, triggers })`](https://github.com/activepieces/activepieces/blob/07d9184432f3378f646deefdc5b9c1c5dc96c8e7/packages/pieces/framework/src/lib/piece.ts)
  和 [Action contract](https://github.com/activepieces/activepieces/blob/07d9184432f3378f646deefdc5b9c1c5dc96c8e7/packages/pieces/framework/src/lib/action/action.ts)：
  Provider / Auth / Action 分层。
- Nango 的 [Connection 模型](https://github.com/NangoHQ/nango/blob/c6b961f781951086009654b79813ed4a3579d58b/packages/types/lib/connection/db.ts)
  与 [refresh single-flight/lock](https://github.com/NangoHQ/nango/blob/c6b961f781951086009654b79813ed4a3579d58b/packages/shared/lib/services/connections/credentials/refresh.ts)：
  Connection 生命周期和未来服务器刷新策略。
- Composio 的 [Tool 模型](https://github.com/ComposioHQ/composio/blob/8720957fb21851d86d4bf289dd7ed07a8f080e0c/ts/packages/core/src/types/tool.types.ts)：
  Toolkit / ConnectedAccount / Tool 的分层与输入输出 schema 方向。
- Latchkey 的 [本地凭证库](https://github.com/imbue-ai/latchkey/blob/6ca865d996065361e15b0e52409231774c9f28ab/src/apiCredentials/store.ts)
  和 [按调用注入流水线](https://github.com/imbue-ai/latchkey/blob/6ca865d996065361e15b0e52409231774c9f28ab/src/curlInjection.ts)：
  本地密钥和调用时解析，但没有采用任意 curl 的大权限面。
- VS Code GitHub Authentication 的
  [session/keychain 实现](https://github.com/microsoft/vscode/blob/main/extensions/github-authentication/src/common/keychain.ts)
  与 Raycast GitHub 的
  [PAT/OAuth 共用客户端](https://github.com/raycast/extensions/blob/main/extensions/github/src/api/githubClient.ts)：
  本地 secret storage 与多认证复用。
- Pipedream 的 [GitHub 创建 Issue Action](https://github.com/PipedreamHQ/pipedream/blob/9378f33421acc4b5f88384f472ce30613e4f3e32/components/github/actions/create-issue/create-issue.mjs)：
  AI Action 的风险注解思路。

Open Connector 当前公开仓库仍以产品说明为主，源码未公开，因此没有作为实现基础：
[openconnector-dev/openconnector](https://github.com/openconnector-dev/openconnector)。

## 下一阶段

1. 将 `packages/link` 迁移为独立仓库并建立 Provider manifest 版本兼容检查。
2. 把 Credential meta 提升为独立 `LinkConnection`，增加明确的 `status / generation / invalidatedAt`。
3. 给 Action 补完整 input/output JSON Schema、版本、幂等和敏感输出路径。
4. 新增 `ServerLinkExecutor`；路由按 Action capability 选择具体 `connectionId`，不只选择 runtime。
5. GitHub App 作为第二个 `connectionMethod` 接入；Actions 和桌面卡片保持不变。
6. 支持同一 Provider 同一 runtime 多账号，并在聊天或项目 binding 中明确选择账号。
