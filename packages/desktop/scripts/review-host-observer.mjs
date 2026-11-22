// Only installed by the isolated Review drivers. Keep the real port and exact
// production response in the utility process, including while a draft is held.
export function observeReviewPort(parent, { method, observe, checkAgent }) {
  let sequence = 0;
  const pending = new Map();
  parent.on("message", ({ data, ports }) => {
    if (data?.type === "fixture-review-release") {
      pending.get(data.id)?.();
      return;
    }
    if (data?.type !== "bind" || ports.length !== 1) return;
    const [port] = ports;
    const requests = new Map();
    const held = new Set();
    port.on("message", ({ data: request }) => {
      if (request?.method === method) requests.set(request.id, request.params);
      if (
        request?.method?.startsWith("agent/") &&
        !["agent/subscribe", "agent/pendingApprovals"].includes(request.method)
      ) {
        checkAgent?.(request);
      }
    });
    port.on("close", () => {
      for (const id of held) pending.delete(id);
      requests.clear();
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (reply, ...args) => {
      const params = requests.get(reply.id);
      if (!params) return post(reply, ...args);
      requests.delete(reply.id);
      if (observe) {
        observe(params, reply);
        return post(reply, ...args);
      }
      const id = ++sequence;
      held.add(id);
      pending.set(id, () => {
        held.delete(id);
        pending.delete(id);
        post(reply, ...args);
      });
      parent.postMessage({ type: "fixture-review-result", id, params, reply });
    };
  });
}

export function observeNativeReviewDrafts(utilityProcess, state) {
  const fork = utilityProcess.fork;
  utilityProcess.fork = function (...args) {
    const child = fork.apply(this, args);
    child.on("message", async (message) => {
      if (message?.type === "fixture-review-registered") state.registered++;
      if (message?.type === "fixture-review-agent-read") {
        state.readonlyAgentRequests.push(message.metadata);
      }
      if (message?.type !== "fixture-review-result") return;
      const { params, reply, id } = message;
      try {
        await state.gate.invoke(() => {
          if (reply.error) throw Error("Production Review preparation failed");
          return reply.result;
        }, [undefined, params.sessionId, params.request]);
      } catch {
        state.unexpected.push("review-response");
      } finally {
        child.postMessage({ type: "fixture-review-release", id });
      }
    });
    return child;
  };
}
