export interface TrustedDevice {
  id: string;
  name: string;
  secretHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface TrustedDevicePublic {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface PairingToken {
  value: string;
  expiresAt: number;
}

export type MobileClientEvent =
  | { type: "auth.device"; deviceId: string; secretHash: string }
  | { type: "pair.complete"; token: string; name: string; secretHash: string }
  | { type: "chat.send"; text: string; sessionId?: string }
  | { type: "session.select"; sessionId: string }
  | { type: "session.create" }
  | { type: "run.stop"; sessionId?: string }
  | { type: "approval.respond"; approvalId: string; decision: "approve" | "reject"; sessionId?: string }
  | { type: "job.stop"; jobId: string };

export type MobileServerEvent =
  | { type: "auth.ok"; device: TrustedDevicePublic }
  | { type: "auth.failed"; message: string }
  | { type: "pair.ok"; device: TrustedDevicePublic }
  | { type: "pair.failed"; message: string }
  | { type: "chat.accepted"; sessionId?: string }
  | {
      type: "approval.request";
      approvalId: string;
      title: string;
      risk: "low" | "medium" | "high";
      body: string;
    }
  | { type: "error"; message: string };
