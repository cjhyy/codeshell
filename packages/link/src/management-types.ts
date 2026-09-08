import type { LinkProviderManifest } from "./types.js";

export type LinkProviderView = LinkProviderManifest & {
  tokenLabel: string;
  tokenPlaceholder: string;
  actions: Array<{
    id: string;
    title: string;
    description: string;
    risk: "discovery" | "read" | "write";
  }>;
  deviceAuth?: {
    providerId: "github" | "gitlab";
    configured: boolean;
    flow: "device-code";
    configurationCode?: "client_id_missing";
  };
};

export interface MaskedLinkConnection {
  id: string;
  providerId: string;
  methodId: string;
  label: string;
  runtime: "local";
  authSource: "manual-token" | "cli-session" | "browser-oauth";
  status: "connected" | "expired" | "invalid" | "unavailable";
  account?: { id?: string; label?: string; resources: string[] };
  capabilityIds: string[];
  verifiedAt?: string;
  expiresAt?: string;
  revision: string;
  scope: "user" | "project";
  editable: boolean;
}

export interface LinkSnapshot {
  providers: LinkProviderView[];
  connections: MaskedLinkConnection[];
  capabilities: { token: boolean; cliBinding: boolean; deviceAuth: boolean };
  revision: string;
}

/** null means create-only; a string is the exact connection revision reviewed by the user. */
export interface LinkConnectionInput {
  providerId: string;
  methodId: string;
  label: string;
  connectionId?: string;
  expectedRevision: string | null;
}

export interface TokenConnectionInput extends LinkConnectionInput {
  token: string;
}

export type LinkErrorCode =
  | "invalid_request"
  | "login_required"
  | "not_found"
  | "read_only"
  | "conflict"
  | "busy"
  | "provider_rejected"
  | "cli_unavailable"
  | "authorization_failed"
  | "authorization_expired"
  | "cancelled"
  | "unavailable";

export interface LinkAuthorization {
  id: string;
  providerId: string;
  state: "pending" | "connected" | "failed" | "cancelled";
  prompt?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresAt: string;
  };
  connection?: MaskedLinkConnection;
  errorCode?: LinkErrorCode;
}
