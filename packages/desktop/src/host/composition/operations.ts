import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { BusinessMethods } from "./business-calls.js";
import { HostOperationReviews } from "../../main/desktop-host/operation-review.js";
import {
  isBatchCommand,
  isOperationCommand,
  type OperationSnapshot,
  type CaptureOperation,
} from "../../main/desktop-host/private-operations.js";
import type { DesktopHostServer } from "../../main/desktop-host/server.js";
import { isDesktopHostIdentity } from "../../shared/desktop-host-protocol.js";

export function nativeOperations(
  storage: Promise<StateStorage>,
  current: () => DesktopHostServer | undefined,
) {
  async function request<T>(method: string, input: unknown): Promise<T> {
    const result = await (await storage).request<T>(method, input);
    if (result === null) throw new Error("Operation storage unavailable");
    return result;
  }
  const reviews = new HostOperationReviews({
    wrappedKey: async () => (await storage).request<string>("operations/wrappedKey"),
    review: (sessionId, key) => request<OperationSnapshot>("operations/review", { sessionId, key }),
    resolve: (input) => request<boolean>("operations/resolve", input),
  });
  type BatchLease = { guard: ReturnType<CaptureOperation>; frame: string; sessionId: string };
  const batches = new Map<string, BatchLease>();
  async function seal(token: string, lease: BatchLease) {
    await request("host/batchClose", { token, frame: lease.frame, sessionId: lease.sessionId });
    if (batches.get(token) === lease) {
      batches.delete(token);
      lease.guard.release?.();
    }
  }
  return {
    authorityChanged() {
      reviews.authorityChanged();
      for (const [token, lease] of batches) {
        try {
          lease.guard.assertCurrent();
        } catch {
          void seal(token, lease).catch(() => {});
        }
      }
    },
    methods: {
      "operations/ledger": async (input, grant) => {
        const host = current();
        if (
          !host ||
          !isDesktopHostIdentity(input?.caller) ||
          !input.payload ||
          typeof input.payload !== "object"
        )
          throw new Error("Invalid native operation");
        const { action, payload, caller } = input;
        if (action === "host/operationKey") {
          const reservation = host.reserveDocumentCommit(caller);
          try {
            return { wrapped: await (await storage).request<string>("operations/wrappedKey") };
          } finally {
            reservation.release();
          }
        }
        if (!isOperationCommand(action)) throw new Error("Invalid native operation");
        const capture: CaptureOperation = (caller, id) => host.captureOperation(caller, id);
        if (!isBatchCommand(action)) return reviews.run(action, caller, payload, capture, grant);
        const { sessionId, token, key, proposal, ...values } = payload;
        if (typeof sessionId !== "string" || typeof token !== "string" || token.length > 128)
          throw new Error("Invalid batch");
        let lease = batches.get(token);
        if (action === "host/batchReserve") {
          if (lease || batches.size >= 128) throw new Error("Batch is already registered");
          lease = { guard: capture(caller, sessionId), frame: caller.frameToken, sessionId };
          batches.set(token, lease);
        }
        if (!lease && action === "host/batchClose") return true;
        if (!lease || lease.frame !== caller.frameToken || lease.sessionId !== sessionId)
          throw new Error("Batch has ended");
        if (action === "host/batchClose") {
          await seal(token, lease);
          return true;
        }
        try {
          lease.guard.assertCurrent();
          const result = await reviews.withPending(capture(caller, sessionId), grant, () =>
            request(action, {
              sessionId,
              token,
              frame: caller.frameToken,
              ...values,
              permit: grant.permit,
              ...(proposal && typeof proposal === "object"
                ? { proposal: { ...proposal, key } }
                : {}),
            }),
          );
          lease.guard.assertCurrent();
          grant.assertCurrent();
          return result;
        } catch (error) {
          try {
            await seal(token, lease);
          } catch {
            /* A failed seal retains the closed native capability for cleanup. */
          }
          throw error;
        }
      },
    } satisfies Pick<BusinessMethods, "operations/ledger">,
  };
}
