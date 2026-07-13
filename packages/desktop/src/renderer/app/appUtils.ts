import type { MobilePermissionMode } from "../../preload/types";
import type { OpenCliSessionRequest } from "../cc-room/types";
import type { ImageAttachment } from "../chat/attachments";
import type { PermissionMode } from "../chat/PermissionPill";
import type { MessagesReducerState } from "../types";
import type { PanelTab } from "../view";
import { loadPanelState, NO_REPO_KEY } from "../transcripts";

export function stablePromptHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

export function toMobilePermissionMode(
  mode: PermissionMode | null | undefined,
): MobilePermissionMode | null {
  switch (mode) {
    case "accept_edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
    case "default":
    case "plan":
      return "default";
    default:
      return null;
  }
}

export function fromMobilePermissionMode(mode: MobilePermissionMode): PermissionMode {
  switch (mode) {
    case "acceptEdits":
      return "accept_edits";
    case "bypassPermissions":
      return "bypass";
    case "default":
    default:
      return "default";
  }
}

export interface ComposerDraftState {
  text: string;
  attachments: ImageAttachment[];
}

export type ComposerDraftsMap = Record<string, ComposerDraftState>;

export const EMPTY_ATTACHMENTS: ImageAttachment[] = [];

export interface ApprovalHistoryEntry {
  decision: "approve" | "deny";
  envelope: import("../../preload/types").ApprovalRequestEnvelope;
  reason?: string;
  at: number;
}

export interface PanelBucketState {
  open: boolean;
  tabs: { id: string; kind: PanelTab }[];
  activeId: string | null;
  requestNonce: number;
  requestKind: PanelTab | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  openUrl?: { url: string; nonce: number };
  openCliSession?: OpenCliSessionRequest;
}

export function emptyPanelBucketState(): PanelBucketState {
  return { open: false, tabs: [], activeId: null, requestNonce: 0, requestKind: null };
}

export function hydratePanelBucketState(bucket: string): PanelBucketState {
  const snap = loadPanelState<PanelTab>(bucket);
  return { ...snap, requestNonce: 0, requestKind: null };
}

export function parsePanelBucket(bucket: string): {
  projectBucketSegment: string;
  projectId: string | null;
  sessionId: string | null;
} {
  const sep = bucket.indexOf("::");
  const projectBucketSegment = sep >= 0 ? bucket.slice(0, sep) : bucket;
  const rawSessionId = sep >= 0 ? bucket.slice(sep + 2) : null;
  return {
    projectBucketSegment: projectBucketSegment || NO_REPO_KEY,
    projectId:
      projectBucketSegment && projectBucketSegment !== NO_REPO_KEY ? projectBucketSegment : null,
    sessionId: rawSessionId && rawSessionId !== "_none_" ? rawSessionId : null,
  };
}

export function browserPartitionForBucket(bucket: string): string {
  return `persist:browser:${bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_")}`;
}

export function quickChatLiveTurnActive(state: MessagesReducerState, busy: boolean): boolean {
  const lastMessage = state.messages[state.messages.length - 1];
  return busy && (state.streamingAssistantId !== null || lastMessage?.kind === "user");
}

export function resolveMainComposerBucket(
  requestedBucket: string | undefined,
  renderedBucket: string,
  activeBucket: string,
): string {
  if (requestedBucket === renderedBucket && renderedBucket !== activeBucket) {
    return activeBucket;
  }
  return requestedBucket ?? activeBucket;
}
