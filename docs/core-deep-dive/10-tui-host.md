# 10 · 终端里的薄客户端:TUI 如何消费 Core

> 一句话:TUI 是 core 的一个**薄客户端**——它通过 in-process 协议接缝驱动引擎,自己**不跑 Engine** 的业务逻辑;它的重头反而在一个 ~14K 行的手写终端渲染器上。

本篇属于"宿主层",不是 core。收录它是为了展示**core 如何被消费**。源码主战场:`packages/tui/`。

## 1. 它在整体里的位置

![Hosts 如何使用 Core](assets/desktop-tui-hosts.svg)

看图左侧那条:**TUI / headless CLI → Thin UI(Ink REPL/渲染器/输出)→ InProcessTransport → AgentClient ⇄ AgentServer → Core EngineRuntime**。

也就是说,TUI 把引擎嵌在**同一个进程**里,但中间仍隔着协议接缝:UI 调 `client.run(task, sessionId)` 并订阅 `client.onStreamEvent(...)`,**从不直接调 `Engine`**。这跟桌面用 stdio 跨进程是同一套协议接缝(见 [05 · 协议与会话](05-protocol-and-sessions.md)),只是这里 in-process 以求零序列化、共享内存。会话状态由 server 持有,resume 只是重发一个 `sessionId`。

> 接缝里那个 `Engine.run` 由共享的 `EngineRuntime` 装配(模型池、工具注册表共享)。这正是 [01](01-core-overview.md) 强调的"一份引擎,被宿主消费",而非宿主自带引擎。

## 2. CLI 入口与子命令

`cli/main.ts` 是个 Commander 程序,带一个 `preAction` 钩子(Node ≥20.10、cwd 校验、拒绝 root 下 `bypassPermissions`、日志轮转)。子命令:
- **`run [task]`** —— headless 一次性,流给格式渲染器(`text`/`json`/`jsonl`/`stream-json`)。
- **`repl`**(无 task 时默认)—— 交互式 Ink UI。
- **`sessions`/`runs`/`arena`/`plugin`** —— 列举/查询/多模型/注册。

flag 含 `-m/--model`、`-p/--provider`、`--preset`、`--permission-mode`、`--effort`、`--resume`、`--prefill`。有 `[task]` arg → `run`,否则 → `repl`。

## 3. Ink REPL 的两个核心设计

`ui/App.tsx` 是应用状态机。两个值得记的设计:

**外部 store,不是 React state**:聊天条目活在一个外部 store(`ui/store.ts`),经 `useSyncExternalStore` 消费——**追加一条消息不重渲整棵树**。一个 `ChatEntry` 联合类型覆盖 `user`、`assistant_text`(带 `streaming`+`agentId`)、`tool_start`/`tool_running`/`tool_result`、`thinking`、`agent_start`/`agent_end`、`error`、`status`、`system`。

**50ms 缓冲**:`handleStreamEvent` 把 text/thinking 增量累进 `textBufferRef`,**每 50ms 刷一次**——LLM 一秒吐 30–200 token,合并后变成约 20 次/秒重渲。`tool_use_start` 刷缓冲并加运行条;`tool_result` 替换它;`approval_request`/`ask_user` 抬起权限/问题提示。带 `agentId` 的子 agent 文本路由到 `AgentDock` 侧栏,不进主 feed。

**输入**:斜杠命令自动补全、vim 模式键位、持久历史。`Shift+Tab` 循环权限模式(plan → normal → bypass)给下一次提交。**斜杠命令**经 `CommandRegistry` 派发,最大的是 `core-commands.ts`(`/help`/`/model`/`/resume`/`/goal`/`/settings`/`/export` 等)。**REPL 内 cron** 在 `repl.ts` 经 `bindCronToEngine` 对每个 fire 的 job 用只读引擎(见 [07](07-run-automation-goal.md))。

## 4. 为什么要手写 ~14K 行渲染器

CodeShell **不用** stock Ink 的增量渲染器(它会闪、会丢更新)。`render/` 是一个手写的、行级 diff 的渲染器,配一个 TypeScript 版 Yoga 做 flexbox 布局:

```
React 树 → reconciler commit → DOM(ink-box/ink-text)→
Yoga.calculateLayout → render-node-to-output(屏幕缓冲、视口裁剪、选区/搜索叠层)→
ANSI diff → 终端(DEC 2026 同步输出)
```

- **全屏 vs 流式**:全屏(alt-screen + 虚拟滚动)是**默认**,resize 时重绘干净;流式模式(`CODESHELL_FULLSCREEN=0`)让 transcript 流进终端原生回滚,但 resize 后可能重复内容。
- **滚动手感**:`ScrollBox` 暴露命令式句柄,把待处理 delta 写到 DOM 节点并调度 60fps 节流渲染,而非每事件 `setState`。按用户偏好,**一格滚轮 = 一行**,copy-on-select 要在 mouseup 接 `copySelectionNoClear`。

## 5. headless 输出

`run` 走 `OutputRenderer`(text/json/jsonl/stream-json)消费同样的 `StreamEvent`:文本到 stdout,工具/agent 生命周期到 stderr 状态行(子 agent 缩进),最终结果打印或 JSON 序列化。

## 6. 这样设计的好处

- **与桌面共用协议**:同一套 `AgentClient`/`StreamEvent` 接法,行为一致。
- **渲染率与 token 率解耦**:外部 store + 50ms 缓冲,无论模型多快吐字,重渲都有上限。
- **终端体验正确**:~14K 行自绘渲染器换来无闪烁、不丢更新、resize 干净。

## 7. 源码阅读路线

1. `cli/main.ts` 看子命令与 `preAction`。
2. `ui/App.tsx` + `ui/store.ts` 看外部 store 与 `handleStreamEvent`。
3. `render/ink.tsx` + `render/render-node-to-output.ts` 看自绘渲染管线。
4. `cli/commands/registry.ts` 看斜杠命令派发。

## 8. 常见误解与边界

- ❌ "TUI 自己跑 Engine 的业务逻辑。" → ✅ 它是协议接缝上的薄客户端,引擎在接缝后面。
- ❌ "用的是标准 Ink 渲染。" → ✅ 自绘渲染器,故意不用 Ink 增量渲染。
- 调试提示:TUI 改动"点了没反应"先疑跑了旧 bundle——跑当前构建(`bun run dev:tui`)验证再查源码。
- 相关:同样的"reducer + 渲染"思路在浏览器 DOM 里的版本,见 [11 · 桌面与手机宿主](11-desktop-mobile-host.md)。
