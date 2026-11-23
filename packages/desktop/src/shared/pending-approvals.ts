import type { PendingMobileApprovals } from "@cjhyy/code-shell-server/mobile-remote";
import type { CallShellBusiness } from "./shell-business-contracts.js";

type Route = NonNullable<ReturnType<PendingMobileApprovals["find"]>>;
type NativeApprovalRead =
  | { scope: "session"; sessionId: string }
  | { scope: "mimi" }
  | { scope: "window"; owner: number };
export interface PendingApprovalOperations {
  "approvals/replay": { input: NativeApprovalRead; result: string[] };
  "approvals/find": { input: { sessionId: string; requestId: string }; result: Route | undefined };
  "approvals/resolve": {
    input: Partial<Route> & { requestId: string; owner?: number };
    result: void;
  };
  "approvals/forget": { input: { sessionId: string }; result: void };
}
type MaybeAsync<F extends (...args: never[]) => unknown> = (
  ...args: Parameters<F>
) => ReturnType<F> | Promise<ReturnType<F>>;
export interface MobileApprovalAccess {
  find: MaybeAsync<PendingMobileApprovals["find"]>;
  resolve(
    requestId: string,
    route: Partial<Route>,
    caller?: { owner: number; signal: AbortSignal },
  ): void | Promise<void>;
  forgetSession: MaybeAsync<PendingMobileApprovals["forgetSession"]>;
  replayLines: MaybeAsync<PendingMobileApprovals["replayLines"]>;
}
export function nativePendingApprovals(call: CallShellBusiness) {
  return {
    find: (sessionId: string, requestId: string) =>
      call("approvals/find", { sessionId, requestId }),
    resolve: (
      requestId: string,
      route: Partial<Route>,
      caller?: { owner: number; signal: AbortSignal },
    ) =>
      call(
        "approvals/resolve",
        { ...route, requestId, ...(caller ? { owner: caller.owner } : {}) },
        caller?.signal,
      ),
    forgetSession: (sessionId: string) => call("approvals/forget", { sessionId }),
    replayLines: (sessionId: string) => call("approvals/replay", { scope: "session", sessionId }),
    replayForMimi: () => call("approvals/replay", { scope: "mimi" }),
    replayForWindow: (owner: number, signal: AbortSignal) =>
      call("approvals/replay", { scope: "window", owner }, signal),
  };
}
