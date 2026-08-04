# @cjhyy/code-shell-link

CodeShell Link 的独立 Provider 清单包。它不依赖 CodeShell Core、Electron、React 或服务端，保存：

- Provider 分类与展示元数据
- 本地、服务端连接方式
- 官方 CLI 会话快速授权（只声明能力，不在清单中拼接命令）
- 官方凭证创建入口、最小权限和双语步骤
- 稳定的 Action ID 契约

Core 负责执行本地 Actions；Desktop 通过 IPC 读取这份清单；未来 Link Server 也复用同一份定义。
因此这个目录可以单独迁移成仓库并独立发版，而不需要把桌面 UI 一起搬走。

## 仓库边界

这个包是 Link 的可迁移边界：没有 CodeShell Core、Electron、React 或 Node 运行时依赖。以后可以把
`packages/link` 原样迁移到独立仓库并独立发版，桌面端和 Link Server 通过包版本升级清单。

安全相关的执行逻辑不放进可编辑清单：CLI 命令及参数 allowlist、HTTP host/path、凭据保存、审批和
断连取消仍由执行宿主实现。这样第三方清单更新不能把任意命令或 URL 注入用户设备。

Core 也不反向依赖这个包。Desktop / Link Server 作为宿主，在加载时把版本化清单与可信执行器组合，
并逐项校验 Provider ID 和 Action ID；版本不匹配会直接拒绝加载，而不是向用户展示半可用连接。

## 当前连接方式

| Provider                                   | 本地快速授权  | 本地备用方式               | 服务器方式         |
| ------------------------------------------ | ------------- | -------------------------- | ------------------ |
| GitHub                                     | `gh` 会话     | Fine-grained PAT           | GitHub App（预留） |
| GitLab                                     | `glab` 会话   | Personal access token      | OAuth（预留）      |
| Notion                                     | `ntn` 会话    | Internal integration token | OAuth（预留）      |
| Todoist                                    | `td` 只读会话 | Developer token            | OAuth（预留）      |
| Vercel                                     | `vercel` 会话 | Access token               | OAuth（预留）      |
| Figma / Linear / Slack / Sentry / Airtable | —             | 官方 Token / App 流程      | OAuth（预留）      |

新增 Provider 时，先在 `src/catalog.ts` 增加 manifest，再在可信执行宿主实现相同的 `actionIds`。
`bun run test` 会校验每个 Provider 都有可用本地方法、独立服务端方法、完整授权引导，并锁定支持
零复制会话的官方 CLI 清单。
