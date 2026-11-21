import type { PreparedOperationKey } from "../../host/composition/operation-key.js";
import { isRpcResponse } from "../../shared/desktop-host-protocol.js";

/** Private utility parent port only. No method accepts a supplied credential or ciphertext. */
export class RunKeyClient {
  private next = 0;
  private pending = new Map<string, (key: PreparedOperationKey | null, error?: boolean) => void>();
  constructor(private readonly send: (frame: unknown) => void) {}
  request(create: boolean): Promise<PreparedOperationKey | null> {
    if (this.pending.size >= 128) return Promise.reject(new Error("Operation keyring busy"));
    const id = `host:run-key:${++this.next}`;
    return new Promise((resolve, reject) => {
      const finish = (key: PreparedOperationKey | null, err = false) => {
        this.pending.delete(id);
        clearTimeout(timer);
        if (err) reject(new Error("Operation keyring unavailable"));
        else resolve(key);
      };
      const timer = setTimeout(() => finish(null, true), 15000).unref();
      this.pending.set(id, finish);
      try {
        this.send({ jsonrpc: "2.0", id, method: "app/operationLedgerKey", params: { create } });
      } catch {
        finish(null, true);
      }
    });
  }
  receive(msg: unknown) {
    if (!isRpcResponse(msg) || typeof msg.id !== "string") return false;
    const finish = this.pending.get(msg.id);
    if (!finish) return false;
    const key = msg.result as PreparedOperationKey | null;
    const invalid =
      key !== null &&
      (!key ||
        typeof key.wrapped !== "string" ||
        typeof key.secret !== "string" ||
        !/^[a-f0-9]{64}$/.test(key.secret));
    finish(key, !!msg.error || invalid);
    return true;
  }
  close() {
    for (const finish of this.pending.values()) finish(null, true);
  }
}
