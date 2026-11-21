import type { OperationLedgerRequest, OperationLedgerTransport } from "./host-transport.js";

/** The trusted parent supplies a separate Node IPC descriptor. Stdio is exclusively AgentServer traffic. */
export function childOperationLedger(): OperationLedgerTransport {
  let next = 0;
  const pending = new Map<number, { finish: (err: boolean, result?: unknown) => void }>();
  process.on("message", (m) => {
    const value = m as { type?: unknown; id?: number; success?: unknown; result?: unknown } | null;
    if (value?.type === "run-ledger-result" && Number.isSafeInteger(value.id))
      pending.get(value.id!)?.finish(value.success !== true, value.result);
  });
  process.once("disconnect", () => {
    for (const call of pending.values()) call.finish(true);
  });
  return (request: OperationLedgerRequest) =>
    new Promise((resolve, reject) => {
      if (!process.connected || !process.send || pending.size >= 32)
        return reject(new Error("Operation Host unavailable"));
      const id = ++next;
      const finish = (err: boolean, result?: unknown) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        if (err) reject(new Error("Operation Host unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 15000).unref();
      pending.set(id, { finish });
      try {
        process.send({ type: "run-ledger", id, request }, (e: Error | null) => {
          if (e) finish(true);
        });
      } catch {
        finish(true);
      }
    });
}
