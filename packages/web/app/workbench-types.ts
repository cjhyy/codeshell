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

/** Host adapters supply existing transport state; the browser workbench owns
 * navigation, focus, message rendering and the composer for every host. */
export interface WorkbenchController {
  host: "hub" | "desktop" | "legacy";
  workspaceApi: boolean;
  connection: ConnectionState;
  session?: AuthSession;
  activeId: string;
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
  approvals: Array<{ id: string; sessionId?: string }>;
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
  send: () => boolean;
  stop: () => void;
  addFiles: (files: FileList | null) => void | Promise<void>;
  refreshSessions: () => void | Promise<void>;
  refreshConfiguration: () => void | Promise<void>;
  onAuthLost: () => void;
  /** Browser-safe controls for capabilities owned by the Desktop host. */
  renderSidebar?: (navigation: WorkbenchNavigation) => React.ReactNode;
  chatControls?: React.ReactNode;
  goalActions?: React.ReactNode;
  loading?: boolean;
  readOnly?: boolean;
  readOnlyNote?: string;
  attachmentAccept?: string;
  cameraAttachments?: boolean;
  unreadSessionIds?: ReadonlySet<string>;
  showTurnCounts?: boolean;
  accountName?: string;
  logout?: () => void;
}
