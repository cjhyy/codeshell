import type { MobileServerEvent } from "@cjhyy/code-shell-server/mobile-remote";
import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";
export type RemoteTerminalEvent = Extract<
  AuthenticatedMobileClientEvent,
  { type: `terminal.${string}` }
>;

export function isRemoteTerminalEvent(
  event: AuthenticatedMobileClientEvent,
): event is RemoteTerminalEvent {
  return event.type.startsWith("terminal.");
}

export type TerminalReply = Extract<MobileServerEvent, { type: `terminal.${string}` }>;
export type TerminalControl =
  | { kind: "policy"; enabled: boolean; revision: number }
  | { kind: "release"; viewerId: string }
  | { kind: "event"; event: RemoteTerminalEvent; generation: string };
export type TerminalDelivery =
  | { kind: "list"; revision: number; event: Extract<TerminalReply, { type: "terminal.list.ok" }> }
  | { kind: "reply"; revision: number; viewerId: string; generation: string; event: TerminalReply };
