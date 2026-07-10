export type RoomCliKind = "claude-code" | "codex";

export interface OpenCliSessionRequest {
  nonce: number;
  consumed?: boolean;
  externalSessionId: string;
  cliKind: RoomCliKind;
  cwd: string;
}

export interface OpenCliSessionEventDetail extends Omit<OpenCliSessionRequest, "nonce"> {
  sourceSessionId: string;
}
