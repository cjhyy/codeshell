import type { ChildProcess } from "node:child_process";
import type { OperationLedgerRequest } from "@cjhyy/code-shell-core/internal/operations";

export type WorkerOperation = (
  request: OperationLedgerRequest,
  current: () => boolean,
) => Promise<unknown>;

/** Never route child IPC through the public JSON-RPC transport. Scope and args are checked by the Host. */
export function bindWorkerOperations(
  child: ChildProcess,
  active: () => boolean,
  run: WorkerOperation,
) {
  let last = 0,
    busy = 0;
  const current = () =>
    active() &&
    child.connected &&
    child.exitCode === null &&
    child.signalCode === null &&
    !child.killed;
  child.on("message", (raw) => {
    const m = raw as { type?: string; id: number; request: OperationLedgerRequest } | null;
    if (m?.type !== "run-ledger" || !Number.isSafeInteger(m.id) || m.id <= last || !current())
      return;
    last = m.id;
    const reply = (success: boolean, result?: unknown) => {
      if (current()) child.send({ type: "run-ledger-result", id: m.id, success, result }, () => {});
    };
    if (busy >= 32) return reply(false);
    busy++;
    void Promise.resolve()
      .then(() => run(m.request, current))
      .then(
        (result) => reply(true, result),
        () => reply(false),
      )
      .finally(() => {
        busy--;
      });
  });
}
