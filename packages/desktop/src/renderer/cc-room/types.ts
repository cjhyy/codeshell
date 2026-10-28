export type RoomCliKind = "claude-code" | "codex";

export interface OpenCliSessionRequest {
  nonce: number;
  consumed?: boolean;
  /** Background tasks keep a stable route before the CLI reports its session id. */
  jobId?: string;
  sourceSessionId?: string;
  title?: string;
  externalSessionId?: string;
  cliKind: RoomCliKind;
  cwd: string;
}

export interface OpenCliSessionEventDetail extends Omit<OpenCliSessionRequest, "nonce"> {
  sourceSessionId: string;
  /** Only new, live delegations may surface the panel without a user click. */
  autoOpen?: boolean;
}
