import type { PreparedOperationKey } from "../../host/composition/operation-key.js";
import type { createLinkOperationReviewStore } from "@cjhyy/code-shell-core/internal";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import type { OperationProjectScope } from "../operation-authority.js";

export type OperationReviewStore = ReturnType<typeof createLinkOperationReviewStore>;
export type OperationSnapshot = ReturnType<OperationReviewStore["review"]>;
export const batchCommands = [
  "host/batchReserve",
  "host/batchResolve",
  "host/batchFinish",
  "host/batchClose",
] as const;
export type BatchCommand = (typeof batchCommands)[number];
export const isBatchCommand = (method: string): method is BatchCommand =>
  batchCommands.includes(method as BatchCommand);
export type OperationCommand = "host/operationReview" | "host/operationResolve" | BatchCommand;
export type PrivateOperationCommand = OperationCommand | "host/operationReadKey";
export const isOperationCommand = (method: string): method is PrivateOperationCommand =>
  method === "host/operationReview" ||
  method === "host/operationResolve" ||
  method === "host/operationReadKey" ||
  isBatchCommand(method);

export interface OperationClient {
  operationCommand<T>(method: OperationCommand, payload: Record<string, unknown>): Promise<T>;
}

export interface NativeReviewClient extends OperationClient {
  withNativeRead<T>(
    input: { sessionId: string; token: string; id: string; revision: string },
    work: (key: PreparedOperationKey, check: () => void) => Promise<T>,
  ): Promise<T>;
}
export function operationReviewClient(
  host: NativeReviewClient,
  reader: (key: PreparedOperationKey) => OperationReviewStore["reconcile"],
) {
  const previews = new WeakMap<OperationSnapshot["owner"], string>();
  return {
    async review(sessionId: string, scope: OperationProjectScope) {
      const { token, snapshot } = await host.operationCommand<{
        token: string;
        snapshot: OperationSnapshot;
      }>("host/operationReview", { sessionId, scope });
      previews.set(snapshot.owner, token);
      return snapshot;
    },
    async reconcile(...args: Parameters<OperationReviewStore["reconcile"]>) {
      const [sessionId, owner, id, revision, options] = args;
      const token = previews.get(owner);
      if (!token) throw new Error("Operation review expired");
      previews.delete(owner);
      options.assertCurrent();
      return host.withNativeRead({ sessionId, token, id, revision }, (key, check) =>
        reader(key)(sessionId, owner, id, revision, {
          ...options,
          assertCurrent() {
            check();
            options.assertCurrent();
          },
        }),
      );
    },
    async resolve(
      sessionId: string,
      owner: OperationSnapshot["owner"],
      id: string,
      revision: string,
      assertCurrent: () => void,
    ) {
      const token = previews.get(owner);
      if (!token) throw new Error("Operation review expired");
      previews.delete(owner);
      assertCurrent();
      await host.operationCommand("host/operationResolve", { sessionId, token, id, revision });
    },
  };
}

export type CaptureOperation = (
  caller: DesktopHostIdentity,
  sessionId: string,
) => { assertCurrent(): void; release?(): void };
