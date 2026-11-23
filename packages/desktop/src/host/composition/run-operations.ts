import { randomUUID } from "node:crypto";
import {
  isOperationLedgerRequest,
  type OperationLedgerRequest,
} from "@cjhyy/code-shell-core/internal/operations";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { PreparedOperationKey } from "./operation-key.js";

type DocumentGuard = { assertCurrent(): void; release?(): void; observe?(): void; pin?(): void };
export class HostRunOperations {
  private readonly live = new Set<{ observe(): void; close(): void }>();
  constructor(
    private readonly storage: Promise<Pick<StateStorage, "request">>,
    private readonly key: (create: boolean) => Promise<PreparedOperationKey | null>,
    private readonly capture: (id: string) => DocumentGuard,
  ) {}
  open(sessionId: string, runId: string, isCurrent: () => boolean) {
    if (this.live.size >= 128) throw new Error("Too many active operation Runs");
    const token = randomUUID();
    const permits = new Set<Int32Array>();
    const guard = this.capture(sessionId);
    let key: PreparedOperationKey | null = null;
    let closed = false;
    let finalizing = false;
    const check = () => {
      if (closed || !isCurrent()) throw new Error("Operation executor changed");
      guard.assertCurrent();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      for (const permit of permits) Atomics.compareExchange(permit, 0, 0, -1);
      this.live.delete(scope);
      guard.release?.();
      key = null;
      if (usedStorage)
        void this.storage.then((db) => db.request("operations/endRun", { token })).catch(() => {});
    };
    let usedStorage = false;
    const scope = {
      observe: () => {
        guard.observe?.();
        check();
      },
      close,
    };
    this.live.add(scope);
    return {
      close,
      run: async (request: OperationLedgerRequest) => {
        check();
        if (
          !isOperationLedgerRequest(request) ||
          request.sessionId !== sessionId ||
          request.runId !== runId ||
          permits.size >= 32
        )
          throw new Error("Invalid operation Run request");
        if (request.method === "sealForFinalization") {
          if (!finalizing) for (const prior of permits) Atomics.compareExchange(prior, 0, 0, -1);
          finalizing = true;
        } else if (finalizing) throw new Error("Operation run has finalized");
        guard.pin?.();
        const permit = new Int32Array(new SharedArrayBuffer(4));
        permits.add(permit);
        try {
          const db = await this.storage;
          check();
          if (!key) {
            const prepared = await this.key(request.method === "prepare");
            check();
            key ??= prepared;
          }
          usedStorage = true;
          const submit = () => db.request("operations/run", { token, request, key, permit });
          let result = await submit();
          if (result === "retryCanonicalKey") {
            check();
            const refreshed = await this.key(false);
            check();
            if (!refreshed) throw new Error("Operation key unavailable");
            key = refreshed;
            result = await submit();
            if (result === "retryCanonicalKey") throw new Error("Operation key changed");
          }
          check();
          if (result == null) throw new Error("Operation storage unavailable");
          return result;
        } finally {
          permits.delete(permit);
        }
      },
    };
  }
  authorityChanged() {
    for (const scope of this.live) {
      try {
        scope.observe();
      } catch {
        scope.close();
      }
    }
  }
  close() {
    for (const scope of this.live) scope.close();
  }
}

export type OperationCap = ReturnType<HostRunOperations["open"]>;
