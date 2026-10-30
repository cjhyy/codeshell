import type { MobileImageAttachment } from "@cjhyy/code-shell-core";

/** Public device execution DTOs. All account, relay and Host grants stay in main. */
export interface AccountExecutionDevice {
  hostId: string;
  environmentId: string;
  name: string;
  online: boolean;
  revoked: boolean;
  lastOnlineAt?: number;
  protocolVersion: number;
}
export interface AccountDeviceProject {
  id: string;
  name: string;
  path: string;
}
export interface AccountDeviceConnection {
  id: string;
  hostId: string;
  environmentId: string;
  projectId: string;
  sessionId: string;
  /** A restored subscription has not proven a complete output/history replay. */
  historyNeedsReview?: boolean;
}
export interface AccountDeviceEvent {
  connectionId: string;
  hostId: string;
  environmentId: string;
  projectId: string;
  sessionId: string;
  type: "event" | "disconnected";
  event?: Record<string, any>;
}
export type AccountDeviceSendResult =
  | { ok: true }
  | { ok: false; error: string; delivery: "not-sent" | "unknown" };
export interface AccountDeviceApi {
  list(): Promise<AccountExecutionDevice[]>;
  projects(input: { hostId: string }): Promise<AccountDeviceProject[]>;
  connect(input: { hostId: string; projectId: string }): Promise<AccountDeviceConnection>;
  resume(input: { connectionId: string }): Promise<AccountDeviceConnection>;
  send(input: {
    connectionId: string;
    text: string;
    attachments?: MobileImageAttachment[];
  }): Promise<AccountDeviceSendResult>;
  stop(input: { connectionId: string }): Promise<void>;
  approve(input: {
    connectionId: string;
    approvalId: string;
    workerConnectionId?: string;
    generation?: number;
    approved: boolean;
    answer?: string;
  }): Promise<void>;
  close(input: { connectionId: string }): Promise<void>;
  onEvent(callback: (event: AccountDeviceEvent) => void): () => void;
}
