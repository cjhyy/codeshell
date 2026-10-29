/** Display-only history views. These are not partial journals or replayable commands. */
export interface MobileHistoryAttachment {
  name: string;
  mime?: string;
  size: number;
  path?: string;
  absPath?: string;
}
export type MobileHistoryItem =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments?: MobileHistoryAttachment[];
      clientMessageId?: string;
      textDetailRef?: string;
    }
  | {
      kind: "assistant";
      id: string;
      messageId?: string;
      text: string;
      reasoning: string;
      done: boolean;
      agentId?: string;
      textDetailRef?: string;
      reasoningDetailRef?: string;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      result?: string;
      error?: boolean;
      summary?: string;
      done: boolean;
      agentId?: string;
      detailRef?: string;
      /** Only an explicit same-run/turn/source identity permits display grouping. */ activityGroupKey?: string;
    }
  | { kind: "subagent"; id: string; agentId: string; label: string; status: string }
  | { kind: "system"; id: string; text: string }
  | { kind: "system_error"; id: string; text: string };

/** Full reducer control state is preserved independently of the visible item window. */
export interface MobileHistoryState {
  run: "idle" | "running" | "waiting" | "completed" | "error";
  goal?: string;
  goalId?: string;
  goalPaused?: boolean;
  goalRevision?: number;
  sessionId?: string;
  title?: string;
  liveByAgent: Record<string, string>;
  seq: number;
}
export interface MobileOutputSnapshot {
  epoch: string;
  nextSeq: number;
  outputCursor?: string;
  unpaired: boolean;
  inputIds?: string[];
  incarnation?: string;
  journalIdentity?: string;
  historicalGap?: true;
}
export interface MobileHistoryView {
  status: "ok";
  /** Opaque grant tied to this viewer/connection/selection and frozen source proof. */
  viewId: string;
  through: string;
  coverageStart: string;
  coverageIdentity?: string;
  snapshot: MobileOutputSnapshot;
  /** Exact stable receipts proved by the complete source, including nonvisible older items. */
  verifiedInputIds: string[];
  state: MobileHistoryState;
  items: MobileHistoryItem[];
  totalItems: number;
  /** Half-open range in the frozen full projection, at most 80 items and 1 MiB per reply. */
  start: number;
  end: number;
  before?: string;
}
export interface MobileHistoryDetail {
  text?: string;
  args?: Record<string, unknown>;
  result?: string;
  reasoning?: string;
}
export type MobileHistoryViewResult =
  | MobileHistoryView
  | { status: "busy" | "incomplete" | "unsupported" };
export type MobileHistoryDetailResult =
  | { status: "busy" | "incomplete" }
  | ({
      status: "ok";
      ref: string;
      /** Byte offset in one immutable UTF-8 JSON MobileHistoryDetail value. */
      index: number;
      /** Canonical base64, at most 256 KiB decoded bytes per part. */
      data: string;
      /** At most 32 MiB and 128 parts; no silent truncation. */
      totalBytes: number;
    } & ({ complete: true; next?: never } | { complete: false; next: string }));
