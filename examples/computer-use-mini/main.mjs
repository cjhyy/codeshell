import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { createRpcClient } from "./rpc.mjs";
import { createRuntime } from "./runtime.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--trace", "--repl"].includes(arg))) {
  console.error("Usage: node examples/computer-use-mini/main.mjs [--trace] [--repl]");
  process.exitCode = 1;
} else {
  const rpc = createRpcClient({
    trace: args.includes("--trace")
      ? (direction, message) => console.error(`[RPC ${direction}] ${JSON.stringify(message)}`)
      : undefined,
  });
  const runtime = createRuntime(rpc);

  async function run(title, code) {
    console.log(`\n${title}\n[js]\n${code}`);
    const observation = await runtime.js(code);
    console.log(`[观察]\n${observation.text}`);
    return observation.result;
  }

  try {
    console.log("Computer Use Mini：持久 JS 上下文 → cua → 子进程 JSON-RPC → 模拟计算器");
    if (args.includes("--repl")) {
      console.log("输入单行 JavaScript；跨调用变量存入 globalThis；.reset 重置，.exit 退出。");
      console.log(
        '例如：globalThis.app = await cua.getApp("Calculator"); return await app.getState();',
      );
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "cua> ",
      });
      let closed = false;
      input.once("close", () => {
        closed = true;
      });
      const prompt = () => {
        if (!closed && process.stdin.isTTY) input.prompt();
      };
      prompt();
      try {
        for await (const line of input) {
          const code = line.trim();
          if (code === ".exit") break;
          try {
            if (code === ".reset") console.log((await runtime.jsReset()).text);
            else if (code) console.log((await runtime.js(code)).text);
          } catch (error) {
            console.error(`[错误] ${error.message}`);
          }
          prompt();
        }
      } finally {
        input.close();
      }
    } else {
      // Fixed tool calls stand in for model output; no LLM/API key is required.
      await run(
        "1. 获取应用句柄，观察界面",
        'globalThis.app = await cua.getApp("Calculator"); return await app.getState();',
      );
      await run(
        "2. 复用上次的 app，逐个点击按钮",
        'for (const label of ["7", "+", "8", "="]) await app.click(label);',
      );
      const state = await run("3. 再次观察，并验证结果", "return await app.getState();");
      assert.equal(state.result, 15);

      console.log("\n4. 执行器返回错误后，上下文仍然可用");
      await assert.rejects(runtime.js('await app.click("missing");'), /Unknown element/);
      assert.equal((await runtime.js("return await app.getState();")).result.result, 15);
      console.log("未知按钮请求已拒绝；计算器结果仍是 15。");

      console.log(`\n5. ${(await runtime.jsReset()).text}`);
      const binding = await run("检查原来的 app 变量", "return typeof app;");
      assert.equal(binding, "undefined");
      const retained = await run(
        "重新获取应用，观察仍然保留的结果",
        'globalThis.app = await cua.getApp("Calculator"); return await app.getState();',
      );
      assert.equal(retained.result, 15);
      console.log("\n演示完成：跨调用复用、错误恢复、reset 与应用状态分离均已验证。");
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await rpc.close();
  }
}
