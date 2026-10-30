import type React from "react";
import type { ChatState } from "../src/lib/streamReducer.js";
import type { AuthSession, UploadedFile } from "./auth.js";
import type { HubConfiguration } from "./configuration.js";
import type { ComposerDraft } from "./drafts.js";
import type { ConnectionState, SessionSummary } from "./protocol.js";

export interface WorkbenchNavigation {
  guard: (action: () => void) => void;
  conversation: (action: () => void) => void;
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
  localDrafts: Array<{ sessionId: string; draft: ComposerDraft }>;
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
}
