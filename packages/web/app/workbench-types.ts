import type React from "react";
import type { MobileProjectMeta, MobileTurnQueueState } from "@cjhyy/code-shell-core";
import type { ChatState } from "../src/lib/streamReducer.js";
import type { AuthSession, UploadedFile } from "./auth.js";
import type { HubConfiguration } from "./configuration.js";
import type { ComposerDraft } from "./drafts.js";
import type { ConnectionState, SessionSummary } from "./protocol.js";

export interface WorkbenchNavigation {
  /** Supply the destination when an action replaces the current workspace. */
  guard: (action: () => void, targetWorkspace?: string | null) => void;
  conversation: (action: () => void, targetWorkspace?: string | null) => void;
  /** Leaving the account/document also discards conversation drafts. */
  leaveWorkspace: (action: () => void) => void;
}

export interface HistoryDetail {
  text?: string;
  args?: Record<string, unknown>;
  result?: string;
  reasoning?: string;
}
export type HistoryDetailLoader = (reference: string) => Promise<HistoryDetail>;

/** Host adapters supply existing transport state; the browser workbench owns
 * navigation, focus, message rendering and the composer for every host. */
export interface WorkbenchController {
  host: "hub" | "desktop" | "legacy";
  workspaceApi: boolean;
  connection: ConnectionState;
  session?: AuthSession;
  activeId: string;
  /** Canonical protocol session, never a draft or CLI-room display bucket. */
  panelSessionId: string | undefined;
  chat: ChatState;
  sessions: SessionSummary[];
  workspaceCwd: string | null;
  workspaceName: string;
  workspaceKey: string;
  /** Existing Host project navigation, when the adapter supports direct selection. */
  projects?: readonly MobileProjectMeta[];
  selectedProjectId?: string;
  selectProject?: (id: string) => void;
  title: string;
  configuration: HubConfiguration | null;
  configurationVersion: number;
  sessionsVersion: number;
  draft: string;
  files: UploadedFile[];
  uploading: boolean;
  uploadBusy: boolean;
  hasUnsent: boolean;
  uncertain: boolean;
  running: boolean;
  localDrafts: Array<{ sessionId: string; draft: ComposerDraft; cwd?: string | null }>;
  approvals: Array<{ id: string; sessionId?: string; asynchronous?: boolean }>;
  approvalCount: (sessionId: string) => number;
  approvalContent: React.ReactNode;
  workerNote?: string | null;
  replayNote?: string | null;
  error: string;
  clearError: () => void;
  setDraft: (text: string) => void;
  removeFile: (id: string) => void;
  selectSession: (id: string) => void | Promise<void>;
  newSession: () => void;
  /** Explicit Panel association: resolve only after the Host session is ready.
   * Rejections preserve the caller's previous Panel association. */
  selectPanelSession?: (id: string) => Promise<string>;
  /** Hosts without an empty-session creation protocol leave this unavailable. */
  newPanelSession?: () => Promise<string>;
  /** True only after the current draft has been accepted by the local sender. */
  send: (options?: { modelTraceSource?: string }) => boolean;
  stop: () => void;
  addFiles: (files: FileList | null) => void | Promise<void>;
  refreshSessions: () => void | Promise<void>;
  refreshConfiguration: () => void | Promise<void>;
  onAuthLost: () => void;
  /** Browser-safe controls for capabilities owned by the Desktop host. */
  renderSidebar?: (navigation: WorkbenchNavigation) => React.ReactNode;
  chatControls?: React.ReactNode;
  /** Session controls belong beside the input; transcript notices stay above history. */
  composerControls?: React.ReactNode;
  modelSelector?: React.ReactNode;
  /** Reads a Host-issued reference in the currently selected history generation. */
  loadHistoryDetail?: HistoryDetailLoader;
  reloadHistory?: () => void;
  historyHasEarlier?: boolean;
  historyLoadingEarlier?: boolean;
  historyEarlierError?: string;
  loadEarlierHistory?: () => Promise<void>;
  goalActions?: React.ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  readOnly?: boolean;
  readOnlyNote?: string;
  attachmentAccept?: string;
  cameraAttachments?: boolean;
  unreadSessionIds?: ReadonlySet<string>;
  showTurnCounts?: boolean;
  accountName?: string;
  logout?: () => void;
  /** Host-owned pending turns. Absent when the Host cannot queue (send stays blocked while busy). */
  turnQueue?: WorkbenchTurnQueue;
  /** Compact conversation facts for the top bar (CLI kind, read-only, …). */
  statusBadges?: Array<{ label: string; tone?: "neutral" | "accent" | "warning" }>;
}

export interface WorkbenchTurnQueue {
  /** True when a message typed now would be queued behind the current turn. */
  canQueue: boolean;
  state?: MobileTurnQueueState;
  online: boolean;
  /** The composer's current permission choice, to label entries queued under another one. */
  currentPermissionMode?: string;
  cancel: (entryId: string) => void;
  retry: (entryId: string) => void;
  resume: () => void;
  clear: () => void;
}
