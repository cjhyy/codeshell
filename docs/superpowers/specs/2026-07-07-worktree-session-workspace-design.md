# Worktree Session Workspace 设计

> 状态：设计稿（待审）
> 日期：2026-07-07
> 分支：dev/todo-iteration
> 目标：把 CodeShell 的 worktree 能力从「进程级单锁的建/清工具」升级为「会话级、可自由切换、切换带会话工作区指针」的工作区模式，对齐 Claude Code 与 Codex 桌面 app，并补齐外部 agent（CC/Codex）的 resume 安全边界。

---

## 1. 问题与目标

### 1.1 现状痛点（已核实代码）

- `packages/core/src/tool-system/builtin/worktree.ts:18` 用**进程级全局变量** `_activeWorktree` 记录「当前 worktree」。
- `worktree.ts:52-54`：已在一个 worktree 时，EnterWorktree **直接拒绝**再进第二个（"Already in a worktree… Exit it first"）。用户被锁死在一个里，无法在多个 worktree 间切换。
- 调研稿 §6.1 确认：EnterWorktree 之后**主会话 cwd 并未真正切过去**，文件工具默认仍作用于原 workspace。这个「active 状态」除了那把拦路锁几乎空转。
- `ExitWorktree keep`（`worktree.ts:143`）语义是「删目录、只留分支」——名字骗人，不是「保留工作区以便继续」。
- DriveAgent 只把 `cwd` 透传给外部 CLI，不存 `sessionId→cwd/worktree` 绑定；外部 CC/Codex resume 时 cwd 若漂移会写错目录（Codex issue #4791 + 记忆 `codeshell-cc-codex-worktree-session-resume-cwd-mismatch`）。
- 并发多 session / 后台 agent 共用一个进程全局变量，存在碰撞（记忆 `codeshell-multi-agent-collision-risk`）。

### 1.2 三家对标（全部核实）

| 能力                  | Claude Code                           | Codex 桌面 app                                            | CodeShell 现状                            |
| --------------------- | ------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| worktree 模式         | ✅ `claude --worktree`                | ✅ Local/Worktree/Cloud 三模式                            | ⚠️ 半成品                                 |
| 切换到另一个 worktree | ✅ EnterWorktree(目标)，旧的留盘      | ✅ Handoff（Local↔Worktree）                              | ❌ 全局锁死一个                           |
| 切换是否带上下文      | transcript relocate 到该目录          | **Handoff 带 thread 上下文+prompt 历史+未提交改动一起搬** | ❌                                        |
| 清理策略              | 无改动自动清；有改动问 keep/remove    | 默认保留 15 个，旧的自动清                                | keep 语义错                               |
| gitignored 文件复制   | `.worktreeinclude`                    | `.worktreeinclude`                                        | ❌                                        |
| resume 与 cwd         | v2.1.198 transcript relocate 后可找回 | Handoff 带上下文；同分支不可双 checkout                   | 会话存 cwd（`readCwd`），但中途切换未回写 |

### 1.3 一个 git 硬约束（两家都受制）

**同一个分支不能被两个 worktree 同时 checkout**（git 报 `branch already used by worktree`）。因此：

- ✅ 允许：两个 session 共享**同一个 worktree 目录**（同一份 checkout）——协作场景。
- ❌ 禁止：两个 worktree 各自 checkout **同一个分支**。
- 设计必须显式挡住后者，给清晰报错。

### 1.4 目标

1. **拆锁**：删除进程级单锁，`EnterWorktree` 语义改为「把当前会话切到目标 worktree」，可反复切、多个 worktree 共存、旧的留盘。
2. **会话级工作区指针**：worktree 归属从进程全局变量改成 **session-scoped state**，并发/后台安全。
3. **cwd 真切**：ToolContext 默认 cwd 从会话工作区指针解析，切过去后 Read/Edit/Bash/Grep/Glob 真落在该目录。
4. **诚实的会话工作区切换**：切换/进入/退出时，回写 `state.json.workspace`，并在当前 transcript 追加 `session_meta` breadcrumb；不物理移动 transcript 文件。下一轮 resume/run 从该指针重新派生 cwd/sandbox/环境。
5. **外部 agent resume 安全**：DriveAgent 持久化 `externalSessionId→cwd/worktree` 绑定；resume cwd 不符则警告/拒绝；worktree 已删则阻止 resume 并给选项。
6. **UI**：状态栏显示当前工作区 + 切换器（列出/diff/切换/新建）+ 清理菜单。
7. **清理语义对齐**：`keep`/`detach`/`discard` 三态 + 无改动自动清 + 删除后 resume 守卫。

### 1.5 非目标（YAGNI，本期不做）

- `.worktreeinclude`（复制 gitignored env）、baseRef 选择（fresh/head/PR）、worktree lock、subagent 自动隔离、DriveAgent `isolation:worktree` 自动建树、Cloud 模式。这些是后续增量。

---

## 2. 架构

系统拆成 5 个边界清晰的单元。

### 2.1 `SessionWorkspace`（会话工作区指针）— core

替代进程全局 `_activeWorktree`。每个会话持有一个工作区指针，随 `SessionState` 持久化到 `state.json`。

```ts
interface SessionWorkspace {
  root: string; // 当前干活的绝对目录
  kind: "main" | "worktree";
  worktree?: {
    path: string; // worktree 目录
    branch: string; // 该 worktree 的分支
    baseRef: string; // 派生自哪个 ref
    createdBy: "codeshell"; // 预留 external
  };
}
```

- **依赖**：git worktree 操作层（`packages/core/src/git/worktree.ts`）、SessionManager。
- **接口**：`getSessionWorkspace(sessionId)`、`setSessionWorkspace(sessionId, ws)`（回写 state.json）。
- **可测**：纯状态读写，不碰进程全局。

### 2.2 Worktree 生命周期服务 — core（复用 `git/worktree.ts`）

- `createWorktree(cwd, slug)`：建 worktree + 分支（现有逻辑保留），去掉「已 active 就拒绝」的锁。
- `listWorktrees(cwd)`：列出所有 worktree + 每个 vs main 的 diff 概况（±文件数 / ahead N commits）+ 是否被某 session 占用。
- `removeWorktree(path, mode)`：支持 `detach`（删目录留分支）/ `discard`（删目录删分支）。
- **同分支双 checkout 守卫**：切换/新建前检查目标分支是否已被别的 worktree 占用，是则报错。

### 2.3 EnterWorktree / ExitWorktree（会话指针 + breadcrumb）— core 工具层

`EnterWorktree` 重定义为「切换当前会话工作区」：

```
EnterWorktree({ target })
  target = slug（新建）| 已存在的 worktree 路径/分支（切过去）| "main"（切回主）
```

行为（会话工作区指针切换）：

1. 解析/创建目标工作区（新建走 createWorktree；已存在直接用；main 直接回主 root）。
2. **上下文 breadcrumb**：不移动 transcript 文件；在同一个 transcript 中追加 `session_meta`，记录 from/to workspace。未提交改动天然跟随目录（worktree 是独立 checkout，不需搬文件）。
3. **回写 `state.json`**：`setSessionWorkspace(sessionId, 目标)` — 下一轮 run/resume 能回到这里。
4. 首次创建时跑 setup 脚本（现有 `localEnvironment.setupScripts`，保留）。
5. 返回：目标 path/branch/from + 「切换已持久化；从下一轮开始生效，本轮文件/shell/sandbox 工具仍使用旧 root」。

`ExitWorktree({ action })` — `action ∈ keep | detach | discard`：

| action    | 行为                                             | 会话指针                     |
| --------- | ------------------------------------------------ | ---------------------------- |
| `keep`    | **保留目录+分支**，可回来继续（对齐 CC 真 keep） | 切回 main，worktree 记录保留 |
| `detach`  | 删目录、留分支，供 merge/review                  | 切回 main                    |
| `discard` | 删目录+删分支，丢弃改动                          | 切回 main                    |

- 智能默认：无未提交改动/新提交 → 可自动 detach；有改动 → 必须显式选 keep/discard（对齐 CC）。

### 2.4 ToolContext cwd 解析 — core

- `ToolContext.cwd` 在每轮 run 开始时从 `getSessionWorkspace(sessionId).root` 解析，而非进程启动 cwd。
- 影响面：Read/Edit/Write/Bash/Grep/Glob 的相对路径基准 + path-policy 边界。
- 轮中 EnterWorktree/ExitWorktree 只更新会话状态和 transcript breadcrumb；不热刷新本轮已经派生的 sandbox、approval、shellEnv、agent definitions 或 cwd。新工作区从下一轮开始生效。
- 保持向后兼容：无 SessionWorkspace（旧会话）时回退现有 `readCwd`/`process.cwd()` 逻辑。

### 2.5 DriveAgent 外部 agent 绑定 — core

持久化每次外部 run：

```ts
interface ExternalAgentRunBinding {
  cli: "claude" | "codex";
  externalSessionId: string;
  codeShellSessionId: string;
  cwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt: number;
  lastUsedAt: number;
}
```

resume 规则：

- 用户未传 cwd → 用绑定里的原 cwd。
- 传了不同 cwd → 默认拒绝或强警告（Codex 尤其：sandbox writable root 随 cwd 变）。
- 原 cwd 不存在：分支还在 → 允许选择重建 worktree；分支没了 → 拒绝并提示「工作区已删除」。

### 2.6 UI — desktop（TUI 状态栏同步）

- **A 状态栏指示器**：显示当前会话工作区（`main` 或 `⑃ dev/todo-iteration`）。
- **B 切换器**（点指示器弹出）：列出所有 worktree（含 main），每行显示分支/路径/vs main diff 概况/是否被占用；点一行 → EnterWorktree 切过去；底部「+ 新建」→ 输 slug。
- **C 清理菜单**（每行 `…`）：detach / discard，二次确认；有未提交改动按 CC 逻辑提示。
- 同分支已占用的行禁用切换并标注原因。

---

## 3. 数据流

### 3.1 切换工作区（指针 + breadcrumb）

```
用户点切换器某行 / 模型调 EnterWorktree(target)
  → 生命周期服务解析或创建目标 worktree（含同分支守卫）
  → 当前 transcript 追加 session_meta breadcrumb（不移动 transcript 文件）
  → setSessionWorkspace 回写 state.json
  → 下一轮 run 开始时 ToolContext.cwd / sandbox / approval / shellEnv / agents 解析为新 root
  → 状态栏更新为新分支
```

### 3.2 Resume（自身会话）

```
resume(sessionId)
  → 读 state.json.workspace（新字段）
  → 目录存在 → 恢复到该 worktree，cwd 正确
  → 目录不存在 → 分支在则提示重建 / 分支没了则回 main 并告知
```

### 3.3 Resume（外部 CC/Codex via DriveAgent）

```
DriveAgent resume(externalSessionId)
  → 读 ExternalAgentRunBinding
  → 校验 cwd（未传→用绑定原 cwd；不符→警告/拒绝；目录没了→按分支在否给选项）
  → spawn 外部 CLI，cwd 锁定为绑定值
```

---

## 4. 错误处理

- **同分支双 checkout**：切换/新建前守卫，命中报 `branch <x> already checked out at <path>`，禁止操作。
- **worktree 已删 + resume**：不静默落回主仓库（最危险）；显式提示 + 给选项。
- **setup 脚本失败**：警告但继续（保留现有语义，不因 setup 挂掉把会话困在工作区外）。
- **有未提交改动时 discard**：二次确认，明确告知会丢弃。
- **切换到不存在的路径/非法 slug**：校验 slug（复用 `validateWorktreeSlug`），报错不创建。

---

## 5. 测试策略

- **SessionWorkspace 状态读写**：set→get→回写 state.json→重读一致；旧会话无该字段时回退。
- **拆锁**：进 A→退→进 B 成功，旧 A 目录仍在盘上（对齐 CC「previous stays untouched」）。
- **cwd 真切**：EnterWorktree 后下一轮 ToolContext.cwd == 目标 root；本轮 Read/Bash 相对路径仍落在旧 root，并在工具结果中说明边界。
- **同分支守卫**：两个 worktree 试图 checkout 同分支 → 第二个报错。
- **自身 resume**：切到 worktree→模拟 resume→回到该 worktree；worktree 删除→resume 走守卫分支。
- **外部绑定**：DriveAgent run 后 binding 落盘；resume 无 cwd→用绑定值；cwd 不符→拒绝/警告；目录没了→按分支在否给选项。
- **清理三态**：keep 保目录+分支；detach 删目录留分支；discard 全删。
- **无改动自动清 vs 有改动提示**。
- 全程 TDD：先写失败测试，再实现（superpowers:test-driven-development）。
- 回归基线：worktree 已知 43 项既有失败（构建缺 dist 所致，记忆 `codeshell-worktree-baseline-failures-43-pre-existing`），改动后失败数不得超过此基线。

---

## 6. 落地顺序

1. **P0 安全边界**：SessionWorkspace 类型 + DriveAgent 绑定 + resume mismatch 守卫 + `keep/detach/discard` 三态语义修正。
2. **P1 会话工作区模式**：拆全局锁 → session-scoped；ToolContext cwd 从会话指针解析；EnterWorktree 指针切换 + breadcrumb + 回写 state.json；状态栏显示。
3. **P1 UI**：切换器（列出/diff/切换/新建）+ 清理菜单。

（`.worktreeinclude`/baseRef/lock/subagent 隔离 = 后续增量，不在本期。）

---

## 7. 设计原则

1. cwd 是安全边界，不是普通参数（Codex sandbox writable root 随 cwd 变）。
2. session id 必须绑定 workspace，只存外部 session id 不足以安全 resume。
3. worktree lifecycle 区分「继续工作(keep)」与「保留分支(detach)」。
4. 不用进程全局变量表达会话状态（TUI/Desktop/Cron/后台 agent 并发场景）。
5. 先做防错（P0 守卫），再做体验。
6. 尊重 git 硬约束：同分支不可双 checkout。
