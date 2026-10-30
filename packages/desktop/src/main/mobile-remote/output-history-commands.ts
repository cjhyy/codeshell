import type {
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";
import type { RemoteHostManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";

type Caller = { kind: "mobile"; viewerId: string; deviceId: string };
export interface MobileOutputHistoryService {
  plan(sessionId: string, caller: Caller): Promise<OutputHistoryRecoveryPlan>;
  apply(
    sessionId: string,
    input: OutputHistoryRecoveryAcceptance,
    caller: Caller,
  ): Promise<OutputHistoryRecoveryResult>;
}
type Request = Extract<
  AuthenticatedMobileClientEvent,
  { type: "session.outputRecovery.plan" | "session.outputRecovery.apply" }
>;

/** Repair reviews are private replies to the authenticated requesting tab. */
export async function handleOutputHistoryRecoveryCommand(
  deps: {
    remote: Pick<RemoteHostManager, "hasAuthenticatedViewer" | "sendToViewer">;
    service?: MobileOutputHistoryService;
  },
  event: Request,
): Promise<void> {
  const { viewerId, deviceId, sessionId, requestId } = event;
  if (!viewerId || !deviceId || !deps.remote.hasAuthenticatedViewer(viewerId, deviceId)) return;
  const caller: Caller = { kind: "mobile", viewerId, deviceId };
  const current = () => deps.remote.hasAuthenticatedViewer(viewerId, deviceId);
  if (event.type === "session.outputRecovery.plan") {
    let result: OutputHistoryRecoveryPlan = { status: "blocked", sessionId, reason: "unavailable" };
    try {
      if (deps.service) result = await deps.service.plan(sessionId, caller);
    } catch {
      result = { status: "blocked", sessionId, reason: "storage_error" };
    }
    if (result.sessionId !== sessionId)
      result = { status: "blocked", sessionId, reason: "storage_error" };
    if (current())
      deps.remote.sendToViewer(viewerId, { type: event.type, sessionId, requestId, result });
    return;
  }
  let result: OutputHistoryRecoveryResult = { status: "blocked", sessionId, reason: "unavailable" };
  try {
    if (event.acceptHistoricalGap !== true)
      result = { status: "blocked", sessionId, reason: "confirmation_required" };
    else if (deps.service)
      result = await deps.service.apply(
        sessionId,
        { planId: event.planId, acceptHistoricalGap: true },
        caller,
      );
  } catch {
    result = { status: "blocked", sessionId, reason: "storage_error" };
  }
  if (result.sessionId !== sessionId)
    result = { status: "blocked", sessionId, reason: "storage_error" };
  if (current())
    deps.remote.sendToViewer(viewerId, { type: event.type, sessionId, requestId, result });
}
