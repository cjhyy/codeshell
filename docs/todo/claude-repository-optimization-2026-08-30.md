# Claude Code 全仓优化 — 证据化候选清单（2026-08-30）

> 状态：审计完成，待实施。本文件是 `docs/superpowers/plans/2026-08-30-claude-code-repository-optimization.md`
> Task 2 的产出，只做只读审计，不含任何生产代码改动。
>
> **基线 commit：** `3c3c024e377c11440970f22fc5c714d3d50f6d37`
> **隔离 worktree：** `/Users/admin/Documents/个人学习/代码学习/.worktrees/drive-claude-acd9nu5p`
> **分支：** `worktree/drive-claude-acd9nu5p`

## 1. 基线门禁实测

在上述干净 worktree 中，`bun install` 之后实测：

| 命令                   | 退出码 | 说明                                                                                              |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `bun install`          | 0      | 1049 installs / 1135 packages，无变更。                                                           |
| `bun run lint`         | 0      | 119 warnings、**0 errors**。全部为既有告警，可作为审计基线。                                      |
| `bun run typecheck`    | 0      | 含标准 build 顺序，11 个 workspace 全部通过。                                                     |
| `bun test`（继承环境） | **1**  | `9139 pass / 45 skip / 1 fail / 1 error`，`Ran 9185 tests`。见 §1.1 —— **环境污染，非仓库缺陷。** |
| `bun test`（清理环境） | **0**  | `9144 pass / 45 skip / 0 fail`，`Ran 9189 tests across 1259 files` [419s]。**全绿。**             |

**结论：三个门禁全部是干净基线。** `lint` 与 `typecheck` 直接可用；`bun test` 在按 §1.1
清理两个继承自宿主 app 的环境变量后 **`0 fail` / 退出码 0**，因此后续每批可以正当地要求
「全仓测试全绿」，任何新出现的失败都应视为本批回归。

### 1.1 基线失败根因：宿主 app 的 `CODE_SHELL_CAPABILITY_MODULES` 泄漏进测试进程

**根因已确定。** 本次审计的 shell 由**已安装的 CodeShell 桌面应用**拉起，该应用向子进程
导出了指向自身 `app.asar` 的能力模块路径：

```
CODE_SHELL_CAPABILITY_MODULES=file:///Applications/code-shell.app/Contents/Resources/app.asar/node_modules/@cjhyy/code-shell-capability-coding/dist/index.js#createCodingModule,...
CODESHELL_AGENT_STDIO=1
```

`packages/core/src/cli/agent-server-stdio.ts:70` 会读取该变量并 import 其中每个 spec。
测试进程继承了它，于是去**已安装的生产 app 包**里解析能力模块，而不是当前 worktree，
报错：

```
error: Cannot find module '/Applications/code-shell.app/Contents/Resources/app.asar/node_modules/@cjhyy/code-shell-capability-coding/dist/index.js'
        from '.../packages/core/src/cli/agent-server-stdio.ts'
```

**验证（两级）：** 清掉这两个变量后，受影响套件与**全仓**都全绿：

```bash
env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO \
  bun test packages/core/src/cli packages/server/src --timeout 30000
# → 328 pass / 0 fail across 31 files

env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO bun test --timeout 30000
# → 9144 pass / 45 skip / 0 fail，Ran 9189 tests across 1259 files [419s]，退出码 0
```

**对后续批次的要求：** 每次跑全仓测试都必须先清理这两个变量，否则会得到一个与代码无关的
假失败：

```bash
env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO bun test --timeout 30000
```

> 附带说明：日志中的 `Hook error in notification`、`[hooks] pre_tool_use hook timed out`、
> `error: pathspec '; touch ...' did not match`、
> `cannot remove a locked working tree, lock reason: test owner` 等文本都是**测试有意构造的
> 负路径输出**（分别来自 `tests/hooks-notification.test.ts:62`、`tests/hooks-shell-runner.test.ts`、
> git 注入 sentinel 用例、`packages/coding/src/git/worktree/crud.test.ts:173`），不是失败。
> 已单独验证 `crud.test.ts` 为 `9 pass / 0 fail`。

## 2. 候选清单（按优先级）

### C1 — DriveAgent `background:false` 在无 session 时超时静默丢任务（P0）

> **状态：completed（2026-08-30）。**
>
> - 实现 + 回归测试：`32327e89` `fix(coding): hand off session-less DriveAgent foreground runs`
> - 复审修正（断言收紧）：`81755703` `fix(coding): tighten DriveAgent handoff regression assertions`
> - **第二轮复审修正（生命周期）：`0053f3be` `fix(coding): defer DriveAgent worktree cleanup to run settlement`**
> - 改动文件仅三个：`packages/coding/src/tools/drive-agent.ts`、
>   `packages/coding/src/tools/drive-agent.test.ts`、`packages/coding/src/tools/drive-agent-worktree.test.ts`
>
> **最终实现与下方「建议修复方向」不同，以本状态块为准。** 原建议是「提前失败」；
> 实际采用的契约是**优先转为可追踪的后台 job**：交接分支不再以 session 为前置条件，
> 改由 `trackBackgroundRun` 统一裁决 —— session 可送达完成通知时注册后台 job 并返回 jobId，
> 否则返回明确错误，并把托管 worktree 的清理**延后到 run settlement**（见下方第二轮复审）。
> 这样保住了「有 session 就不丢工作」，同时消除了无限阻塞。
>
> **RED（修复前，必须失败）**
>
> ```bash
> bun test packages/coding/src/tools/drive-agent.test.ts -t 'without a session'
> # → 1 fail：Expected: not Symbol(still blocked past the handoff deadline)
> #   即交接期限后 promise 仍未 settle，命中目标缺陷而非 import/fixture 错误
> ```
>
> 复审修正后已再次验证：临时还原 `isValidSessionId` 条件，该用例仍然失败，证明断言非同义反复。
>
> **第二轮独立复审：NOT APPROVED，两个 Important。已在 `0053f3be` 收口。**
>
> 1. **同步 finalize 与仍存活的 CLI 竞态（已修）。** 失败分支原本是
>    `foregroundAbort.abort(); safeFinalizeDriveWorktree(managedWorktree)`。但 abort 只是**启动**
>    异步进程树终止 —— `packages/coding/src/cc-orchestrator/external-agent-driver.ts:186`
>    的 `terminateAttachedProcessTree(child).then(() => fail(abortError()))`，内部是
>    SIGTERM → 500ms grace（`:34 AGENT_TERMINATE_GRACE_MS`）→ SIGKILL。abort() 返回时 CLI 仍可能活着，
>    同步删除 worktree 会与活进程和 git `index.lock` 竞态，且返回文案**虚称已清理**。
>    修复：新增 `finalizeDriveWorktreeAfter(run, managed)`，把清理挂到 `run` settlement 之后；
>    立即返回的文案改为「将在 CLI 退出后清理」，不虚称已完成。
>    finalize 仍是 **exactly once**（该分支 return 在先，够不到 fall-through 的 finalize）；
>    `managedWorktree === undefined`、run resolve、run reject、finalize 自身抛错四条路径都已覆盖
>    （`safeFinalizeDriveWorktree` 对 undefined 早返回，对异常降级为 "kept" 说明而不抛）。
> 2. **失败分支未消费 run rejection —— 核实为不成立（no-op，但已顺带加固）。**
>    `waitForForegroundOrHandoff`（`drive-agent.ts:906`）内的 `run.then(...)` 会**永久**订阅 `run`，
>    因此无论 race 由哪一支胜出，`run` 都始终有 handler，abort 导致的 reject 不会成为
>    unhandled rejection。已在还原后的旧实现上实测确认：异步 reject 后无 unhandled rejection。
>    尽管如此，新的 `finalizeDriveWorktreeAfter` 自身订阅了 `run`，其中的
>    `.catch(() => undefined)` 保证新增链路不会引入新的未消费 rejection，并有回归测试固化。
>
> 另：`bun` 的 unhandled rejection **不会**触发 `process.on("unhandledRejection")`，而是直接判定该
> 用例失败 —— 探针实测确认。故回归测试以「Bun 判失败」为断言手段，而非监听事件。
>
> **RED（第二轮，旧实现上失败）**
>
> ```bash
> bun test packages/coding/src/tools/drive-agent-worktree.test.ts -t 'session-less handoff'
> # → 1 fail：expect(worktreeExistedAtSettle).toBe(true) — Expected: true, Received: false
> #   即 run settle 时 worktree 已被提前删除，正中「同步 finalize 竞态」缺陷
> ```
>
> 已通过临时还原旧失败分支再次验证该用例仍然失败，证明断言非同义反复。
>
> **GREEN（修复后）**
>
> ```bash
> bun test packages/coding/src/tools/drive-agent.test.ts \
>          packages/coding/src/tools/drive-agent-worktree.test.ts  # 56 pass / 0 fail
> bun run --filter '@cjhyy/code-shell-capability-coding' typecheck  # exit 0
> bunx eslint <改动文件>                                             # exit 0
> ```
>
> **全仓门禁**（均加 `env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO`）：
> `bun test` **9147 pass / 45 skip / 0 fail**，`Ran 9192 tests across 1259 files`，exit 0
> （= 基线 9144 + 本批累计新增 3 个用例，零回归）、
> `bun run typecheck` exit 0（含完整 build）、`bun run lint` exit 0（119 warning / 0 error，与基线持平）、
> `lint:engine-bypass` / `lint:workflow-test-paths` / `lint:baseline` 均 exit 0。
>
> **第一轮复审结论：** Critical 0、Important 1、Minor 2。Important（失败路径上 lease 已释放但
> 尚无 job 的窗口）经核验在当前代码中**不可达** —— 该区间全同步、无 `await`，已补注释固化该不变量
> （`0053f3be` 同步更新了该注释：worktree finalization 现已明确**不在**该同步区间内）；
> 两个 Minor 中的断言过宽问题已在 `81755703` 修复（改为断言
> `result notification would be dropped` 并追加「未注册任何 job」断言）。
>
> **附带发现（未处理，不属本批）：** `bun run lint:baseline` 会把
> `scripts/lint-baseline.json` 从 `maxWarnings: 122` 自动改写为 `119`。该漂移在
> `3c3c024e` 上即已存在（文件记 122，实测 119），与 C1 无关，已 revert 未纳入本批提交。

**证据（已实测复现）**

- `packages/coding/src/tools/drive-agent.ts:1207` — 交接分支的条件是
  `if (result.kind === "handoff" && isValidSessionId(ctx?.sessionId))`。
- `packages/coding/src/tools/drive-agent.ts:1197` — `waitForForegroundOrHandoff` 在
  `foregroundHandoffMs`（`:37`，默认 `110_000`）后返回 `{kind:"handoff"}`。
- 当 `ctx.sessionId` 无效时该分支**不成立**，控制流落到
  `packages/coding/src/tools/drive-agent.ts:1247` 的 `await run` —— 继续无限期前台阻塞。
- `packages/coding/src/tools/drive-agent.ts:38` — 工具级 `DRIVE_AGENT_TOOL_TIMEOUT_MS = 1_800_000`
  （30 分钟），在 `packages/coding/src/index.capability.ts:66` 注册。
- `packages/core/src/tool-system/registry.ts:155,174` — 到达该上限后 registry 用
  `ToolTimeoutError` abort 子 controller。
- `packages/coding/src/tools/drive-agent.ts:1184` — 前台 controller 是
  `makeAbortController(callerSignal, true)`，`linkParent=true`，所以这个 abort **会真的杀掉**
  外部 CLI 进程，工作成果被销毁而不是留在后台。
- `packages/coding/src/tools/drive-agent.ts:1247-1265` — 该路径的 `finally` 只
  `lease.release()`，**不调用** `safeFinalizeDriveWorktree(managedWorktree)`，托管 worktree 一并泄漏。

**实测复现：** 用 `makeDriveClaudeCodeTool(runner, { foregroundHandoffMs: 5 })`，传
`background:false` 且 ctx 不含 `sessionId`，在交接期限的 40 倍时间（200ms）后 promise
仍未 settle（实测输出 `SETTLED AFTER HANDOFF DEADLINE? false`）。

**用户影响：** 用户请求一次前台委派，界面静默挂起最多 30 分钟，随后外部 agent 被杀、
成果丢失，且没有 jobId、没有完成通知、没有可恢复入口，托管 worktree 残留在磁盘上。
对照 `background:true` 路径（`drive-agent.ts:962`）对同样的缺失 session **是显式报错的**，
说明这是遗漏而非设计。

**最小修改文件**

- `packages/coding/src/tools/drive-agent.ts`（仅 `:1207` 起的交接分支）
- `packages/coding/src/tools/drive-agent.test.ts`（新增回归测试）

**建议失败测试：** 在 `drive-agent.test.ts` 新增
`"background:false without a session fails loud instead of blocking past the handoff deadline"`：
以 `foregroundHandoffMs: 5` 构造工具，ctx 不含 `sessionId`，断言 promise 在交接期限后
及时 settle 且返回值包含明确错误说明（而不是无限等待）。

```bash
bun test packages/coding/src/tools/drive-agent.test.ts -t 'without a session'
```

**建议修复方向：** 与 `drive-agent.ts:962` 的既有契约对齐 —— 无有效 session 时
在交接期限处**提前失败并附带明确说明**，同时在返回前调用
`safeFinalizeDriveWorktree(managedWorktree)` 清理托管 worktree。

**风险：** 低。改动限定在一个此前无人到达即无限阻塞的分支；`background:true` 与
有 session 的前台路径（`drive-agent.test.ts:506` 起的既有用例）行为不变。
`externalRuntime` 走 `foregroundHandoffMs = Number.POSITIVE_INFINITY`（`:1121-1122`），
天然不进入该分支，需在测试中确认不回归。

**单 session 可行：** 是。单文件、单分支、有已复现的红灯。
**优先级：** P0。

---

### C2 — 静态资源服务缺符号链接遏制，可读取 root 之外文件（P1）

> **状态：completed（2026-08-30）。**
>
> - 实现 + 回归测试：`9c396c42` `fix(server): contain static assets by real path, not string prefix`
> - 复审修正（文档诚实性）：`43c0e116` `fix(server): scope the static containment guarantee to symlinks`
> - 改动文件三个：`packages/server/src/mobile-remote/mobile-static.ts`、
>   `packages/server/src/mobile-remote/mobile-static.test.ts`、
>   `packages/server/src/serve/headless-server.test.ts`
>
> **证据已在实施前重新核验成立**：`resolveSafe` 当时仍是
> `full.startsWith(rootResolved + sep)` + `statSync`（跟随符号链接），无 `lstat`/`realpath`。
>
> **RED（旧实现，两级证明真实泄漏）**
>
> ```bash
> bun test packages/server/src/mobile-remote/mobile-static.test.ts
> # → resolveSafe rejects a symlinked file escaping the root:
> #   expect(received).toBeNull() — Received: ".../mobile-static-XXXX/leak.txt"
> # → resolveSafe rejects a file reached through a symlinked directory:
> #   Received: ".../linked/secret.txt"
>
> bun test packages/server/src/serve/headless-server.test.ts -t 'symlink inside the static root'
> # → expect(leak.status).toBe(404) — Expected: 404, Received: 200
> #   即 headless host 真的以 200 把 root 外文件内容发了出去（端到端 HTTP 证明）
> ```
>
> 修复后又临时还原旧实现复跑，端到端用例仍失败，证明断言非同义反复。
>
> **实现（最小）**：新增基于 `relative()` 的 `isContained`（不是 `startsWith`，
> 因此 `/srv/app-old` 这类同前缀兄弟目录也挡得住），在既有词法 `..` 检查与
> `existsSync/statSync` 之后追加**两侧都 `realpathSync`** 的遏制判定，并用 `try/catch`
> 兜住 dangling link / EACCES / stat 后被删，保持 404 契约不变成 500。
> **返回值仍是请求路径而非 realpath**：调用方直接 `createReadStream`/`readFileSync`，
> 且既有测试（`mobile-static.test.ts:48,52`）钉住了该契约；在 macOS 上 `/var` 的 realpath
> 是 `/private/var`，返回 realpath 会改变每一个结果。这保持了模块原有的
> stat-then-read 同步窗口 —— **未新增** TOCTOU（攻击者在旧实现下本就有更容易的路径），
> 彻底关闭需要把两个调用方改成 open-then-fstat，超出本批范围。
>
> **兼容性**：符号链接指向 root 内部仍可服务；**root 自身是符号链接**（常见部署形态）
> 仍可服务 —— 因为两侧都做 realpath，只 realpath 目标的天真写法会在这里破功；
> SPA fallback、index.html、`assets/` 缓存头与 dev proxy 均未触及。
>
> **GREEN**
>
> ```bash
> bun test packages/server/src/mobile-remote/mobile-static.test.ts  # 12 pass / 0 fail
> bun test packages/server/src                                      # 325 pass / 0 fail（29 文件）
> bun run --filter '@cjhyy/code-shell-server' typecheck              # exit 0
> bunx eslint <三个改动文件>                                          # exit 0，零新增 warning
> ```
>
> **全仓门禁**（均加 `env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO`）：
> `bun test` **9152 pass / 45 skip / 0 fail**，`Ran 9197 tests across 1259 files`，exit 0
> （= C1 结束时的 9147 + 本批新增 5 个用例，零回归）、
> `bun run typecheck` exit 0（含完整 build）、`bun run lint` exit 0（119 warning / 0 error，与基线持平）、
> `lint:engine-bypass` / `lint:workflow-test-paths` / `lint:baseline` 均 exit 0。
>
> **独立复审结论：Critical 0、Important 0**，4 个 Minor。其中唯一需要处理的是
> **硬链接不在 realpath 的保护范围内**：已实测确认 root 内指向 root 外文件的硬链接仍会被服务，
> 且路径级检查原理上看不穿（硬链接本身就是 root 内的一个真实名字）。这是**既有风险、非本批引入**，
> 已在 `43c0e116` 把 docblock 的措辞收敛为「只保证符号链接」，不虚称更强的保证；
> 真要防需引入 inode/device 策略，且能在服务根内建硬链接的人本就能直接写文件。
> 其余 3 个 Minor（`assets/` 缓存头按请求路径计算、两处测试断言可更强）均为既有且非安全性问题，未处理。
>
> **已实测的绕过尝试（全部被拦截）**：符号链接链（link→link→root 外）、相对符号链接
> （`../outside/secret`）、嵌套目录内的逃逸链接、同名前缀兄弟目录；同时确认
> 「链条终点仍在 root 内」的合法情形依然可服务。

**证据**

- `packages/server/src/mobile-remote/mobile-static.ts:55-58` — 遏制判定是纯字符串的
  `full.startsWith(rootResolved + sep)`，随后 `statSync(full).isFile()`。
  `statSync` **跟随符号链接**，且全程没有 `lstat` / `realpath`。
- 同包内的正确写法作为对照：`packages/server/src/mobile-remote/room-manager.ts:457-463`
  同时做 `lstatSync().isSymbolicLink()` + `realpathSync` + `isContained`。
- 两个 host 共用同一个 `resolveSafe`：`packages/server/src/serve/headless-server.ts:200`
  与 mobile 静态服务，故一处修复覆盖两处。

**用户影响：** 若被服务的静态目录内存在指向外部的符号链接（打包步骤或 `bun install`
留下的 `node_modules` 链接是最现实的来源），通过 passcode 的客户端即可读取 root 之外的
文件内容。`..` 词法穿越已被正确拦截，缺的只是符号链接这一维。

**最小修改文件**

- `packages/server/src/mobile-remote/mobile-static.ts`（`resolveSafe` 一处）
- `packages/server/src/mobile-remote/mobile-static.test.ts`（新增回归测试）

**建议失败测试：** 在 root 内创建指向 root 外文件的符号链接，断言 `resolveSafe` 返回 `null`。
现有 `mobile-static.test.ts:59-63` 只覆盖词法 `../` 与绝对路径，**无任何符号链接用例**。

```bash
bun test packages/server/src/mobile-remote/mobile-static.test.ts
```

**风险：** 低—中。需保证正常文件与 SPA fallback 不被误伤；若部署形态刻意依赖
root 内符号链接指向合法资源，该修复会改变行为，因此测试需同时覆盖
「指向 root 内部的符号链接仍可服务」这一正向用例。

**单 session 可行：** 是。
**优先级：** P1。

---

### C3 — `Config` 工具绕过锁直接读改写项目 `settings.json`（P1）

**证据**

- `packages/core/src/tool-system/builtin/config.ts:64` 读，`:68` 改，`:84`
  `writeFileSync` 写 —— 全程**无 `acquireFileLock`、无 temp+rename**。
- `packages/core/src/utils/file-mutex.ts:6-11` 的模块文档把这一 bug 类写得很明确，
  并带实测数字：「48 个并发写入者各写一个不同的 settings key，最后只剩 17 个 key」。
- 正确路径已存在且被 `SettingsManager` 采用：`packages/core/src/settings/manager.ts:422`
  与 `:682` 都先 `acquireFileLock`。`config.ts` 完全绕过了 `SettingsManager`。
- `packages/core/src/utils/file-mutex.ts:143` 已导出 `mutateJsonFile`（锁 + 锁内重读 +
  唯一 tmp + rename），可直接复用。
- `config.ts:64` 的 `JSON.parse` 在 `:67` 的 try 之外，撕裂文件会直接抛未捕获异常。

**用户影响：** 两个会话（或 desktop 主进程与 agent worker）同时写项目
`.code-shell/settings.json` 时发生丢更新——先写的 key 被后写者的陈旧快照覆盖而消失；
`writeFileSync` 先截断，崩溃或并发读会留下非法 JSON，导致下一次 `Config` 读取直接抛错。

**最小修改文件**

- `packages/core/src/tool-system/builtin/config.ts`（`:63-84` 一段）
- `packages/core/src/tool-system/builtin/config.concurrency.test.ts`（新增）

**建议失败测试：** 两个写入者并发写入不同 key，断言两个 key 最终都存在。
现有 `config.resurrect.test.ts` 只覆盖「不重建已删除 cwd」，无并发断言。

```bash
bun test packages/core/src/tool-system/builtin/config.concurrency.test.ts
```

**风险：** 低。`mutateJsonFile` 是仓库内既有且已被其他写入者使用的实现，
不引入新依赖；需注意保留 `config.ts:78-83` 「不复活已删除项目根」的既有前置检查。

**单 session 可行：** 是。
**优先级：** P1。

---

### C4 — `MemoryManager.save` 的记忆正文非原子写，撕裂即静默丢记忆（P2）

**证据**

- `packages/core/src/session/memory.ts:292` — `writeFileSync(filePath, content, "utf-8")`，
  既无锁也无 temp+rename。
- 同文件内的不对称对照：派生索引 `MEMORY.md` **有**完整保护 ——
  `memory.ts:984` `acquireFileLock` + `memory.ts:1005` `writeFileAtomic`。
- `memory.ts:39` 已经 import 了 `writeFileAtomic`，但正文写入没有使用它。
- `memory.ts:964` 的注释明确承认多写入者场景（desktop 主进程、agent worker、TUI、
  第二个 desktop 实例）共享同一目录。
- 撕裂后果是静默的：`memory.ts:499` 的 `catch { return null; }` 让 `parseMemoryFile`
  吞掉解析失败，`loadAll()` 直接丢掉该条目，随后 `writeIndex` 的锁内重扫
  （`memory.ts:986-989`）会写出一个**不再包含该记忆**的 `MEMORY.md`。

**用户影响：** 并发保存同一条记忆时，磁盘上留下半截 frontmatter 文件，而该记忆
从索引中消失、不再进入 prompt —— 用户看到的是「记忆莫名其妙没了」，且没有任何报错。

**最小修改文件**

- `packages/core/src/session/memory.ts`（`:292` 一行，改用已 import 的 `writeFileAtomic`）
- `packages/core/src/session/memory.atomic-save.test.ts`（新增）

**建议失败测试：** 断言 `save()` 过程中不存在可观测的半截文件（例如校验写入走
temp+rename、目标路径不会出现非法 frontmatter 中间态）。
现有 `memory-index-concurrency.test.ts` 只覆盖陈旧索引缓存对 `MEMORY.md` 的覆盖，
不覆盖正文文件的原子性。

```bash
bun test packages/core/src/session/memory.atomic-save.test.ts
```

**风险：** 低（仅原子性这一半）。把 `:292` 换成 `writeFileAtomic` 是同语义替换。
**注意范围控制：** 「锁内读—改—写」以消除丢更新是更大的改动（涉及
`recordRecall` 等读改写路径），**不应**与原子性修复混在同一批；本候选只做原子性。

**单 session 可行：** 是（限定为原子性修复）。
**优先级：** P2。

---

### C5 — headless serve 的 WebSocket 未设 `maxPayload`（P2）

**证据**

- `packages/server/src/serve/headless-server.ts:239` — `new WebSocketServer({ noServer: true })`，
  未设 `maxPayload`，ws 8.x 默认回落到 **100 MiB/帧**。
- 同包对照：`packages/server/src/mobile-remote/remote-host-manager.ts:194-195`
  在两个分支上都显式设了 `maxPayload: 1024 * 1024`。这种不对称说明是遗漏。
- `headless-server.ts:251` 对每帧先 `String(data)`（再生成一份 UTF-16 副本），
  `:264` 才 `JSON.parse`，**校验发生在全部分配之后**。

**用户影响：** 通过 passcode 的客户端发送单个超大帧即可放大内存占用；数个并发标签页
足以耗尽 Node 堆并让 host 连同 agent worker 一起崩溃。注意该 host 除 passcode
外没有其他授权层（`headless-server.ts:7-9`）。

**最小修改文件**

- `packages/server/src/serve/headless-server.ts`（`:239` 一行）
- `packages/server/src/serve/headless-server.test.ts`（新增回归测试）

**建议失败测试：** 断言超过上限的帧被拒绝且连接不致命。现有
`headless-server.test.ts:285` 只发送小的畸形帧，无任何 payload 上限断言。

```bash
bun test packages/server/src/serve/headless-server.test.ts
```

**风险：** 低。与 mobile host 现有取值（1 MiB）对齐即可；需确认正常协议帧
（含较大的 transcript / 附件元数据）不会超过该上限，否则需要选更大的值并在测试中固化。

**单 session 可行：** 是。
**优先级：** P2。

## 3. 已核验但排除的候选

以下几项在本轮任务中被点名要求核验，经逐条读源码后确认**已经修复或本就不成立**，
不纳入实施清单：

- **Read 工具 8192 字节采样在 UTF-8 多字节边界误判二进制 —— 已修复。**
  `packages/core/src/tool-system/builtin/read.ts:141` 的
  `new TextDecoder("utf-8",{fatal:true}).decode(sample,{stream:true})` 已经处理，
  回归测试在 `packages/core/src/tool-system/builtin/read.test.ts:92`。
  另实测确认 `{stream:true}` 只容忍**末尾截断**，采样中段的非法字节仍会抛错
  （即仍能正确识别真二进制），修复是精确的而非过度放宽。

- **Goal exhausted/complete 后 `activeGoal` 未清 `state.json` —— 已处理。**
  `packages/core/src/engine/run-goal.ts:247` 的 `persistGoalTerminalOutcome` 是持久化屏障，
  `:263-273` 明确要求「客户端绝不能看到磁盘上不存在的 exhausted Goal」，
  且 `packages/core/src/goal/lifecycle.ts:340` 起的 `GoalTerminal` 墓碑专门用于阻止
  陈旧写入者把已终结的 goal 重新变为可激活。

- **mobile pending approval 切 session 无重放 —— 已处理，三层均有测试。**
  服务端 `packages/server/src/mobile-remote/pending-approvals.ts:49` 提供 `replayLines`；
  `session.select` 在 `packages/desktop/src/main/mobile-remote/handle-client-event.ts:272`
  重放，`session.sync`（重连）在 `:461` 重放；客户端 `packages/web/src/hooks/useRemoteApp.ts:1090`
  先更新 `boundSessionRef` 再发 `session.select`，因此本地清空与重放的顺序是安全的。
  测试：`packages/server/src/mobile-remote/pending-approvals.test.ts:26`、
  `packages/web/src/hooks/useRemoteApp.test.tsx:509`。

- **review panel cwd / session workspace 与 browser panel session 隔离 —— 已修复。**
  review 的 git 操作根本不使用 renderer 的 cwd：renderer 只发送
  `sessionId` + 选择器（`packages/desktop/src/renderer/panels/ReviewPanel.tsx:295-301`），
  主进程用 `packages/desktop/src/main/session-workspace-service.ts:334-370`
  从 session 绑定重新推导根目录。browser panel 按 bucket 分区
  （`packages/desktop/src/renderer/panels/PanelRegistry.ts:145`）。
  测试：`packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.test.tsx:139`、
  `packages/desktop/src/renderer/panels/ReviewPanel.workspace.test.tsx:37`。

## 4. 记录但本轮不实施

- **`appendOnboardingResult` 未加锁的读—改—写**
  （`packages/core/src/onboarding.ts:355-399`）。它是原子的（tmp+rename）但**没有取锁**，
  而 `SettingsManager.saveUserSetting`（`packages/core/src/settings/manager.ts:422`）取锁 ——
  单边加锁等于没加锁，onboarding 会用陈旧快照覆盖刚保存的凭据。该文件存放明文
  `apiKey`，丢失的是用户必须重新输入的密钥。此外 `:390` 的临时文件名
  `${file}.${process.pid}.tmp` 在同进程内不唯一（对照 `file-mutex.ts:122` 刻意加了
  `randomUUID()`）；`packages/core/src/engine/engine.ts:3065` 有相同写法。
  **不放入第一批的原因：** 与 C3 同属「跨进程共享写入者」根因，应在 C3 落地并验证
  `mutateJsonFile` 迁移模式之后，作为同一根因的后续批次统一处理，避免两批并行改同类路径。

- **`pendingWorkerResponses` 无上限无 TTL**
  （`packages/server/src/serve/headless-server.ts:107` 定义、`:296` 插入，
  仅在 `:154` 收到响应、`:119-125` worker 退出、`:311-313` 标签页关闭时清理）。
  worker 卡死但存活时，单个长连接标签页反复发请求即可无界增长。
  同包内 `mobile-upload-service.ts:122` 有「每设备上限 16 + TTL」的正确范式可参照。
  **不放入第一批的原因：** 与 C5 同文件同区域，应在 C5 之后作为同文件的后续批次处理，
  避免同批内混入两个不同性质的改动。

## 5. 第一批与验收标准（C1 — 已完成）

> **已实施并收口，见 §2 C1 状态块。** 实际落地的契约与下方第 2 条「最小实现」不同：
> 采用「优先转后台可追踪 job，不可送达时才报错」，而非一律提前失败。
> 其余验收标准（红灯先行、49 个既有用例保持通过、门禁全绿、diff 只含两个文件）均已满足。
> C2 亦已完成（见 §2 C2 状态块）。下一批为 C3，尚未开始。

**推荐：C1（DriveAgent 无 session 前台交接静默丢任务）。**

理由：唯一一个已**实测复现**红灯的候选；用户可感知程度最高（静默挂起 30 分钟 + 成果被杀

- worktree 泄漏）；修复范围是单文件单分支；且同文件 `:962` 已有可直接对齐的既有契约，
  不需要新设计。

**可判定验收标准（TDD）**

1. **红灯先行。** 在 `packages/coding/src/tools/drive-agent.test.ts` 新增用例：
   `makeDriveClaudeCodeTool(runner, { foregroundHandoffMs: 5 })`，
   调用 `tool({ prompt, cwd, background: false }, { cwd })` —— ctx **不含** `sessionId`。
   断言该 promise 在交接期限之后及时 settle。
   先跑 `bun test packages/coding/src/tools/drive-agent.test.ts -t 'without a session'`，
   必须因**超时未 settle**而失败，而不是因 import/fixture/语法错误失败。

2. **最小实现。** 只改 `drive-agent.ts:1207` 起的交接分支：无有效 session 时在交接期限
   提前返回明确错误，并在返回前调用 `safeFinalizeDriveWorktree(managedWorktree)`。
   不重构相邻模块、不动 `background:true` 路径、不改公共 API。

3. **绿灯 + 不回归。** 以下命令全部退出码 0：

   ```bash
   bun test packages/coding/src/tools/drive-agent.test.ts
   bun test packages/coding/src/tools/drive-agent-worktree.test.ts
   bun run --filter '@cjhyy/code-shell-capability-coding' typecheck
   bunx eslint packages/coding/src/tools/drive-agent.ts packages/coding/src/tools/drive-agent.test.ts
   ```

   其中 `drive-agent.test.ts` 的 49 个既有用例必须全部保持通过 —— 特别是
   `:506` 起的「有 session 时正常交接为后台 job」与 `:457` 起的
   external-runtime 用例，用以证明修复没有波及正常交接路径。

4. **全仓门禁。** 以下全部退出码 0：

   ```bash
   env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO bun test --timeout 30000
   bun run typecheck
   bun run lint
   bun run lint:engine-bypass
   bun run lint:workflow-test-paths
   bun run lint:baseline
   ```

   `lint` 允许维持 119 个既有 warning、0 error。`bun test` **必须**按 §1.1 清理环境变量后再跑，
   基线为 `9144 pass / 45 skip / 0 fail`，**要求 0 fail**（通过数应 ≥ 9144 加上本批新增用例数）。
   若在未清理的环境下跑出 `agent-server-stdio` 的 `Cannot find module .../app.asar/...` 失败，
   那是环境污染而非本批回归 —— 须清理环境重跑，而不是修改代码或放宽断言。

5. **diff 边界。** `git diff --stat` 只包含
   `packages/coding/src/tools/drive-agent.ts` 与
   `packages/coding/src/tools/drive-agent.test.ts` 两个文件；
   `git status --short` 不含任何主工作区禁区文件。

**建议后续顺序：** C1 → C2 → C3 →（C3 同根因的 onboarding 跟进）→ C4 → C5 →
（C5 同文件的 `pendingWorkerResponses` 跟进）。每批一个独立 Conventional Commit。
