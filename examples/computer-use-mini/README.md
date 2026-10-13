# Computer Use 最小教学版

用一个模拟计算器，演示 Computer Use 的核心链路：执行 JavaScript → 调用控制接口 → 跨进程发送请求 → 执行操作 → 读取状态并验证。代码只使用 Node.js 内置模块，需要 Node.js **20.10 或更新版本**，无需安装依赖。

## 运行

在仓库根目录执行：

```sh
# 自动演示计算与状态验证
node examples/computer-use-mini/main.mjs

# 同时打印实际经 stdio 传输的 JSON-RPC 请求和回复
node examples/computer-use-mini/main.mjs --trace

# 手动输入单行 JavaScript
node examples/computer-use-mini/main.mjs --repl
```

交互模式中，每行代码作为一个 async 函数执行，可以直接使用 `await`；用 `return` 返回观察结果，也可以用 `nodeRepl.write(value)` 输出信息。例如逐行输入：

```js
globalThis.app = await cua.getApp("Calculator");
await app.click("7");
return await app.getState();
await app.click("+");
await app.click("8");
await app.click("=");
return await app.getState();
```

此时计算器结果应为 `15`。`await app.click("C")` 可以清空计算器。

交互命令：

- `.reset`：重建 JavaScript 上下文，清除保存的变量；子进程中的计算器状态保留。
- `.exit`：退出交互模式并关闭执行器子进程。

重置后需要重新获取句柄：

```js
globalThis.app = await cua.getApp("Calculator");
return await app.getState();
```

## 具体实现

```text
main.mjs：固定脚本或手动输入
    ↓ JavaScript
runtime.mjs：VM 中的 async 函数，注入 cua 与 nodeRepl.write
    ↓ app.getState() / app.click(label)
rpc.mjs：请求 ID、JSON-RPC、子进程 stdio
    ↓ 实际跨进程通信
executor.mjs：模拟计算器执行操作并返回结构化状态
    ↑ 回复经过 RPC 返回运行时，再由演示脚本检查结果
```

`cua.getApp("Calculator")` 返回控制句柄，提供 `app.getState()` 和 `app.click(label)`。示例使用 `"7"`、`"+"`、`"8"`、`"="`、`"C"` 这些按钮标签。句柄的方法将操作转成 JSON-RPC 请求，由独立的执行器进程处理；RPC 层负责请求超时和子进程关闭时的未完成请求处理。

建议按 **main.mjs → runtime.mjs → rpc.mjs → executor.mjs** 的顺序阅读：先看任务如何分步执行和验证，再看接口如何转成进程消息，最后看执行器如何更新应用状态。

## 持久状态的边界

这里使用简化的 VM async 包装器，**只有显式保存到 `globalThis.*` 的数据跨调用保留**。例如 `globalThis.app = ...` 在下次调用时仍可通过 `app` 使用；普通 `let`、`const`、`var` 位于单次 async 函数内，不会跨调用保留。

`globalThis` 属于当前 JavaScript 上下文，不是操作系统全局变量。保存 `app` 只保存控制句柄，先前读取的状态不会自动刷新；需要再次调用 `getState()`。`.reset` 清除的是 JavaScript 状态，不是撤销已经执行的计算器操作。

## 教学版的范围

固定脚本代替模型生成代码，因此不会发送 LLM 请求。它实现了实际的子进程和 stdio JSON-RPC 通信，但没有 MCP 握手，也不控制真实浏览器或桌面，不生成截图或图片。它用于展示分层关系，不是 Codex 内部实现的复刻。

VM 不是权限沙箱，此示例只适合运行自己编写、信任的代码。

操作应使用 `await` 等待完成。RPC 超时会关闭执行器并拒绝未完成请求，不会撤销已经完成的操作；VM 的执行时限只覆盖同步代码，不是异步任务的完整取消机制。

后续可以保留 `cua` 接口与 RPC 层，把 `executor.mjs` 换成浏览器执行器，再增加页面观察与截图返回，逐步接近真实的 Computer Use 工作流。
