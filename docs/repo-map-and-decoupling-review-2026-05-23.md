# CodeShell Repo 梳理与解耦评审

日期：2026-05-23

## 1. 总结

当前 monorepo split 基本已经落地。现在这棵树最准确的理解方式是：

```text
@cjhyy/code-shell         meta package，兼容旧入口和 CLI bin
@cjhyy/code-shell-core    engine / protocol / tools / LLM / run / arena
@cjhyy/code-shell-tui     CLI / React TUI / terminal renderer
@cjhyy/code-shell-desktop Electron POC，private，renderer 保持 thin client
```

解耦已经走过最关键的一步：`core` 和 `tui` 物理分包，依赖方向也基本正确。但现在还不是“彻底完成”的状态，更像是“主结构正确，边界需要收口”。

| 维度 | 评分 | 判断 |
|---|---:|---|
| 包级边界 | 8/10 | `core` 没有 React/Ink/Yoga/Electron 依赖，也没有反向 import `tui` / `desktop`。 |
| Engine/UI 运行时边界 | 7/10 | REPL、headless run、RunManager 都走 protocol；但还有一些 singleton state 横跨 core/UI。 |
| Public SDK 表面 | 6/10 | `core/src/index.ts` 同时导出稳定 API 和 TUI 迁移期内部支持函数，边界偏宽。 |
| Desktop 准备度 | 4/10 | renderer 方向是对的，但 main/preload/IPC 还只是 POC 脚手架。 |
| 架构约束与文档新鲜度 | 5/10 | ESLint 有包边界限制，但 `check-no-engine-bypass.sh` 还在扫旧的 `src/` 路径。 |

一句话判断：

> 大方向是对的，下一步不需要再做一次大拆包，而是要做边界加固：修约束脚本、收窄 public exports、把 terminal presentation 从 core public API 里拿出去，然后接 desktop bridge。

## 2. 当前 Repo 结构

### 2.1 Root

| 路径 | 职责 |
|---|---|
| `package.json` | workspace root，也是 `@cjhyy/code-shell` meta package。build 顺序是 core -> tui -> root meta。 |
| `scripts/build-meta.ts` | 生成 root `dist/`：`index.js` re-export core，`cli.js` delegate 到 TUI CLI。 |
| `tests/` | Bun 测试，覆盖 core、protocol、tools、renderer、plugins、settings、run manager 等。 |
| `bench/` | terminal renderer benchmark。 |
| `docs/` | 架构文档、spec、plan、历史分析和这份评审。 |
| `examples/` | 基于 core/product API 的示例 agent。 |

### 2.2 `packages/core`

`@cjhyy/code-shell-core` 是 UI-agnostic engine 包。

| 模块 | 职责 |
|---|---|
| `engine/` | `Engine`、`TurnLoop`、model facade、token budget、streaming tool queue。 |
| `protocol/` | `AgentServer`、`AgentClient`、in-process/stdio transport、RPC types。 |
| `llm/` | provider 抽象、provider clients、model pool/cache/fetcher、retry/watchdog。 |
| `tool-system/` | built-in tools、registry、executor、permission、MCP、sandbox。 |
| `context/` | context manager、compaction、tool result persistence。 |
| `prompt/` + `preset/` | prompt section loading，以及 `general` / `terminal-coding` preset。 |
| `session/` | transcript、session manager、memory、file history。 |
| `run/` | managed run lifecycle：queue、store、runner、approval、checkpoint、artifact。 |
| `arena/` | 多模型 review/planning/iteration，以及部分结果格式化。 |
| `hooks/`, `plugins/`, `skills/` | 扩展机制。 |
| `settings/`, `services/`, `logging/`, `utils/`, `state.ts` | 运行时基础设施和共享状态。 |

当前规模：`packages/core/src` 下约 229 个 TypeScript 文件。

### 2.3 `packages/tui`

`@cjhyy/code-shell-tui` 负责 terminal-specific 体验。

| 模块 | 职责 |
|---|---|
| `cli/` | `code-shell` bin、commander 命令、`run` / `repl` / `arena` / `runs`、slash command handlers。 |
| `ui/` | React terminal app、message list、input、model manager、permission、agent dock、store。 |
| `render/` | 自研 terminal renderer、layout、events、ANSI parsing、selection、scroll、screen output。 |
| `bootstrap/` | CLI 启动前 setup。 |
| `native-ts/` | Yoga layout binding shim。 |
| `utils/`, `voice/` | TUI 侧 helper 和输入适配。 |

当前规模：`packages/tui/src` 下约 188 个 TypeScript/TSX 文件。

### 2.4 `packages/desktop`

`@cjhyy/code-shell-desktop` 是 private Electron POC。

| 模块 | 当前状态 |
|---|---|
| `src/main/index.ts` | 只创建 BrowserWindow；还没有实例化 `Engine` / `AgentServer`。 |
| `src/preload/index.ts` | 暂时暴露 generic `sendRpc/onRpc/removeRpcListener`。 |
| `src/renderer/App.tsx` | placeholder UI；正确地没有 import 任何 CodeShell package。 |

当前规模：`packages/desktop/src` 下约 5 个 TypeScript/TSX 文件。

## 3. 主运行路径

### 3.1 Interactive TUI

```text
packages/tui/src/cli/main.ts
  -> replCommand()
  -> new Engine(...)
  -> AgentServer(engine, serverTransport)
  -> AgentClient(clientTransport)
  -> startInkRepl(client)
```

UI 不直接调用 `engine.run`。它通过 `AgentClient` 收 stream events、发 approval/cancel/config/query 请求，然后渲染结果。

### 3.2 Headless `code-shell run`

```text
packages/tui/src/cli/main.ts
  -> runCommand()
  -> new Engine(...)
  -> createInProcessClient(engine)
  -> client.run(task)
  -> CLI output renderer
```

这条路径现在和 REPL 共用 protocol surface，可以避免 task stream、status notification、cancellation 这些行为在不同入口漂移。

### 3.3 Managed Runs

```text
RunManager
  -> EngineRunner
  -> new Engine(...)
  -> createInProcessClient(engine)
  -> lifecycle hooks / approvals / checkpoints
```

这个形状适合 productized/background execution：RunManager 管 durable state，Engine 管 agent execution，protocol 管运行语义。

### 3.4 Desktop 目标形态

```text
renderer React UI
  -> window.codeShell.* from preload
  -> Electron IPC
  -> main process AgentServer + Engine
  -> stream/status/approval events back to renderer
```

当前 desktop package 已经遵守依赖方向，但 bridge 还没真正实现。

## 4. 解耦做得好的地方

1. 包级依赖方向干净。

`core` 没有 import `tui` / `desktop`，也没有 React、Ink、Yoga、Commander、Chalk、Vite、Electron 这类 UI/CLI 依赖。`tui` 大量 import `@cjhyy/code-shell-core`，这是正确方向。

2. root package 已经变成真正的 meta package。

`scripts/build-meta.ts` 会清掉旧 root `dist/`，写入 `export * from "@cjhyy/code-shell-core"`，并用很小的 CLI shim 指向 `@cjhyy/code-shell-tui/cli`。

3. 运行时调用基本收敛到 protocol。

REPL、headless run、RunManager 都走 `AgentServer` / `AgentClient` 或 `createInProcessClient`。这让 status notification、approval plumbing、cancel、task stream 有了统一入口。

4. Desktop renderer 的边界设计是对的。

`eslint.config.js` 禁止 `packages/desktop/src/renderer` import `@cjhyy/code-shell-core`、`@cjhyy/code-shell-tui`、`@cjhyy/code-shell`。当前 renderer placeholder 也遵守了这个规则。

5. 自研 terminal renderer 已经物理放在 TUI 包内。

React/reconciler/Yoga/ANSI screen 相关逻辑在 `packages/tui/src/render`，没有留在 core。

## 5. 还没解干净的地方

### 5.1 Engine bypass guard 已经失效

`scripts/check-no-engine-bypass.sh` 还在 grep：

```text
/Users/admin/Documents/个人学习/代码学习/codeshell/src/
```

但 split 后真实代码已经在：

```text
packages/core/src
packages/tui/src
packages/desktop/src
```

所以现在 `bun run lint:engine-bypass` 即使通过，也不能证明没有新的 bypass。这是优先级最高的小修。

### 5.2 `core/src/index.ts` 的 public surface 太宽

现在 core public entry 同时导出了：

| 类型 | 例子 |
|---|---|
| 稳定 SDK API | `Engine`、`RunManager`、`defineProduct`、`ToolRegistry`、`AgentServer`。 |
| 实验 API | `Arena`、`IterativeArena`、plugin/skill/model provider utilities。 |
| TUI 迁移期内部支持 | `state.ts`、notification queue、async agent registry、terminal arena renderer、theme/debug/env helpers、UI usage recorder。 |

这对迁移很方便，但会让 `@cjhyy/code-shell-core` 不像一个干净 SDK，而像一个 shared internal bucket。

### 5.3 `core/src/state.ts` 是 core/UI 的共享 singleton

`state.ts` 同时放了 session id、cwd、model state、scroll interaction state、cost counters、hooks、feature flags、prompt cache 和一些 compatibility stubs。

其中一部分是 engine runtime state，一部分明显是 TUI interaction state。继续全放 core，会让未来 desktop/web client 继承 CLI/TUI 假设。

### 5.4 `AgentClient` 仍然是 Node-oriented

`packages/core/src/protocol/client.ts` import 了 `node:events` 和 core logger。当前 TUI/Node 使用没问题，但这意味着它还不能直接作为 browser/renderer SDK。

这点不用马上拆，`docs/architecture/14-engine-call-paths.md` 里记录的触发条件是合理的：等 VS Code、browser、non-Node 或 multi-client 需求真实出现，再抽独立 client SDK。

### 5.5 Arena terminal formatting 还在 core public API

`packages/core/src/arena/render/terminal.ts` 不依赖 Chalk/TUI，所以不是硬违规。但它是 presentation logic，而且被 `core/src/index.ts` public export。

另外 `packages/core/src/tool-system/builtin/arena.ts` import 了 `createProgressRenderer`。这意味着 Arena tool 还会直接选择一种 terminal-style 进度展示，而不是只发结构化 progress event 让 client 决定怎么展示。

### 5.6 TUI UI 还 import CLI command modules

`packages/tui/src/ui/App.tsx` import 了 `packages/tui/src/cli/commands/builtin/*` 下的 slash-command modules。

这仍然在 TUI 包内部，不是 package-level 问题。但 UI render/state 和 CLI command organization 耦合在一起。以后 desktop 或其他 UI 想复用 command model，会比较别扭。

### 5.7 测试里还有内部路径和 dist 路径

大多数 root tests 直接 import `packages/core/src/*` 或 `packages/tui/src/*`，单元测试这样可以接受。

但有一个测试 import 了：

```text
packages/tui/node_modules/@cjhyy/code-shell-core/dist/index.js
```

这容易和 source drift，应该改成 source import 或 public package import。

### 5.8 架构文档还残留旧 `src/...` anchor

一些 split 前的 architecture docs 还指向 `src/...`。它们作为历史文档仍有价值，但 active architecture index 应该改成 `packages/core/src` / `packages/tui/src`。

## 6. 下一步怎么做

### Phase 0：把 split 的尾巴收掉

目标：让当前架构可验证、可维护、文档路径准确。

1. 修 `scripts/check-no-engine-bypass.sh`，扫描：

```text
packages/core/src
packages/tui/src
packages/desktop/src/main
```

保留 allowlist：

```text
packages/core/src/engine/engine.ts
packages/core/src/run/EngineRunner.ts
packages/tui/src/cli/commands/repl.ts
packages/tui/src/cli/commands/run.ts
```

2. 把 guard 纳入常规验证：

```text
bun run lint:engine-bypass
bun run lint
bun run typecheck
bun test
```

3. 更新 active architecture docs 中旧的 `src/...` 路径。

4. 去掉测试里的 `packages/tui/node_modules/@cjhyy/code-shell-core/dist/index.js` import。

预估：0.5 到 1 天。

### Phase 1：收窄 core public API

目标：区分稳定 SDK、实验 API、内部迁移接口。

建议先把 exports 分三层：

| 层级 | 例子 |
|---|---|
| Stable public | `Engine`、`RunManager`、`defineProduct`、`ToolRegistry`、`AgentServer`、public protocol types。 |
| Experimental public | `Arena`、`IterativeArena`、plugin/skill APIs、部分 model/provider utilities。 |
| Internal TUI support | `state.ts`、notification queue、async agent registry、terminal arena renderer、UI recording/debug helpers。 |

可以考虑新增 subpath：

```text
@cjhyy/code-shell-core/internal/tui
```

或者不作为 package export，只在明确内部边界里消费。

预估：2 到 3 天。

### Phase 2：把 presentation 从 core runtime 拿出去

目标：让 core 发结构化语义，client 决定展示方式。

1. 将 `arena/render/terminal.ts` 移到 TUI CLI output 层，或至少不要从 core public entry 导出。

2. 保留 `formatArenaResultForSession` 在 core 也可以，它更像 session/model 语义输出，而不是 terminal presentation。

3. 修改 Arena built-in tool：尽量发 structured progress/events，不直接选择 terminal renderer。

4. 拆 `core/state.ts`：engine/session/cwd/model state 留在 core，scroll/input/UI interaction state 下沉到 TUI adapter。

预估：2 到 4 天。

### Phase 3：接通 desktop bridge

目标：把 Electron POC 变成真正可跑的 thin client，同时不破坏边界。

1. `packages/desktop/src/main/index.ts` 里创建 `Engine` 和 `AgentServer`。

2. preload 从 generic RPC 改成 typed named methods：

```text
run(task, sessionId?)
cancel()
approve(requestId, decision)
configure(params)
query(type, arg?)
onStream(handler)
onApprovalRequest(handler)
onStatus(handler)
```

3. renderer 继续保持干净：只能 import React、本地 renderer 文件，以及使用 `window.codeShell`。

4. 加一个 desktop smoke check：

```text
renderer 能看到 preload bridge
main 能创建 Engine
run request 能收到 stream/status event
cancel 能 abort active run
```

预估：3 到 5 天。

### Phase 4：清 TUI 内部边界

目标：未来非 CLI frontend 更容易复用 command model。

1. 把 slash-command registry 和 command execution model 从 `cli/commands/builtin` 抽到 UI-neutral 的 TUI module。

2. 让 `cli/` 只负责 argv parsing 和 terminal process lifecycle。

3. 让 `ui/` 消费 command registry interface，而不是 import CLI files。

4. 增加 import guard：

```text
tui/src/ui 不应直接 import tui/src/cli，除非通过 approved command registry
tui/src/render 不应 import tui/src/ui
```

预估：2 到 3 天。

## 7. 建议排序

先做：

1. 修 stale enforcement 和文档路径。
2. 移除 dist-based test import。
3. 将 `core/src/index.ts` 拆成 public exports 和 internal/TUI support exports。
4. 将 Arena terminal rendering 从 core public API 中移出。
5. 接 desktop main/preload/renderer bridge。

暂时不要做：

1. 不要现在抽独立 protocol SDK。等 VS Code、browser、non-Node 或 multi-client 消费者真的出现。
2. 不要继续把 `core` 拆成更多 package。当前问题不是 package 数量，而是 API 表面和内部边界。
3. 不要一次性重写所有 singleton。先处理最影响 client independence 的：`state.ts` 的 UI interaction 字段、async agent registry、notification queue、terminal progress renderer。

## 8. 最终判断

CodeShell 已经跨过了解耦的主要门槛：core 和 TUI 物理分离，依赖方向健康，主要运行路径也统一到了 protocol。

下一阶段的关键词不是“继续大迁移”，而是“边界硬化”：让约束脚本真的有效，让 public API 更像 SDK，让 terminal presentation 不污染 core public surface，再把 desktop 作为第一个真实 thin client 接起来。
