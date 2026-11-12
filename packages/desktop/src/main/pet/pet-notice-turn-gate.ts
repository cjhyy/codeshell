import type { PetDispatchCommand } from "./pet-dispatch-service.js";
import { petContextOriginForSource } from "./pet-context-links.js";
import { ownerTurnRefusal } from "./pet-mimi-notice-changes.js";

/**
 * Mimi's notice tools exist only in the owner's turns (design §4.7): the
 * dispatcher withholds their host-action kinds otherwise (which hides all
 * four tools), and tells the gate whose turn is running so the read
 * loopbacks refuse a turn that is not the owner's even if a tool is called.
 */
export const NOTICE_TOOL_KINDS: ReadonlySet<string> = new Set([
  "noticeTriggerMutation",
  "notificationSettingsMutation",
]);

export interface PetNoticeTurnGate {
  /** Whether an IM conversation is one of the owner's allowlisted targets. */
  isOwnerConversation(channel: string, target: string): boolean;
  /** A Mimi turn starts in `sessionId`; `owner`: it is the owner's. */
  begin(sessionId: string, owner: boolean): void;
  /** That turn ended (however it ended). */
  end(sessionId: string): void;
}

type ChatCommand = Extract<PetDispatchCommand, { type: "chat" }>;

/** The same check the change executors run, on this turn's own routing facts. */
export function isNoticeOwnerTurn(command: ChatCommand, gate?: PetNoticeTurnGate): boolean {
  if (command.hostWake) return false;
  const source = command.source;
  const refusal = ownerTurnRefusal(
    {
      originClientMessageId: command.clientMessageId ?? "",
      requestedAt: 0,
      originRef: petContextOriginForSource(source, command.clientMessageId),
      ...(source?.target
        ? {
            completionTarget: {
              kind: "im-gateway",
              channel: source.channel,
              target: source.target,
            },
          }
        : {}),
      isDirectMessage: source?.isDirectMessage === true,
    },
    (channel, target) => gate?.isOwnerConversation(channel, target) === true,
  );
  return refusal === undefined;
}

/**
 * Run one Mimi turn with the gate told whether it is the owner's (it is when
 * its run offers the notice tools' kinds), and always told when it ends.
 */
export async function withNoticeTurn<T>(
  gate: PetNoticeTurnGate | undefined,
  params: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  if (!gate || !sessionId) return run();
  const profile = params.profileParams as { hostActions?: unknown } | undefined;
  const kinds = Array.isArray(profile?.hostActions) ? profile.hostActions : [];
  gate.begin(
    sessionId,
    kinds.some((kind) => NOTICE_TOOL_KINDS.has(kind as string)),
  );
  try {
    return await run();
  } finally {
    gate.end(sessionId);
  }
}
