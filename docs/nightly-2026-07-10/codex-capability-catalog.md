# Codex CLI / Codex 生态能力全清单

调研日期：2026-07-10  
范围：OpenAI Codex CLI (`codex`) 及其紧密相关的本地 Codex host 能力。事实以 OpenAI 官方文档为准；本机 `codex --help` 仅用于交叉校验，未在官方文档中出现的点放入“未确证/版本差异”。

主要官方来源：

- Codex CLI / developer commands：<https://developers.openai.com/codex/developer-commands?surface=cli>
- Non-interactive mode：<https://developers.openai.com/codex/non-interactive-mode>
- Config basics / advanced / reference：<https://developers.openai.com/codex/config-file/config-basic>、<https://developers.openai.com/codex/config-file/config-advanced>、<https://developers.openai.com/codex/config-file/config-reference>
- Agent approvals and security：<https://developers.openai.com/codex/agent-approvals-security>
- MCP / hooks / plugins / skills / AGENTS.md / subagents：<https://developers.openai.com/codex/extend/mcp>、<https://developers.openai.com/codex/hooks>、<https://developers.openai.com/codex/plugins>、<https://developers.openai.com/codex/build-skills>、<https://developers.openai.com/codex/agent-configuration/agents-md>、<https://developers.openai.com/codex/agent-configuration/subagents>
- Models / auth / SDK / app-server：<https://developers.openai.com/codex/models>、<https://developers.openai.com/codex/auth>、<https://developers.openai.com/codex/codex-sdk>、<https://developers.openai.com/codex/app-server>

## 运行模式与 CLI 命令

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| `codex` interactive TUI | 无子命令启动交互式终端 UI，可带初始 prompt 和图片附件。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-interactive> |
| 初始 `PROMPT` 参数 | `codex [PROMPT]` 用可选文本指令预填或启动会话。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `codex exec` / `codex e` | 无头、非交互运行，用于脚本、CI、管道和自动化。 | <https://developers.openai.com/codex/non-interactive-mode> |
| `codex exec resume [SESSION_ID]` | 继续非交互 session，可用 `--last` 选当前目录最近一次运行。 | <https://developers.openai.com/codex/non-interactive-mode#resume-a-non-interactive-session> |
| `codex resume` | 继续历史交互式会话，可按 ID、名称或 `--last` 恢复。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-resume> |
| `codex fork` | 从历史交互式会话分叉新任务，保留原 transcript。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-fork> |
| `codex archive` / `unarchive` | 归档或恢复保存的交互式 session，不删除 transcript。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-archive-and-codex-unarchive> |
| `codex delete` | 永久删除保存的 session transcript，UUID 可配 `--force`。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-delete> |
| `codex review` | 对未提交改动、base branch diff、commit 或自定义说明做非交互代码审查。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-review> |
| `codex apply` / `codex a` | 将 Codex cloud task 的最新 diff 应用到本地工作树。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-apply> |
| `codex cloud` | 在终端浏览、提交 Codex cloud task，并可用 `cloud list --json` 脚本化。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-cloud> |
| `codex app` | 从终端打开 ChatGPT desktop app；macOS 可传 workspace path。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-app> |
| `codex app-server` | 本地启动 Codex app-server，供深度客户端集成、远程 TUI 或调试使用。 | <https://developers.openai.com/codex/app-server> |
| `codex --remote` | 交互式 TUI 可连接远端 app-server，支持 `ws://`、`wss://`、`unix://`。 | <https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui> |
| `codex remote-control` | 实验性本地 app-server daemon 远程控制和短期 pairing code。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-remote-control> |
| `codex mcp-server` | 将 Codex CLI 暴露成 MCP server，供其它 agent 或 MCP client 调用。 | <https://developers.openai.com/codex/guides/agents-sdk> |
| `codex mcp` | 管理 MCP server 配置，包括 list/get/add/remove/login/logout。 | <https://developers.openai.com/codex/extend/mcp> |
| `codex plugin` | 安装、列出、移除插件；`--json` 输出可用于自动化。 | <https://developers.openai.com/codex/plugins> |
| `codex plugin marketplace` | 添加、列出、升级、移除 Git 或本地 marketplace source。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-plugin-marketplace> |
| `codex features` | 列出并持久启用/禁用 feature flags。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-features> |
| `codex execpolicy` | 实验性检查 `.rules` 规则文件对命令的 allow/prompt/forbidden 决策。 | <https://developers.openai.com/codex/agent-configuration/rules> |
| `codex sandbox` | 用 Codex 的 macOS/Linux/Windows sandbox 运行任意命令，便于本地测试边界。 | <https://developers.openai.com/codex/agent-approvals-security#test-the-sandbox-locally> |
| `codex completion` | 为 Bash、Zsh、Fish、PowerShell 或 Elvish 生成 shell completion。 | <https://developers.openai.com/codex/cli-customization#shell-completions> |
| `codex doctor` | 生成安装、配置、认证、运行时、Git、terminal、app-server、thread inventory 诊断报告。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-doctor> |
| `codex login` / `logout` | 支持 ChatGPT OAuth、device auth、stdin API key、stdin access token 登录，并可退出。 | <https://developers.openai.com/codex/auth> |
| `codex update` | 检查并应用 CLI 自更新，前提是安装版本支持。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-update> |
| `codex debug models` | 打印 Codex 看到的原始 model catalog，可只看 bundled catalog。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-debug-models> |
| `codex debug prompt-input` | 将模型可见 prompt input list 渲染成 JSON，用于调试 prompt/session context。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-debug-prompt-input> |
| `codex debug app-server send-message-v2` | 通过内置 test client 调试 app-server V2 thread/turn 流。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-debug-app-server-send-message-v2> |
| `codex app-server generate-ts/json-schema` | 从当前 Codex 版本生成 TypeScript schema 或 JSON Schema bundle。 | <https://developers.openai.com/codex/app-server#message-schema> |

## 关键 CLI flags

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| `-c, --config key=value` | 对单次调用覆盖任意配置值，value 按 TOML 解析。 | <https://developers.openai.com/codex/config-file/config-advanced#one-off-overrides-from-the-cli> |
| `--enable` / `--disable` | 单次强制启用或禁用 feature flag，等价于覆盖 `features.<name>`。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `--strict-config` | 配置包含当前 Codex 版本不认识的字段时直接报错。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `-m, --model` | 单次覆盖 active model。 | <https://developers.openai.com/codex/models> |
| `--oss` | 使用本地开源模型 provider，并结合 `--local-provider` 或 `oss_provider`。 | <https://developers.openai.com/codex/config-file/config-advanced#oss-mode-local-providers> |
| `--local-provider` | 指定 `lmstudio` 或 `ollama` 作为本次 OSS provider。 | <https://developers.openai.com/codex/config-file/config-advanced#oss-mode-local-providers> |
| `-p, --profile` | 加载 `$CODEX_HOME/<name>.config.toml` 作为 named profile。 | <https://developers.openai.com/codex/config-file/config-advanced#profiles> |
| `-C, --cd` | 设置 agent 工作根目录。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `--add-dir` | 在主 workspace 之外增加可写目录，优先于直接开 full access。 | <https://developers.openai.com/codex/developer-commands?surface=cli#flag-combinations-and-safety-tips> |
| `--remote` | 连接远端 app-server endpoint，仅支持部分 session 管理命令。 | <https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui> |
| `--remote-auth-token-env` | 从环境变量读取 bearer token 供 `--remote` 使用。 | <https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui> |
| `--no-alt-screen` | 禁用 TUI alternate screen，保留 terminal scrollback。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `--skip-git-repo-check` | 允许 `codex exec` 在非 Git 仓库运行。 | <https://developers.openai.com/codex/non-interactive-mode#git-repository-required> |
| `--ephemeral` | 非交互运行不把 session rollout 文件持久化到磁盘。 | <https://developers.openai.com/codex/non-interactive-mode#basic-usage> |
| `--ignore-user-config` | 非交互运行跳过 `$CODEX_HOME/config.toml`，认证仍使用 `CODEX_HOME`。 | <https://developers.openai.com/codex/non-interactive-mode#permissions-and-safety> |
| `--ignore-rules` | 非交互运行跳过 user/project execpolicy `.rules` 文件。 | <https://developers.openai.com/codex/non-interactive-mode#permissions-and-safety> |
| `--output-schema` | 要求最终响应符合 JSON Schema，便于下游自动化消费。 | <https://developers.openai.com/codex/non-interactive-mode#create-structured-outputs-with-a-schema> |
| `--color` | 控制非交互 stdout 颜色输出为 `always`、`never` 或 `auto`。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| `--full-auto` | 已弃用兼容 flag；官方建议改用显式 `--sandbox workspace-write`。 | <https://developers.openai.com/codex/non-interactive-mode#permissions-and-safety> |
| `review --uncommitted` | 审查 staged、unstaged 和 untracked 改动。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-review> |
| `review --base` | 审查相对指定 base branch 的变化。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-review> |
| `review --commit` / `--title` | 审查某 commit 引入的变化，并可设置 review summary 标题。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-review> |
| `login --device-auth` | 在远程或无头设备上使用 OAuth device code flow。 | <https://developers.openai.com/codex/auth#login-on-headless-devices> |
| `login --with-api-key` | 从 stdin 读取 API key 并登录。 | <https://developers.openai.com/codex/auth#sign-in-with-an-api-key> |
| `login --with-access-token` | 从 stdin 读取 Codex access token 并登录。 | <https://developers.openai.com/codex/auth#use-codex-access-tokens-for-enterprise-automation> |
| `login status` | 打印当前认证方式并在已登录时返回 0。 | <https://developers.openai.com/codex/auth#check-authentication-or-sign-out> |

## 输入、多模态与上下文

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| prompt argument | `codex` 和 `codex exec` 都接受命令行 prompt。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| stdin as prompt | `codex exec` 未给 prompt 或使用 `-` 时从 stdin 读取完整 prompt。 | <https://developers.openai.com/codex/non-interactive-mode#use-codex-exec-when-stdin-is-the-prompt> |
| prompt + stdin context | 同时传 prompt 和管道 stdin 时，prompt 是指令，stdin 作为额外 `<stdin>` context。 | <https://developers.openai.com/codex/non-interactive-mode#basic-usage> |
| `-i, --image` | 向初始 prompt 或 `exec resume` follow-up prompt 附加一个或多个图片文件。 | <https://developers.openai.com/codex/image-inputs> |
| comma/repeated images | 多图可逗号分隔或重复 `--image`，常见 PNG/JPEG 受支持。 | <https://developers.openai.com/codex/image-inputs> |
| interactive pasted image | CLI 交互 composer 可粘贴图片作为 visual context。 | <https://developers.openai.com/codex/image-inputs> |
| `/mention` file context | 在 CLI 用 `/mention path` 把文件或路径加入对话 context。 | <https://developers.openai.com/codex/developer-commands?surface=cli#highlight-files-with-mention> |
| `@` file search | 交互式 TUI 中输入 `@` 搜索 workspace 文件并把路径加入 prompt。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-interactive-shortcuts> |
| explicit path context | 官方 workflow 建议 CLI 中显式提路径，或用 `/mention` / `@` 选择路径。 | <https://developers.openai.com/codex/workflows> |
| image generation prompt | CLI 交互会话可直接描述图片，或显式包含 `$imagegen` 调用图像生成 skill。 | <https://developers.openai.com/codex/image-generation> |
| image reference for generation | 生成或编辑图片时可用 `-i/--image` 附参考图。 | <https://developers.openai.com/codex/image-generation> |
| live web input | `--search` 让单次 CLI 运行使用 live web search；默认 local task 是 cached search。 | <https://developers.openai.com/codex/web-search> |
| arbitrary non-image file flag | 未确证：官方 CLI flag 只明确列出 `--image`；非图片文件上下文通过路径、workspace 读取、`/mention` 或 stdin 提供。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |

## 输出、事件流与机器可读格式

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| formatted stdout | `codex exec` 默认把进度写 stderr，把最终 agent message 写 stdout。 | <https://developers.openai.com/codex/non-interactive-mode#basic-usage> |
| `--json` JSONL | `codex exec --json` 将 stdout 改为 newline-delimited JSON event stream。 | <https://developers.openai.com/codex/non-interactive-mode#make-output-machine-readable> |
| JSONL event types | JSONL 事件包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*` 和 `error`。 | <https://developers.openai.com/codex/non-interactive-mode#make-output-machine-readable> |
| JSONL item types | item 覆盖 agent messages、reasoning、command executions、file changes、MCP tool calls、web searches、plan updates。 | <https://developers.openai.com/codex/non-interactive-mode#make-output-machine-readable> |
| `--output-last-message` / `-o` | 把最终 assistant message 写入文件，同时仍输出到 stdout。 | <https://developers.openai.com/codex/non-interactive-mode#make-output-machine-readable> |
| `--output-schema` final schema | 用 JSON Schema 约束最终响应，适合 job summary、risk report、release metadata 等自动化。 | <https://developers.openai.com/codex/non-interactive-mode#create-structured-outputs-with-a-schema> |
| app-server JSONL stdio | `codex app-server --listen stdio://` 使用 JSONL-over-stdio JSON-RPC。 | <https://developers.openai.com/codex/app-server#protocol> |
| app-server notifications | app-server 流式通知 thread、turn、item 和 server request 状态。 | <https://developers.openai.com/codex/app-server#event-stream> |
| `doctor --json` | 诊断报告可输出 redacted machine-readable JSON。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-doctor> |
| `mcp list --json` | MCP server 清单可输出机器可读 JSON。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-mcp> |
| `plugin --json` | 插件安装、列表、移除和 marketplace 管理支持 JSON 输出。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-plugin> |
| `cloud list --json` | Codex cloud task list 支持 JSON 输出和 cursor 分页。 | <https://developers.openai.com/codex/developer-commands?surface=cli#cli-codex-cloud> |

## Session、thread 与 rollout 文件

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| local transcript persistence | 默认 Codex 在 `CODEX_HOME` 下保存本地 session transcript，例如 `~/.codex/history.jsonl`。 | <https://developers.openai.com/codex/config-file/config-advanced#history-persistence> |
| `history.persistence` | 可设为 `none` 禁用本地 history persistence。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `history.max_bytes` | 可限制 history 文件大小，超限后丢弃较旧记录并 compact。 | <https://developers.openai.com/codex/config-file/config-advanced#history-persistence> |
| `CODEX_HOME` | 控制 Codex state 根目录，包含 config、auth、logs、sessions、skills 和 package metadata。 | <https://developers.openai.com/codex/config-file/environment-variables> |
| `CODEX_SQLITE_HOME` / `sqlite_home` | 控制 SQLite-backed runtime state 存储位置，用于 agent jobs 等 resumable state。 | <https://developers.openai.com/codex/config-file/environment-variables> |
| session rollout persistence | `codex exec --ephemeral` 明确表示不持久化 session rollout files。 | <https://developers.openai.com/codex/non-interactive-mode#basic-usage> |
| persisted JSONL thread log | app-server `thread/archive` 会移动持久化 JSONL thread log 到 archived sessions directory。 | <https://developers.openai.com/codex/app-server#threads> |
| rollout metadata | app-server 文档说明 experimental `dynamicTools` 会持久化到 thread rollout metadata 并在 resume 恢复。 | <https://developers.openai.com/codex/app-server#threads> |
| `thread.sessionId` | app-server thread 有 live session tree root 标识，forked thread 保留 root session id。 | <https://developers.openai.com/codex/app-server#threads> |
| `thread/resume` | app-server 可用 thread id 恢复 stored session，并支持与 `thread/start` 类似的 override。 | <https://developers.openai.com/codex/app-server#threads> |
| `thread/fork` | app-server 可复制 stored history 创建新 thread id，并可用 `lastTurnId` 截断。 | <https://developers.openai.com/codex/app-server#threads> |
| transcript format stability | 未确证：hook 文档明确说 `transcript_path` 方便使用，但 transcript 格式不是稳定接口、可能变化。 | <https://developers.openai.com/codex/hooks#common-input-fields> |

## 权限、审批、沙箱与安全边界

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| OS-enforced sandbox | Codex CLI / IDE extension 使用 OS 机制限制命令文件系统和网络访问。 | <https://developers.openai.com/codex/agent-approvals-security#sandbox-and-approvals> |
| `--sandbox read-only` | 只读沙箱，适合问答、浏览和保守 CI。 | <https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations> |
| `--sandbox workspace-write` | 允许读文件、在 workspace 内编辑和运行命令；默认网络关闭。 | <https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations> |
| `--sandbox danger-full-access` | 给命令 broad access，官方建议仅在受控隔离环境使用。 | <https://developers.openai.com/codex/non-interactive-mode#permissions-and-safety> |
| `--dangerously-bypass-approvals-and-sandbox` / `--yolo` | 跳过所有审批和 sandbox，官方强烈警告仅在外部沙箱环境使用。 | <https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations> |
| `--ask-for-approval untrusted` | 只自动运行已知安全读命令，不可信或有副作用命令需审批。 | <https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations> |
| `--ask-for-approval on-request` | 由模型决定何时请求审批，常与 workspace-write 组合成 Auto preset。 | <https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations> |
| `--ask-for-approval never` | 永不询问审批，失败直接返回模型。 | <https://developers.openai.com/codex/agent-approvals-security#run-without-approval-prompts> |
| granular approval policy | `approval_policy = { granular = { ... } }` 可分别控制 sandbox、rules、MCP elicitation、permission request、skill approval。 | <https://developers.openai.com/codex/config-file/config-reference> |
| auto approval reviewer | `approvals_reviewer = "auto_review"` 让 eligible approval 由自动 review 模型审查。 | <https://developers.openai.com/codex/agent-approvals-security#automatic-approval-reviews> |
| workspace network access | `sandbox_workspace_write.network_access = true` 才允许 workspace-write sandbox outbound network。 | <https://developers.openai.com/codex/agent-approvals-security#network-access> |
| web search independent from shell network | `web_search` 可在不授予 spawned command 网络权限时单独控制。 | <https://developers.openai.com/codex/agent-approvals-security#network-access> |
| protected writable roots | workspace-write 中 `.git/`、`.codex/` 等保护路径仍可能只读或需审批。 | <https://developers.openai.com/codex/agent-approvals-security#protected-paths-in-writable-roots> |
| named permission profiles | 支持内置 `:read-only`、`:workspace`、`:danger-full-access` 和自定义 `[permissions.<name>]`。 | <https://developers.openai.com/codex/config-file/config-basic#permission-profiles> |
| `.rules` execpolicy | `.rules` 文件控制哪些命令可在 sandbox 外 allow、prompt 或 forbidden。 | <https://developers.openai.com/codex/agent-configuration/rules> |
| shell wrapper splitting | 对简单 `bash -lc` / `sh -c` 复合命令，Codex 会尽量拆成单命令分别套 rules。 | <https://developers.openai.com/codex/agent-configuration/rules#shell-wrappers-and-compound-commands> |
| `codex execpolicy check` | 可测试 rules 文件对指定命令的最严格决策。 | <https://developers.openai.com/codex/agent-configuration/rules#test-a-rule-file> |
| macOS sandbox | macOS 使用 Seatbelt policy 和 `sandbox-exec`。 | <https://developers.openai.com/codex/agent-approvals-security#os-level-sandbox> |
| Linux sandbox | Linux sandbox 使用 Landlock/seccomp/bubblewrap 相关机制，容器环境可能需外部隔离。 | <https://developers.openai.com/codex/agent-approvals-security#os-level-sandbox> |
| Windows sandbox | 原生 Windows 支持 `windows.sandbox = "elevated"` 或 `"unelevated"`。 | <https://developers.openai.com/codex/windows/windows-sandbox> |
| Dev Containers | host 无法运行 Linux sandbox 时可在 Dev Container 内运行，并以容器作为外部边界。 | <https://developers.openai.com/codex/agent-approvals-security#run-codex-in-dev-containers> |
| MCP/app destructive approvals | 带 destructive hint 的 app/MCP tool call 在相关审批模型下会触发审批。 | <https://developers.openai.com/codex/agent-approvals-security#sandbox-and-approvals> |
| admin `requirements.toml` | 管理员可约束 approval policy、sandbox mode、permission profiles、web search modes 等。 | <https://developers.openai.com/codex/config-file/config-reference#requirementstoml> |

## 工具、扩展与生态能力

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| local repository work | Codex CLI 可检查文件、修改代码并运行本机已有工具。 | <https://developers.openai.com/codex/cli> |
| default shell tool | `features.shell_tool` 控制默认 shell tool，稳定且默认开启。 | <https://developers.openai.com/codex/config-file/config-reference> |
| unified exec | `features.unified_exec` 使用 PTY-backed exec tool，除 Windows 外默认开启。 | <https://developers.openai.com/codex/config-file/config-reference> |
| background terminals | `/ps` 和 `/stop` 管理 unified exec 下的后台 terminal。 | <https://developers.openai.com/codex/developer-commands?surface=cli#check-background-terminals-with-ps> |
| file changes item | JSONL `item.*` 会包含 file changes，hook 文档也把 `apply_patch` 作为文件编辑 tool 暴露。 | <https://developers.openai.com/codex/non-interactive-mode#make-output-machine-readable> |
| local image view tool | `tools.view_image` 配置项控制本地图片附件 tool `view_image`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| web search tool | 本地 task 默认 cached search，可切 indexed/live/disabled。 | <https://developers.openai.com/codex/web-search> |
| image generation skill | CLI 可通过 `$imagegen` 显式调用图像生成 skill，内置使用 `gpt-image-2`。 | <https://developers.openai.com/codex/image-generation> |
| MCP STDIO servers | 支持本地进程式 MCP server，配置 command/args/env/env_vars/cwd。 | <https://developers.openai.com/codex/extend/mcp#stdio-servers> |
| MCP Streamable HTTP servers | 支持 HTTP MCP server，带 bearer token、OAuth、ChatGPT session auth、headers。 | <https://developers.openai.com/codex/extend/mcp#streamable-http-servers> |
| MCP server instructions | Codex 读取 MCP 初始化返回的 `instructions` 作为 server-wide guidance。 | <https://developers.openai.com/codex/extend/mcp#supported-mcp-features> |
| MCP required server | `required = true` 时，enabled MCP 初始化失败会让 `codex exec` 或 thread start/resume 失败。 | <https://developers.openai.com/codex/non-interactive-mode#permissions-and-safety> |
| MCP tool allow/deny | `enabled_tools`、`disabled_tools` 和 per-tool approval mode 控制 MCP tool 暴露与审批。 | <https://developers.openai.com/codex/extend/mcp#streamable-http-servers> |
| plugin-provided MCP | 插件可 bundle MCP server，用户可在 `plugins.<plugin>.mcp_servers` 下控制。 | <https://developers.openai.com/codex/extend/mcp#plugin-provided-mcp-servers> |
| apps/connectors | `apps.*` 配置控制 connector/app tool 启用和审批策略。 | <https://developers.openai.com/codex/config-file/config-reference> |
| plugins | 插件可包含 skills、apps/connectors、MCP servers、browser extensions、hooks、scheduled task templates。 | <https://developers.openai.com/codex/plugins> |
| plugin browser | CLI 内输入 `/plugins` 打开插件浏览器，按 marketplace 管理安装和启用状态。 | <https://developers.openai.com/codex/plugins#plugin-directory-in-codex-cli> |
| skills | skill 是带 `SKILL.md` 的目录，可含 scripts/references/assets，由 Codex 按需加载。 | <https://developers.openai.com/codex/build-skills> |
| explicit skill invocation | CLI/IDE 可用 `/skills` 或 `$skill` 显式调用 skill。 | <https://developers.openai.com/codex/build-skills#how-codex-uses-skills> |
| implicit skill invocation | Codex 可按 skill `description` 自动选择 skill。 | <https://developers.openai.com/codex/build-skills#how-codex-uses-skills> |
| skill locations | Codex 从 repo `.agents/skills`、user `$HOME/.agents/skills`、admin `/etc/codex/skills` 和 system 位置读 skill。 | <https://developers.openai.com/codex/build-skills#where-to-save-skills> |
| `$skill-creator` | 官方内置 creator 可通过对话生成 skill。 | <https://developers.openai.com/codex/build-skills#create-a-skill> |
| `$skill-installer` | 可安装 curated skills 或从其它 repo 下载 skill。 | <https://developers.openai.com/codex/build-skills#install-curated-skills-for-local-use> |
| hooks | hooks 是 lifecycle extensibility，可运行 deterministic scripts。 | <https://developers.openai.com/codex/hooks> |
| hook locations | hooks 可来自 `~/.codex/hooks.json`、`~/.codex/config.toml`、repo `.codex/hooks.json`、repo `.codex/config.toml` 和插件。 | <https://developers.openai.com/codex/hooks#where-codex-looks-for-hooks> |
| hook trust | 非 managed command hook 需 review/trust；变更 hash 后需重新信任。 | <https://developers.openai.com/codex/hooks#review-and-trust-hooks> |
| hook events | 支持 `SessionStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStart/Stop`、`Stop`。 | <https://developers.openai.com/codex/hooks#matcher-patterns> |
| `notify` external command | `notify` 在 `agent-turn-complete` 等事件触发外部程序，传入 JSON 参数。 | <https://developers.openai.com/codex/config-file/config-advanced#notifications> |
| TUI notifications | `[tui]` 下可配置 terminal notifications、方法和触发条件。 | <https://developers.openai.com/codex/config-file/config-advanced#tui-options> |
| AGENTS.md guidance | Codex 在工作前读取 `AGENTS.md`，用于持久项目指令和上下文。 | <https://developers.openai.com/codex/agent-configuration/agents-md> |
| AGENTS layering | 全局 `~/.codex/AGENTS.md` 与项目路径上的 `AGENTS.md`/`AGENTS.override.md` 按层拼接，近目录优先。 | <https://developers.openai.com/codex/agent-configuration/agents-md#how-codex-discovers-guidance> |
| AGENTS fallback names | `project_doc_fallback_filenames` 可配置除 `AGENTS.md` 外的 instruction 文件名。 | <https://developers.openai.com/codex/agent-configuration/agents-md#customize-fallback-filenames> |
| custom prompts | `~/.codex/prompts/*.md` 可变成 `/prompts:name` slash command，但官方标注已弃用，推荐用 skills。 | <https://developers.openai.com/codex/custom-prompts> |
| Record & Replay | 通过演示 workflow 生成 reusable skill；与 skills 生态相关。 | <https://developers.openai.com/codex/extend/record-and-replay> |
| import from another agent | desktop app 可导入其它 agent 的 instructions、settings、skills、plugins、MCP、hooks、slash commands、subagents 等。 | <https://developers.openai.com/codex/import> |

## 配置体系与关键 `config.toml` 项

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| user config | 用户级配置位于 `~/.codex/config.toml`。 | <https://developers.openai.com/codex/config-file/config-basic#codex-configuration-file> |
| project config | repo 内 `.codex/config.toml` 可作为 trusted project 的局部覆盖。 | <https://developers.openai.com/codex/config-file/config-advanced#project-config-files-codexconfigtoml> |
| precedence | 优先级为 CLI flags/`--config`、project config、profile、user、system、built-in defaults。 | <https://developers.openai.com/codex/config-file/config-basic#configuration-precedence> |
| system config | Unix 可有 `/etc/codex/config.toml` 作为 system config。 | <https://developers.openai.com/codex/config-file/config-basic#configuration-precedence> |
| profile files | profile 文件为 `~/.codex/<name>.config.toml`，由 `--profile` 选择。 | <https://developers.openai.com/codex/config-file/config-advanced#profiles> |
| project trust | untrusted project 会跳过 project `.codex/` layers，包括 config、hooks、rules。 | <https://developers.openai.com/codex/config-file/config-basic#configuration-precedence> |
| `model` | 设置默认模型。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `review_model` | 为 `/review` 指定可选模型覆盖。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `model_provider` | 指向 `model_providers` 中的 provider id，默认 `openai`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `openai_base_url` | 覆盖内置 `openai` provider base URL，用于 proxy/router/data residency。 | <https://developers.openai.com/codex/config-file/config-advanced#config-and-state-locations> |
| `model_context_window` | 配置 active model 可用 context window tokens。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `model_auto_compact_token_limit` | 设置自动 history compaction 触发阈值。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `model_catalog_json` | 指定启动时加载的 JSON model catalog，profile 可覆盖。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `oss_provider` | 设置 `--oss` 默认本地 provider，值为 `lmstudio` 或 `ollama`。 | <https://developers.openai.com/codex/config-file/config-advanced#oss-mode-local-providers> |
| `approval_policy` | 配置审批策略：`untrusted`、`on-request`、`never` 或 granular。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `approvals_reviewer` | 设置审批 reviewer 为 `user` 或 `auto_review`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[auto_review].policy` | 给自动审批 reviewer 提供本地 Markdown policy。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `allow_login_shell` | 可禁止 shell tools 使用 login-shell semantics。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `sandbox_mode` | 设置 `read-only`、`workspace-write` 或 `danger-full-access`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[sandbox_workspace_write]` | 配置 workspace-write 的额外 writable roots、network、tmp 策略。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[windows]` | 配置 Windows native sandbox `elevated` 或 `unelevated`。 | <https://developers.openai.com/codex/config-file/config-basic#windows-sandbox-mode> |
| `notify` | 配置外部通知命令数组。 | <https://developers.openai.com/codex/config-file/config-advanced#notifications> |
| `check_for_update_on_startup` | 控制启动时是否检查 Codex 更新。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `feedback.enabled` | 控制 local clients 中 `/feedback` 可用性。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `analytics.enabled` | 控制本机/profile analytics。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `developer_instructions` | 向 session 注入额外 developer instructions。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `log_dir` | 设置日志目录；显式设置也启用 plaintext `codex-tui.log`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `sqlite_home` | 设置 SQLite-backed state DB 目录。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `compact_prompt` / `experimental_compact_prompt_file` | 覆盖 history compaction prompt。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `model_instructions_file` | 用文件替换 built-in instructions，而不是替代 `AGENTS.md`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `personality` | 设置默认交流风格：`none`、`friendly`、`pragmatic`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `service_tier` | 设置 preferred service tier，如 `fast` 或 catalog-provided tier。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `skills.config` | 用配置启用或禁用具体 skill。 | <https://developers.openai.com/codex/build-skills#enable-or-disable-skills> |
| `apps.*` | 控制 app/connector 及其 tool 的启用和 approval mode。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[features]` | 管理 apps、goals、hooks、fast_mode、memories、multi_agent、shell_tool、unified_exec 等 feature flags。 | <https://developers.openai.com/codex/config-file/config-basic#feature-flags> |
| `[hooks]` | 在 config.toml 中内联 lifecycle hooks。 | <https://developers.openai.com/codex/hooks#config-shape> |
| `[mcp_servers.<id>]` | 配置 MCP stdio 或 HTTP server。 | <https://developers.openai.com/codex/extend/mcp#configure-with-configtoml> |
| `[agents]` | 配置 subagent 全局上限和自定义 agent role。 | <https://developers.openai.com/codex/agent-configuration/subagents#global-settings> |
| `[memories]` | 控制 memories use/generate 和 memory generation 参数，功能默认实验性。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[model_providers.<id>]` | 自定义 provider 的 name、base_url、env_key、headers、retry、auth command 等。 | <https://developers.openai.com/codex/config-file/config-advanced#custom-model-providers> |
| model reasoning keys | `model_reasoning_effort`、`plan_mode_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 等控制推理和输出风格。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `[shell_environment_policy]` | 控制 Codex 传给 subprocess 的环境变量继承、过滤和覆盖。 | <https://developers.openai.com/codex/config-file/config-advanced#shell-environment-policy> |
| `project_root_markers` | 自定义 project root 检测标记。 | <https://developers.openai.com/codex/config-file/config-advanced#project-root-detection> |
| `project_doc_max_bytes` | 限制 Codex 从 `AGENTS.md` 读取的最大字节数。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `project_doc_fallback_filenames` | 指定 `AGENTS.md` 缺失时尝试的替代文件名。 | <https://developers.openai.com/codex/agent-configuration/agents-md#customize-fallback-filenames> |
| `tool_output_token_limit` | 限制单个 tool/function output 存入 history 的 token budget。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `file_opener` | 把文件引用渲染为 VS Code、Cursor、Windsurf 等可点击 URI。 | <https://developers.openai.com/codex/config-file/config-advanced#clickable-citations> |
| `[otel]` | 配置 OpenTelemetry logs/traces/metrics exporter。 | <https://developers.openai.com/codex/config-file/config-advanced#observability-and-telemetry> |
| `[tui]` | 配置 notifications、animations、alternate screen、vim mode、raw output、status line、title、theme 等 TUI 行为。 | <https://developers.openai.com/codex/config-file/config-advanced#tui-options> |
| `tools.web_search` | 配置 web search 的 context size、allowed domains、location 等。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `tools.view_image` | 启用本地图片附件工具 `view_image`。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `web_search` | 全局 web search 模式：`disabled`、`cached`、`indexed`、`live`。 | <https://developers.openai.com/codex/config-file/config-basic#web-search-mode> |
| `default_permissions` / `[permissions]` | 使用 permission profiles 替代旧 sandbox 配置模型。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `projects.<path>.trust_level` | 标记项目或 worktree 为 trusted/untrusted。 | <https://developers.openai.com/codex/config-file/config-reference> |
| `cli_auth_credentials_store` | 控制 CLI credential cache 存在文件、keyring 或 auto。 | <https://developers.openai.com/codex/config-file/config-reference> |
| MCP OAuth store/callback keys | `mcp_oauth_credentials_store`、`mcp_oauth_callback_port`、`mcp_oauth_callback_url` 控制 MCP OAuth 存储和回调。 | <https://developers.openai.com/codex/extend/mcp#streamable-http-servers> |
| env `CODEX_HOME` | 设置 Codex state 根目录。 | <https://developers.openai.com/codex/config-file/environment-variables> |
| env `CODEX_API_KEY` | 仅 `codex exec` 支持的单次 API key 环境变量，官方建议 inline 设置。 | <https://developers.openai.com/codex/non-interactive-mode#use-api-key-auth> |
| env `CODEX_ACCESS_TOKEN` | 为 trusted automation 提供 ChatGPT/Codex access token。 | <https://developers.openai.com/codex/config-file/environment-variables> |
| env `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE` | 配置 corporate TLS/private CA PEM bundle。 | <https://developers.openai.com/codex/config-file/environment-variables> |
| env `RUST_LOG` | 控制 CLI 和 app-server Rust 日志过滤与详细程度。 | <https://developers.openai.com/codex/config-file/environment-variables> |

## 模型、provider 与鉴权

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| `/model` interactive switch | CLI 内用 `/model` 切换模型或 reasoning effort。 | <https://developers.openai.com/codex/models> |
| `--model` launch override | `codex --model` 和 `codex exec -m` 可在启动时覆盖模型。 | <https://developers.openai.com/codex/models> |
| recommended default | 官方建议从默认 Power 设置开始，当前默认使用 `gpt-5.6-sol` medium reasoning。 | <https://developers.openai.com/codex/models#recommended-models> |
| GPT-5.6 Sol | 适合复杂、开放、高价值、需要判断和打磨的任务。 | <https://developers.openai.com/codex/models#choosing-sol-terra-and-luna> |
| GPT-5.6 Terra | 日常 workhorse，平衡能力与成本。 | <https://developers.openai.com/codex/models#choosing-sol-terra-and-luna> |
| GPT-5.6 Luna | 适合清晰、可重复、高吞吐的提取、分类、转换、摘要等任务。 | <https://developers.openai.com/codex/models#choosing-sol-terra-and-luna> |
| GPT-5.4 | 官方 subagents 文档仍列为可用于 pinned GPT-5.4 workflow 的模型。 | <https://developers.openai.com/codex/agent-configuration/subagents#model-choice> |
| GPT-5.3-Codex-Spark | ChatGPT Pro research preview，近实时、文本优先、低延迟迭代。 | <https://developers.openai.com/codex/agent-configuration/subagents#model-choice> |
| deprecated ChatGPT sign-in models | ChatGPT 登录下 `gpt-5.2` 和 `gpt-5.3-codex` 在 Codex 中已弃用。 | <https://developers.openai.com/codex/models#deprecated-codex-models> |
| API-key model availability | API key 下模型可用性跟随 key 的 API model availability。 | <https://developers.openai.com/codex/models#deprecated-codex-models> |
| arbitrary compatible providers | Codex 可指向支持 Responses API 或已弃用 Chat Completions API 的任意模型/provider。 | <https://developers.openai.com/codex/models#other-models> |
| built-in OpenAI provider | 默认 provider 为 `openai`，可用 `openai_base_url` 指向 proxy/router。 | <https://developers.openai.com/codex/config-file/config-advanced#custom-model-providers> |
| custom provider | `[model_providers.<id>]` 支持 base URL、env key、headers、query params、retry、auth command。 | <https://developers.openai.com/codex/config-file/config-advanced#custom-model-providers> |
| command-backed auth | provider 可通过外部命令刷新 bearer token。 | <https://developers.openai.com/codex/config-file/config-advanced#custom-model-providers> |
| Azure provider pattern | 可用自定义 provider 配置 Azure OpenAI endpoint、API key、api-version query param。 | <https://developers.openai.com/codex/config-file/config-advanced#azure-provider-and-per-provider-tuning> |
| data residency provider | ChatGPT data residency 项目可用 provider base URL 前缀配置 residency。 | <https://developers.openai.com/codex/config-file/config-advanced#chatgpt-customers-using-data-residency> |
| Amazon Bedrock provider | 内置 `amazon-bedrock` provider，把本地 Codex 请求发到 AWS Bedrock Mantle Responses API。 | <https://developers.openai.com/codex/amazon-bedrock> |
| Bedrock supported IDs | 官方 Bedrock 文档明确列出 `openai.gpt-5.5` 和 `openai.gpt-5.4`，区域可用性看 AWS。 | <https://developers.openai.com/codex/amazon-bedrock#supported-models> |
| OSS local providers | `--oss` 支持 Ollama 或 LM Studio，本地 provider 可由 `oss_provider` 持久配置。 | <https://developers.openai.com/codex/config-file/config-advanced#oss-mode-local-providers> |
| reasoning effort | CLI 使用 `low/medium/high/xhigh` 等 reasoning effort，部分模型还支持 `max/ultra/minimal/none`。 | <https://developers.openai.com/codex/agent-configuration/subagents#reasoning-effort-model_reasoning_effort> |
| Fast mode | `/fast` 可为 catalog 支持的模型启用 Fast service tier；ChatGPT 登录可用，API key 不使用 Fast credits。 | <https://developers.openai.com/codex/agent-configuration/speed#fast-mode> |
| ChatGPT OAuth | `codex login` 默认通过浏览器 ChatGPT OAuth 登录。 | <https://developers.openai.com/codex/auth#sign-in-with-chatgpt> |
| API key auth | `printenv OPENAI_API_KEY | codex login --with-api-key` 以 API key 登录。 | <https://developers.openai.com/codex/auth#sign-in-with-an-api-key> |
| access token auth | Enterprise trusted automation 可用 `CODEX_ACCESS_TOKEN` 或 stdin access token。 | <https://developers.openai.com/codex/auth#use-codex-access-tokens-for-enterprise-automation> |
| `CODEX_API_KEY` for exec | `CODEX_API_KEY` 只支持 `codex exec` 单次运行。 | <https://developers.openai.com/codex/non-interactive-mode#use-api-key-auth> |
| exact full supported model list | 未确证：官方页面强调可用模型随账号、plan、workspace、API key 和 provider 变化；静态完整列表不稳定。 | <https://developers.openai.com/codex/models> |

## Slash 命令

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| slash popup | 在 composer 输入 `/` 打开命令弹窗并筛选命令。 | <https://developers.openai.com/codex/cli/slash-commands> |
| queued slash command | 任务运行中可输入 slash command 后按 Tab 排队到下一 turn。 | <https://developers.openai.com/codex/cli/slash-commands#built-in-slash-commands> |
| `/permissions` | 中途调整审批/权限 preset 或 named permission profile。 | <https://developers.openai.com/codex/cli/slash-commands#update-permissions-with-permissions> |
| `/ide` | 把 IDE 打开的文件、选择区等 context 放入下一 prompt。 | <https://developers.openai.com/codex/cli/slash-commands#include-ide-context-with-ide> |
| `/keymap` | 检查、修改并持久化 TUI key bindings。 | <https://developers.openai.com/codex/cli/slash-commands#remap-tui-shortcuts-with-keymap> |
| `/vim` | 切换 composer Vim mode。 | <https://developers.openai.com/codex/cli/slash-commands#toggle-vim-mode-with-vim> |
| `/setup-default-sandbox` | Windows only，设置 elevated agent sandbox。 | <https://developers.openai.com/codex/cli/slash-commands#set-up-the-elevated-windows-sandbox-with-setup-default-sandbox> |
| `/sandbox-add-read-dir` | Windows only，给 sandbox 增加额外只读目录。 | <https://developers.openai.com/codex/cli/slash-commands#grant-sandbox-read-access-with-sandbox-add-read-dir> |
| `/agent` / `/subagents` | 切换 active agent thread，查看或继续 subagent 工作。 | <https://developers.openai.com/codex/cli/slash-commands#switch-agent-threads-with-agent> |
| `/apps` | 浏览 apps/connectors 并插入 `$app-slug` 到 prompt。 | <https://developers.openai.com/codex/cli/slash-commands#browse-apps-with-apps> |
| `/plugins` | 打开插件浏览器、安装、检查或切换插件状态。 | <https://developers.openai.com/codex/cli/slash-commands#browse-plugins-with-plugins> |
| `/hooks` | 查看 lifecycle hooks、信任或禁用非 managed hooks。 | <https://developers.openai.com/codex/cli/slash-commands#view-and-manage-lifecycle-hooks-with-hooks> |
| `/clear` | 清屏并在同一 CLI session 开启新 task。 | <https://developers.openai.com/codex/cli/slash-commands#clear-the-terminal-and-start-a-new-task-with-clear> |
| `/rename` | 重命名当前 task，不改变 transcript。 | <https://developers.openai.com/codex/cli/slash-commands#rename-the-current-task-with-rename> |
| `/archive` | 归档当前 session 并退出 CLI。 | <https://developers.openai.com/codex/cli/slash-commands#archive-the-current-session-with-archive> |
| `/delete` | 删除当前 session transcript 并退出 CLI。 | <https://developers.openai.com/codex/cli/slash-commands#delete-the-current-session-with-delete> |
| `/compact` | 压缩对话，释放 context。 | <https://developers.openai.com/codex/cli/slash-commands#keep-transcripts-lean-with-compact> |
| `/copy` | 复制最近完成的 Codex 输出，等价快捷键 `Ctrl+O`。 | <https://developers.openai.com/codex/cli/slash-commands#copy-the-latest-response-with-copy> |
| `/diff` | 显示 Git diff，包括未跟踪文件。 | <https://developers.openai.com/codex/cli/slash-commands#review-changes-with-diff> |
| `/quit` / `/exit` | 退出 CLI。 | <https://developers.openai.com/codex/cli/slash-commands#exit-the-cli-with-quit-or-exit> |
| `/experimental` | 切换实验 features，例如 Network proxy 或 Prevent sleep。 | <https://developers.openai.com/codex/cli/slash-commands#toggle-experimental-features-with-experimental> |
| `/approve` | 对最近一次 auto-review denial 允许重试一次。 | <https://developers.openai.com/codex/cli/slash-commands#approve-an-auto-review-denial-with-approve> |
| `/memories` | 控制当前/未来 session 是否使用或生成 memories。 | <https://developers.openai.com/codex/cli/slash-commands#configure-memories-with-memories> |
| `/skills` | 浏览并选择 skill 让下一请求遵循其说明。 | <https://developers.openai.com/codex/cli/slash-commands#use-skills-with-skills> |
| `/import` | 导入 Claude Code 等外部 agent 的支持项。 | <https://developers.openai.com/codex/cli/slash-commands#import-claude-code-configuration-with-import> |
| `/feedback` | 收集并提交 logs/diagnostics 给维护者。 | <https://developers.openai.com/codex/cli/slash-commands#send-feedback-with-feedback> |
| `/init` | 在当前目录生成 `AGENTS.md` scaffold。 | <https://developers.openai.com/codex/cli/slash-commands#generate-agentsmd-with-init> |
| `/logout` | 清除当前用户本地凭据。 | <https://developers.openai.com/codex/cli/slash-commands#sign-out-with-logout> |
| `/mcp` | 列出当前 session 可用 MCP servers/tools，`verbose` 显示诊断。 | <https://developers.openai.com/codex/cli/slash-commands#list-mcp-tools-with-mcp> |
| `/mention` | 把文件加入 conversation context。 | <https://developers.openai.com/codex/cli/slash-commands#highlight-files-with-mention> |
| `/model` | 选择 active model 和 reasoning effort。 | <https://developers.openai.com/codex/cli/slash-commands#set-the-active-model-with-model> |
| `/fast` | 切换当前模型的 Fast service tier 并持久化。 | <https://developers.openai.com/codex/cli/slash-commands#toggle-fast-mode-with-fast> |
| `/plan` | 切换 Plan mode，并可附 inline prompt。 | <https://developers.openai.com/codex/cli/slash-commands#switch-to-plan-mode-with-plan> |
| `/goal` | 设置、查看、编辑、暂停、恢复或清除持久 task goal。 | <https://developers.openai.com/codex/cli/slash-commands#set-or-view-a-task-goal-with-goal> |
| `/personality` | 设置 Codex 响应风格。 | <https://developers.openai.com/codex/cli/slash-commands#set-a-communication-style-with-personality> |
| `/ps` | 查看后台 terminals 和最近输出。 | <https://developers.openai.com/codex/cli/slash-commands#check-background-terminals-with-ps> |
| `/stop` / `/clean` | 停止当前 session 的后台 terminals。 | <https://developers.openai.com/codex/cli/slash-commands#stop-background-terminals-with-stop> |
| `/fork` | 从当前 conversation 分叉新 task。 | <https://developers.openai.com/codex/cli/slash-commands#fork-the-current-conversation-with-fork> |
| `/app` | 在 macOS/Windows desktop app 中继续当前 session。 | <https://developers.openai.com/codex/cli/slash-commands#continue-in-the-desktop-app-with-app> |
| `/side` / `/btw` | 开启不打断主 task transcript 的 ephemeral side conversation。 | <https://developers.openai.com/codex/cli/slash-commands#start-a-side-conversation-with-side> |
| `/raw` | 切换 raw scrollback mode，改善长输出选择复制。 | <https://developers.openai.com/codex/cli/slash-commands#toggle-raw-scrollback-with-raw> |
| `/resume` | 从保存的 session 列表恢复 conversation。 | <https://developers.openai.com/codex/cli/slash-commands#resume-a-saved-conversation-with-resume> |
| `/new` | 在同一 CLI session 中开始新 task。 | <https://developers.openai.com/codex/cli/slash-commands#start-a-new-conversation-with-new> |
| `/review` | 请求 Codex 审查 working tree。 | <https://developers.openai.com/codex/cli/slash-commands#ask-for-a-working-tree-review-with-review> |
| `/status` | 显示 model、approval policy、writable roots、token/context usage 等 session 信息。 | <https://developers.openai.com/codex/cli/slash-commands#inspect-the-session-with-status> |
| `/usage` | 查看账号 token usage 或使用 rate-limit reset。 | <https://developers.openai.com/codex/cli/slash-commands#view-account-usage-with-usage> |
| `/debug-config` | 打印配置层、requirements 和 policy 诊断。 | <https://developers.openai.com/codex/cli/slash-commands#inspect-config-layers-with-debug-config> |
| `/statusline` | 交互式配置 TUI footer status line 字段。 | <https://developers.openai.com/codex/cli/slash-commands#configure-footer-items-with-statusline> |
| `/title` | 交互式配置 terminal title 字段。 | <https://developers.openai.com/codex/cli/slash-commands#configure-terminal-title-items-with-title> |
| `/theme` | 预览并持久化 syntax-highlighting theme。 | <https://developers.openai.com/codex/cli/slash-commands#choose-a-syntax-theme-with-theme> |
| `/pets` / `/pet` | 选择或隐藏 terminal pet。 | <https://developers.openai.com/codex/cli/slash-commands#choose-a-terminal-pet-with-pets> |
| `/prompts:<name>` | 调用 `~/.codex/prompts/*.md` 自定义 prompt，官方已弃用并建议用 skills。 | <https://developers.openai.com/codex/custom-prompts> |

## 多 agent、子任务与可编程控制

| Feature | 一句话说明 | 官方来源 URL |
| --- | --- | --- |
| subagent workflows | Codex 可并行生成 specialized agents 并把结果汇总回主线程。 | <https://developers.openai.com/codex/agent-configuration/subagents> |
| CLI subagent trigger | 交互式 CLI 中可直接要求使用 subagents，也可由 `AGENTS.md` 或 skill 指令触发。 | <https://developers.openai.com/codex/agent-configuration/subagents#availability> |
| `/agent` management | CLI 用 `/agent` 查看、切换 active subagent thread。 | <https://developers.openai.com/codex/agent-configuration/subagents#managing-subagents> |
| approval surfacing from inactive agents | CLI 中 inactive agent thread 的审批请求也可弹出，overlay 显示来源 thread。 | <https://developers.openai.com/codex/agent-configuration/subagents#approvals-and-sandbox-controls> |
| non-interactive subagent approval failure | 非交互或无法弹出新审批时，需要新 approval 的 action 会失败并返回父 workflow。 | <https://developers.openai.com/codex/agent-configuration/subagents#approvals-and-sandbox-controls> |
| inherited sandbox | subagents 继承 parent 当前 sandbox policy 和 live runtime overrides。 | <https://developers.openai.com/codex/agent-configuration/subagents#approvals-and-sandbox-controls> |
| built-in agents | 内置 `default`、`worker`、`explorer` agent。 | <https://developers.openai.com/codex/agent-configuration/subagents#custom-agents> |
| custom agents | 可在 `~/.codex/agents/` 或 `.codex/agents/` 放 TOML 定义自定义 agent。 | <https://developers.openai.com/codex/agent-configuration/subagents#custom-agents> |
| custom agent schema | 自定义 agent 必须有 `name`、`description`、`developer_instructions`，可覆盖 model、sandbox、MCP、skills 等。 | <https://developers.openai.com/codex/agent-configuration/subagents#custom-agent-file-schema> |
| `agents.max_threads` | 控制并发打开的 agent thread 数，默认 6。 | <https://developers.openai.com/codex/agent-configuration/subagents#global-settings> |
| `agents.max_depth` | 控制 spawn 嵌套深度，默认 1。 | <https://developers.openai.com/codex/agent-configuration/subagents#global-settings> |
| `agents.job_max_runtime_seconds` | 控制 CSV batch subagent worker 默认超时。 | <https://developers.openai.com/codex/agent-configuration/subagents#global-settings> |
| `spawn_agents_on_csv` | 官方文档列为 experimental CSV batch subagents workflow。 | <https://developers.openai.com/codex/agent-configuration/subagents#process-csv-batches-with-subagents-experimental> |
| app-server thread API | app-server 暴露 `thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer` 等原语。 | <https://developers.openai.com/codex/app-server#lifecycle-overview> |
| `turn/interrupt` | app-server 可请求取消 in-flight turn。 | <https://developers.openai.com/codex/app-server#method-index> |
| app-server `review/start` | app-server 可触发 review mode，并流式进入/退出 review items。 | <https://developers.openai.com/codex/app-server#method-index> |
| app-server `command/exec` | app-server 可在 server sandbox 下执行单命令，不创建 thread/turn。 | <https://developers.openai.com/codex/app-server#command-execution> |
| Codex SDK TypeScript | `@openai/codex-sdk` 可 programmatically start/resume thread 并运行任务。 | <https://developers.openai.com/codex/codex-sdk> |
| Codex SDK Python | `openai-codex` 通过本地 app-server JSON-RPC 控制 Codex，带 Sandbox presets。 | <https://developers.openai.com/codex/codex-sdk> |
| Codex as MCP server tools | `codex mcp-server` 暴露 `codex` 和 `codex-reply` 两个 MCP tools。 | <https://developers.openai.com/codex/guides/agents-sdk#running-codex-as-an-mcp-server> |
| Agents SDK orchestration | 官方示例用 Codex MCP server 与 OpenAI Agents SDK 构建单 agent 和多 agent workflow。 | <https://developers.openai.com/codex/guides/agents-sdk> |
| `/goal` persisted goal | CLI 支持持久 task goal，用于长任务持续跟踪目标。 | <https://developers.openai.com/codex/cli/slash-commands#set-or-view-a-task-goal-with-goal> |
| `/side` side conversation | CLI 可开启 ephemeral fork 做旁路问题，不污染主 task transcript。 | <https://developers.openai.com/codex/cli/slash-commands#start-a-side-conversation-with-side> |

## 未确证 / 版本差异 / 稳定性注意

| 点 | 结论 | 官方来源 URL |
| --- | --- | --- |
| `codex exec-server` | 本机 `codex-cli 0.142.5 --help` 显示实验性 `exec-server`，但当前官方 developer commands 页面未列出，故未作为官方能力纳入主清单。 | <https://developers.openai.com/codex/developer-commands?surface=cli> |
| 非图片文件 CLI attachment flag | 未找到官方 `--file` 或类似 flag；官方确认的是 image flag、stdin、workspace 路径、`/mention` 和 `@` path autocomplete。 | <https://developers.openai.com/codex/image-inputs> |
| 完整内部 tool protocol | 官方公开了 JSONL item 类型和 hook 可拦截的 `Bash`、`apply_patch`、MCP tool；完整内部 tool 集合/参数不是稳定公开接口。 | <https://developers.openai.com/codex/hooks#pretooluse> |
| transcript / rollout 文件格式 | app-server 和 hooks 文档确认 JSONL log、rollout metadata、transcript_path，但明确 transcript format 不是稳定 hook interface。 | <https://developers.openai.com/codex/hooks#common-input-fields> |
| 静态“所有模型”列表 | 官方模型页面给推荐模型和 provider 机制，但 exact availability 随 plan、workspace、API key、provider、region 变化。 | <https://developers.openai.com/codex/models> |
| ChatGPT desktop/web 专属能力 | Browser、Computer Use、Appshots、Chrome extension、Record & Replay 等在 Codex 生态中存在，但并非全部是 CLI 原生能力；本清单只在相关生态/插件处标注。 | <https://developers.openai.com/codex/cli> |

## 速览表

| 能力面 | 重点覆盖 |
| --- | --- |
| 运行模式 | 交互式 TUI、`codex exec`、`exec resume`、interactive resume/fork/archive/delete、cloud、app/app-server、SDK、MCP server。 |
| 输入与多模态 | prompt、stdin、prompt+stdin、图片输入、图片生成、文件路径 context、`/mention`、`@` file search、web search。 |
| 权限与沙箱 | read-only、workspace-write、danger-full-access、bypass/yolo、approval policies、granular approvals、rules、permission profiles、OS sandbox。 |
| 输出格式 | formatted stdout/stderr、JSONL event stream、event/item types、final message file、JSON Schema final output、app-server JSONL/JSON-RPC。 |
| 工具与扩展 | shell/unified exec、file changes/apply_patch、web search、view_image、MCP、apps/connectors、plugins、skills、hooks、notify、AGENTS.md、custom prompts。 |
| 配置 | config layer precedence、profile、project trust、model/provider、sandbox/approval、MCP、hooks、features、TUI、OTel、history、env vars。 |
| 模型/provider | GPT-5.6 Sol/Terra/Luna、GPT-5.4、GPT-5.3-Codex-Spark、OpenAI/API key、custom provider、Azure、Bedrock、Ollama/LM Studio。 |
| Slash 命令 | 官方内置 slash commands、queued slash、session 控制、权限/model/status/diff/review/mcp/plugins/hooks/subagents 等。 |
| 多 agent | subagent workflow、custom agents、built-in agents、agent limits、inherit sandbox、app-server threads、Codex SDK、Codex-as-MCP。 |
| 未确证 | `exec-server`、非图片 attachment flag、完整内部 tool protocol、稳定 rollout/transcript 格式、静态所有模型列表。 |
