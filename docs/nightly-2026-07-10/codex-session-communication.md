# Codex session / thread 通信机制调研

调研日期：2026-07-10。范围限定在 CodeShell 当前 `DriveAgent(cli:"codex")`
实现、Codex CLI `codex exec` 非交互模式，以及今晚三角色流水线。

## 结论

不能把多个 Codex session 当成可互相发消息的 thread 网络。当前机制是：

1. `resumeSessionId` 只表示续接同一个 Codex thread/session。
2. CodeShell 不提供 session 间共享上下文、消息总线、自动 transcript 注入或 fan-in/fan-out 合并。
3. implementer -> reviewer -> integrator 之间传上下文，必须显式靠 prompt、`finalText`、git commit/diff、review 报告文件、产物路径或附件。
4. 同一个 `resumeSessionId` 不要并发 resume。当前代码没有按 sessionId 加锁，只有同 cwd 的后台可写任务 warning；并发续接同一 thread 可能产生上下文顺序、rollout 写入和工作区改动竞争。

对今晚流水线的建议：三角色默认各自新 session；只有 BLOCK 后打回 implementer
修同一个任务时，才 resume implementer 自己的 session。reviewer 和 integrator 不要
resume implementer 的 session，而是把 commit、diff 范围、review 文件和验收标准写进新 prompt。

## 机制总览

CodeShell 的 DriveAgent 对 Codex 的封装是“一次 DriveAgent 调用 = 启动一个
`codex exec` 子进程，跑完一个 turn，然后解析 JSONL”。如果传入 `resumeSessionId`，
adapter 把它映射为 `codex exec ... resume <sessionId> -`，其中尾部 `-` 表示后续
prompt 从 stdin 读入。

Codex CLI JSONL 输出里的 `thread.started.thread_id` 被 CodeShell 当作
`sessionId` 返回和保存。后续 `resumeSessionId` 用的就是这个 thread id。CodeShell
额外维护一份外部 session 到 cwd 的绑定，用于防止同一个 Codex session 被拿到错误
目录里续接。

这条链路没有“session 间通信”步骤。每个 Codex session 的模型可见上下文来自：

- Codex 自身持久化的同一 thread 历史。
- 本次 `codex exec` 的 prompt/stdin。
- Codex 在 cwd 里读取到的文件、git 状态和命令结果。
- 编排方显式传入的附件或产物路径。

## CodeShell 代码证据

### 1. `resumeSessionId` 如何变成 Codex CLI 参数

- `packages/core/src/cc-orchestrator/agent-adapter.ts:103` 定义 `codexAdapter`，
  `promptViaStdin: true` 表示 prompt 不放 argv，而由 driver 写入 stdin。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:107` 基础参数是
  `exec --json --color never --skip-git-repo-check`。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:108` 到 `:115` 把 CodeShell 的
  permission mode 映射为 Codex sandbox 或
  `--dangerously-bypass-approvals-and-sandbox`。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:119` 到 `:122` 是关键映射：
  有 `resumeSessionId` 时追加 `resume <thread_id> -`，否则只追加 `-`。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:139` 从
  `thread.started.thread_id` 读取 session id。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:141` 到 `:145` 把最后一个
  `item.completed` 且 `item.type === "agent_message"` 的 `text` 当成 `finalText`。
- `packages/core/src/cc-orchestrator/agent-adapter.ts:146` 到 `:154` 把
  `turn.failed` / `error` 视为失败。

单元测试也覆盖了这个约定：

- `packages/core/src/cc-orchestrator/agent-adapter.test.ts:99` 到 `:110` 断言
  `resumeSessionId` 会生成 `resume <id> -`。
- `packages/core/src/cc-orchestrator/agent-adapter.test.ts:151` 到 `:168` 断言
  `thread.started.thread_id` 是返回的 sessionId，agent_message 是 finalText。

### 2. 子进程执行和 stdin 写入

- `packages/core/src/cc-orchestrator/external-agent-driver.ts:82` 到 `:89` 调用
  adapter `buildArgs`，把 `resumeSessionId`、`cwd`、permission mode 和图片信息传入。
- `packages/core/src/cc-orchestrator/external-agent-driver.ts:94` 到 `:108` 检查
  `promptViaStdin`，并通过 `child.stdin.end(opts.prompt)` 把 prompt 写入 Codex。
- `packages/core/src/cc-orchestrator/external-agent-driver.ts:95` 到 `:105` 启动子进程时
  使用 `cwd: opts.cwd`，stdout 按行收集 JSONL。
- `packages/core/src/cc-orchestrator/external-agent-driver.ts:140` 到 `:142` 在进程退出时
  用收集到的 lines 解析结果。这里是一轮执行模型，不是常驻跨 session 消息通道。

### 3. DriveAgent 入口、cwd 绑定和后台通知

- `packages/core/src/tool-system/builtin/drive-claude-code.ts:29` 到 `:54` 的工具描述写明：
  `resumeSessionId` 是“continue a prior session of the SAME cli”，大任务建议按序列 resume，
  不要 swarm。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:117` 到 `:130` 默认 runner 选择
  `codexAdapter` + `codex` command，并调用 `runAgentOnce`。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:191` 到 `:199` 只在成功且有
  `sessionId` 时记录 `{ cli, sessionId, cwd }`。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:344` 到 `:358` 处理
  `resumeSessionId`：读取绑定，如果绑定 cwd 存在且和调用方 cwd 不同，就强制使用已绑定 cwd，
  并返回 note。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:415` 到 `:430` 后台模式只登记
  background job 并返回 jobId，结果稍后靠通知回到当前 CodeShell session。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:229` 到 `:256` 后台完成后把
  `finalText` 或错误放入 `notificationQueue`，附带 `ccSessionId`。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:260` 到 `:268` 完成后从外部
  transcript 里读 changed files，记录到 background job。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:211` 到 `:217` 只对“同 cwd 的
  可写后台任务”发 warning。这里没有按 `resumeSessionId` 或 thread id 的互斥锁。

对应测试：

- `packages/core/src/tool-system/builtin/drive-claude-code.test.ts:359` 到 `:390` 断言
  resume 时会强制使用 stored cwd。
- `packages/core/src/tool-system/builtin/drive-claude-code.test.ts:438` 到 `:467` 断言
  stored cwd 不存在时不启动外部 agent。
- `packages/core/src/tool-system/builtin/drive-claude-code.test.ts:282` 到 `:304` 断言
  同 cwd 的第二个可写后台任务只会 warning，不会阻断。

### 4. CodeShell 自己保存了什么绑定

实际 DriveAgent 使用的是 `external-agent-session-store.ts`：

- `packages/core/src/session/session-manager.ts:93` 到 `:94` 表明 CodeShell home 默认是
  `~/.code-shell`，可由 `CODE_SHELL_HOME` 覆盖。
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:39` 到 `:40` 默认文件是
  `<codeShellHome>/external-agent-sessions.json`。
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:17` 到 `:24` 的 binding
  字段是 `cli`、`sessionId`、`cwd`、可选 `worktreePath` / `worktreeBranch`、`updatedAt`。
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:46` 到 `:49` 通过
  `(cli, sessionId)` 读取。
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:51` 到 `:67` 写入时会
  normalize cwd，并用同 `(cli, sessionId)` 替换旧记录。
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:102` 到 `:130` 有文件级
  lock，保护绑定文件并发写，但这不是 Codex thread resume 锁。

另一个 `external-agent-bindings.ts` 定义了更丰富的 store，但当前 DriveAgent 路径没有使用它：

- `packages/core/src/cc-orchestrator/external-agent-bindings.ts:23` 到 `:24` 默认路径是
  `<codeShellHome>/external-agents/bindings.json`。
- `packages/core/src/cc-orchestrator/external-agent-bindings.ts:8` 到 `:17` 记录
  `externalSessionId`、`codeShellSessionId`、`cwd`、worktree 字段和 created/lastUsed 时间。
- `packages/core/src/cc-orchestrator/external-agent-bindings.ts:30` 到 `:46` 支持 get/upsert。
- `packages/core/src/cc-orchestrator/external-agent-bindings.ts:105` 到 `:120` 能在绑定 cwd
  丢失时生成错误信息。
- `rg` 结果显示当前直接引用集中在该文件自身的导出；DriveAgent 用的是
  `externalAgentSessionStore`，不是 `externalAgentBindingStore`。

### 5. 如何发现 Codex 历史 session

CodeShell 不问 Codex 进程拿历史列表，而是直接扫描 Codex rollout 文件：

- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:12` 到 `:18` 注释记录布局：
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，第一行
  `session_meta.payload` 里有 `{ id, cwd, timestamp }`，其中 `id` 是可 resume 的 thread id。
- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:26` 到 `:31` 默认
  `codexHome = ~/.codex`，扫描 `sessions`。
- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:39` 到 `:56` 先按 rollout
  文件 mtime 做 recency window，再读第一行 meta，并按 `meta.cwd === cwd` 过滤。
- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:57` 到 `:62` 返回的
  `DiscoveredSession.sessionId` 是 `meta.id`。
- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:119` 到 `:126` 只解析第一行
  `session_meta`。
- `packages/core/src/cc-orchestrator/codex-session-discovery.ts:138` 到 `:172` 为标题读取有限前缀，
  找第一条非 `<environment_context>` 的用户消息。

本机核验也看到 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 存在，rollout 文件
按日期目录分布；抽样第一行是 `type:"session_meta"`，payload 含 `id`、`cwd`、`timestamp`
等字段。

### 6. 如何读 transcript 和 changed files

- `packages/core/src/cc-orchestrator/codex-session-history.ts:25` 到 `:33` 根据 `cwd` +
  `threadId` 找 rollout 文件。
- `packages/core/src/cc-orchestrator/codex-session-history.ts:41` 到 `:68` 逐行解析 JSONL，
  只收集 `response_item` 中的 user/assistant message，以及 function/custom tool call 摘要。
- `packages/core/src/cc-orchestrator/codex-session-history.ts:54` 到 `:57` 跳过
  `<environment_context>` 注入。
- `packages/core/src/cc-orchestrator/codex-session-history.ts:121` 到 `:133` 同时匹配
  `session_meta.id === threadId` 和 `session_meta.cwd === cwd`。
- `packages/core/src/cc-orchestrator/external-agent-changes.ts:77` 到 `:82` 说明 Codex changed
  files 来自 rollout 中的 `response_item` tool call。
- `packages/core/src/cc-orchestrator/external-agent-changes.ts:83` 到 `:101` 提取写文件类工具：
  `apply_patch`、`ApplyPatch`、`write_file`、`edit_file`。
- `packages/core/src/cc-orchestrator/external-agent-changes.ts:128` 到 `:143` 根据
  `threadId + cwd` 定位 Codex rollout 并返回 changed files。

这些读取能力是 UI/编排层的“回放和归因”，不是把一个 session 的上下文自动注入另一个
session。

## Codex CLI 事实

官方 Codex 文档和本机 `codex-cli 0.142.5` help 一致：

- `codex exec --json` 输出 JSON Lines，每行是事件。官方非交互文档列出的事件包括
  `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*` 和 `error`；
  示例第一行是 `{"type":"thread.started","thread_id":"..."}`，最终消息可来自
  `item.completed` 的 `agent_message`。
- `codex exec` 的 prompt 参数可以是 `-`，表示从 stdin 读取。CodeShell 正是使用这个模式。
- `codex exec resume [SESSION_ID]` 用 session/thread id 续接非交互 session；也支持
  `--last` 选择当前工作目录最近 session，`--all` 跨目录选择。`resume` 后还可接一个可选
  follow-up prompt，`-` 同样表示从 stdin 读取。
- Codex transcript 默认位置是 `$CODEX_HOME/sessions`，默认 `$CODEX_HOME=~/.codex`，所以默认是
  `~/.codex/sessions`；归档位置是 `$CODEX_HOME/archived_sessions`。
- Codex app-server 文档把 Thread 定义为 conversation，Turn 是一次用户请求和随后的 agent
  work。app-server 有 `thread/start`、`thread/resume` 和 `thread/fork`，但 CodeShell 当前
  DriveAgent 走的是 `codex exec` 子进程，不是 app-server，也没有暴露 `thread/fork` 或
  `thread/inject_items`。

官方来源：

- OpenAI Codex non-interactive mode:
  https://developers.openai.com/codex/noninteractive
- OpenAI Codex CLI reference:
  https://developers.openai.com/codex/cli/reference
- OpenAI Codex app troubleshooting, transcript paths:
  https://developers.openai.com/codex/app/troubleshooting
- OpenAI Codex app-server, thread/turn primitives:
  https://developers.openai.com/codex/app-server

## 对三角色流水线的实操建议

### implementer

为每项任务开新 Codex session，`cwd` 设为该任务独立 worktree。prompt 必须完整自足：
目标、约束、验收、测试命令、commit 要求都写进去。完成通知里的 `ccSessionId` 只给后续
“打回同一 implementer 继续修”使用，不给 reviewer/integrator 共享上下文用。

### reviewer

默认新 Codex session，最好只读。不要 resume implementer session 来审，因为那会把 review
prompt 和审查上下文写进 implementer 的同一 thread，降低角色隔离。把这些显式写进 reviewer
prompt：

- worktree `cwd`。
- base 分支和 diff 范围，例如 `git diff <base>...HEAD`。
- implementer 的 commit hash / branch。
- 任务验收标准。
- implementer finalText 中的实现摘要。
- 要写出的 review 报告路径，例如 `docs/nightly-2026-07-10/review-<slug>.md`。

如果 BLOCK，把 review 文件路径和关键 findings 明确传给 implementer。此时可以 resume
implementer 自己的 session，原因是修复需要延续同一实现上下文；但必须等原 session 没有
正在运行的 job。

### integrator

默认新 Codex session，`cwd` 是主 worktree，不是任务 worktree。prompt 显式包含：

- 要 merge 的分支名和 commit。
- review 报告路径及结论。
- 回归测试命令。
- 清扫 worktree 的路径。

不要 resume implementer/reviewer session 做合并。合并阶段依赖的是 git 产物和 review 文件，
不是某个 agent 的私有上下文。

### 什么时候适合 resume 同一个 session

适合：

- 同一个 implementer 对同一任务做 BLOCK 修复。
- 同一个 agent 对刚完成的一轮继续补充遗漏，且没有角色切换。

不适合：

- reviewer 续接 implementer。
- integrator 续接 reviewer 或 implementer。
- 两个后台 job 同时 resume 同一 session。
- 跨任务复用旧 session。那会把上一任务上下文混入下一任务。

## 并发风险

当前代码里有两类保护：

- 绑定文件写入有 lock，避免 `external-agent-sessions.json` 并发写丢记录。
- 同 cwd 的可写后台 DriveAgent job 会 warning，提示可能互相覆盖工作区。

当前代码里没有这些保护：

- 没有 `resumeSessionId` 级别的 mutex。
- 没有检测同一 Codex thread 是否已在另一个 `codex exec resume` 中运行。
- 没有把一个 session 的 finalText 自动注入另一个 session。
- 没有跨 session 的消息队列或共享 memory。

因此编排规则应写成硬约束：同一个 Codex `sessionId/thread_id` 同一时刻只能有一个活跃
DriveAgent job。若要并行审多个独立任务，每个任务、每个角色都用新 session，并通过 git
分支、diff、报告文件和 prompt 传上下文。

## 最终回答

用户原问题的答案是：不能做真正的 session 间 thread 通信。Codex 的 thread 是单条会话链，
`codex exec resume <thread_id>` 是向同一条链追加一个 turn；CodeShell 当前 DriveAgent 只
暴露这条单链 resume 能力。多 session 之间要传信息，只能由编排方显式搬运：把上一个
session 的 `finalText`、commit/diff、改动文件、review 报告路径或产物文件写进下一个
session 的 prompt，或作为附件传入。
