# DriveAgent worktree / cwd 可见性缺口根因调研

> 状态：已完成（只读源码、Git 历史与定向测试核实）  
> 日期：2026-07-12  
> 核实代码：`main@2766513c`

## 结论先行

用户的担忧不能用一个 YES/NO 概括：

| “房间”的实际含义 | worktree 切换后会不会丢 | 结论 |
| --- | --- | --- |
| (a) `backgroundJobRegistry` 中的 DriveAgent job | **NO（默认 session 查询）/ 部分（显式 cwd 查询）** | job 以 `jobId` 为 Map key，另存 owner `sessionId` 和一次性 `cwd` 快照。Codex 后续在别处工作不会改 job。`DriveAgentJobs(action:"list")` 不带 cwd 时按当前 CodeShell session 查，因此仍能找到 running job；带新 worktree cwd 时会漏掉，因为它只匹配旧快照。完成后的 job 还需 `status:"all"`。 |
| (b) CC Room / external-agent session | **实际 Room：NO；裸 CLI session picker：部分** | DriveAgent 不自动创建 CC Room。已创建 Room 持久化在 `room.json`，`listRooms()` 不按 cwd 过滤。未建 Room 的 Claude/Codex session picker 确实按 cwd 枚举；**推断（基于 CodeShell 只读 rollout 首行）**：Codex 的普通 shell `cd` 不会改既有 `session_meta.cwd`，所以仍列在原 cwd，不是消失，而是归在“旧目录”。若外部 CLI 真正迁移 transcript/cwd（典型是 Claude 原生 `EnterWorktree`），原 cwd picker 可看不到它。 |
| (c) 从 DriveAgent 卡片“跳转到 CLI session” | **Codex 普通自建 worktree：通常 NO；真实 transcript/cwd 迁移：部分/YES** | 跳转绕过 session picker，直接用 job 的 `externalSessionId + 快照 cwd + owner sessionId`。**推断**：Codex thread 的索引 cwd 仍是启动 cwd，所以普通 `cd`/`git worktree` 后通常能打开；但房间会继续以旧 cwd resume。若 transcript 已迁到 worktree，旧 cwd 会使历史定位/订阅失败或 resume 到错误目录。 |

因此，用户原话中“**job 因为按 cwd 分组所以找不到**”这一判断对默认 `DriveAgentJobs list` 和桌面后台面板都**不成立**。真正成立的是两个较窄的缺口：

1. 显式 `DriveAgentJobs(action:"list", cwd:<新 worktree>)` 只匹配 job 的启动 cwd 快照，会返回空；
2. external-session picker、历史读取、跳转后的 resume 都依赖 cwd。外部 agent 若真正迁移了其会话 cwd/transcript，CodeShell 没有回写实际 cwd，可能失配。

另有一个独立的正确性隐患：`listRunningByCwd` 只是“启动目录冲突提示”，不是实际写目录锁。外部 agent 自己转去 worktree 后，它可能漏报实际同目录并发，也可能误报已经分流的任务。

## 1. 把模糊问题拆成四个可验证问题

本报告分别验证：

1. job registry 的主 key、owner 维度和 cwd 生命周期；
2. 面向 LLM 的 `DriveAgentJobs`（不是 registry 内部 API）如何选择 session/cwd/all/status；
3. background job、持久 CC Room、裸 external CLI session、卡片跳转四个对象是否被混称为“房间”；
4. 外部 Codex/Claude 实际工作目录脱离启动 cwd 后，visibility、resume、changed-files 和并发冲突提示分别会怎样。

## 2. Job 的 key 与 cwd 生命周期

### 2.1 真正的存储 key 是 `jobId`

`BackgroundJobRegistry` 是进程内 `Map<string, BackgroundJobEntry>`，注释明确为 `jobId -> entry`；entry 内同时携带 `sessionId`、可选 `cwd` 等字段。也就是说：

- 主键：`jobId`；
- owner/检索维度：`sessionId`；
- 可选过滤/冲突维度：`cwd`；
- 不是 `(sessionId, cwd)` 复合主键，更不是 cwd 分桶存储。

证据：`packages/core/src/tool-system/builtin/background-jobs.ts:41-67`、`:118-120`、`:130-144`。

### 2.2 cwd 在注册时规范化并快照一次

`start()` 把 `options.cwd` 经 `normalizeCwdPath()` 写入 entry；`normalizeCwdPath()` 对存在路径做 `realpathSync`，否则至少做绝对路径 `resolve`。后续 `finish()` 和 `recordArtifacts()` 只更新 status/result/`ccSessionId`/`changedFiles`，没有 cwd 更新路径。

证据：

- 快照写入：`packages/core/src/tool-system/builtin/background-jobs.ts:123-145`，关键行为在 `:137`；
- 规范化规则：`packages/core/src/cc-orchestrator/cwd-normalize.ts:4-10`；
- 完成/产物更新不触碰 cwd：`packages/core/src/tool-system/builtin/background-jobs.ts:150-175`。

所以 job **不会跟随**外部 Codex 的 shell `cd`、绝对路径访问、`git worktree add`，也不会跟随 Claude 原生会话内 worktree 迁移。

### 2.3 DriveAgent 注册的并不严格等于“发起 session cwd”

已确认事实需要修正一处：job 记录的是 DriveAgent 本次运行的 **effective launch cwd**，不保证天然等于 `ctx.cwd`。

- schema 要求调用者传 `cwd`：`packages/core/src/tool-system/builtin/drive-claude-code.ts:83`、`:102`；
- 实现从 `args.cwd` 读取，缺失时兼容性 fallback 是 `process.cwd()`，不是 `ctx.cwd`：同文件 `:518-521`；
- resume 时，如果持久 binding 有 cwd，则 stored cwd 可覆盖请求 cwd：`:535-555`；
- effective cwd 同时进入 runner 和 background tracking：`:583-620`；
- registry 最终收到的是 `params.cwd`：`:448-477`。

通常 LLM 会把当前 session workspace cwd 显式传入，因此“通常相等”；但架构契约不是“从 ToolContext 自动快照 session cwd”。这是一个容易被工具描述掩盖的细节。

CodeShell 自己的 session-workspace 已经是另一套机制：已有 session 会优先从持久 `SessionWorkspace` 解析下一轮 engine cwd（`packages/core/src/engine/engine.ts:1101-1146`），`SwitchSessionWorkspace` 也明确提示切换从下一轮生效（`packages/core/src/tool-system/builtin/worktree.ts:45-71`）。这与“已经派出的外部 CLI 自己又去了另一 worktree”没有联动。

## 3. `DriveAgentJobs(action:"list")` 的真实默认维度

### 3.1 不带 cwd：按当前 CodeShell session，不按 cwd

`listDriveAgentJobs()` 的决策顺序是：

1. 只有 `args.cwd` 为非空字符串才构造 cwd filter；没有从 `ctx.cwd` 补默认值；
2. `args.all === true`、显式 cwd、或缺少 `ctx.sessionId` 时才读取全进程 `registry.list()`；
3. 否则读取 `registry.listForSession(ctx.sessionId)`；
4. 再按 job kind、可选 cwd、status 过滤。

证据：`packages/core/src/tool-system/builtin/drive-claude-code.ts:690-709`、`:722-757`。registry 的 `listForSession()` 与全量 `list()` 分别见 `packages/core/src/tool-system/builtin/background-jobs.ts:227-235`。

结论：

- `DriveAgentJobs(action:"list")`：当前 session 的 running/cancelling DriveAgent jobs；
- `DriveAgentJobs(action:"list", status:"all")`：当前 session 的 running + retained terminal jobs；
- `DriveAgentJobs(action:"list", all:true)`：全进程所有 session（仍默认只看 running）；
- `DriveAgentJobs(action:"list", cwd:"/x")`：自动跨 session，再精确过滤规范化后的 `/x`；
- `ctx.cwd` 对该 list **没有默认过滤作用**。

`inspect` 和 `cancel` 更直接：二者拿 `jobId` 调 `registry.get(jobId)`，没有 session/cwd 过滤，见 `packages/core/src/tool-system/builtin/drive-claude-code.ts:760-815`。只要进程内 entry 仍在，知道 jobId 就不受 worktree 影响。

### 3.2 默认 status 也是一个常见“消失”错觉

`status` 只有显式为 `"all"` 才包含完成/失败/取消；默认是 `"running"`。因此 Codex 恰好完成后，用户再次执行最短的 `DriveAgentJobs(action:"list")`，会看到空，但原因是 status，不是 cwd。

证据：`packages/core/src/tool-system/builtin/drive-claude-code.ts:727`、`:734-741`。terminal job 实际仍被 registry 保留，见 `packages/core/src/tool-system/builtin/background-jobs.ts:11-17`、`:148-160`。

### 3.3 worktree 切换后的可见性矩阵

设 job 启动/记录 cwd 为 `/repo/main`，外部 Codex 后续实际在 `/repo/wt` 写：

| 调用 | running 时 | terminal 时（加 `status:"all"`） |
| --- | --- | --- |
| 不带 cwd、仍在 owner CodeShell session | 找得到 | 找得到 |
| `cwd:"/repo/main"` | 找得到（跨 session） | 找得到 |
| `cwd:"/repo/wt"` | 找不到 | 找不到 |
| 从另一 CodeShell session 不带 cwd | 找不到 | 找不到 |
| 另一 session 使用 `all:true` | 找得到 | 找得到 |

所以“worktree 后完全找不到 job”不成立；“按新 worktree cwd 过滤时找不到旧快照 job”成立且是当前设计的直接结果。

### 3.4 `changedFiles=unknown` 不是 cwd 默认值

list 每行总会展示 `cwd=<job.cwd>`；`changedFiles=unknown` 来自“entry 尚无非空 `changedFiles`”的 formatter，并不是说 cwd 未知或 list 按 cwd 查询。证据：`packages/core/src/tool-system/builtin/drive-claude-code.ts:160-165`、`:192-206`。对应测试明确断言一个按 cwd 找到的 running job 同时显示 `changedFiles=unknown`：`packages/core/src/tool-system/builtin/drive-claude-code.test.ts:596-629`。

这里还有语义压缩：空数组既可能表示“确实无改动”，也可能表示“transcript 找不到/解析器未识别”。LLM formatter 显示 unknown；protocol 只在数组非空时下发 `changedFiles`（`packages/core/src/tool-system/builtin/background-work.ts:223-229`），desktop 对缺失值按空数组处理并不显示文件计数（`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:316-320`、`:354-357`）。

## 4. 三种“房间”逐项判断

### 4.1 (a) background job 本身：NO，带条件

**结论：默认 session list 不会因外部 worktree 丢失 job；显式新 cwd filter 会漏。**

桌面后台面板甚至比 LLM 默认 list 更宽：renderer 每次以当前 sessionId 调 RPC，但显式传 `scope:"all"`（`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:56-64`）；core 在 all scope 下使用 `backgroundJobRegistry.list()`，job row 保留原 owner session badge 与 cwd（`packages/core/src/tool-system/builtin/background-work.ts:175-180`、`:212-231`）。面板按 kind 分区，不按 cwd 分组（`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:145-166`、`:312-360`）。

与 worktree 无关但会真正让 job 不可见的边界：

- registry 是进程内 Map，worker/app 重启后不持久化：`packages/core/src/tool-system/builtin/background-jobs.ts:118-120`；无 live worker 时 desktop fallback 诚实返回空：`packages/desktop/src/main/agent-bridge-fallback.ts:71-101`；
- session close/delete 会 `dropForSession()`：`packages/core/src/tool-system/builtin/background-jobs.ts:237-259`、`packages/core/src/protocol/server.ts:1476-1485`；
- 每 session 只保留最近 50 个 terminal jobs：`packages/core/src/tool-system/builtin/background-jobs.ts:36-38`、`:284-290`。

这些比 cwd 分组更可能造成“以前见过、后来彻底没了”。

### 4.2 (b) CC Room / external-agent session：两个对象，结论不同

#### 已创建的 CC Room：NO

DriveAgent job 并不是 Room；registry 文件开头明确说 job 没有自己的 transcript（`packages/core/src/tool-system/builtin/background-jobs.ts:1-5`）。DriveAgent 完成后只记录 external CLI session id，不自动创建 Room（`packages/core/src/tool-system/builtin/drive-claude-code.ts:421-428`）。

Room 由 `RoomManager.createRoom()` 单独创建并把 `cwd/kind/claudeSessionId` 持久化到 `room.json`；`listRooms()` 扫全部 room directory，没有 cwd filter。证据：`packages/desktop/src/main/mobile-remote/room-manager.ts:277-320`。所以一个已经创建的 CC Room 不会因为 agent 内部去了 worktree 就从 Room 列表消失；它只是继续绑定旧 `room.cwd`。

#### 尚未建 Room 的 external CLI session picker：部分成立

CC/Codex picker 明确以当前 panel cwd 请求 session 列表：`packages/desktop/src/renderer/cc-room/CCRoomView.tsx:209-234`，main 再把 cwd 原样交给发现器：`packages/desktop/src/main/index.ts:2995-3008`。

- Claude：只扫描 `~/.claude/projects/<encodeCwd(cwd)>`，见 `packages/core/src/cc-orchestrator/session-discovery.ts:107-130`；transcript 若迁到 worktree 对应 project dir，旧 cwd picker 就看不到。
- Codex：扫描 rollout 首行 `session_meta`，要求 `meta.cwd === cwd`，见 `packages/core/src/cc-orchestrator/codex-session-discovery.ts:26-64`。**推断**：普通 shell `cd` 只影响该 shell 命令，CodeShell 又没有重写 rollout 首行的代码，因此该 thread 仍在原启动 cwd 的 picker 中；它不会自动改分组到实际 worktree。

换句话说，对用户原话中的 Codex 场景，常见现象是“在新 worktree 分组找不到，但在原 repo 分组仍在”，不是 session 被删除。

### 4.3 (c) “跳转到该 Codex 的 CLI session”：部分成立

跳转链路是：

1. job 完成时写入 `ccSessionId`：`packages/core/src/tool-system/builtin/drive-claude-code.ts:421-428`；
2. protocol 把它映射成 `externalSessionId`，并携带 job 快照 cwd 与 owner session：`packages/core/src/tool-system/builtin/background-work.ts:212-231`；
3. renderer 从 job 生成 `{externalSessionId, cliKind, cwd, sourceSessionId}`：`packages/desktop/src/renderer/cc-room/driveAgentLink.ts:13-31`；
4. App 先按 owner CodeShell session 找 panel bucket，再传 external id + cwd 给 CC Room：`packages/desktop/src/renderer/App.tsx:3895-3937`；
5. `openLinkedSession()` 直接按 external id + kind 复用/创建 Room，不经过 session picker：`packages/desktop/src/main/mobile-remote/room-manager.ts:466-499`。

因此，**推断**对于 Codex 普通 `git worktree add` + `cd /repo/wt && ...`：跳转通常仍能定位 rollout，因为 CodeShell 传的旧 cwd 与 Codex 初始 `session_meta.cwd` 一致。它绕过了“新 cwd picker 查不到”的问题。

但有三个限制：

- running job 通常尚无 `ccSessionId`，link builder 会返回 null；只有 runner 返回/取消落盘 external id 后才出现跳转，见 `packages/desktop/src/renderer/cc-room/driveAgentLink.ts:17-24`；
- owner CodeShell session 已不可解析时，App 明确拒绝跳转，见 `packages/desktop/src/renderer/App.tsx:3909-3919`；
- 真正发生 transcript/cwd 迁移时，旧 job cwd 会变成错误定位键。Claude transcript follower按 `<encodeCwd(job.cwd)>/<sid>.jsonl` 定位，Codex follower也按 `(cwd, threadId)` 定位：`packages/desktop/src/main/cc-room/transcript-subscriptions.ts:237-247`。这时可能打开一个绑定旧 cwd 的 Room，却读不到迁移后的历史，或下一轮 resume 回到旧 workspace。

## 5. 外部 Codex 是否真的能“自己切 worktree”

### 5.1 CodeShell 不会替 DriveAgent 自动切

当前 DriveAgent schema 没有 isolation/baseRef/worktree 参数；默认 runner 只把 cwd 交给 `runAgentOnce()`（`packages/core/src/tool-system/builtin/drive-claude-code.ts:129-143`）。driver 以该 cwd 启动独立 `codex exec`/`claude` child process（`packages/core/src/cc-orchestrator/external-agent-driver.ts:221-262`）。仓库 TODO 也明确剩余“外部 agent 自动隔离”尚未实现：`TODO.md:33`。

这与 commit `6f251c3e` 已实现的 CodeShell session-workspace 不冲突：后者决定 CodeShell session 下一轮的 workspace，不能追踪已经派出的外部 CLI 内部工具行为。

### 5.2 外部 agent 自己做：可以，但含义不是“CodeShell 观察到 cwd 改了”

Codex adapter 默认 DriveAgent permission 是 `bypassPermissions`（`packages/core/src/tool-system/builtin/drive-claude-code.ts:558-570`），Codex argv 对应 `--dangerously-bypass-approvals-and-sandbox`（`packages/core/src/cc-orchestrator/agent-adapter.ts:106-127`）。因此它有能力执行 `git worktree add`、使用绝对路径，或在 shell command 内 `cd /worktree && ...`。

严格说，shell 子进程里的 `cd` 不会修改父 `codex exec` 进程由 CodeShell 设置的 OS cwd；但 Codex 完全可以让后续每条命令以 `cd /worktree && ...` 开头或使用绝对路径，实际写入已经离开 launch cwd。对 CodeShell 而言效果相同：没有运行时 cwd/workspace 回报通道。

Claude 还可能使用自身一等 worktree 能力并迁移 transcript；仓库既有调研记录了这一外部行为：`docs/todo/worktree-session-isolation-research.md:18-40`。该文档中关于“CodeShell session workspace 尚未实现”的旧段落已被 `6f251c3e` 淘汰，不能用来描述当前 CodeShell 主 session；但 external CLI 原生能力与本问题仍相关。

## 6. launch cwd 与实际工作目录不一致的实际后果

### 6.1 Job list

如第 3 节：默认 session list 无影响；显式按实际 worktree cwd 查会漏，按 launch cwd 查仍在。

### 6.2 Resume binding

DriveAgent 成功时持久化的是 `{cli, sessionId, cwd}`，其中 cwd 仍是 launch cwd：`packages/core/src/tool-system/builtin/drive-claude-code.ts:292-310`。store 本身以 `(cli, sessionId)` 查找并保存规范化 cwd：`packages/core/src/cc-orchestrator/external-agent-session-store.ts:17-28`、`:43-67`。下次 resume 会强制用 stored cwd，必要时忽略调用者的新 cwd：`packages/core/src/tool-system/builtin/drive-claude-code.ts:538-555`。

所以 Codex 首轮实际跑去 `/repo/wt` 后，CodeShell 仍可能把下一轮 resume 拉回 `/repo/main`。这不是 job visibility bug，而是更实质的 workspace correctness gap。

`packages/core/src/cc-orchestrator/external-agent-bindings.ts` 虽定义了 `codeShellSessionId/cwd/worktreePath/worktreeBranch`（`:8-17`）和 worktree 检测（`:87-103`），但生产代码没有调用它；实际 DriveAgent 只使用 `packages/core/src/cc-orchestrator/external-agent-session-store.ts`。仓库级 `rg` 结果中，`externalAgentBindingStore` 除定义自身外没有非测试消费者。

### 6.3 Changed-files 归因

completion 仍以 launch cwd 调 `readChangedFiles(cli, cwd, sessionId)`，再相对 launch cwd 规范化路径：`packages/core/src/tool-system/builtin/drive-claude-code.ts:350-383`。Codex transcript 查找要求 `(threadId, session_meta.cwd)` 同时匹配：`packages/core/src/cc-orchestrator/external-agent-changes.ts:129-143`、`:180-191`。

可能结果：

- transcript 仍按 launch cwd：能找到 thread，但相对文件路径可能被错误解释为相对旧目录；
- transcript 已迁移：直接找不到，`changedFiles` 变 unknown；
- agent 用 shell 命令在 worktree 写文件：parser 只识别有限的 Claude write tools / Codex apply_patch/write/edit tools（`external-agent-changes.ts:18-20`、`:84-103`），shell 内改动本来就可能不被归因。

这会影响后台面板的 changed-file 数量、聊天 turn 的外部改动记录和 CLI jump 的完整元数据，不只影响 list 文本。

### 6.4 `listRunningByCwd` 并发写冲突检测：存在盲区

实现只做 `isActiveStatus && entry.cwd === normalize(cwd)` 的精确比较，且跨 session：`packages/core/src/tool-system/builtin/background-jobs.ts:221-225`。新 writable DriveAgent 启动前调用它生成 warning：`packages/core/src/tool-system/builtin/drive-claude-code.ts:313-323`、`:460-477`。

**风险结论：成立，属于中等正确性/安全提示缺口，但不是所有“两者都转去同一 worktree”都会漏。**

- 若两个 job 都从同一个旧 cwd 启动，第二个在启动时仍会看到第一个，warning 不会漏；之后二者是否同去一个 worktree，CodeShell 不知道。
- 若 job A 从 `/repo/main` 启动后自己去了 `/repo/wt`，job B 随后显式以 `/repo/wt` 启动，B 查询新 cwd 时匹配不到 A，**假阴性**。
- 若 A、B 从不同 launch cwd 启动后都收敛到同一个 worktree，也是假阴性。
- 反过来，两者从同一 launch cwd 启动后分流到不同 worktree，仍会 warning，形成**假阳性**。

因此它应被理解为“launch-cwd overlap warning”，不能当作实际 write-set/worktree lock。当前 warning 文案说“already running in cwd”略强于实现能证明的事实。

## 7. 用户为什么会产生“按 cwd 分组所以房间丢了”的错觉

最可能是四个信号叠加：

1. `DriveAgent` 描述一直引导 `DriveAgentJobs(action:'list', cwd)`，这是**跨 session 冲突查询**，不是找回自己 job 的推荐默认路径：`drive-claude-code.ts:39-41`；
2. list 输出显眼地打印 `cwd=...` 与 `changedFiles=unknown`，看起来像 cwd 是主归属 key，实际主 owner 仍是 session；
3. `DriveAgentJobs` 默认只列 running，job 一完成就像“消失”，需 `status:"all"`；
4. CC/Codex picker 确实按 cwd 枚举，而 job list/后台面板不是。UI 上两个对象挨得近，容易被统称为“房间”。

## 8. 最小修复方向（只描述，不实施）

### 8.1 先消除可见性误解（XS）

- 工具描述明确写：不带 cwd = current session；带 cwd = cross-session launch-cwd conflict filter；完成 job 用 `status:"all"`。
- UI/LLM 输出把 `cwd` 标成 `launchCwd`；warning 文案改成“another job launched from this cwd”。
- 可选增加 `DriveAgentJobs(action:"list", jobId/owner session)` 的显式示例，不改变 registry。

这能修“找不到/误以为按 cwd 存储”的产品理解，但不解决实际 cwd 漂移。

### 8.2 修 external session picker / jump 的 cwd 定位（S-M）

最小可落地方案：打开 external session 时先按 external session id 定位 transcript，再从 transcript location/meta 得到 `sessionCwd`；caller cwd 仅作 fast path/校验，不再是唯一定位 key。找到迁移后的 cwd 后，用它创建 Room/订阅 history，并更新 external-session binding。job 的 `launchCwd` 保留审计语义，另加 `sessionCwd`，不要偷偷改写旧字段。

Codex 可按 thread id 扫 rollout 后读取 meta；Claude 可在原 project dir miss 时有界搜索 session id。需要注意现有 discovery 做了两周/20 条限制，fallback 搜索必须按 id 精确且有界，避免每次全量深读。

### 8.3 真正修并发冲突与 resume（M；若做完整自动隔离则 L）

最小可靠方向不是猜外部进程的 cwd，而是让 DriveAgent **管理/声明 effective workspace**：

- 启动前显式决定 `launchCwd/effectiveWorkspaceCwd/worktreePath/branch`；
- job、external-session binding、changed-file attribution、jump、resume 和 conflict index 共用这份 workspace identity；
- 不允许无人知晓的 implicit workspace 漂移，或要求外部 agent 用结构化结果回报并由宿主验证 git worktree identity。

只从 shell transcript 猜 `cd` 不可靠。完整 `isolation:"worktree"` 生命周期、cleanup/include/baseRef 已是 `TODO.md:33` 的 L 项；但先补显式 effective workspace 与冲突 key 可独立作为 M 项。

## 9. 自检与验证

### 锚点复核

- [x] registry entry 确有 `sessionId + cwd`，Map 主 key 是 `jobId`；
- [x] cwd 只在 `start()` 规范化快照，finish/artifact 不更新；
- [x] `listForSession` 按 session，`list` 全量，`listRunningByCwd` 按 cwd；
- [x] 面向 LLM 的 `DriveAgentJobs` 不带 cwd 默认 session，显式 cwd 才跨 session + cwd filter；
- [x] `DriveAgentJobs` 的 cwd 没有从 `ctx.cwd` 默认注入；
- [x] DriveAgent runner 与 job 使用同一 effective launch cwd，resume binding 可覆盖请求 cwd；
- [x] Desktop background panel、CC/Codex picker、CLI jump 三条路径已分别追踪；
- [x] `external-agent-session-store.ts` 是实际 DriveAgent store，`external-agent-bindings.ts` 当前未接入；
- [x] session-workspace commit 与外部 CLI 自行 worktree 已区分；
- [x] 并发冲突假阴性/假阳性条件已单独评估。

### 只读测试

执行了以下现有定向测试（未跑 build）：

```text
bun test \
  packages/core/src/tool-system/builtin/background-jobs.test.ts \
  packages/core/src/tool-system/builtin/drive-claude-code.test.ts \
  packages/core/src/cc-orchestrator/external-agent-session-store.test.ts \
  packages/core/src/cc-orchestrator/codex-session-discovery.test.ts \
  packages/desktop/src/renderer/cc-room/driveAgentLink.test.ts \
  packages/desktop/src/renderer/cc-room/openCliSession.test.ts
```

结果：`75 pass / 0 fail`。测试覆盖了 cwd 规范化、同 cwd warning、resume 强制 stored cwd、`changedFiles=unknown`、job retention/cancel、Codex cwd discovery、DriveAgent link metadata 与 owner bucket 路由。

工作树原有 `TODO.md` 修改保持未触碰；本调研唯一写入为本报告。
