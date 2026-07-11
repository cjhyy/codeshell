# PIPELINE SUMMARY — Quick Chat Ephemeral Lifecycle

> 分支：`feat/quickchat-ephemeral`  
> 日期：2026-07-12  
> 约束遵守：未 merge、未 push、未切分支；测试使用 `bun test`；实现按红→绿完成。

## 1. 调研结论摘要

完整调研见
[`docs/research/quickchat-lifecycle-vs-codex-side.md`](docs/research/quickchat-lifecycle-vs-codex-side.md)。

- CodeShell 原有 `cleanupQuickChatSession` 不是只解绑内存。正常关闭/替换会经 main ownership claim
  tombstone，调用 worker `agent/closeSession`，等待 child turn settle，然后递归删除
  `~/.code-shell/sessions/<qchat-id>/`，所以 `state.json` 与 `transcript.jsonl` 都会删除；同时清附件、
  main snapshot 与 pending mobile approvals。parent session 不受影响。
- renderer/window 销毁已有 main owner cleanup；in-flight fork 关闭已有 deferred settle；旧 claim 会 inactive，
  晚到 reply 只触发一次删除，不再投递到已销毁 renderer。
- 未对齐点在持久语义和列表源头：side target state 原先没有 `ephemeral` 标记，且 fork/blank qchat 都是
  `parentSessionId: null + origin: desktop`，会通过 `listDiskSessions()` 的普通顶层会话规则。renderer
  只在“当前 repo index 为空”时扫前 30 条并过滤/清理，mobile picker 与 core disk list 没有同等防线。
- 整个 desktop 进程被强杀或 close RPC 失败时，旧 qchat 目录可能残留；原 renderer reaper 不是完整 GC。
- Codex `/side` 的固定语义是：关闭销毁、不进普通 picker、child generation 隔离；若未来要保留，必须
  显式另存为普通 fork，而不能把 side 改成默认持久。本轮没有实现“另存为会话”。

## 2. 实现结果

已对齐以下生命周期语义：

1. core side fork 现在把 target state 写成 `ephemeral: true`。
2. `SessionManager.list()` 排除 `ephemeral: true`，并用 `qchat-*` fallback 排除旧数据与 blank qchat。
3. desktop `listDiskSessions()` 从数据源排除 marker/qchat，因此 sidebar disk rebuild 与 mobile session
   picker 不会看到 quick chat；旧式 flat `listSessions()` 同样排除 `qchat-*`。
4. desktop 在 `createWindow()`/worker/claim 建立前执行 stale-qchat GC，回收上次异常退出留下的 qchat
   session 目录及兼容 flat JSON/JSONL，普通 session 不受影响。
5. 正常清理仍保持 `close/等待 settle → rm` 顺序，未交换顺序，避免旧 writer 在删除后复活目录。
6. 上一轮行为保持：busy parent fork 只截到最后完成 turn；side UI 不 hydrate 父气泡；parent/child
   stream/draft/busy/stop 独立；关闭/替换后的 approval 与 AskUser fail-closed。

## 3. TDD 证据

实现前红测：

```text
listDiskSessions expected ["normal"]
received ["qchat-legacy", "side-with-marker", "normal"]
SyntaxError: Export named 'cleanupStaleQuickChatSessions' not found
```

第一次 core 红测加载还因隔离 worktree 未安装 `nanoid` 而中止；随后执行
`bun install --frozen-lockfile` 恢复 lockfile 指定依赖，没有修改依赖版本或 lockfile。

实现后定向组合测试：

```text
51 pass
0 fail
174 expect() calls
Ran 51 tests across 9 files
```

覆盖文件：

- `packages/core/src/session/session-manager.side-fork.test.ts`
- `packages/core/src/protocol/server.fork.test.ts`
- `packages/core/src/session/session-manager.generation.test.ts`
- `packages/desktop/src/main/sessions-service.disk.test.ts`
- `packages/desktop/src/main/sessions-service.test.ts`
- `packages/desktop/src/main/quick-chat-ownership.test.ts`
- `packages/desktop/src/main/quick-chat-fork-router.test.ts`
- `packages/desktop/src/renderer/AppQuickChat.test.tsx`
- `packages/desktop/src/renderer/quickChatSession.test.ts`

额外构建验证：

- `bun run --cwd packages/core build`：通过。
- `bun run --cwd packages/cdp build`：通过。
- `bun run --cwd packages/desktop build:main`：通过。
- `bunx tsc -p packages/core/tsconfig.json --noEmit`：通过。
- desktop standalone typecheck 在 core/cdp build 前报告 workspace `dist` 未生成及仓库既有错误；实际 main
  bundle 在依赖 build 后通过。本任务没有把 root typecheck 当 clean gate，符合 `CODESHELL.md`。

用户指定的最终全量命令：

```text
$ bun test 2>&1 | tail -5
 5817 pass
 6 skip
 0 fail
 14280 expect() calls
Ran 5823 tests across 824 files. [73.66s]
```

首次全量运行在 core `dist` 未生成时出现大量 module-resolution errors；构建 core 后同一命令 0 fail。
本轮没有出现已知的 `ExternalAgentSessionStore concurrent writers` 基线失败。

## 4. Commits

1. `d609b1dc45e6234b05def51d91e22bd4e898812f`  
   `docs(quickchat): research ephemeral lifecycle gaps`
2. `56ed232dc930b08809d1f1d9de234eb8ef2e1bd7`  
   `test(quickchat): define ephemeral lifecycle guarantees`
3. `f4d49d2c5b0896df690b7efe35192fadd5fd42fb`  
   `test(quickchat): cover blank picker filtering`
4. `3ff37b7bdd57d843c92b1d55551b5cb5a12230c2`  
   `fix(quickchat): enforce ephemeral session lifecycle`

## 5. 改动文件

调研：

- `docs/research/quickchat-lifecycle-vs-codex-side.md`

测试：

- `packages/core/src/protocol/server.fork.test.ts`
- `packages/core/src/session/session-manager.side-fork.test.ts`
- `packages/desktop/src/main/quick-chat-ownership.test.ts`
- `packages/desktop/src/main/sessions-service.disk.test.ts`
- `packages/desktop/src/main/sessions-service.test.ts`

实现：

- `packages/core/src/types.ts`
- `packages/core/src/session/session-manager.ts`
- `packages/core/src/protocol/server.ts`
- `packages/desktop/src/main/sessions-service.ts`
- `packages/desktop/src/main/index.ts`

## 6. 偏离与未决

- 没有实现“另存为会话”；这是刻意遵守本任务 ephemeral 范围。后续若做，必须生成/升级成非 qchat、
  `ephemeral !== true` 的普通 fork，再加入普通 picker。
- blank quick chat 没有先行 fork state，其持久识别继续依赖固定 `qchat-*` ID；full side 同时有
  `ephemeral: true` 和 qchat fallback。两者均有列表与 GC 回归测试。
- 启动 GC 延续当前 desktop 对共享 session store 的单生命周期所有权假设。仓库已注明 SessionManager
  没有跨进程 writer lock；若未来支持多个独立 desktop 进程共享同一 `$CODE_SHELL_HOME`，应先加入
  lease/lock，再允许跨进程 stale GC。
- `SessionsView` 仍是只枚举旧式 flat session 文件的历史页面；本轮只补其 qchat 过滤，没有扩展该页面
  去枚举现代目录，避免把无关 session UI 重构混入生命周期修复。
- `PIPELINE-SUMMARY-QCLIFE.md` 按交付约定保留为唯一未提交文件，以便准确记录最终 commit hashes。

## 7. 追加调研：父会话后续更新是否传播到已打开快聊

### 7.1 结论

**不会传播，现状已经符合 Codex `/side` 的时间点快照语义，不需要生产代码修复。**

完整证据见
[`docs/research/quickchat-parent-update-propagation.md`](docs/research/quickchat-parent-update-propagation.md)。

- `SessionManager.fork()` 从父磁盘 transcript 读取事件后执行 `structuredClone`，side 按
  `completedThroughEventId` 截断，再把副本写入独立 target 目录；target 不是父 Transcript 的引用。
- target 发布后通过 `resume(targetSessionId)` 创建独立 Transcript。父 fork 后的新 turn 只追加到父文件。
- child 首次及后续模型调用固定按 child sessionId `resume(childId)`，provider messages 只来自 child
  transcript；不会再读取 `forkedFrom.sessionId`。
- AgentServer 给 stream envelope 标记 originating sessionId；renderer 对非空 ID 只做精确 route table /
  session index 匹配，父新 stream 只进父 bucket，不会落进 quick-chat bucket。
- quick-chat 的 `sourceSessionId` 只在创建时用于一次 fork。ready 后不存在轮询父 transcript、增量 inject、
  自动 rebase 或 parent `turn_complete` 同步路径。
- 当前 renderer full 路径不再读取 target transcript hydrate 父历史，而是明确 `foldTranscript([])`；父
  历史只存在于 child 的磁盘/模型上下文快照中。

用户若需要父 session 的最新上下文，应关闭并重新打开 quick chat，生成新的时间点 fork。本轮刻意没有
实现 live parent sync。

### 7.2 新增守护测试

两条新增测试在未修改生产代码时首次即通过，证明现状正确：

1. `packages/core/src/engine/engine.session-fork-history.test.ts`
   - 创建 child snapshot；
   - 父随后完成新 turn；
   - child 再发请求；
   - 断言 child provider messages 与 child 磁盘 transcript 包含 fork 前历史和 child 问题，但不包含
     父 fork 后的新 turn。
2. `packages/desktop/src/renderer/AppQuickChat.test.tsx`
   - 打开 quick chat；
   - 模拟父 session 的新 `session_started/text_delta/turn_complete`；
   - 断言父 UI 收到新文本，现有 quick-chat UI 不收到且不被置 busy。

定向测试：

```text
38 pass
0 fail
129 expect() calls
Ran 38 tests across 4 files
```

覆盖：

- `packages/core/src/engine/engine.session-fork-history.test.ts`
- `packages/core/src/session/session-manager.side-fork.test.ts`
- `packages/desktop/src/renderer/AppQuickChat.test.tsx`
- `packages/desktop/src/renderer/streamRouting.test.ts`

最终全量命令：

```text
$ bun test 2>&1 | tail -5
 5819 pass
 6 skip
 0 fail
 14291 expect() calls
Ran 5825 tests across 824 files. [69.09s]
```

没有出现已知的 `ExternalAgentSessionStore concurrent writers` 基线失败，也没有新增失败。

### 7.3 本维度 commits

1. `9f49927fe1387e1387222afb65e23343577af4f5`  
   `docs(quickchat): verify parent update snapshot isolation`
2. `ee44bb0083ff209f921141352d44c1a352e3aaa1`  
   `test(quickchat): guard parent snapshot isolation`

本维度没有 `fix(quickchat)` commit，因为调研与守护测试均证明生产实现已经是真快照隔离；硬改会增加
无意义风险。

### 7.4 边界

- parent/child 可以共享 workspace；父后来写入的文件可能被 child 工具读取。这是共享文件系统，不是
  conversation transcript 或模型上下文自动传播。
- 本轮不做 live sync、自动 rebase 或 send 前刷新 parent。未来若产品明确需要 live mode，必须作为独立
  模式设计 turn boundary、tool pair、冲突和路由，不得改变 `/side` 默认语义。

## 8. 只读复审 HOLD 修复

复审结论为 2 MAJOR + 1 MINOR + 1 NIT；删除 ID 的路径约束、ephemeral 列表过滤和时间点快照隔离无需
修改。本节记录启动 GC 所有权/session root/staging 安全边界修复。

### 8.1 TDD 红测

统一复现测试 commit：

- `7e5800c4e7c57619ce35ac6b1b43dfcc13887494`  
  `test(quickchat): reproduce startup GC safety gaps`

实现前失败证据：

```text
cleanupStaleQuickChatSessions(stagingDir) expected
[".pending-fork-qchat-ephemeral-12345678"], received []

Cannot find module './quick-chat-startup-cleanup'

Export named 'sessionsRoot' not found in @cjhyy/code-shell-core
```

新增测试：

- `packages/desktop/src/main/quick-chat-startup-cleanup.test.ts`
  - 实例 A 的 live qchat 已落盘；实例 B 拿不到 single-instance lock 时必须 quit、跳过 GC，A 的目录保留；
  - owner 实例拿到锁后保持原正常 startup GC 路径。
- `packages/desktop/src/main/sessions-service.home.test.ts`
  - 设置 `CODE_SHELL_HOME` 后，core create 与 desktop list/delete/startup GC 使用同一
    `<CODE_SHELL_HOME>/sessions`。
- `packages/desktop/src/main/sessions-service.test.ts`
  - rename 前崩溃遗留 `.pending-fork-*`；只删除 state 同时证明
    `ephemeral === true` 且 `sessionId` 为 `qchat-*` 的 staging；persistent/non-qchat staging 均保留。

### 8.2 MAJOR 1 — 跨进程 GC 所有权

修复 commit：

- `6c7a69d41b520ddc66d3c604a446e4bb0547826d`  
  `fix(quickchat): gate startup GC on instance lock`

修法：

- 修改前全仓库没有 `requestSingleInstanceLock` 或 `second-instance` 注册。
- main 在 `whenReady` 之前只调用一次 `app.requestSingleInstanceLock()`。
- 拿不到锁的第二实例立即 `app.quit()`；`whenReady` callback 同时 fail-closed return。
- destructive qchat startup cleanup 另由 `runOwnedQuickChatStartupCleanup()` 检查同一 ownership decision，
  防止后续重构绕过门。
- owner 实例拿到锁时继续原启动流程；没有新增/重复 `second-instance` handler，不改变其事件语义。

改动文件：

- `packages/desktop/src/main/quick-chat-startup-cleanup.ts`
- `packages/desktop/src/main/index.ts`

### 8.3 MAJOR 2 — CODE_SHELL_HOME session root

修复 commit：

- `9e722093dd2621538e0addb438a4ea070488ee8d`  
  `fix(quickchat): honor configured session root`

修法：

- core 新增并公开 `sessionsRoot()`，其唯一规则是 `join(codeShellHome(), "sessions")`。
- `SessionManager` 默认 storageDir 改用同一 resolver。
- desktop `sessions-service` 删除硬编码 `~/.code-shell/sessions`，所有 list/delete/GC 默认参数在调用时
  动态解析 `sessionsRoot()`，因此测试或运行时设置 `CODE_SHELL_HOME` 均命中 worker 的真实目录。

改动文件：

- `packages/core/src/session/session-manager.ts`
- `packages/core/src/index.ts`
- `packages/desktop/src/main/sessions-service.ts`

### 8.4 MINOR — ephemeral side-fork staging

修复 commit：

- `2fe1175ecef3fd6e4fe16b6bdba064ca535c9812`  
  `fix(quickchat): reap ephemeral fork staging`

修法：

- 在 single-instance owner 的 startup GC 中识别直接子目录 `.pending-fork-*`。
- 读取 staging `state.json`；只有 `ephemeral === true` 且 state `sessionId` 为 `qchat-*` 才递归删除。
- state 缺失、损坏、不可读、persistent 或非 qchat 均 fail-closed 保留。
- staging 名来自 session root 的 `readdir` 且只接受真实 directory，不接受 symlink；原 session ID
  delete path traversal 防线保持不变。

改动文件：

- `packages/desktop/src/main/sessions-service.ts`

### 8.5 NIT — 研究稿行尾空格

修复 commit：

- `d2604723d736ab7eb78e44a3233a3dd563cb8431`  
  `docs(quickchat): remove research trailing whitespace`

修法：移除两份研究稿 front matter 中依赖 Markdown hard-break 的行尾空格；`git diff --check` 通过。

改动文件：

- `docs/research/quickchat-lifecycle-vs-codex-side.md`
- `docs/research/quickchat-parent-update-propagation.md`

### 8.6 复审修复验证

定向测试与旧行为回归：

```text
51 pass
0 fail
191 expect() calls
Ran 51 tests across 10 files
```

覆盖新 GC ownership/root/staging 测试，并重跑：

- quick-chat ownership/fork router；
- ephemeral list/filter/close cleanup；
- busy completed snapshot 与 child provider context；
- App quick-chat stream、父更新不传播、迟到 approval/AskUser fail-closed；
- core `CODE_SHELL_HOME` isolation。

构建与格式：

- `bun run --cwd packages/core build`：通过；
- `bun run --cwd packages/desktop build:main`：通过；
- `git diff --check`：通过。

最终全量命令：

```text
$ bun test 2>&1 | tail -5
 5823 pass
 6 skip
 0 fail
 14308 expect() calls
Ran 5829 tests across 826 files. [71.90s]
```

没有出现已知 `ExternalAgentSessionStore concurrent writers` 基线失败，也没有新增失败。

## 9. 终审补修

终审确认上一节 single-instance GC、staging 与文档修复有效，追加发现同根因 1 MAJOR + 1 MINOR。

### 9.1 TDD 红测

红测 commit：

- `46050b14e95d6b6befe0576f2d199087f77bf348`  
  `test(quickchat): reproduce cold session root gaps`

实现前失败证据：

```text
desktop getSessionTranscript(sessionId)
Expected configured-home user message, received []

Engine FileHistory hook
Expected <CODE_SHELL_HOME>/sessions/<id>/file-history/index.json to exist, received false

Export named 'registerSecondInstanceFocus' not found
```

新增测试：

- `packages/desktop/src/main/session-cold-paths.home.test.ts`
  - 设置 `CODE_SHELL_HOME` 后创建真实 session；
  - 默认参数调用冷启动 folded transcript replay 与长断线 raw-event fallback；
  - 在 canonical session dir 写入 FileHistory，再通过 desktop `turnUndoState()` 读取；
  - 断言真实 `~/.code-shell/sessions/<random-id>` 下没有幽灵目录。
- `packages/core/src/engine/engine.file-history-home.test.ts`
  - 将 `$HOME` 与 `$CODE_SHELL_HOME` 指向不同临时根；
  - Engine 未显式传 `sessionStorageDir`，真实执行一次 `Write` tool；
  - 断言 run-scoped FileHistory hook 与 SessionManager 同写 `sessionsRoot()`，`$HOME/.code-shell` 无副本。
- `packages/desktop/src/main/quick-chat-startup-cleanup.test.ts`
  - 注册一次 second-instance handler；
  - 模拟已最小化现有窗口；
  - 断言事件按 `restore → show → focus` 唤醒该窗口。

### 9.2 MAJOR — 冷路径统一 session root

修复 commit：

- `83b8a83e1deef4a4fb0729ee141fb98248f8b536`  
  `fix(quickchat): unify cold session storage paths`

修法：以下四处删除 `~/.code-shell/sessions` / `userHome()` 分叉，统一复用 core 公共
`sessionsRoot()`；显式 `baseDir` / `sessionStorageDir` 仍保持最高优先级：

1. `packages/desktop/src/main/transcript-reader.ts`
   - `getSessionTranscript()` 默认根改为动态 `sessionsRoot()`。
2. `packages/desktop/src/main/rawTranscript.ts`
   - `getSessionEvents()` 默认根改为动态 `sessionsRoot()`。
3. `packages/desktop/src/main/file-history-service.ts`
   - desktop undo/redo/state lookup 改从 `sessionsRoot()/sessionId` 加载 FileHistory。
4. `packages/core/src/engine/engine.ts`
   - Engine hook 使用 `config.sessionStorageDir ?? sessionsRoot()`；不再用不识别
     `CODE_SHELL_HOME` 的 `userHome()/.code-shell/sessions`。

结果：create/list/delete/GC、冷 transcript/raw replay、desktop undo/redo 与 Engine FileHistory hook 现在
共享同一 `$CODE_SHELL_HOME/sessions` 权威根，不再在真实 home 产生同 ID 幽灵目录。

### 9.3 MINOR — second-instance 唤醒现有窗口

修复 commit：

- `b68b14b0b6aa47c478def8a1f08a5a9a807b381b`  
  `fix(desktop): focus window on second instance`

修法：

- 只在 `ownsDesktopInstance === true` 分支注册一次 `app.on("second-instance", ...)`。
- 事件到达时选择首个未销毁的现有窗口；若最小化先 `restore()`，随后 `show()`、`focus()`。
- 第二实例仍按原 single-instance lock 路径退出；第一实例被带回前台。
- 未在 createWindow、activate 或其他窗口生命周期重复注册 handler。

自动化验证覆盖了终审要求的“第二次启动唤醒已有窗口”；实际 Electron 手动验收点等价为：启动应用、最小化
主窗口、再次启动应用，原窗口应恢复并获得焦点。

### 9.4 终审补修验证

定向测试：

```text
68 pass
0 fail
213 expect() calls
Ran 68 tests across 12 files
```

除新增冷路径/second-instance 测试外，还重跑：

- transcript-reader/rawTranscript 原解析与文件系统测试；
- FileHistory hook；
- quick-chat startup ownership、staging、close cleanup；
- completed snapshot、父更新不传播；
- App stream 与迟到 approval/AskUser fail-closed。

构建与格式：

- `bun run --cwd packages/core build`：通过；
- `bun run --cwd packages/desktop build:main`：通过；
- `git diff --check`：通过。

最终全量命令：

```text
$ bun test 2>&1 | tail -5
 5826 pass
 6 skip
 0 fail
 14316 expect() calls
Ran 5832 tests across 828 files. [68.68s]
```

没有出现已知 `ExternalAgentSessionStore concurrent writers` 基线失败，也没有新增失败。
