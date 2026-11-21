import type { MobileServerEvent } from "@cjhyy/code-shell-server/mobile-remote";
import type { RemoteTerminalEvent } from "./remote-terminals.js";

export type TerminalReply = Extract<MobileServerEvent, { type: `terminal.${string}` }>;
export type TerminalControl =
  | { kind: "policy"; enabled: boolean; revision: number }
  | { kind: "release"; viewerId: string }
  | { kind: "event"; event: RemoteTerminalEvent; generation: string };
export type TerminalDelivery =
  | { kind: "list"; revision: number; event: Extract<TerminalReply, { type: "terminal.list.ok" }> }
  | { kind: "reply"; revision: number; viewerId: string; generation: string; event: TerminalReply };
