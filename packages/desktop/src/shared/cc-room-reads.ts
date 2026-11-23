import type {
  listRelatedClaudeSessions,
  probeClaudeCli,
  readRecentHistory,
} from "@cjhyy/code-shell-capability-coding/orchestration";

export type CliKind = "claude-code" | "codex";
export type CliList = {
  kind: CliKind;
  cwd: string;
  all?: boolean;
}
export type CliHistory = {
  kind: CliKind;
  cwd: string;
  sessionId: string;
  limit: number;
  before?: number;
}
export interface CcRoomReads {
  "ccRoom/probe": {
    params: { kind: CliKind; force?: boolean };
    result: Awaited<ReturnType<typeof probeClaudeCli>>;
  };
  "ccRoom/sessions": {
    params: CliList;
    result: Awaited<ReturnType<typeof listRelatedClaudeSessions>>;
  };
  "ccRoom/history": { params: CliHistory; result: ReturnType<typeof readRecentHistory> };
}
export type ReadCcRoom = <K extends keyof CcRoomReads>(
  method: K,
  input: CcRoomReads[K]["params"],
) => Promise<CcRoomReads[K]["result"]>;
export type NativeCcRoomReads = {
  [K in keyof CcRoomReads]: { input: CcRoomReads[K]["params"]; result: CcRoomReads[K]["result"] };
};
