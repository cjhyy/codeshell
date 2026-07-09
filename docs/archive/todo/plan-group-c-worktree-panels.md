# Group C: worktree / panel / message 小修技术方案

调研时间：2026-07-08  
范围：只读调研后形成实施方案；本方案不包含生产代码改动。

## 统一约束

- Desktop renderer 不能 runtime import core；renderer 侧新增数据必须通过 `window.codeshell.*` / preload 类型面进入。
- `agent/backgroundWork` 当前是 UI 专用查询，不要改变 goal judge 使用的 `listRunningBackgroundWork()` 语义。
- Worktree 自动清理属于数据安全路径，宁可多保留、提示用户手动处理，也不能静默删除不确定状态。

## 1. 后台工作面板补「来源 session」徽标

### 真实锚点

- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:24`：`BackgroundShellPanel({ sessionId })` 入口。
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:51`：只调用 `window.codeshell.listBackgroundWork(sessionId)`。
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:134`、`:142`、`:146`：按 `kind` 拆成 shells / agents / jobs。
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:260`、`:299`、`:365`：agent/job/shell row UI。
- `packages/desktop/src/renderer/panels/PanelArea.tsx:74`、`:436`：面板只收到 active `engineSessionId`。
- `packages/core/src/tool-system/builtin/background-work.ts:71`：`BackgroundWorkEntry` union，无来源 session 元数据。
- `packages/core/src/tool-system/builtin/background-work.ts:110`、`:113`、`:118`、`:135`：`listBackgroundWorkForUI(sessionId)` 从三个 registry 按当前 session 拉。
- `packages/core/src/protocol/server.ts:950`、`:959`：`agent/backgroundWork` 只接收 `sessionId` 并返回 `{ items }`。
- `packages/desktop/src/preload/types.d.ts:53`、`packages/desktop/src/preload/index.ts:38`：renderer-visible `BackgroundWorkInfo` 类型需要同步扩展。
- 可用来源字段：`BgShell.sessionId` 在 `packages/core/src/runtime/background-shell.ts:68`；`AsyncAgentEntry.sessionId` / `childSessionId` 在 `packages/core/src/tool-system/builtin/agent-registry.ts:32`；`BackgroundJobEntry.sessionId` / `ccSessionId` / `cwd` 在 `packages/core/src/tool-system/builtin/background-jobs.ts:39`。

### 当前实现分析

后台面板是“当前会话背景工作”的视图：renderer 传 active `sessionId`，core 只返回这个 session 的 shell、sub-agent、job。条目只带自身状态和描述，不带“由哪个 CodeShell session 发起”的短 id / 标题。  

如果下一步要在面板里展示 CC/Codex/外部 agent 等跨 session 后台工作，当前模型会出现两个问题：

- row 不能解释来源，用户不知道任务是当前会话发起还是别的会话发起。
- shell 的 output/kill 现在用面板当前 `sessionId` 调 `backgroundShellOutput(sessionId, shellId)` / `killBackgroundShell(sessionId, shellId)`；如果列表扩到其他 session，必须用 row 的 owner/source session，否则 core 的 session ownership 校验会失败。

### 具体改动步骤

1. 在 core UI entry 增加统一来源元数据，不影响 judge entry。

```ts
export interface BackgroundWorkSourceSession {
  sessionId: string;
  shortId: string;
  title?: string;
  current: boolean;
}

type WithSource<T> = T & { sourceSession: BackgroundWorkSourceSession };

export type BackgroundWorkEntry =
  | WithSource<{ kind: "shell"; shell: BgShell }>
  | WithSource<{ kind: "subagent"; agentId: string; /* existing fields */ }>
  | WithSource<{ kind: "job"; jobId: string; /* existing fields */ }>;
```

2. 把 `listBackgroundWorkForUI` 扩成 UI 查询函数，默认保持 session-scoped，新增 all scope 供 desktop 面板使用。

```ts
export function listBackgroundWorkForUI(
  currentSessionId: string,
  opts: { scope?: "session" | "all" } = {},
): BackgroundWorkEntry[] {
  const scope = opts.scope ?? "session";
  const shells = scope === "all"
    ? backgroundShellManager.list()
    : backgroundShellManager.listForSession(currentSessionId);
  const agents = scope === "all"
    ? asyncAgentRegistry.list()
    : asyncAgentRegistry.listForSession(currentSessionId);
  const jobs = scope === "all"
    ? backgroundJobRegistry.list()
    : backgroundJobRegistry.listForSession(currentSessionId);

  const sourceOf = makeSourceResolver(currentSessionId, [...session ids...]);
  return [...].map((entry) => ({ ...entry, sourceSession: sourceOf(ownerSessionId) }));
}
```

需要新增轻量 list API：

- `BackgroundShellManager.list(): BgShell[]`，复用 `toPublic()`，不改变 `listForSession()`。
- `BackgroundJobRegistry.list(): BackgroundJobEntry[]`，返回所有 jobs 的浅拷贝。

3. 来源标题解析用轻量 session state 读，不走 `SessionManager.list()`，避免每 3s poll tail transcript。

建议在 `SessionManager` 增加只读 helper，或在 `background-work.ts` 内封装同等逻辑：

```ts
function readSessionLabel(sessionId: string): { title?: string } {
  // 只读 sessions/<id>/state.json
  // title ?? summary；失败返回 undefined
}

function shortSessionId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}
```

4. protocol / preload 扩展可选 scope。

```ts
// server params
const params = (req.params ?? {}) as { sessionId?: string; scope?: "session" | "all" };
const items = listBackgroundWorkForUI(sessionId, { scope: params.scope });

// preload
listBackgroundWork: (sessionId: string, opts?: { scope?: "session" | "all" }) =>
  rpc("agent/backgroundWork", { sessionId, ...(opts ?? {}) }).then(rpcResult)
```

5. renderer 面板改用 all scope，并按 row source 渲染徽标。

```ts
const res = await window.codeshell.listBackgroundWork(sessionId, { scope: "all" });

function SourceSessionBadge({ source }: { source: BackgroundWorkSourceSession }) {
  const label = source.current ? t("panels.shells.sourceCurrent") : (source.title ?? source.shortId);
  return <span title={source.sessionId}>{label}</span>;
}
```

Shell row 的 selected key 和操作都要带 owner：

```ts
const shellKey = `${item.sourceSession.sessionId}:${item.shell.shellId}`;
backgroundShellOutput(item.sourceSession.sessionId, item.shell.shellId);
killBackgroundShell(item.sourceSession.sessionId, item.shell.shellId);
```

### IPC / 状态 / i18n

- IPC：`agent/backgroundWork` params 新增可选 `scope`；返回 entry 新增 `sourceSession`。
- preload 类型：`BackgroundWorkInfo` 三个 union 分支都补 `sourceSession`；`preload/index.ts` 和 `preload/types.d.ts` 要保持一致。
- renderer 状态：`selected` 从 `shellId` 改为 composite key，避免跨 session shell id 碰撞。
- i18n：`panels.shells.sourceCurrent`（“本会话” / “Current”）、`panels.shells.sourceSession`（tooltip 或 aria）、可选 `sourceUnknown`。

### 风险与边界情况

- 跨 session 展示会暴露其他会话的命令/任务描述；这是本机 desktop 内部面板，仍建议默认只展示 live/retained background work，不展示完整 transcript。
- session state 可能不存在（mobile 刚 announce、旧会话已删、测试 registry 手写 sessionId）：badge fallback 为 short id。
- polling every 3s 时读 state.json 要做小缓存或只读涉及 session id，避免扫描全量 sessions。
- `preload/index.ts` 里当前 `BackgroundWorkInfo` 的 job 分支比 `types.d.ts` 旧，实施时要顺手同步，避免类型漂移。

### 体量估计

S。核心是类型扩展 + 两个 registry list helper + row badge。若同时做全 session scope 和测试，接近 S+。

## 2. automation/mobile announce 乐观气泡补稳定 clientMessageId

### 真实锚点

- `packages/desktop/src/renderer/App.tsx:1682`：automation announce dispatch `user_message`，无 `clientMessageId`。
- `packages/desktop/src/renderer/App.tsx:1752`：mobile announce dispatch `user_message`，无 `clientMessageId`。
- `packages/desktop/src/renderer/transcriptsReducer.ts:56`、`:66`、`:73`、`:78`：hydrate 只保护带 `steerId` / `clientMessageId` 的本地 user intent。
- 普通 send 已有 key：`packages/desktop/src/renderer/App.tsx:1989`、`:2032`、`:2057`。
- steer 已有 key：`packages/desktop/src/preload/index.ts:270`；core server 在 `packages/core/src/protocol/server.ts:1855` 透传。
- core run 已支持 key：`packages/core/src/protocol/types.ts:73`、`packages/core/src/protocol/server.ts:491`、`:597`；engine 写 transcript 在 `packages/core/src/engine/engine.ts:1459`、`:1484`。
- automation announce 来源：`packages/desktop/src/main/automation-host.ts:162`、`:165`；`packages/desktop/src/main/agent-bridge.ts:728`。
- mobile announce 来源：`packages/desktop/src/main/index.ts:380`、`:788`、`:796`。

### 当前实现分析

普通用户发送路径生成 `clientMessageId`，并同时：

- 先在 renderer 里乐观插入 user bubble。
- 随 `agent/run` 传给 core。
- core transcript 持久化该 id。
- hydrate 时根据 id 用 server copy 替换/去重本地 intent。

automation/mobile announce 只做第一步：renderer 本地插泡，但 announce metadata 和真正的 `agent/run` 都没有 key。若 hydrate 读到一个较旧快照，`transcriptsReducer` 认为这个本地 bubble 不是可保护 intent，可能被覆盖；若之后读到 server copy，因为 server copy 也无 key，也无法稳定去重。

### 具体改动步骤

1. 增加同步 hash helper，避免 async WebCrypto 影响 announce 时序。

```ts
function stablePromptHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}
```

2. automation：在 main automation runner 生成一次 id，并同时用于 announce 与 engine.run。

```ts
const clientMessageId = `automation:${sid}:${stablePromptHash(req.job.prompt)}`;
onSession({ sessionId: sid, cwd: jobCwd, title, prompt: req.job.prompt, cronJobId, clientMessageId });
const result = await engine.run(req.prompt, { cwd: jobCwd, onStream, signal: req.signal, clientMessageId });
```

注意：`req.prompt` 可能包含 memory-prepended 内容，UI user bubble 应继续用 `req.job.prompt`；hash 也用原始 prompt。

3. mobile：在 `chat.send` 收到事件时生成一次 id，并同时用于 announce 与 injected worker run。

```ts
const runId = `mobile-run-${Date.now()}`;
const clientMessageId = `mobile:${sessionId}:${runId}:${stablePromptHash(event.text)}`;
broadcastMobileSession({ sessionId, cwd, title: event.text, prompt: event.text, clientMessageId });
bridge.injectWorkerMessage(JSON.stringify({
  jsonrpc: "2.0",
  id: runId,
  method: "agent/run",
  params: { task: event.text, cwd, sessionId, clientMessageId, ... },
}));
```

不要只用 `mobile:${sessionId}:${hash(prompt)}`：同一手机 session 连续发送两次相同文本时会被误判为重复 submit。automation 的 session 通常每次触发是新 sid，示例 id 可用；mobile 需要 per-turn run id。

4. preload / renderer type 补字段。

```ts
onAutomationSession(cb: (meta: { ..., clientMessageId?: string }) => void)
onMobileSession(cb: (meta: { ..., clientMessageId?: string }) => void)
```

5. App dispatch 透传。

```ts
const clientMessageId =
  meta.clientMessageId ?? `automation:${meta.sessionId}:${stablePromptHash(meta.prompt.trim())}`;
dispatch({ type: "user_message", bucket, text: meta.prompt, clientMessageId });
```

mobile fallback 同理，但仅作兼容旧 main；新 main 必传 per-turn id。

### IPC / 状态 / i18n

- IPC：`agent/automationSession` / `agent/mobileSession` metadata 新增可选 `clientMessageId`。
- 状态：`transcriptsReducer` 无需改，现有 hydrate 保护逻辑会自动生效。
- i18n：无新增文案。

### 风险与边界情况

- automation resume-session job（`injectResumeTurn`）不是 `buildDesktopAutomationRunner` 路径，若它也要乐观气泡，需要在注入 `agent/run` 时同样传 `clientMessageId`；当前锚点问题主要是 live announce。
- mobile 旧客户端或旧 main 未传 `clientMessageId` 时，renderer fallback 只能降低丢失概率，不能完全避免重复相同 prompt 的误判；新协议应以 main-generated id 为准。
- hash 不是安全用途，只做稳定 id；包含长度可降低简单碰撞。

### 体量估计

S。跨 main / preload / renderer / automation-host 四处小改，核心 reducer 不动。

## 3. 顶栏 workspace 徽标 main 分支显示真实 HEAD

### 真实锚点

- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:45`：`workspaceIndicatorText()`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:50`：只有 worktree branch 显示 `⑃ <branch>`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:53`、`:54`：main 固定返回 `"main"` / `"main (repoName)"`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:176`、`:181`：`getSessionWorkspace` 失败 fallback `{ kind:"main" }`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:282`、`:285`：`getGitBranches(repoPath)` 只用于 `isGitRepo`，丢弃 `current`。
- `packages/desktop/src/main/desktop-services.ts:186`、`:198`、`:218`：`getGitBranches()` 已返回 `current`。
- `packages/desktop/src/renderer/chat/BranchPicker.tsx:102`、`:120`：切分支后只更新 BranchPicker 自己的 state，没有通知 WorkspaceIndicator。

### 当前实现分析

`SessionWorkspace.kind` 表示“当前会话在 main root 还是 worktree path”，不是 Git HEAD 分支名。当前 label 把 `kind:"main"` 直接等同于 branch `main`，用户在主仓库切到 `release/foo` 后顶栏仍显示 `main`，语义错误。

### 具体改动步骤

1. `WorkspaceIndicator` 增加 main branch state。

```ts
const [mainBranch, setMainBranch] = useState<string | null>(null);

function normalizeCurrentBranch(current: string | null): string | null {
  if (!current || current === "HEAD") return null;
  return current;
}
```

2. 在现有 git repo probe 中保存 `current`。

```ts
window.codeshell.getGitBranches(repoPath).then((res) => {
  if (cancelled) return;
  setIsGitRepo(res.isRepo === true);
  setMainBranch(res.isRepo ? normalizeCurrentBranch(res.current) : null);
});
```

3. 改 `workspaceIndicatorText` 签名，main 情况优先用真实 branch。

```ts
export function workspaceIndicatorText(
  workspace: SessionWorkspace | null,
  repoName: string | null,
  opts: { includeRepoName?: boolean; mainBranch?: string | null } = {},
): string {
  const branch =
    workspace?.kind === "worktree" && workspace.worktree?.branch
      ? workspace.worktree.branch
      : opts.mainBranch;
  const base = branch ? `⑃ ${branch}` : "main";
  if (opts.includeRepoName === false) return base;
  return repoName ? `${base} (${repoName})` : base;
}
```

4. 让 branch switch 后即时刷新。

建议在 `BranchPicker` 切分支成功后 dispatch 一个 renderer-local 事件：

```ts
window.dispatchEvent(new CustomEvent("codeshell:git-branches-changed", { detail: { cwd } }));
```

`WorkspaceIndicator` 监听该事件，若 `detail.cwd` 与 `repoPath` 同一路径，则重新 `getGitBranches(repoPath)`。这比等 sessionBusy 或打开切换器更直接。

### IPC / 状态 / i18n

- IPC：复用现有 `getGitBranches(cwd)`，无需新增。
- 状态：新增 renderer-local `mainBranch`。
- i18n：无新增文案；detached / 读不到继续 fallback `"main"`。

### 风险与边界情况

- detached HEAD：`rev-parse --abbrev-ref HEAD` 通常返回 `"HEAD"`，必须当作无 branch，按要求回退 `"main"`。
- 非 git repo：组件当前隐藏，保持不变。
- branch 由外部终端切换：没有事件；可在 `codeshell:files-changed` 或 popover open 时顺手 refresh branch，保证最终一致。
- includeRepoName=false 的 compact 顶栏仍显示 `⑃ <realBranch>`，不会再显示固定 main。

### 体量估计

S。主要是 state + helper signature + 少量测试更新。

## 4. 顶栏 worktree 切换器视觉/语义梳理

### 真实锚点

- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:117`：`WorkspaceIndicator` 主组件。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:392`：`list.worktrees` 直接 flat map 成 rows。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:481`：`WorkspaceRow`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:497`：当前项通过 `workspaceRowDisabledReason()` 禁用，但没有明确 active 样式。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:504`：main row label 固定 `topbar.workspace.main`。
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:548`、`:553`、`:558`：已有 occupied/external/dirty badges，但没有“当前项 / 本会话拥有”badge。
- `packages/core/src/git/worktree/query.ts:123`、`:130`：`listWorktreesFast()` 已可返回 `occupiedBySessionIds` / `occupiedByOtherSession`。

### 当前实现分析

下拉里所有 worktree 混在一个列表里。当前项只是 disabled + tooltip，视觉上和“不可切换项”混在一起；main、CodeShell 管理 worktree、外部/ detached worktree 没分组。对于“这个 worktree 是当前会话正在用、另一个会话占用、还是只是一个可切换目标”，用户需要靠 path 和 badge 猜。

### 具体改动步骤

1. 在 `WorkspaceIndicator` 渲染前派生分组。

```ts
const rows = list?.worktrees ?? [];
const mainRows = rows.filter((r) => r.isMain);
const managedRows = rows.filter((r) => !r.isMain && r.isManaged);
const externalRows = rows.filter((r) => !r.isMain && !r.isManaged);
```

渲染结构：

```tsx
<WorkspaceGroup title={t("topbar.workspace.groupMain")}>{mainRows.map(...)}</WorkspaceGroup>
<WorkspaceGroup title={t("topbar.workspace.groupWorktrees")}>{managedRows.map(...)}</WorkspaceGroup>
{externalRows.length > 0 && <WorkspaceGroup title={t("topbar.workspace.groupExternal")}>...</WorkspaceGroup>}
```

2. `WorkspaceRow` 显式计算 active / owned。

```ts
const active = current ? samePath(row.path, current.root) : false;
const ownedByCurrentSession = !!sessionId && row.occupiedBySessionIds?.includes(sessionId);
```

需要把 `sessionId` 传给 `WorkspaceRow`，或在 main `SessionWorkspaceWorktreeInfo` 中新增 `occupiedByCurrentSession`。推荐传 `sessionId`，少改 IPC。

3. active row 视觉。

```ts
className={cn(
  "grid ...",
  active && "bg-accent text-accent-foreground ring-1 ring-border",
  !active && !disabledReason && "hover:bg-accent",
)}
aria-current={active ? "true" : undefined}
```

active badge：

```tsx
{active && <Badge>{t("topbar.workspace.currentBadge")}</Badge>}
{ownedByCurrentSession && !active && <Badge>{t("topbar.workspace.thisSession")}</Badge>}
```

4. main row 与 worktree row 文案区分。

- main row 主标题显示 `⑃ <mainBranch>`（来自 feature 3）或 `topbar.workspace.main` fallback。
- worktree row 主标题显示 branch，副标题显示 compact path。
- `title` / `aria-label` 写成“当前工作区：...”或“切换到：...”，但不要在 UI 中塞长说明。

5. cleanup action 与 disabled reason 保持。

当前项 disabled 是对的，但需要看起来是 selected，而不是“灰掉不可用”。实现上把 active 样式和 disabled opacity 拆开：

```ts
const switchDisabled = disabledReason !== null || switching;
const visuallyMuted = switchDisabled && !active;
```

### IPC / 状态 / i18n

- IPC：不必新增；复用 `occupiedBySessionIds`。
- 状态：无新持久状态。
- i18n 新增：
  - `topbar.workspace.groupMain`
  - `topbar.workspace.groupWorktrees`
  - `topbar.workspace.groupExternal`
  - `topbar.workspace.currentBadge`
  - `topbar.workspace.thisSession`

### 风险与边界情况

- detached worktree 没 branch，仍禁用切换，放 external/other 分组并保留 tooltip。
- 当前 session 和其他 session 共用同一 worktree 时，同时显示 `currentBadge` 和 `occupied`；cleanup 仍由 `workspaceCleanupDisabledReason()` 禁掉。
- 分组标题 sticky 与现有 popover 高度要验证，小屏宽度 `max-w-[calc(100vw-2rem)]` 不变。

### 体量估计

S。主要是 renderer 结构和 i18n；无 main/core 逻辑改动。

## 5. 自动清理 worktree 的数据安全护栏

### 真实锚点

- `packages/desktop/src/main/desktop-services.ts:318`：`cleanupStaleWorktrees()`。
- `packages/desktop/src/main/desktop-services.ts:338`：mtime cutoff。
- `packages/desktop/src/main/desktop-services.ts:357`：只用目录 mtime 判断 stale。
- `packages/desktop/src/main/desktop-services.ts:363`、`:367`：读取 branch，只校验托管前缀。
- `packages/desktop/src/main/desktop-services.ts:373`：`git worktree remove --force`。
- `packages/desktop/src/main/desktop-services.ts:379`、`:380`：失败后 `fs.rm(..., force:true)` + `git worktree prune`。
- `packages/desktop/src/main/desktop-services.ts:388`：`git branch -D`。
- 调度入口：`packages/desktop/src/main/index.ts:2773`、`:2780`、`:2782`。
- 现有测试：`packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts:51` 只覆盖 external / detached skip 和 managed remove。
- 可借鉴 diff helper：`packages/core/src/git/worktree/diff.ts:25`、`:30`、`:80`。

### 当前实现分析

当前清理条件只有：

1. `<repo>/../.worktrees/<name>` 是目录。
2. 目录 mtime 早于 grace cutoff。
3. 当前 branch 存在且是 CodeShell managed prefix。
4. branch 不是主 worktree 当前 branch。

满足后直接：

```bash
git -C <root> worktree remove --force <wtPath>
git -C <root> branch -D <branch>
```

这会静默丢掉未提交改动，也会强删未合并 commit。`fs.rm(..., force:true)` fallback 还会绕过 Git worktree lock，数据安全风险更高。

### 护栏逻辑

删除前每个候选都必须通过三层检查：

1. 工作区必须干净。

```bash
git -C <wtPath> status --porcelain=v1 --untracked-files=all
```

stdout 非空则跳过，reason=`dirty`。

2. 比较基准必须可确定。

优先用主 worktree 当前分支 `rootBranch`；为空时 fallback `main`、`master`、`origin/main`、`origin/master` 中第一个存在的 commit ref。

```bash
git -C <root> rev-parse --verify --quiet <baseRef>^{commit}
```

找不到 base 则跳过，reason=`base_unknown`。

3. branch 必须已经合并到 base。

```bash
git -C <root> rev-list --count <baseRef>..<branch>
```

count > 0 则跳过，reason=`unmerged_commits`。  
count = 0 才允许删除。这个命令表示“branch 上有多少 commit 不可从 base 到达”。

通过后才执行删除：

```bash
git -C <root> worktree remove --force <wtPath>
git -C <root> branch -D <branch>
```

建议把 branch 删除进一步收紧为 `git branch -d <branch>`；如果保留 `-D`，也必须只在 `rev-list` 通过后执行。

### 具体改动步骤

1. 定义返回结构，保留 skip reason。

```ts
export type StaleWorktreeSkipReason =
  | "dirty"
  | "unmerged_commits"
  | "base_unknown"
  | "inspect_failed"
  | "remove_failed";

export interface StaleWorktreeCleanupResult {
  removed: string[];
  skipped: Array<{
    path: string;
    branch: string;
    reason: StaleWorktreeSkipReason;
    detail?: string;
  }>;
}
```

如果不想破坏现有调用，可新增 `cleanupStaleWorktreesDetailed()`，让旧 `cleanupStaleWorktrees()` 包一层只返回 `removed`。但当前只有 main sweep 和测试调用，直接改返回结构也可控。

2. 在 `cleanupStaleWorktrees()` 内加 guard helper。

```ts
async function worktreeDeletionGuard(root: string, wtPath: string, branch: string, rootBranch: string | null) {
  const status = await gitRun(wtPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) return { ok: false as const, reason: "dirty" as const };

  const baseRef = await resolveCleanupBaseRef(root, rootBranch);
  if (!baseRef) return { ok: false as const, reason: "base_unknown" as const };

  const raw = await gitRun(root, ["rev-list", "--count", `${baseRef}..${branch}`]);
  const ahead = Number.parseInt(raw.trim() || "0", 10);
  if (!Number.isFinite(ahead) || ahead > 0) {
    return { ok: false as const, reason: "unmerged_commits" as const, detail: `${ahead} commit(s)` };
  }
  return { ok: true as const, baseRef };
}
```

3. 删除 fallback `fs.rm(..., force:true)` 路径。

`git worktree remove` 失败时跳过并记录 `remove_failed`。不要用 `fs.rm` 绕过 Git 的 lock / metadata 判断。

4. `sweepStaleWorktrees()` 处理 skipped。

```ts
const result = await cleanupStaleWorktrees(root, grace, branchPrefix);
if (result.removed.length) dlog("main", "git.worktree.cleanup", { removed: result.removed });
if (result.skipped.length) {
  dlog("main", "git.worktree.cleanup_skipped", { skipped: result.skipped });
  broadcastWorktreeCleanupSkipped(root, result.skipped);
}
```

5. UI 提示。

新增 main -> renderer event，例如 `git:worktreeCleanupSkipped`：

```ts
for (const w of BrowserWindow.getAllWindows()) {
  if (!w.isDestroyed()) w.webContents.send("git:worktreeCleanupSkipped", { root, skipped });
}
```

preload 暴露：

```ts
onWorktreeCleanupSkipped(cb): Unsubscribe
```

renderer `App.tsx` 或一个 top-level effect 里 toast：

```ts
toast({
  message: t("misc.worktree.cleanupSkipped", { count: skipped.length }),
  variant: "error",
});
```

文案要明确“已保留，需要手动处理”，不要写成清理失败的普通错误。

### IPC / 状态 / i18n

- IPC：新增 `git:worktreeCleanupSkipped` push event + preload subscription。
- 状态：不新增持久状态；skipped 只日志和 toast。将来可在 worktree switcher row 里展示最近 skip reason，但不是本次必需。
- i18n：新增 toast 文案：
  - zh：`已保留 {count} 个自动清理候选 worktree：存在未提交改动、未合并提交或无法确认安全。请在工作区切换器中手动处理。`
  - en：`Kept {count} stale worktree candidate(s): they have local changes, unmerged commits, or could not be verified. Review them manually in the workspace switcher.`

### 测试矩阵

在 `packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts` 补：

- clean + merged managed worktree：被删除，branch 删除。
- dirty worktree：`status --porcelain` 非空，目录和 branch 都保留，skip reason `dirty`。
- untracked file only：也算 dirty，保留。
- branch ahead of main：`rev-list main..branch` > 0，保留，reason `unmerged_commits`。
- detached worktree：仍跳过。
- external prefix：仍跳过。
- base ref 不存在或 inspect 失败：保留。
- `git worktree remove` 失败：不再 `fs.rm`，保留并记录 `remove_failed`。

### 风险与边界情况

- “已合并”基准如果主仓库当前分支不是 `main`，用 `rootBranch` 更符合用户当前 repo 状态；fallback main/master 只用于 root detached 或读不到。
- `status --porcelain` 会把 untracked 也视为需保留，这是正确的数据安全默认。
- mtime 可能因编辑器/工具触碰目录而变新或不变；mtime 只作为候选条件，不能作为安全条件。
- `branch -D` 在 guard 后风险可控，但 `branch -d` 更稳；如果 `-d` 失败，应保留 branch 并记录，不应升级为 `-D`。

### 体量估计

S-M。核心 guard 是 S；加 skipped UI event、i18n、测试矩阵后接近 M。

## 改动文件清单

方案实施预计会改以下文件：

- `packages/core/src/tool-system/builtin/background-work.ts`
- `packages/core/src/runtime/background-shell.ts`
- `packages/core/src/tool-system/builtin/background-jobs.ts`
- `packages/core/src/session/session-manager.ts`（可选：轻量 session label helper）
- `packages/core/src/protocol/server.ts`
- `packages/core/src/protocol/server.backgroundwork.test.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`
- `packages/desktop/src/renderer/panels/PanelArea.tsx`（仅当背景面板需要传额外 scope/active session 语义时）
- `packages/desktop/src/renderer/i18n/ns/panels.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/main/automation-host.ts`
- `packages/desktop/src/main/agent-bridge.ts`
- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx`
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx`
- `packages/desktop/src/renderer/chat/BranchPicker.tsx`
- `packages/desktop/src/renderer/i18n/ns/core.ts`
- `packages/desktop/src/main/desktop-services.ts`
- `packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts`
- `packages/desktop/src/renderer/i18n/ns/misc.ts`

本次调研实际只写入本文档：`docs/archive/todo/plan-group-c-worktree-panels.md`。
