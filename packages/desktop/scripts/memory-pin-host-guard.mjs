/** Hold only a completed memory read on its original workbench port. The
 * native driver sees metadata and can release that exact reply, never its bytes. */
export function observeMemoryPort(parent) {
  let sequence = 0;
  const replies = new Map();
  parent.on("message", ({ data, ports }) => {
    if (data?.type === "fixture-memory-release") {
      replies.get(data.id)?.();
      replies.delete(data.id);
      return;
    }
    if (data?.type !== "bind" || ports.length !== 1) return;
    const [port] = ports;
    const calls = new Map();
    const ownReplies = new Set();
    port.on("message", ({ data: message }) => {
      if (message?.method === "memory/read" || message?.method === "memory/list") {
        calls.set(message.id, {
          channel: message.method.replace("/", ":"),
          scope: message.params?.scope,
          name: message.params?.name ?? null,
        });
      }
    });
    port.on("close", () => {
      for (const id of ownReplies) replies.delete(id);
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (message, ...args) => {
      const call = calls.get(message.id);
      if (!call) return post(message, ...args);
      calls.delete(message.id);
      const id = ++sequence;
      ownReplies.add(id);
      replies.set(id, () => {
        ownReplies.delete(id);
        post(message, ...args);
      });
      parent.postMessage({ type: "fixture-memory-read", id, call, ok: !message.error });
    };
  });
}

export function observeNativeMemoryReads(utilityProcess, state) {
  const fork = utilityProcess.fork;
  utilityProcess.fork = function (...args) {
    const child = fork.apply(this, args);
    child.on("message", async (message) => {
      if (message?.type !== "fixture-memory-read") return;
      const call = { ...message.call, route: "workbench-port", status: "pending" };
      state.calls.push(call);
      state.lastActivity = Date.now();
      const gate = state.gate;
      if (gate?.channel === call.channel && gate.name === call.name) {
        state.gate = null;
        await new Promise((resolve) => {
          state.release = resolve;
        });
        state.release = null;
      }
      child.postMessage({ type: "fixture-memory-release", id: message.id });
      call.status = message.ok ? "completed" : "handler-error";
      state.lastActivity = Date.now();
    });
    return child;
  };
}
