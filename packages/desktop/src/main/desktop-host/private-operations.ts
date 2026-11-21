import type { createLinkOperationReviewStore } from "@cjhyy/code-shell-core/internal";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import type { OperationProjectScope } from "../operation-authority.js";

export type OperationReviewStore = ReturnType<typeof createLinkOperationReviewStore>;
export type OperationSnapshot = ReturnType<OperationReviewStore["review"]>;
export type OperationCommand = "host/operationReview" | "host/operationResolve";
export const isOperationCommand = (method: string): method is OperationCommand =>
  method === "host/operationReview" || method === "host/operationResolve";

export interface OperationClient {
  operationCommand<T>(method: OperationCommand, payload: Record<string, unknown>): Promise<T>;
}

export function operationReviewClient(host: OperationClient) {
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
