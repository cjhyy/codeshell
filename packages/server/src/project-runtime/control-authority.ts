import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubAuth } from "../hub/auth-http.js";
import type { HubSession } from "../hub/auth-store.js";

/** Public Account identity; access/refresh credentials never enter project workers. */
export interface CloudAccountPrincipal {
  accountOrigin: string;
  accountId: string;
  sessionId: string;
  rootSessionId: string;
  authorityEpoch: string;
  expiresAt: number;
}
export interface CloudManagementSession {
  id: string;
  kind: "cloud-management";
  audience: string;
  installationId: string;
  accountOrigin: string;
  accountId: string;
  managementEpoch: string;
  expiresAt: number;
  /** Internal owner scope, excluded from every response. */
  ownerId: string;
}
export type ProjectControlSession = HubSession | CloudManagementSession;

export interface ProjectControlAuthority {
  bootstrapToken?: string;
  cookieName: string;
  store: { listSessions(): ProjectControlSession[] };
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  authenticate(req: IncomingMessage): Promise<ProjectControlSession | null>;
  isOriginAllowed(req: IncomingMessage): boolean;
  /** Local lifetime check, synchronous so an already revoked transport closes promptly. */
  isActive(session: ProjectControlSession): boolean;
  /** Continuous authority check, also called around asynchronous lifecycle work. */
  revalidate(session: ProjectControlSession): Promise<void>;
  close?(): void;
}

export interface CloudAccountAuthority {
  accountOrigin: string;
  redeem(ticket: string, installationId: string): Promise<CloudAccountPrincipal>;
  validate(
    principal: CloudAccountPrincipal,
    installationId: string,
  ): Promise<CloudAccountPrincipal>;
}

export function legacyProjectAuthority(auth: HubAuth): ProjectControlAuthority {
  const isActive = (session: ProjectControlSession) =>
    !("kind" in session) &&
    auth.store
      .listSessions()
      .some((row) => row.id === session.id && row.username === session.username);
  return {
    ...auth,
    cookieName: "cs_hub_session",
    isActive,
    async revalidate(session) {
      if (!isActive(session)) throw new Error("Project control authority expired.");
    },
  };
}
