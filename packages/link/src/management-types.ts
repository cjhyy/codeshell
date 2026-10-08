import type { LinkProviderManifest } from "./types.js";

export type LinkProviderView = LinkProviderManifest & {
  /** Host-verified capabilities, distinct from short-lived authorization steps. */
  authModes?: LinkAuthMode[];
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

export interface LinkAuthMode {
  id: string;
  methodId: string;
  kind: "credential-input" | "local-session" | "device-code" | "redirect" | "qr-code";
  label: string;
  preferred?: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface LinkCredentialFieldView {
  id: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  maxLength?: number;
}

export interface LinkResourceGroupView {
  id: string;
  label: string;
  items: Array<{ id: string; label: string; description?: string }>;
  minSelected?: number;
  maxSelected?: number;
  truncated?: boolean;
}

/** Only the current interaction is exposed; protocol credentials stay in their Host. */
export type LinkAuthorizationStep = {
  id: string;
  expiresAt: string;
} & (
  | { kind: "redirect"; authorizationUrl: string }
  | {
      kind: "device-code";
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
    }
  | {
      kind: "qr-code";
      qr?: { payload: string; challengeExpiresAt: string; instructions: string[] };
      phase: "awaiting-scan" | "awaiting-confirmation" | "expired";
      canRefresh: boolean;
    }
  | {
      kind: "credential-input";
      purpose: "credential" | "verification-code" | "second-factor";
      fields: LinkCredentialFieldView[];
    }
  | {
      kind: "local-session";
      session: {
        installed: boolean;
        authenticated: boolean;
        account?: string;
        message?: string;
        canLogin?: boolean;
        canInstall?: boolean;
      };
    }
  | {
      kind: "consent";
      account: { id?: string; label: string };
      permissions: Array<{ id: string; label: string; description?: string; required?: boolean }>;
      resourceGroups: LinkResourceGroupView[];
    }
  | { kind: "processing" }
);

export interface LinkAuthorizationResponse {
  stepId: string;
  operation:
    | "submit"
    | "detect-session"
    | "login-session"
    | "bind-session"
    | "confirm"
    | "refresh-qr";
  input?: Record<string, string | string[] | boolean>;
}

export interface MaskedLinkConnection {
  id: string;
  providerId: string;
  methodId: string;
  label: string;
  runtime: "local" | "server";
  authSource: "manual-token" | "cli-session" | "browser-oauth" | "remote-link";
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
  capabilities: {
    token: boolean;
    cliBinding: boolean;
    deviceAuth: boolean;
    remoteAuth?: boolean;
    authorizationSteps?: 1;
  };
  remoteServer?: { issuer: string };
  /** Count only; retired secrets never leave the Host. Retried after restart with backoff. */
  remoteCleanupPending?: number;
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

export interface LinkAuthorizationInput extends LinkConnectionInput {
  authModeId: string;
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
  methodId?: string;
  authModeId?: string;
  expiresAt?: string;
  step?: LinkAuthorizationStep;
  prompt?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresAt: string;
  };
  redirect?: { authorizationUrl: string; expiresAt: string };
  previousGrantRevocationPending?: boolean;
  connection?: MaskedLinkConnection;
  errorCode?: LinkErrorCode;
}
