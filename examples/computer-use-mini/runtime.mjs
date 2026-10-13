import { inspect } from "node:util";
import vm from "node:vm";

export function createRuntime(rpc) {
  // The facade holds app identities; it delegates actions rather than owning app state.
  const cua = Object.freeze({
    async getApp(name) {
      const { appId } = await rpc.call("app.open", { name });
      return Object.freeze({
        getState: () => rpc.call("app.getState", { appId }),
        click: (label) => rpc.call("app.click", { appId, elementId: `button:${label}` }),
      });
    },
  });

  const format = (value) =>
    typeof value === "string" ? value : inspect(value, { depth: 6, colors: false });
  let output = [];
  const write = (...values) => output.push(values.map(format).join(" "));
  const createContext = () =>
    vm.createContext({
      cua,
      nodeRepl: Object.freeze({ write }),
      console: Object.freeze({ log: write, error: write }),
    });
  let context = createContext();
  let queue = Promise.resolve();

  // Reset and execution share a queue so a reset cannot race an unfinished invocation.
  function enqueue(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }

  return {
    js(code) {
      return enqueue(async () => {
        output = [];
        // This small evaluator supports await by wrapping each call in an async function.
        // Cross-call bindings must therefore be explicit globalThis properties.
        const script = new vm.Script(`(async () => {\n${code}\n})()`, {
          filename: "computer-use-mini.js",
        });
        const result = await script.runInContext(context, { timeout: 1_000 });
        if (result !== undefined) write(result);
        return { result, text: output.join("\n") || "(无输出)" };
      });
    },
    jsReset() {
      return enqueue(() => {
        context = createContext();
        return { text: "JS 上下文已重置；执行器与计算器状态保留。" };
      });
    },
  };
}
