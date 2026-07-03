# Worktree / Session Isolation 调研：Claude Code、Codex 与 CodeShell

> 状态：调研稿 / 设计输入  
> 日期：2026-07-03  
> 目的：梳理 Claude Code、Codex 与 CodeShell 当前 worktree/session/cwd 机制，为后续 CodeShell 完整 worktree workspace 模式提供技术依据。

## 1. 背景与结论

CodeShell 目前已经有基础 worktree 工具：`EnterWorktree` / `ExitWorktree` 可以创建、清理 git worktree，并能在创建后运行项目 setup script。但它还不是完整的 workspace 模式：主会话的 `cwd` 不会被真正切换，文件工具和 `DriveAgent` 也不会自动继承 active worktree。

外部对标结论：

- Claude Code 已有一等 worktree 能力：`claude --worktree`、会话内 `EnterWorktree`、subagent worktree、cleanup、`.worktreeinclude`、transcript relocation 等。
- Codex CLI 没有等价的内置 git worktree 模式；它主要依赖调用者提供的 working directory，并用 sandbox 限制当前 workspace。
- 两者 resume 都与 `cwd` 强相关。Claude Code 官方文档显示新版已处理 worktree transcript relocation；历史 issue 证明 worktree resume cwd 曾有坑。Codex issue 明确指出 resume 会采用调用者当前目录，导致 sandbox/workdir 边界漂移。
- CodeShell 的 `DriveAgent` 目前只把传入 `cwd` 交给外部 CLI；如果 CC/Codex session 在 worktree 内启动，后续 resume 必须绑定原 `cwd`，否则容易写错目录或扩大 sandbox 边界。

## 2. Claude Code 的 worktree 能力

Claude Code 官方文档《Run parallel sessions with worktrees》定义了完整的 worktree workflow：

- `claude --worktree <name>` / `claude -w <name>` 会创建隔离 worktree 并在其中启动 Claude。
- 默认目录为仓库内 `.claude/worktrees/<value>/`。
- 默认分支名为 `worktree-<value>`。
- 不传 name 时会自动生成名称。
- 会话中也可以要求 Claude “work in a worktree”，由 `EnterWorktree` 工具创建。
- 可通过 `worktree.baseRef` 选择从远端默认分支 fresh checkout，或从本地 `HEAD` 派生。
- `.worktreeinclude` 用于复制 gitignored 文件，例如 `.env` / `.env.local`。
- subagents 可通过 `isolation: worktree` 在独立 worktree 中运行。
- agent 运行期间会 `git worktree lock`，避免 cleanup 并发删除工作区。

关键设计点是：**Claude Code 把 worktree 作为会话执行位置的一等概念，而不是单纯暴露一个 `git worktree add` helper。**

### 2.1 transcript 与 resume

Claude Code 文档还写明：从 v2.1.198 起，进入或退出 worktree 会把 session transcript relocation 到对应目录的 project storage，和 `/cd` 行为一致，因此 `/desktop` 和 `--resume` 能在之后找到该 session。

这说明 Claude Code 已经意识到一个核心问题：**worktree 不只是文件系统目录，还是 session 存储归属和 resume 查找路径的一部分。**

历史 issue `anthropics/claude-code#30906` 也印证了这个问题：用户报告 Claude 通过 `EnterWorktree` 在 worktree 工作后，退出再 `--resume` / `--continue`，工作目录会回到主仓库 root，而不是原 worktree path。该 issue 已关闭为 duplicate，但它说明 resume cwd restore 是真实风险。

## 3. Codex 的 cwd / sandbox / resume 行为

OpenAI Codex 官方文档没有提供等价于 `claude --worktree` 的 git worktree workflow。Codex 的本地 CLI/IDE 模式重点是 sandbox 与 approval：

- Codex CLI / IDE 使用 OS-level sandbox。
- 默认网络关闭。
- writable scope 通常限制在当前 workspace。
- `read-only` 适合只读浏览。
- `workspace-write` 允许读写当前 workspace。
- `dangerously-bypass-approvals-and-sandbox` / `--yolo` 等价于放弃 sandbox 和审批。

CodeShell 当前 Codex adapter 也按这个模型驱动：

- `default` → `--sandbox read-only`
- `acceptEdits` → `--sandbox workspace-write`
- `bypassPermissions` → `--dangerously-bypass-approvals-and-sandbox`

实现位置：`packages/core/src/cc-orchestrator/agent-adapter.ts:97`。

Codex 的已关闭 issue `openai/codex#4791` 明确指出：resume session 时，如果调用者 shell 当前目录变了，resumed session 会采用调用者当前目录；sandbox writable roots 和 tool-call resolution 也随之变化。这对 CodeShell 很关键：**如果 CodeShell 只保存 Codex thread id，而不保存原 cwd，就无法保证 resume 后仍在原 workspace/worktree 内。**

## 4. CodeShell 当前实现

### 4.1 基础 worktree 工具

CodeShell 的 worktree 能力由两层组成：

- 工具层：`packages/core/src/tool-system/builtin/worktree.ts`
- git 操作层：`packages/core/src/git/worktree.ts`

`EnterWorktree` / `ExitWorktree` 已经作为内置工具存在。`EnterWorktree` 会校验 slug、创建 worktree、记录 active worktree，并运行 setup script。工具定义和入口在 `packages/core/src/tool-system/builtin/worktree.ts:24` 与 `packages/core/src/tool-system/builtin/worktree.ts:45`。

当前 active state 是模块级全局变量：

```ts
let _activeWorktree: WorktreeSession | undefined;
```

位置：`packages/core/src/tool-system/builtin/worktree.ts:17`。

这意味着它不是 per-session / per-task 状态；并发 session 或后台 agent 之间存在碰撞风险。

### 4.2 创建规则

`createWorktree` 的核心规则如下：

```ts
const branchName = `worktree/${slug}-${sessionId.slice(0, 8)}`;
const worktreePath = resolve(gitRoot, "..", `.worktrees/${slug}-${sessionId.slice(0, 8)}`);
```

位置：`packages/core/src/git/worktree.ts:80`。

也就是说，CodeShell 当前创建路径是主仓库父目录下的 `.worktrees/<slug>-<sessionPrefix>`，而不是仓库内 `.claude/worktrees/<name>`。

实际创建命令使用 argv 形式，避免 shell quoting 注入：

```ts
execFileSync(GIT_BIN, ["worktree", "add", "-b", branchName, worktreePath], ...)
```

位置：`packages/core/src/git/worktree.ts:99`。

创建后会 symlink 大目录，降低重复依赖安装成本：

```ts
const largeDirs = ["node_modules", ".venv", "vendor", ".pnpm-store"];
```

位置：`packages/core/src/git/worktree.ts:268`。

### 4.3 setup script

CodeShell 在 worktree 创建后读取项目 `localEnvironment.setupScripts`，选择当前平台脚本并在新 worktree root 执行。失败不阻断，只警告继续。

相关设计注释在 `packages/core/src/git/worktree.ts:129`：setup 属于 worktree lifecycle，而不是 conversation lifecycle。

### 4.4 cleanup 语义

`ExitWorktree` 支持两个 action：

- `discard`：删除 worktree，并删除 `worktree/*` 分支。
- `keep`：删除 worktree 目录，但保留分支，提示用户之后可 `git merge <branch>`。

实现位置：`packages/core/src/tool-system/builtin/worktree.ts:129`。

需要注意：当前 `keep` 不是“保留工作区以便继续”，而是“删除 worktree 目录，仅保留分支”。这与 Claude Code 的 “keep preserves the directory and branch so you can return later” 语义不同。

## 5. DriveAgent / DriveClaudeCode / Codex 驱动方式

CodeShell 的外部 agent 驱动入口在 `packages/core/src/tool-system/builtin/drive-claude-code.ts`。

`DriveAgent` 支持两个 CLI：

```ts
const CLI_ADAPTERS = {
  claude: { adapter: claudeAdapter, command: "claude" },
  codex: { adapter: codexAdapter, command: "codex" },
};
```

位置：`packages/core/src/tool-system/builtin/drive-claude-code.ts:12`。

`DriveClaudeCode` 是兼容别名，本质是 `DriveAgent` 固定 `cli: "claude"`，位置：`packages/core/src/tool-system/builtin/drive-claude-code.ts:148`。

### 5.1 关键事实：DriveAgent 不自动使用 worktree

`DriveAgent` 默认 runner 只把调用参数传给 `runAgentOnce`：

```ts
return runAgentOnce(adapter, {
  command,
  prompt,
  resumeSessionId,
  cwd,
  permissionMode,
});
```

位置：`packages/core/src/tool-system/builtin/drive-claude-code.ts:60`。

`runAgentOnce` 直接用 `opts.cwd` 作为 child process cwd：

```ts
const child = spawn(opts.command, args, {
  cwd: opts.cwd,
  ...
});
```

位置：`packages/core/src/cc-orchestrator/external-agent-driver.ts:43`。

因此：**DriveAgent 不会自动创建 worktree，也不会读取 `getActiveWorktree()`，更不会把 `cwd` 重定向到 active worktree。** 如果希望 Claude Code / Codex 在 worktree 内运行，必须显式传入 worktree path 作为 `cwd`。

### 5.2 Claude Code adapter

Claude Code 通过 headless print mode 运行：

```bash
claude -p <prompt> --output-format stream-json --verbose
```

并支持：

- `--resume <sessionId>`
- `--permission-mode <mode>`
- `--disallowedTools Workflow`
- `--append-system-prompt <costGuard>`

实现位置：`packages/core/src/cc-orchestrator/agent-adapter.ts:44`。

### 5.3 Codex adapter

Codex 通过 `codex exec` 运行：

```bash
codex exec --json --color never --skip-git-repo-check -
```

prompt 通过 stdin 输入。resume 时参数形态为：

```bash
codex exec ... resume <thread_id> -
```

实现位置：`packages/core/src/cc-orchestrator/agent-adapter.ts:97`。

## 6. 风险分析

### 6.1 active worktree 不改变主 session cwd

当前 `EnterWorktree` 创建 worktree 后只记录 `_activeWorktree`，没有把 Engine / ToolContext 的 `cwd` 切换过去。因此后续 `Read`、`Edit`、`Bash`、`Grep`、`Glob` 等工具默认仍可能作用于原 workspace，除非每次显式传 worktree path。

这说明 CodeShell 当前能力更接近“创建 worktree 的工具”，还不是“当前 session 进入 worktree workspace 模式”。

### 6.2 外部 agent resume 缺少 cwd 绑定

DriveAgent 返回或记录外部 `sessionId`，但没有持久化：

```ts
{
  cli,
  sessionId,
  cwd,
  worktreePath,
  worktreeBranch,
}
```

如果首次运行在 worktree 内，后续 resume 却传主仓库 cwd，则可能发生：

- Claude Code / Codex 对话恢复，但文件工具在主仓库执行。
- Codex sandbox writable root 漂移到调用者 cwd。
- CodeShell 的 `readExternalChangedFiles(cli, cwd, sessionId)` 以错误 cwd 读取或归因 changed files。
- worktree 已删除时，旧 cwd 不存在，resume 无法安全继续。

### 6.3 `ExitWorktree keep` 语义不适合继续工作

CodeShell 当前 `keep` 删除 worktree 目录，只保留 branch。这样适合“之后手动 merge”，但不适合“稍后继续这个 isolated workspace”。

如果外部 agent session 绑定到被删除的 worktree path，resume 时只能：

1. 失败；
2. 落回主仓库；
3. 由上层重新创建 worktree 并 checkout 原 branch。

没有显式策略时，最危险的是第 2 种。

### 6.4 并发模型不安全

模块级 `_activeWorktree` 是进程全局变量。多个 UI session、后台 DriveAgent、Cron、sub-agent 同时运行时，不能依赖这个变量表达“当前会话的工作区”。

完整方案需要 per-session / per-task worktree state，而不是 process singleton。

## 7. 建议的 CodeShell 目标模型

建议把 CodeShell 的 worktree 能力升级为三层模型。

### 7.1 Session workspace mode

主会话进入 worktree 后，应当更新当前 session workspace：

```ts
SessionWorkspace {
  root: string;
  kind: "main" | "worktree";
  worktree?: {
    path: string;
    branch: string;
    baseRef: string;
    createdBy: "codeshell" | "external";
  };
}
```

所有默认 `cwd` 解析都从 session workspace root 派生，而不是从进程启动 cwd 派生。

### 7.2 External agent run binding

每次 DriveAgent 启动后持久记录：

```ts
ExternalAgentRunBinding {
  cli: "claude" | "codex";
  externalSessionId: string;
  codeShellSessionId: string;
  cwd: string;
  workspaceRoot: string;
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt: number;
  lastUsedAt: number;
}
```

resume 规则：

- 如果用户未显式传 `cwd`，使用绑定里的原 cwd。
- 如果用户传了不同 cwd，默认拒绝或至少强警告。
- 如果原 cwd 不存在：
  - branch 仍存在：允许用户选择自动重建 worktree。
  - branch 不存在：拒绝 resume，并提示工作区已删除。

### 7.3 Worktree lifecycle policy

建议把 cleanup action 明确拆成三种：

- `discard`：删除 worktree + 删除 branch。
- `detach`：删除 worktree，保留 branch，用于 merge/review，不承诺原 session 可继续。
- `keep`：保留 worktree 目录和 branch，用于稍后继续。

这样与 Claude Code 语义更一致，也避免当前 `keep` 名称误导。

## 8. 推荐落地顺序

### P0：先修安全边界与可观测性

1. 为 DriveAgent 持久化 `externalSessionId -> cwd/worktree` binding。
2. resume 时检测 cwd mismatch，先警告或拒绝。
3. 在后台 job panel / transcript 中展示 external agent 的 cwd 和 worktree branch。
4. `ExitWorktree keep` 文案改为 `detach` 或明确说明会删除目录。

### P1：主 session workspace mode

1. 把 active worktree 从 process singleton 改成 session-scoped state。
2. ToolContext 默认 cwd 从 session workspace 读取。
3. UI/TUI 状态栏显示当前 workspace/worktree。
4. `EnterWorktree` 成功后真正切换 session workspace。

### P2：外部 agent 自动隔离

1. DriveAgent 增加 `isolation?: "current" | "worktree" | "none"`。
2. `isolation: "worktree"` 时自动创建 per-run worktree。
3. background jobs 完成后根据 diff/commits 决定保留、清理或提示。
4. 支持 subagent/DriveAgent 并行隔离，避免多 agent 改同一 checkout。

### P3：高级体验

1. `.worktreeinclude` 等价能力：复制 gitignored env/config 文件。
2. baseRef 策略：`fresh` / `head` / explicit branch。
3. worktree lock 与定期 cleanup。
4. Desktop session picker 支持 worktree-backed sessions。

## 9. 设计原则

1. **cwd 是安全边界，不是普通参数。** 对 Codex 尤其如此，因为 sandbox writable roots 会随 cwd 改变。
2. **session id 必须绑定 workspace。** 只保存 Claude/Codex session id 不足以安全 resume。
3. **worktree lifecycle 要区分“继续工作”和“保留分支”。** 删除目录但保留分支不等于保留 workspace。
4. **不要用进程全局变量表达会话状态。** CodeShell 有 TUI、Desktop、Cron、background agent 等长时/并发场景，worktree state 必须 session-scoped。
5. **先做防错，再做自动化。** P0 的 cwd mismatch guard 比自动创建 worktree 更重要。

## 10. 参考资料

- Claude Code Docs: [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)
- Claude Code issue: [anthropics/claude-code#30906 — Worktree cwd is not restored on session resume](https://github.com/anthropics/claude-code/issues/30906)
- OpenAI Codex docs export: [Codex full documentation](https://developers.openai.com/codex/llms-full.txt)
- OpenAI Codex issue: [openai/codex#4791 — Resuming a session silently switches the agent cwd to the caller’s directory](https://github.com/openai/codex/issues/4791)
- CodeShell source:
  - `packages/core/src/tool-system/builtin/worktree.ts`
  - `packages/core/src/git/worktree.ts`
  - `packages/core/src/tool-system/builtin/drive-claude-code.ts`
  - `packages/core/src/cc-orchestrator/agent-adapter.ts`
  - `packages/core/src/cc-orchestrator/external-agent-driver.ts`
